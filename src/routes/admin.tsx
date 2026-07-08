import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { formatCents, isSupportedCurrency, parseAmountToCents } from '../lib/money';
import { addDaysISO, isValidTimezone, todayInTz } from '../lib/dates';
import { configWarnings } from '../lib/config';
import { keySource } from '../lib/providers';
import { isLocalRequest } from '../lib/admin-auth';
import { parseSchedule } from '../lib/reminders';
import {
  buildTimeline,
  completeSetup,
  createClient,
  createInvoice,
  deleteInvoice,
  deleteViewEvent,
  getClient,
  getInvoice,
  getInvoiceEvents,
  getInvoiceItems,
  getPayments,
  getSettings,
  logInvoiceEvent,
  invoiceNumberExists,
  listAllPayments,
  listClients,
  listInvoices,
  markInvoiceSent,
  markInvoiceUnsent,
  monthlyReport,
  reportSummary,
  suggestedInvoiceNumber,
  recordManualPayment,
  undoPayment,
  updatePaymentNote,
  setInvoiceStatus,
  updateClient,
  updateInvoice,
  setNextInvoiceNumber,
  setResendApiKey,
  updateEmailSettings,
  updateProviderSettings,
  updateSettings,
  type ItemDraft,
} from '../db/queries';
import { DashboardPage, INVOICE_FILTERS, type InvoiceFilter } from '../views/admin/dashboard';
import { generateInvoicePdf } from '../services/pdf';
import { sendInvoiceEmail } from '../services/email';
import { InvoiceFormPage } from '../views/admin/invoice-form';
import { InvoiceDetailPage } from '../views/admin/invoice-detail';
import { ClientEditPage, ClientNewPage, ClientsPage } from '../views/admin/clients';
import { PaymentsPage } from '../views/admin/payments';
import { ReportsPage } from '../views/admin/reports';
import { SettingsPage } from '../views/admin/settings';
import { SetupPage } from '../views/admin/setup';

export const admin = new Hono<AppEnv>();

// ---------- First-launch setup wizard ----------

// Gate every admin page behind the wizard until required settings exist.
admin.use('*', async (c, next) => {
  if (c.req.path === '/admin/setup') return next();
  const settings = await getSettings(c.env.DB);
  if (!settings.setup_complete) return c.redirect('/admin/setup');
  await next();
});

admin.get('/setup', async (c) => {
  const settings = await getSettings(c.env.DB);
  if (settings.setup_complete) return c.redirect('/admin');
  // Cloudflare geolocates the request — prefill the visitor's timezone.
  const detected = (c.req.raw.cf as { timezone?: string } | undefined)?.timezone;
  return c.html(<SetupPage values={{ timezone: detected && isValidTimezone(detected) ? detected : undefined }} />);
});

admin.post('/setup', async (c) => {
  const settings = await getSettings(c.env.DB);
  if (settings.setup_complete) return c.redirect('/admin');

  const body = (await c.req.parseBody()) as Record<string, string>;
  const values = {
    business_name: body.business_name?.trim() ?? '',
    business_email: body.business_email?.trim() ?? '',
    business_address: body.business_address?.trim() ?? '',
    currency: (body.currency?.trim() ?? '').toUpperCase(),
    timezone: body.timezone ?? 'UTC',
    invoice_prefix: body.invoice_prefix?.trim() || 'INV-',
    payment_terms_days: body.payment_terms_days ?? '',
    default_rate: body.default_rate ?? '',
  };

  const problems: string[] = [];
  if (!values.business_name) problems.push('business name');
  if (!values.business_email || !values.business_email.includes('@')) problems.push('business email');
  if (!isSupportedCurrency(values.currency))
    problems.push('currency (3-letter code; zero-decimal currencies like JPY are not supported)');
  if (!isValidTimezone(values.timezone)) problems.push('time zone');
  if (problems.length) {
    return c.html(<SetupPage error={`Please provide a valid ${problems.join(', ')}.`} values={values} />, 400);
  }

  await updateSettings(c.env.DB, {
    business_name: values.business_name,
    business_address: values.business_address,
    business_email: values.business_email,
    logo_url: null,
    currency: values.currency,
    tax_rate_bps: 0,
    invoice_prefix: values.invoice_prefix,
    default_rate_cents: (values.default_rate && parseAmountToCents(values.default_rate)) || 0,
    timezone: values.timezone,
    // No send_email binding (zero-config deploys) -> Resend is the workable provider
    email_provider: c.env.EMAIL ? 'cloudflare' : 'resend',
    email_from: '',
    payment_terms_days: Math.max(0, parseInt(values.payment_terms_days, 10) || 0),
  });
  await completeSetup(c.env.DB);
  return c.redirect('/admin');
});

