import { Hono } from 'hono';
import type { AppEnv, Bindings } from './env';
import { sendOverdueReminders } from './services/reminders';
import { accessMiddleware } from './middleware/access';
import { csrfGuard } from './middleware/csrf';
import { admin } from './routes/admin';
import { pay } from './routes/pay';
import { webhooks } from './routes/webhooks';
import {
  clearLoginAttempts,
  getInvoice,
  getInvoiceItems,
  getSettings,
  purgeOldLoginAttempts,
  purgeOldOutbox,
  recordLoginAttempt,
} from './db/queries';
import { processEmailOutbox } from './services/outbox';
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MINUTES, MAX_OUTBOX_ATTEMPTS } from './lib/outbox';
import { generateInvoicePdf, pdfResponse } from './services/pdf';
import { sendErrorAlert } from './services/email';
import { NotFoundPage } from './views/error';
import { AuthSetupPage, LoginPage } from './views/admin/login';
import {
  authMode,
  isLocalRequest,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signSession,
  timingSafeEqual,
} from './lib/admin-auth';
import { resolveBaseUrl } from './lib/base-url';
import { deleteCookie, setCookie } from 'hono/cookie';

const app = new Hono<AppEnv>();

// Zero-config base URL: when APP_BASE_URL isn't set (workers.dev / one-click
// deploys), derive it per request so emails, checkout redirects, and PDF
// links point at wherever the app is actually served.
app.use('*', async (c, next) => {
  const resolved = resolveBaseUrl(c.env.APP_BASE_URL, c.req.url, isLocalRequest(c.req.raw));
  if (resolved !== c.env.APP_BASE_URL) c.env = { ...c.env, APP_BASE_URL: resolved };
  await next();
});

app.get('/', (c) => c.redirect('/admin'));

// CSRF: reject cross-site state-changing requests to any admin route (incl.
// login). Registered before the routes below so it covers them all.
app.use('/admin/*', csrfGuard);

// ---- Login/logout: registered BEFORE the /admin/* auth middleware so they're
// reachable while signed out. In access mode they defer to Access entirely.
app.get('/admin/login', (c) => {
  const mode = authMode(c.env);
  if (mode === 'access') return c.redirect('/admin');
  if (mode === 'unconfigured') return c.html(<AuthSetupPage />, 403);
  return c.html(<LoginPage loggedOut={c.req.query('out') === '1'} />);
});

app.post('/admin/login', async (c) => {
  if (authMode(c.env) !== 'password') return c.redirect('/admin');

  // Rate limit BEFORE the password check: every POST atomically consumes one
  // of 10 attempts per IP per 15 minutes (upsert + RETURNING in one D1
  // statement), so parallel requests each get a distinct count and can't all
  // observe a below-limit counter. Success clears the row.
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if ((await recordLoginAttempt(c.env.DB, ip, LOGIN_WINDOW_MINUTES)) > LOGIN_MAX_ATTEMPTS) {
    return c.html(<LoginPage lockedOut />, 429);
  }

  const body = await c.req.parseBody();
  const password = typeof body.password === 'string' ? body.password : '';
  if (password && (await timingSafeEqual(password, c.env.ADMIN_PASSWORD!))) {
    c.executionCtx.waitUntil(clearLoginAttempts(c.env.DB, ip));
    const expiresAt = Date.now() + SESSION_TTL_MS;
    setCookie(c, SESSION_COOKIE, await signSession(c.env.ADMIN_PASSWORD!, expiresAt), {
      path: '/',
      httpOnly: true,
      // Secure except plain-http local dev — Safari drops Secure cookies on
      // http://localhost (no Chrome-style exception), which breaks login there.
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      expires: new Date(expiresAt),
    });
    return c.redirect('/admin');
  }
  await new Promise((r) => setTimeout(r, 800)); // per-request friction on top of the counter
  return c.html(<LoginPage error />, 401);
});

app.get('/admin/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  // Access sessions end at the edge; password sessions end with the cookie.
  if (authMode(c.env) === 'access') return c.redirect('/cdn-cgi/access/logout');
  return c.redirect('/admin/login?out=1');
});

// Uptime probe: 200 only when the Worker AND its database answer. Public by
// design — exempt this path from WAF ASN blocks so external monitors reach it.
app.get('/health', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.text('ok');
  } catch (e) {
    console.error('health check failed', e);
    return c.text('unhealthy', 503);
  }
});

// Admin: Cloudflare Access at the edge + JWT verification here (defense in depth).
app.use('/admin/*', accessMiddleware);

// PDF route lives here (not in admin.tsx) so it can share the renderer with /pay/:token/pdf.
app.get('/admin/invoices/:id/pdf', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();
  const invoice = await getInvoice(c.env.DB, id);
  if (!invoice) return c.notFound();
  const [items, settings] = await Promise.all([getInvoiceItems(c.env.DB, id), getSettings(c.env.DB)]);
  return pdfResponse(
    await generateInvoicePdf(invoice, items, settings, `${c.env.APP_BASE_URL}/pay/${invoice.public_token}`, c.env.ASSETS),
    `${invoice.number}.pdf`
  );
});

app.route('/admin', admin);

// Public + provider-facing routes — deliberately outside the Access boundary.
app.route('/pay', pay);
app.route('/webhooks', webhooks);

app.notFound((c) => {
  c.header('X-Robots-Tag', 'noindex');
  return c.html(<NotFoundPage />, 404);
});

// Unhandled errors: log, alert the business email (fire-and-forget), 500.
app.onError((err, c) => {
  console.error('unhandled error', c.req.path, err);
  c.executionCtx.waitUntil(sendErrorAlert(c.env, c.env.DB, err, c.req.path));
  return c.text('Something went wrong. The error has been reported.', 500);
});

export default {
  fetch: app.fetch,
  // Daily cron (wrangler.jsonc triggers): enqueue due reminders (opt-in via
  // Settings), drain the email outbox (delivers reminders + retries any
  // payment emails that failed their immediate attempt), then housekeeping.
  scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await sendOverdueReminders(env);
        await processEmailOutbox(env);
        await purgeOldOutbox(env.DB, MAX_OUTBOX_ATTEMPTS);
        await purgeOldLoginAttempts(env.DB);
      })()
    );
  },
};
