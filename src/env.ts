export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  EMAIL?: SendEmail; // optional: absent when Email Sending isn't onboarded — use Resend instead
  APP_BASE_URL?: string; // optional: falls back to the request origin per request
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  PAYPAL_API_BASE?: string; // optional: Settings' live/sandbox selector drives it when unset
  // Secrets (wrangler secret / .dev.vars). All optional: credentials may
  // instead live in Settings (D1); env always wins when both exist.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  RESEND_API_KEY?: string; // only when settings.email_provider = 'resend'
  ADMIN_PASSWORD?: string; // fallback admin login until Cloudflare Access is configured
  // Local dev only — never set in wrangler.jsonc
  DEV_BYPASS_ACCESS?: string;
};

export type AppEnv = { Bindings: Bindings };