/** Normalize a parseBody({ all: true }) field into a string[]. */
function arr(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Parse line items, reporting every problem by line number instead of
 * silently dropping bad rows. Fully blank rows are ignored; a row with ANY
 * content must be complete and valid.
 */
function parseItemDrafts(body: Record<string, string | string[]>): { items: ItemDraft[]; problems: string[] } {
  const descriptions = arr(body['item_description[]']);
  const quantities = arr(body['item_quantity[]']);
  const unitPrices = arr(body['item_unit_price[]']);
  const rowCount = Math.max(descriptions.length, quantities.length, unitPrices.length);

  const items: ItemDraft[] = [];
  const problems: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const description = (descriptions[i] ?? '').trim();
    const priceRaw = (unitPrices[i] ?? '').trim();
    const qtyRaw = (quantities[i] ?? '').trim();
    if (!description && !priceRaw) continue; // untouched row

    const line = `Line ${i + 1}`;
    let ok = true;
    if (!description) {
      problems.push(`${line}: description is missing.`);
      ok = false;
    }
    const unitPriceCents = parseAmountToCents(priceRaw);
    if (!priceRaw) {
      problems.push(`${line}: unit price is missing.`);
      ok = false;
    } else if (unitPriceCents === null) {
      problems.push(`${line}: "${priceRaw}" is not a valid amount.`);
      ok = false;
    }
    const quantity = qtyRaw === '' ? 1 : parseFloat(qtyRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      problems.push(`${line}: quantity must be a positive number.`);
      ok = false;
    }
    if (ok) items.push({ description, quantity, unit_price_cents: unitPriceCents! });
  }
  if (items.length === 0 && problems.length === 0) {
    problems.push('Add at least one line item.');
  }
  return { items, problems };
}

/** Header-field checks shared by create and edit. */
async function invoiceHeaderProblems(
  db: D1Database,
  body: Record<string, string | string[]>,
  opts: { checkClient: boolean }
): Promise<string[]> {
  const problems: string[] = [];
  if (opts.checkClient) {
    const clientId = Number(str(body.client_id));
    if (!Number.isInteger(clientId) || !(await getClient(db, clientId))) {
      problems.push('Select a client.');
    }
  }
  const issue = str(body.issue_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue)) {
    problems.push('Issue date is required.');
  }
  const due = str(body.due_date);
  if (due && issue && due < issue) {
    problems.push(`Due date (${due}) is before the issue date (${issue}).`);
  }
  return problems;
}

