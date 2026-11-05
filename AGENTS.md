# Agent guide

Minvoice is single-business invoicing on Cloudflare Workers, designed to be
forked and customized. This file tells you where customization is welcome and
which invariants must survive your changes.

## Architecture (30 seconds)

Hono + server-rendered JSX — no client framework, no frontend build step.
`src/routes/` (HTTP) → `src/db/queries.ts` (all SQL) → D1. `src/services/`
holds Stripe/PayPal/email/PDF integrations, `src/views/` the JSX pages,
`public/styles.css` the entire stylesheet, `src/lib/strings/` the
customer-facing locales. Admin UI is English-only; customer-facing surfaces
(pay page, emails, PDF) are localized.

## Customize freely

- **Look & feel:** every color/font/radius is a token in the `:root` block of
  `public/styles.css`, with light and dark values via `light-dark()`. Change
  tokens, not scattered rules. Customer-facing pages always render light — an
  intentional invariant, not a bug.
- **Language:** add a locale by copying `src/lib/strings/en.ts` and
  registering it in `SUPPORTED_LOCALES` in `src/lib/strings/index.ts`.
  A test enforces every locale implements every key.
- **Email & PDF content:** `src/services/email.ts`, `src/services/pdf.ts`.
- **Business logic defaults:** most behavior (currency, tax, terms, reminders,
  accent color, logo) is a Settings row, not code — check the Settings page
  before hardcoding anything.

## Invariants — do not break

- **Money is integer cents; tax rates are basis points.** No floats, ever.
  Amounts in different currencies are NEVER added together — reports group by
  currency. Zero-decimal (JPY, KRW, …) and three-decimal (BHD, KWD, …)
  currencies are excluded on purpose; read `isSupportedCurrency` in
  `src/lib/money.ts` and the currency-list comments in `src/lib/providers.ts`
  before "fixing" a missing currency.
- **Payment correctness lives in `markInvoicePaidFromWebhook`**
  (`src/db/queries.ts`): webhook idempotency, and a paid transition that
  requires the payment to match the invoice's current total AND currency.
  The PayPal-Request-Id is a hash capped at PayPal's 38-byte limit
  (`src/services/paypal.ts`). Don't weaken any of it.
- **Secrets:** wrangler secrets always win; dashboard-entered keys are
  envelope-encrypted in D1 (`enc:v1:` tag, `src/lib/secretbox.ts`) under
  `SETTINGS_MASTER_KEY` (≥ 32 chars). Never rotate or delete that secret —
  stored keys become undecryptable.
- **MCP OAuth:** authorization codes and tokens are stored only as SHA-256
  hashes in D1. Redirect URIs are exact-match, PKCE is S256-only, tokens are
  audience-bound to `/mcp`, and refresh tokens rotate. Never weaken these
  checks or accept third-party bearer tokens.
- **Migrations are append-only.** New numbered file in `migrations/`; never
  edit a shipped one.
- **Workers Free plan is a target:** the PDF embeds Noto fonts only when the
  rendered text needs them (`src/services/pdf.ts`) because font embedding
  blows the 10 ms CPU cap. Don't regress this, and don't add R2 or other
  billing-gated bindings.
- **Zero runtime dependencies** is a project goal — don't add npm packages
  for things a Worker API can do.

## Workflow

- `npm run dev` — wrangler dev on :8787 (first time: `npm run db:migrate:local`)
- `npm run typecheck && npm test` — required green before you're done;
  money/payment changes need new tests (vitest, real Workers runtime)
- `npm run deploy` — migrates remote D1, deploys, ensures `SETTINGS_MASTER_KEY`

**Testing logged-in UI (the default way):** the admin session is a stateless
signed cookie, so mint one locally instead of typing the password or adding a
bypass route. `node scripts/dev-session.mjs --cookie` prints a
`document.cookie = 'minvoice_admin=…'` snippet (it reads ADMIN_PASSWORD from
your local `.dev.vars`); set it in the browser and load `/admin`. It grants
nothing you couldn't get by logging in, and there is deliberately no dev-login
route in the app.

Match the existing code style: comments state constraints and reasons, not
what the next line does. Server-rendered forms; add client JS only when the
interaction genuinely needs it.