function str(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

// ---------- Dashboard ----------

admin.get('/', async (c) => {
  const [invoices, settings] = await Promise.all([listInvoices(c.env.DB), getSettings(c.env.DB)]);
  const status = c.req.query('status');
  const filter: InvoiceFilter = (INVOICE_FILTERS as readonly string[]).includes(status ?? '')
    ? (status as InvoiceFilter)
    : 'all';
  const clientParam = Number(c.req.query('client'));
  const clientId = Number.isInteger(clientParam) && clientParam > 0 ? clientParam : undefined;
  return c.html(
    <DashboardPage
      invoices={invoices}
      filter={filter}
      clientId={clientId}
      deleted={c.req.query('deleted')}
      today={todayInTz(settings.timezone)}
      warnings={configWarnings(c.env, settings, { localDev: isLocalRequest(c.req.raw) })}
      currentPath="/admin"
    />
  );
});

// ---------- Invoices: new ----------

admin.get('/invoices/new', async (c) => {
  const [clients, settings] = await Promise.all([listClients(c.env.DB), getSettings(c.env.DB)]);
  return c.html(
    <InvoiceFormPage
      currentPath="/admin"
      clients={clients}
      settings={settings}
      suggestedNumber={await suggestedInvoiceNumber(c.env.DB, settings)}
    />
  );
});

admin.post('/invoices/new', async (c) => {
  const body = (await c.req.parseBody({ all: true })) as Record<string, string | string[]>;
  const [clients, settings] = await Promise.all([listClients(c.env.DB), getSettings(c.env.DB)]);
  const { items, problems: itemProblems } = parseItemDrafts(body);
  const suggested = await suggestedInvoiceNumber(c.env.DB, settings);

  const rerender = (errors: string[]) =>
    c.html(
      <InvoiceFormPage
        currentPath="/admin"
        clients={clients}
        settings={settings}
        suggestedNumber={suggested}
        errors={errors}
        formValues={{
          number: str(body.number),
          client_id: str(body.client_id),
          issue_date: str(body.issue_date),
          due_date: str(body.due_date),
          subject: str(body.subject),
          notes: str(body.notes),
          item_description: arr(body['item_description[]']),
          item_quantity: arr(body['item_quantity[]']),
          item_unit_price: arr(body['item_unit_price[]']),
        }}
      />,
      400
    );

  const problems = [...(await invoiceHeaderProblems(c.env.DB, body, { checkClient: true })), ...itemProblems];

  // Blank or untouched number -> auto counter; anything else is a custom number.
  const typedNumber = str(body.number).trim();
  const customNumber = typedNumber && typedNumber !== suggested ? typedNumber : undefined;
  if (customNumber && (await invoiceNumberExists(c.env.DB, customNumber))) {
    problems.push(`Invoice number "${customNumber}" is already in use.`);
  }
  if (problems.length) return rerender(problems);
  const clientId = Number(str(body.client_id));

  try {
    const invoiceId = await createInvoice(
      c.env.DB,
      {
        client_id: clientId,
        issue_date: str(body.issue_date),
        due_date: str(body.due_date) || null,
        subject: str(body.subject).trim() || null,
        notes: str(body.notes) || null,
        items,
      },
      customNumber
    );
    return c.redirect(`/admin/invoices/${invoiceId}`);
  } catch (e) {
    // Lost a race on the UNIQUE(number) constraint — surface it instead of a 500.
    if (String(e).includes('UNIQUE')) {
      return rerender(['That invoice number was just taken — please try again.']);
    }
    throw e;
  }
});

// ---------- Invoices: detail ----------

admin.get('/invoices/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const invoice = await getInvoice(c.env.DB, id);
  if (!invoice) return c.notFound();

  const [items, payments, events, settings] = await Promise.all([
    getInvoiceItems(c.env.DB, id),
    getPayments(c.env.DB, id),
    getInvoiceEvents(c.env.DB, id),
    getSettings(c.env.DB),
  ]);
  const payLink = `${c.env.APP_BASE_URL}/pay/${invoice.public_token}`;
  const timeline = buildTimeline(invoice, payments, events, formatCents);
  const emailedTo = c.req.query('emailed');
  const emailError = c.req.query('email_error');

  return c.html(
    <InvoiceDetailPage
      currentPath="/admin"
      invoice={invoice}
      items={items}
      payments={payments}
      payLink={payLink}
      timeline={timeline}
      timezone={settings.timezone}
      emailEnabled={settings.email_provider !== 'none'}
      notice={emailedTo ? `Invoice emailed to ${emailedTo}.` : undefined}
      error={emailError}
    />
  );
});

// ---------- Invoices: edit ----------

admin.get('/invoices/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const invoice = await getInvoice(c.env.DB, id);
  if (!invoice) return c.notFound();

  if (invoice.status !== 'draft' && invoice.status !== 'sent') {
    return c.redirect(`/admin/invoices/${id}`);
  }

  const [clients, items, settings] = await Promise.all([
    listClients(c.env.DB),
    getInvoiceItems(c.env.DB, id),
    getSettings(c.env.DB),
  ]);

  return c.html(
    <InvoiceFormPage currentPath="/admin" clients={clients} settings={settings} invoice={invoice} items={items} />
  );
});

admin.post('/invoices/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const invoice = await getInvoice(c.env.DB, id);
  if (!invoice) return c.notFound();

  if (invoice.status !== 'draft' && invoice.status !== 'sent') {
    return c.redirect(`/admin/invoices/${id}`);
  }

  const body = (await c.req.parseBody({ all: true })) as Record<string, string | string[]>;
  const { items, problems: itemProblems } = parseItemDrafts(body);
  const problems = [...(await invoiceHeaderProblems(c.env.DB, body, { checkClient: true })), ...itemProblems];

  if (problems.length) {
    const [clients, settings] = await Promise.all([listClients(c.env.DB), getSettings(c.env.DB)]);
    return c.html(
      <InvoiceFormPage
        currentPath="/admin"
        clients={clients}
        settings={settings}
        invoice={invoice}
        errors={problems}
        formValues={{
          client_id: str(body.client_id),
          issue_date: str(body.issue_date),
          due_date: str(body.due_date),
          subject: str(body.subject),
          notes: str(body.notes),
          item_description: arr(body['item_description[]']),
          item_quantity: arr(body['item_quantity[]']),
          item_unit_price: arr(body['item_unit_price[]']),
        }}
      />,
      400
    );
  }

  await updateInvoice(c.env.DB, id, {
    client_id: Number(str(body.client_id)),
    issue_date: str(body.issue_date),
    due_date: str(body.due_date) || null,
    subject: str(body.subject).trim() || null,
    notes: str(body.notes) || null,
    items,
  });
  await logInvoiceEvent(c.env.DB, id, 'edited');

  return c.redirect(`/admin/invoices/${id}`);
});

// ---------- Invoices: status transitions ----------

admin.post('/invoices/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const invoice = await getInvoice(c.env.DB, id);
  if (!invoice) return c.notFound();

  const body = (await c.req.parseBody()) as Record<string, string>;
  const action = body.action;
  const today = todayInTz((await getSettings(c.env.DB)).timezone);

  switch (action) {
    case 'send': {
      // Drafts become sent; sent invoices can have their date adjusted.
      // Never resurrects a paid/void invoice (guarded again in SQL).
      if (invoice.status === 'draft' || invoice.status === 'sent') {
        const raw = body.sent_date?.trim();
        // "Today" means now — keep the full timestamp; only real backdates stay date-only.
        const sentDate = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && raw !== today ? raw : undefined;

        // The email path: send first, mark sent only on success.
        if (body.email === '1') {
          if (!invoice.client_email) {
            return c.redirect(`/admin/invoices/${id}?email_error=${encodeURIComponent('Client has no email address.')}`);
          }
          try {
            const [items, settings] = await Promise.all([getInvoiceItems(c.env.DB, id), getSettings(c.env.DB)]);
            const pdf = await generateInvoicePdf(invoice, items, settings);
            await sendInvoiceEmail(c.env, invoice, settings, pdf);
          } catch (e) {
            console.error('invoice email failed', e);
            const reason = e instanceof Error ? e.message.slice(0, 160) : 'unknown error';
            return c.redirect(
              `/admin/invoices/${id}?email_error=${encodeURIComponent(
                `Email failed to send — the invoice was NOT marked sent. (${reason})`
              )}`
            );
          }
          if (invoice.status === 'draft') {
            await markInvoiceSent(c.env.DB, id);
            await logInvoiceEvent(c.env.DB, id, 'sent');
          }
          await logInvoiceEvent(c.env.DB, id, 'emailed', `Invoice emailed to ${invoice.client_email}`);
          return c.redirect(`/admin/invoices/${id}?emailed=${encodeURIComponent(invoice.client_email)}`);
        }

        await markInvoiceSent(c.env.DB, id, sentDate);
        if (invoice.status === 'draft') {
          await logInvoiceEvent(c.env.DB, id, 'sent', sentDate ? `Dated ${sentDate}` : undefined);
        } else if (sentDate && sentDate !== invoice.sent_at?.slice(0, 10)) {
          await logInvoiceEvent(c.env.DB, id, 'sent_date_changed', `Sent date set to ${sentDate}`);
        }
      }
      break;
    }
    case 'unsend':
      if (invoice.status === 'sent') {
        await markInvoiceUnsent(c.env.DB, id);
        await logInvoiceEvent(c.env.DB, id, 'unsent');
      }
      break;
    case 'void':
      if (invoice.status === 'draft' || invoice.status === 'sent') {
        await setInvoiceStatus(c.env.DB, id, 'void');
        await logInvoiceEvent(c.env.DB, id, 'voided');
      }
      break;
    case 'mark_paid':
      if (invoice.status === 'draft' || invoice.status === 'sent') {
        const paymentDate = body.payment_date?.trim();
        await recordManualPayment(c.env.DB, invoice, {
          note: body.note?.trim() || undefined,
          // "Today" means now — keep the full timestamp; only real backdates stay date-only.
          paidDate:
            paymentDate && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate) && paymentDate !== today
              ? paymentDate
              : undefined,
        });
      }
      break;
    case 'delete':
      await deleteInvoice(c.env.DB, id);
      return c.redirect(`/admin?deleted=${encodeURIComponent(invoice.number)}`);
    default:
      break;
  }

  return c.redirect(`/admin/invoices/${id}`);
});

admin.post('/invoices/:id/duplicate', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const source = await getInvoice(c.env.DB, id);
  if (!source) return c.notFound();

  const [items, settings, client] = await Promise.all([
    getInvoiceItems(c.env.DB, id),
    getSettings(c.env.DB),
    getClient(c.env.DB, source.client_id),
  ]);
  const today = todayInTz(settings.timezone);
  const terms = client?.payment_terms_days ?? settings.payment_terms_days;

  const newId = await createInvoice(c.env.DB, {
    client_id: source.client_id,
    issue_date: today,
    due_date: terms > 0 ? addDaysISO(today, terms) : null,
    subject: source.subject,
    notes: source.notes,
    items: items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      unit_price_cents: it.unit_price_cents,
    })),
  });
  await logInvoiceEvent(c.env.DB, newId, 'duplicated', `Duplicated from ${source.number}`);
  return c.redirect(`/admin/invoices/${newId}`);
});

admin.post('/invoices/:id/payments/:pid/undo', async (c) => {
  const id = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  if (!Number.isInteger(id) || !Number.isInteger(pid)) return c.notFound();

  const invoice = await getInvoice(c.env.DB, id);
  if (!invoice) return c.notFound();

  await undoPayment(c.env.DB, id, pid, formatCents);
  return c.redirect(`/admin/invoices/${id}`);
});

admin.post('/invoices/:id/payments/:pid/note', async (c) => {
  const id = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  if (!Number.isInteger(id) || !Number.isInteger(pid)) return c.notFound();

  const body = (await c.req.parseBody()) as Record<string, string>;
  const note = body.note?.trim() || null;
  const updated = await updatePaymentNote(c.env.DB, id, pid, note);
  if (updated) {
    await logInvoiceEvent(c.env.DB, id, 'payment_note_edited', note ?? 'Note cleared');
  }
  return c.redirect(`/admin/invoices/${id}`);
});

// ---------- Clients ----------

admin.get('/clients', async (c) => {
  const clients = await listClients(c.env.DB, true);
  return c.html(<ClientsPage currentPath="/admin/clients" clients={clients} />);
});

admin.post('/clients', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string>;
  await createClient(c.env.DB, {
    name: body.name,
    email: body.email || null,
    address: body.address || null,
    default_rate_cents: body.default_rate ? parseAmountToCents(body.default_rate) : null,
    payment_terms_days: body.payment_terms_days?.trim() ? Math.max(0, parseInt(body.payment_terms_days, 10) || 0) : null,
  });
  return c.redirect('/admin/clients');
});

// Registered before /clients/:id so the static path wins.
admin.get('/clients/new', (c) => c.html(<ClientNewPage currentPath="/admin/clients" />));

admin.get('/clients/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const client = await getClient(c.env.DB, id);
  if (!client) return c.notFound();

  return c.html(<ClientEditPage currentPath="/admin/clients" client={client} />);
});

admin.post('/clients/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();

  const client = await getClient(c.env.DB, id);
  if (!client) return c.notFound();

  const body = (await c.req.parseBody()) as Record<string, string>;
  await updateClient(c.env.DB, id, {
    name: body.name,
    email: body.email || null,
    address: body.address || null,
    archived: body.archived ? 1 : 0,
    default_rate_cents: body.default_rate ? parseAmountToCents(body.default_rate) : null,
    payment_terms_days: body.payment_terms_days?.trim() ? Math.max(0, parseInt(body.payment_terms_days, 10) || 0) : null,
  });

  return c.redirect('/admin/clients');
});

// ---------- CSV export ----------

function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvResponse(rows: unknown[][], filename: string): Response {
  const body = rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

admin.get('/export/invoices.csv', async (c) => {
  const invoices = await listInvoices(c.env.DB);
  const rows: unknown[][] = [
    ['number', 'client', 'subject', 'status', 'issue_date', 'due_date', 'sent_at', 'paid_at', 'currency', 'subtotal', 'tax', 'total'],
    ...invoices.map((i) => [
      i.number,
      i.client_name,
      i.subject,
      i.status,
      i.issue_date,
      i.due_date,
      i.sent_at,
      i.paid_at,
      i.currency,
      (i.subtotal_cents / 100).toFixed(2),
      (i.tax_cents / 100).toFixed(2),
      (i.total_cents / 100).toFixed(2),
    ]),
  ];
  return csvResponse(rows, 'invoices.csv');
});

admin.get('/export/payments.csv', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.created_at AS date, i.number AS invoice, c.name AS client, p.provider, p.provider_ref,
            p.amount_cents, p.currency, p.note, p.undone_at
     FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id
     ORDER BY p.id`
  ).all<{
    date: string;
    invoice: string;
    client: string;
    provider: string;
    provider_ref: string | null;
    amount_cents: number;
    currency: string;
    note: string | null;
    undone_at: string | null;
  }>();
  const rows: unknown[][] = [
    ['date', 'invoice', 'client', 'provider', 'reference', 'amount', 'currency', 'note', 'undone_at'],
    ...results.map((p) => [
      p.date,
      p.invoice,
      p.client,
      p.provider,
      p.provider_ref,
      (p.amount_cents / 100).toFixed(2),
      p.currency,
      p.note,
      p.undone_at,
    ]),
  ];
  return csvResponse(rows, 'payments.csv');
});

// Remove a recorded pay-link view (own views, email scanners) from History.
admin.post('/invoices/:id/events/:eventId/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const eventId = Number(c.req.param('eventId'));
  if (!Number.isInteger(id) || !Number.isInteger(eventId)) return c.notFound();
  await deleteViewEvent(c.env.DB, id, eventId);
  return c.redirect(`/admin/invoices/${id}`);
});

// ---------- Payments ----------

admin.get('/payments', async (c) => {
  const clientId = Number(c.req.query('client')) || null;
  const [payments, settings, clients] = await Promise.all([
    listAllPayments(c.env.DB, clientId),
    getSettings(c.env.DB),
    listClients(c.env.DB, true),
  ]);
  return c.html(
    <PaymentsPage
      currentPath="/admin/payments"
      payments={payments}
      timezone={settings.timezone}
      currency={settings.currency}
      clients={clients}
      clientId={clientId}
    />
  );
});

// ---------- Reports ----------

admin.get('/reports', async (c) => {
  const settings = await getSettings(c.env.DB);
  const clientId = Number(c.req.query('client')) || null;
  const [summary, months, clients] = await Promise.all([
    reportSummary(c.env.DB, todayInTz(settings.timezone), clientId),
    monthlyReport(c.env.DB, clientId),
    listClients(c.env.DB, true),
  ]);
  return c.html(
    <ReportsPage
      currentPath="/admin/reports"
      summary={summary}
      months={months}
      currency={settings.currency}
      clients={clients}
      clientId={clientId}
    />
  );
});

// ---------- Settings ----------

admin.get('/settings', async (c) => {
  const settings = await getSettings(c.env.DB);
  const saved = c.req.query('saved') === '1';
  const tzKept = c.req.query('tz_kept') === '1';
  const curKept = c.req.query('cur_kept') === '1';
  const numKept = c.req.query('num_kept') === '1';
  const tail = (v: string) => (v ? v.slice(-4) : '');
  const providerMeta = {
    sources: {
      stripeKey: keySource(c.env.STRIPE_SECRET_KEY, settings.stripe_secret_key),
      stripeWebhook: keySource(c.env.STRIPE_WEBHOOK_SECRET, settings.stripe_webhook_secret),
      paypalId: keySource(c.env.PAYPAL_CLIENT_ID, settings.paypal_client_id),
      paypalSecret: keySource(c.env.PAYPAL_CLIENT_SECRET, settings.paypal_client_secret),
      paypalWebhook: keySource(c.env.PAYPAL_WEBHOOK_ID, settings.paypal_webhook_id),
      resend: keySource(c.env.RESEND_API_KEY, settings.resend_api_key),
    },
    hints: {
      stripeKey: tail(settings.stripe_secret_key),
      stripeWebhook: tail(settings.stripe_webhook_secret),
      paypalSecret: tail(settings.paypal_client_secret),
      resend: tail(settings.resend_api_key),
    },
    paypalEnvManaged: !!(c.env.PAYPAL_API_BASE ?? '').trim(),
  };
  return c.html(
    <SettingsPage
      currentPath="/admin/settings"
      settings={settings}
      saved={saved}
      tzKept={tzKept}
      curKept={curKept}
      numKept={numKept}
      providerMeta={providerMeta}
    />
  );
});

admin.post('/settings', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string>;
  const current = await getSettings(c.env.DB);
  const taxRateBps = Math.round(parseFloat(body.tax_rate_percent) * 100);
  // A typo in the free-text timezone keeps the previous value, never resets to UTC.
  const tzValid = !!body.timezone && isValidTimezone(body.timezone);
  const curValid = isSupportedCurrency((body.currency ?? '').toUpperCase());
  const nextNum = parseInt(body.next_invoice_number, 10);
  const numValid = Number.isInteger(nextNum) && nextNum >= 1;

  await updateSettings(c.env.DB, {
    business_name: body.business_name,
    business_address: body.business_address,
    business_email: body.business_email || null,
    logo_url: body.logo_url || null,
    currency: curValid ? body.currency.toUpperCase() : current.currency,
    tax_rate_bps: Number.isFinite(taxRateBps) ? taxRateBps : 0,
    invoice_prefix: body.invoice_prefix,
    default_rate_cents: (body.default_rate && parseAmountToCents(body.default_rate)) || 0,
    timezone: tzValid ? body.timezone : current.timezone,
    // Email settings live in their own card/form — preserve as-is here
    email_provider: current.email_provider,
    email_from: current.email_from,
    payment_terms_days: Math.max(0, parseInt(body.payment_terms_days, 10) || 0),
  });
  if (numValid && nextNum !== current.next_invoice_number) {
    await setNextInvoiceNumber(c.env.DB, nextNum);
  }

  return c.redirect(
    `/admin/settings?saved=1${tzValid ? '' : '&tz_kept=1'}${curValid ? '' : '&cur_kept=1'}${
      numValid ? '' : '&num_kept=1'
    }`
  );
});

admin.post('/settings/email', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string>;
  await updateEmailSettings(c.env.DB, {
    email_provider:
      body.email_provider === 'resend' ? 'resend' : body.email_provider === 'none' ? 'none' : 'cloudflare',
    email_from: (body.email_from ?? '').trim(),
    reminders_enabled: body.reminders_enabled ? 1 : 0,
    // Normalized on save so the cron and the UI always agree on the cadence
    reminder_schedule: parseSchedule(body.reminder_schedule ?? '').join(', '),
  });
  // Masked field: blank means keep the stored key
  const resendKey = (body.resend_api_key ?? '').trim();
  if (resendKey) await setResendApiKey(c.env.DB, resendKey);
  return c.redirect('/admin/settings?saved=1');
});

admin.post('/settings/providers', async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string>;
  const cur = await getSettings(c.env.DB);
  // Masked fields: blank means "keep the stored value". Plain fields (ids)
  // display their value and submit it back directly, so empty clears them.
  const keep = (input: string | undefined, current: string) => (input ?? '').trim() || current;
  const plain = (input: string | undefined, current: string) =>
    input === undefined ? current : input.trim();
  await updateProviderSettings(c.env.DB, {
    stripe_enabled: body.stripe_enabled ? 1 : 0,
    paypal_enabled: body.paypal_enabled ? 1 : 0,
    stripe_secret_key: keep(body.stripe_secret_key, cur.stripe_secret_key),
    stripe_webhook_secret: keep(body.stripe_webhook_secret, cur.stripe_webhook_secret),
    paypal_client_id: plain(body.paypal_client_id, cur.paypal_client_id),
    paypal_client_secret: keep(body.paypal_client_secret, cur.paypal_client_secret),
    paypal_webhook_id: plain(body.paypal_webhook_id, cur.paypal_webhook_id),
    paypal_environment: body.paypal_environment === 'sandbox' ? 'sandbox' : body.paypal_environment === 'live' ? 'live' : cur.paypal_environment,
    resend_api_key: keep(body.resend_api_key, cur.resend_api_key),
  });
  return c.redirect('/admin/settings?saved=1');
});
