import type { Bindings } from '../env';
import {
  createClient,
  createInvoice,
  deleteInvoice,
  getClient,
  getInvoice,
  getInvoiceEvents,
  getInvoiceItems,
  getPayments,
  getSettings,
  invoiceNumberExists,
  listAllPayments,
  listClients,
  listInvoices,
  logInvoiceEvent,
  markInvoiceSent,
  markInvoiceUnsent,
  monthlyReport,
  recordManualPayment,
  reportSummary,
  setInvoiceStatus,
  undoPayment,
  updateClient,
  updateInvoice,
  updatePaymentNote,
  updateSettings,
  type InvoiceDraft,
} from '../db/queries';
import { isValidTimezone, todayInTz, addDaysISO } from '../lib/dates';
import { formatCents, isSupportedCurrency } from '../lib/money';
import { generateInvoicePdf } from '../services/pdf';
import { sendInvoiceEmail } from '../services/email';
import { getLogo } from '../db/queries';
import { authorizeMcpRequest, MCP_READ_SCOPE, MCP_WRITE_SCOPE } from './oauth';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26'] as const;
const SERVER_VERSION = '1.0.0';

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown };
type JsonObject = Record<string, unknown>;
type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: JsonObject; isError?: boolean };

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations?: JsonObject;
  run: (args: JsonObject, env: Bindings) => Promise<unknown>;
};

const objectSchema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const string = (description: string, extra: JsonObject = {}): JsonObject => ({ type: 'string', description, ...extra });
const integer = (description: string, extra: JsonObject = {}): JsonObject => ({ type: 'integer', description, ...extra });
const boolean = (description: string): JsonObject => ({ type: 'boolean', description });
const nullableString = (description: string): JsonObject => ({ type: ['string', 'null'], description });

function argsObject(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('arguments must be an object');
  return value as JsonObject;
}

function textArg(args: JsonObject, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function intArg(args: JsonObject, key: string, required = false): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (!Number.isSafeInteger(value)) throw new Error(`${key} must be an integer`);
  return value as number;
}

function boolArg(args: JsonObject, key: string, fallback = false): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

function nullableTextArg(args: JsonObject, key: string): string | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${key} must be a string or null`);
  return value;
}

function nullableIntArg(args: JsonObject, key: string): number | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error(`${key} must be an integer or null`);
  return value as number;
}

function nonNegativeIntArg(args: JsonObject, key: string, nullable = false): number | null | undefined {
  const value = nullable ? nullableIntArg(args, key) : intArg(args, key);
  if (value !== undefined && value !== null && value < 0) throw new Error(`${key} must be non-negative`);
  return value;
}

/** A plausible BCP-47 tag; unknown languages use the English string fallback. */
function validLocaleTag(value: string): boolean {
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(value.trim());
}

function idArg(args: JsonObject, key = 'id'): number {
  const id = intArg(args, key, true)!;
  if (id < 1) throw new Error(`${key} must be a positive integer`);
  return id;
}

function isoDate(value: string | undefined, key: string, required = false): string | undefined {
  if (!value) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${key} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

function requireConfirmation(args: JsonObject, message: string): void {
  if (args.confirm !== true) throw new Error(`${message} Set confirm=true after the user explicitly approves it.`);
}

function publicSettings(settings: Awaited<ReturnType<typeof getSettings>>): JsonObject {
  const {
    stripe_secret_key: _stripeSecret,
    stripe_webhook_secret: _stripeWebhook,
    paypal_client_secret: _paypalSecret,
    resend_api_key: _resendKey,
    ...safe
  } = settings;
  return {
    ...safe,
    stripe_secret_key_configured: !!settings.stripe_secret_key,
    stripe_webhook_secret_configured: !!settings.stripe_webhook_secret,
    paypal_client_secret_configured: !!settings.paypal_client_secret,
    resend_api_key_configured: !!settings.resend_api_key,
  };
}

function invoiceItemSchema(): JsonObject {
  return objectSchema(
    {
      description: string('Line-item description'),
      quantity: { type: 'number', exclusiveMinimum: 0, description: 'Quantity; may be fractional' },
      unit_price_cents: integer('Unit price in the invoice currency’s hundredths', { minimum: 0 }),
    },
    ['description', 'quantity', 'unit_price_cents']
  );
}

function parseItems(args: JsonObject): InvoiceDraft['items'] {
  const raw = args.items;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('items must be a non-empty array');
  return raw.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`items[${index}] must be an object`);
    const item = value as JsonObject;
    const description = textArg(item, 'description', true)!.trim();
    const quantity = item.quantity;
    const unitPrice = item.unit_price_cents;
    if (!description) throw new Error(`items[${index}].description cannot be blank`);
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`items[${index}].quantity must be greater than zero`);
    }
    if (!Number.isSafeInteger(unitPrice) || (unitPrice as number) < 0) {
      throw new Error(`items[${index}].unit_price_cents must be a non-negative integer`);
    }
    return { description, quantity, unit_price_cents: unitPrice as number };
  });
}

async function checkedClient(env: Bindings, id: number) {
  const client = await getClient(env.DB, id);
  if (!client) throw new Error(`client ${id} not found`);
  return client;
}

async function checkedInvoice(env: Bindings, id: number) {
  const invoice = await getInvoice(env.DB, id);
  if (!invoice) throw new Error(`invoice ${id} not found`);
  return invoice;
}

async function invoiceDetail(env: Bindings, id: number): Promise<JsonObject> {
  const invoice = await checkedInvoice(env, id);
  const [items, payments, events] = await Promise.all([
    getInvoiceItems(env.DB, id),
    getPayments(env.DB, id),
    getInvoiceEvents(env.DB, id),
  ]);
  return {
    invoice,
    items,
    payments,
    events,
    pay_url: `${env.APP_BASE_URL}/pay/${invoice.public_token}`,
  };
}

const clientFields = {
  name: string('Client name'),
  email: nullableString('Email address, or null'),
  address: nullableString('Postal address, or null'),
  default_rate_cents: { type: ['integer', 'null'], minimum: 0, description: 'Default hourly/unit rate, or null to inherit' },
  payment_terms_days: { type: ['integer', 'null'], minimum: 0, description: 'Payment terms, or null to inherit' },
  locale: nullableString('BCP-47 locale, or null to inherit'),
};

const invoiceFields = {
  client_id: integer('Client ID', { minimum: 1 }),
  issue_date: string('Issue date (YYYY-MM-DD)', { format: 'date' }),
  due_date: nullableString('Due date (YYYY-MM-DD), or null'),
  subject: nullableString('Invoice subject, or null'),
  notes: nullableString('Customer-visible notes, or null'),
  currency: string('Three-letter supported currency code'),
  items: { type: 'array', minItems: 1, items: invoiceItemSchema() },
};

const tools: Tool[] = [
  {
    name: 'get_settings', title: 'Get settings', description: 'Get business settings. Secret values are never returned.',
    inputSchema: objectSchema({}), annotations: { readOnlyHint: true },
    run: async (_args, env) => publicSettings(await getSettings(env.DB)),
  },
  {
    name: 'update_settings', title: 'Update settings', description: 'Update ordinary business, locale, numbering, tax, email, and reminder settings. Omitted fields stay unchanged.',
    inputSchema: objectSchema({
      business_name: string('Business name'), business_address: string('Business address'), business_email: nullableString('Business email'),
      logo_url: nullableString('External logo URL'), currency: string('Default currency code'), tax_rate_bps: integer('Tax rate in basis points', { minimum: 0 }),
      invoice_prefix: string('Invoice number prefix'), default_rate_cents: integer('Default rate in hundredths', { minimum: 0 }),
      timezone: string('IANA timezone'), locale: string('BCP-47 locale'), accent_color: string('Six-digit hex color'),
      email_provider: { type: 'string', enum: ['cloudflare', 'resend', 'none'] }, email_from: string('From email address'),
      payment_terms_days: integer('Default payment terms', { minimum: 0 }), reminders_enabled: boolean('Whether overdue reminders run'),
      reminder_schedule: string('Comma-separated days overdue, such as 1,7,14'), confirm: boolean('Confirms settings changes'),
    }, ['confirm']), annotations: { destructiveHint: true },
    run: async (args, env) => {
      requireConfirmation(args, 'Changing business settings affects future documents and messages.');
      const current = await getSettings(env.DB);
      const currency = (textArg(args, 'currency') ?? current.currency).toUpperCase();
      const timezone = textArg(args, 'timezone') ?? current.timezone;
      const locale = textArg(args, 'locale') ?? current.locale;
      const accent = textArg(args, 'accent_color') ?? current.accent_color;
      if (!isSupportedCurrency(currency)) throw new Error(`currency ${currency} is not supported`);
      if (!isValidTimezone(timezone)) throw new Error(`timezone ${timezone} is not valid`);
      if (!validLocaleTag(locale)) throw new Error(`locale ${locale} is not valid`);
      if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw new Error('accent_color must be a six-digit hex color');
      const emailProvider = textArg(args, 'email_provider') ?? current.email_provider;
      if (!['cloudflare', 'resend', 'none'].includes(emailProvider)) throw new Error('email_provider is invalid');
      const schedule = textArg(args, 'reminder_schedule') ?? current.reminder_schedule;
      if (!/^\s*\d+\s*(,\s*\d+\s*)*$/.test(schedule)) throw new Error('reminder_schedule must be comma-separated non-negative days');
      const taxRate = nonNegativeIntArg(args, 'tax_rate_bps') ?? current.tax_rate_bps;
      const defaultRate = nonNegativeIntArg(args, 'default_rate_cents') ?? current.default_rate_cents;
      const paymentTerms = nonNegativeIntArg(args, 'payment_terms_days') ?? current.payment_terms_days;
      await updateSettings(env.DB, {
        business_name: textArg(args, 'business_name') ?? current.business_name,
        business_address: textArg(args, 'business_address') ?? current.business_address,
        business_email: nullableTextArg(args, 'business_email') === undefined ? current.business_email : nullableTextArg(args, 'business_email')!,
        logo_url: nullableTextArg(args, 'logo_url') === undefined ? current.logo_url : nullableTextArg(args, 'logo_url')!,
        currency, tax_rate_bps: taxRate,
        invoice_prefix: textArg(args, 'invoice_prefix') ?? current.invoice_prefix,
        default_rate_cents: defaultRate,
        timezone, locale, accent_color: accent,
        email_provider: emailProvider as typeof current.email_provider,
        email_from: textArg(args, 'email_from') ?? current.email_from,
        payment_terms_days: paymentTerms,
      });
      if ('reminders_enabled' in args || 'reminder_schedule' in args) {
        await env.DB.prepare('UPDATE settings SET reminders_enabled = ?, reminder_schedule = ? WHERE id = 1')
          .bind(boolArg(args, 'reminders_enabled', !!current.reminders_enabled) ? 1 : 0, schedule).run();
      }
      return publicSettings(await getSettings(env.DB));
    },
  },
  {
    name: 'list_clients', title: 'List clients', description: 'List clients, optionally including archived clients.',
    inputSchema: objectSchema({ include_archived: boolean('Include archived clients') }), annotations: { readOnlyHint: true },
    run: async (args, env) => ({ clients: await listClients(env.DB, boolArg(args, 'include_archived')) }),
  },
  {
    name: 'get_client', title: 'Get client', description: 'Get a client by numeric ID.',
    inputSchema: objectSchema({ id: integer('Client ID', { minimum: 1 }) }, ['id']), annotations: { readOnlyHint: true },
    run: async (args, env) => ({ client: await checkedClient(env, idArg(args)) }),
  },
  {
    name: 'create_client', title: 'Create client', description: 'Create a client.',
    inputSchema: objectSchema(clientFields, ['name']), annotations: { idempotentHint: false },
    run: async (args, env) => {
      const name = textArg(args, 'name', true)!.trim();
      if (!name) throw new Error('name cannot be blank');
      const locale = nullableTextArg(args, 'locale') ?? null;
      if (locale && !validLocaleTag(locale)) throw new Error('locale is not valid');
      const defaultRate = nonNegativeIntArg(args, 'default_rate_cents', true);
      const paymentTerms = nonNegativeIntArg(args, 'payment_terms_days', true);
      const id = await createClient(env.DB, {
        name, email: nullableTextArg(args, 'email') ?? null, address: nullableTextArg(args, 'address') ?? null,
        default_rate_cents: defaultRate ?? null,
        payment_terms_days: paymentTerms ?? null, locale,
      });
      return { client: await checkedClient(env, id) };
    },
  },
  {
    name: 'update_client', title: 'Update client', description: 'Update or archive a client. Omitted fields stay unchanged.',
    inputSchema: objectSchema({ id: integer('Client ID', { minimum: 1 }), ...clientFields, archived: boolean('Archive the client') }, ['id']),
    run: async (args, env) => {
      const id = idArg(args); const current = await checkedClient(env, id);
      const locale = nullableTextArg(args, 'locale');
      if (locale && !validLocaleTag(locale)) throw new Error('locale is not valid');
      const defaultRate = nonNegativeIntArg(args, 'default_rate_cents', true);
      const paymentTerms = nonNegativeIntArg(args, 'payment_terms_days', true);
      await updateClient(env.DB, id, {
        name: textArg(args, 'name')?.trim() || current.name,
        email: nullableTextArg(args, 'email') === undefined ? current.email : nullableTextArg(args, 'email')!,
        address: nullableTextArg(args, 'address') === undefined ? current.address : nullableTextArg(args, 'address')!,
        archived: boolArg(args, 'archived', !!current.archived) ? 1 : 0,
        default_rate_cents: defaultRate === undefined ? current.default_rate_cents : defaultRate,
        payment_terms_days: paymentTerms === undefined ? current.payment_terms_days : paymentTerms,
        locale: locale === undefined ? current.locale : locale,
      });
      return { client: await checkedClient(env, id) };
    },
  },
  {
    name: 'list_invoices', title: 'List invoices', description: 'List invoices with optional status and client filters.',
    inputSchema: objectSchema({ status: { type: 'string', enum: ['draft', 'sent', 'paid', 'void'] }, client_id: integer('Client ID', { minimum: 1 }) }),
    annotations: { readOnlyHint: true },
    run: async (args, env) => {
      const status = textArg(args, 'status'); const clientId = intArg(args, 'client_id');
      if (status && !['draft', 'sent', 'paid', 'void'].includes(status)) throw new Error('status is invalid');
      const invoices = (await listInvoices(env.DB)).filter((invoice) => (!status || invoice.status === status) && (!clientId || invoice.client_id === clientId));
      return { invoices };
    },
  },
  {
    name: 'get_invoice', title: 'Get invoice', description: 'Get an invoice with line items, payments, history, and pay URL.',
    inputSchema: objectSchema({ id: integer('Invoice ID', { minimum: 1 }) }, ['id']), annotations: { readOnlyHint: true },
    run: async (args, env) => invoiceDetail(env, idArg(args)),
  },
  {
    name: 'create_invoice', title: 'Create invoice', description: 'Create a draft invoice with integer-hundredth prices.',
    inputSchema: objectSchema({ ...invoiceFields, number: string('Optional custom invoice number') }, ['client_id', 'issue_date', 'items']),
    run: async (args, env) => {
      const clientId = idArg(args, 'client_id'); await checkedClient(env, clientId);
      const issueDate = isoDate(textArg(args, 'issue_date', true), 'issue_date', true)!;
      const dueDate = nullableTextArg(args, 'due_date'); if (dueDate) isoDate(dueDate, 'due_date');
      const currency = textArg(args, 'currency')?.toUpperCase(); if (currency && !isSupportedCurrency(currency)) throw new Error(`currency ${currency} is not supported`);
      const customNumber = textArg(args, 'number')?.trim() || undefined;
      if (customNumber && await invoiceNumberExists(env.DB, customNumber)) throw new Error(`invoice number ${customNumber} is already in use`);
      const id = await createInvoice(env.DB, {
        client_id: clientId, issue_date: issueDate, due_date: dueDate ?? null,
        subject: nullableTextArg(args, 'subject') ?? null, notes: nullableTextArg(args, 'notes') ?? null,
        currency, items: parseItems(args),
      }, customNumber);
      return invoiceDetail(env, id);
    },
  },
  {
    name: 'update_invoice', title: 'Update invoice', description: 'Replace the editable header and line items of a draft or sent invoice.',
    inputSchema: objectSchema({ id: integer('Invoice ID', { minimum: 1 }), ...invoiceFields }, ['id', 'issue_date', 'items']),
    run: async (args, env) => {
      const id = idArg(args); const current = await checkedInvoice(env, id);
      if (!['draft', 'sent'].includes(current.status)) throw new Error('only draft or sent invoices can be edited');
      const clientId = intArg(args, 'client_id') ?? current.client_id; await checkedClient(env, clientId);
      const issueDate = isoDate(textArg(args, 'issue_date', true), 'issue_date', true)!;
      const dueDate = nullableTextArg(args, 'due_date'); if (dueDate) isoDate(dueDate, 'due_date');
      const currency = (textArg(args, 'currency') ?? current.currency).toUpperCase(); if (!isSupportedCurrency(currency)) throw new Error(`currency ${currency} is not supported`);
      await updateInvoice(env.DB, id, {
        client_id: clientId, issue_date: issueDate, due_date: dueDate === undefined ? current.due_date : dueDate,
        subject: nullableTextArg(args, 'subject') === undefined ? current.subject : nullableTextArg(args, 'subject')!,
        notes: nullableTextArg(args, 'notes') === undefined ? current.notes : nullableTextArg(args, 'notes')!,
        currency, items: parseItems(args),
      });
      await logInvoiceEvent(env.DB, id, 'edited', 'Updated through MCP');
      return invoiceDetail(env, id);
    },
  },
  {
    name: 'duplicate_invoice', title: 'Duplicate invoice', description: 'Create a new draft from an existing invoice.',
    inputSchema: objectSchema({ id: integer('Source invoice ID', { minimum: 1 }) }, ['id']),
    run: async (args, env) => {
      const source = await checkedInvoice(env, idArg(args));
      const [items, settings, client] = await Promise.all([getInvoiceItems(env.DB, source.id), getSettings(env.DB), getClient(env.DB, source.client_id)]);
      const today = todayInTz(settings.timezone); const terms = client?.payment_terms_days ?? settings.payment_terms_days;
      const id = await createInvoice(env.DB, {
        client_id: source.client_id, issue_date: today, due_date: terms > 0 ? addDaysISO(today, terms) : null,
        subject: source.subject, notes: source.notes, currency: source.currency,
        items: items.map(({ description, quantity, unit_price_cents }) => ({ description, quantity, unit_price_cents })),
      });
      await logInvoiceEvent(env.DB, id, 'duplicated', `Duplicated from ${source.number} through MCP`);
      return invoiceDetail(env, id);
    },
  },
  {
    name: 'send_invoice', title: 'Send invoice', description: 'Mark an invoice sent, optionally emailing the client with its PDF. Email is an external side effect.',
    inputSchema: objectSchema({ id: integer('Invoice ID', { minimum: 1 }), email: boolean('Email the invoice'), sent_date: string('Optional backdate (YYYY-MM-DD)', { format: 'date' }), confirm: boolean('Confirms the status change and optional email') }, ['id', 'confirm']),
    annotations: { destructiveHint: true },
    run: async (args, env) => {
      requireConfirmation(args, 'Sending changes invoice state and may email the client.');
      const id = idArg(args); const invoice = await checkedInvoice(env, id);
      if (!['draft', 'sent'].includes(invoice.status)) throw new Error('only draft or sent invoices can be sent');
      const sentDate = isoDate(textArg(args, 'sent_date'), 'sent_date');
      if (boolArg(args, 'email')) {
        if (!invoice.client_email) throw new Error('client has no email address');
        const [items, settings, logo] = await Promise.all([getInvoiceItems(env.DB, id), getSettings(env.DB), getLogo(env.DB)]);
        const pdf = await generateInvoicePdf(invoice, items, settings, undefined, env.ASSETS, logo);
        await sendInvoiceEmail(env, invoice, settings, pdf);
        await logInvoiceEvent(env.DB, id, 'emailed', `Invoice emailed to ${invoice.client_email} through MCP`);
      }
      await markInvoiceSent(env.DB, id, sentDate);
      if (invoice.status === 'draft') await logInvoiceEvent(env.DB, id, 'sent', sentDate ? `Dated ${sentDate}` : 'Sent through MCP');
      return invoiceDetail(env, id);
    },
  },
  {
    name: 'unsend_invoice', title: 'Revert invoice to draft', description: 'Revert a sent invoice to draft.',
    inputSchema: objectSchema({ id: integer('Invoice ID', { minimum: 1 }), confirm: boolean('Confirms the status change') }, ['id', 'confirm']), annotations: { destructiveHint: true },
    run: async (args, env) => { requireConfirmation(args, 'This reopens the invoice as a draft.'); const id = idArg(args); const invoice = await checkedInvoice(env, id); if (invoice.status !== 'sent') throw new Error('only a sent invoice can be reverted'); await markInvoiceUnsent(env.DB, id); await logInvoiceEvent(env.DB, id, 'unsent', 'Reverted through MCP'); return invoiceDetail(env, id); },
  },
  {
    name: 'void_invoice', title: 'Void invoice', description: 'Void a draft or sent invoice.',
    inputSchema: objectSchema({ id: integer('Invoice ID', { minimum: 1 }), confirm: boolean('Confirms voiding') }, ['id', 'confirm']), annotations: { destructiveHint: true },
    run: async (args, env) => { requireConfirmation(args, 'Voiding makes this invoice unpayable.'); const id = idArg(args); const invoice = await checkedInvoice(env, id); if (!['draft', 'sent'].includes(invoice.status)) throw new Error('only draft or sent invoices can be voided'); await setInvoiceStatus(env.DB, id, 'void'); await logInvoiceEvent(env.DB, id, 'voided', 'Voided through MCP'); return invoiceDetail(env, id); },
  },
  {
    name: 'delete_invoice', title: 'Delete invoice', description: 'Permanently delete an invoice and its payment records. This never refunds providers.',
    inputSchema: objectSchema({ id: integer('Invoice ID', { minimum: 1 }), confirm: boolean('Confirms permanent deletion') }, ['id', 'confirm']), annotations: { destructiveHint: true },
    run: async (args, env) => { requireConfirmation(args, 'This permanently erases the invoice and payment records and cannot be undone.'); const invoice = await checkedInvoice(env, idArg(args)); await deleteInvoice(env.DB, invoice.id); return { deleted: true, id: invoice.id, number: invoice.number }; },
  },
  {
    name: 'list_payments', title: 'List payments', description: 'List payments across invoices, optionally filtered by client or invoice.',
    inputSchema: objectSchema({ client_id: integer('Client ID', { minimum: 1 }), invoice_id: integer('Invoice ID', { minimum: 1 }) }), annotations: { readOnlyHint: true },
    run: async (args, env) => { const clientId = intArg(args, 'client_id') ?? null; const invoiceId = intArg(args, 'invoice_id'); const payments = invoiceId ? await getPayments(env.DB, invoiceId) : await listAllPayments(env.DB, clientId); return { payments }; },
  },
  {
    name: 'record_manual_payment', title: 'Record manual payment', description: 'Record the invoice total as a manual payment and mark the invoice paid.',
    inputSchema: objectSchema({ id: integer('Invoice ID', { minimum: 1 }), note: string('Payment note'), payment_date: string('Optional payment date (YYYY-MM-DD)', { format: 'date' }), confirm: boolean('Confirms recording money received') }, ['id', 'confirm']), annotations: { destructiveHint: true },
    run: async (args, env) => { requireConfirmation(args, 'This records money received and changes the books.'); const invoice = await checkedInvoice(env, idArg(args)); if (!['draft', 'sent'].includes(invoice.status)) throw new Error('only draft or sent invoices can be marked paid'); const paidDate = isoDate(textArg(args, 'payment_date'), 'payment_date'); await recordManualPayment(env.DB, invoice, { note: textArg(args, 'note')?.trim() || undefined, paidDate }); return invoiceDetail(env, invoice.id); },
  },
  {
    name: 'undo_payment', title: 'Undo payment', description: 'Soft-undo a payment in the books. This never refunds a provider payment.',
    inputSchema: objectSchema({ invoice_id: integer('Invoice ID', { minimum: 1 }), payment_id: integer('Payment ID', { minimum: 1 }), confirm: boolean('Confirms the bookkeeping correction') }, ['invoice_id', 'payment_id', 'confirm']), annotations: { destructiveHint: true },
    run: async (args, env) => { requireConfirmation(args, 'This removes the payment from totals but does not refund it at the provider.'); const invoiceId = idArg(args, 'invoice_id'); await checkedInvoice(env, invoiceId); const updated = await undoPayment(env.DB, invoiceId, idArg(args, 'payment_id'), formatCents); if (!updated) throw new Error('active payment not found'); return invoiceDetail(env, invoiceId); },
  },
  {
    name: 'update_payment_note', title: 'Update payment note', description: 'Edit or clear the note on an active payment.',
    inputSchema: objectSchema({ invoice_id: integer('Invoice ID', { minimum: 1 }), payment_id: integer('Payment ID', { minimum: 1 }), note: nullableString('New note, or null to clear') }, ['invoice_id', 'payment_id', 'note']),
    run: async (args, env) => { const invoiceId = idArg(args, 'invoice_id'); const note = nullableTextArg(args, 'note') ?? null; const updated = await updatePaymentNote(env.DB, invoiceId, idArg(args, 'payment_id'), note); if (!updated) throw new Error('active payment not found'); await logInvoiceEvent(env.DB, invoiceId, 'payment_note_edited', note ?? 'Note cleared through MCP'); return invoiceDetail(env, invoiceId); },
  },
  {
    name: 'get_reports', title: 'Get reports', description: 'Get monthly invoiced/received totals and the current summary, grouped by currency.',
    inputSchema: objectSchema({ client_id: integer('Optional client ID', { minimum: 1 }) }), annotations: { readOnlyHint: true },
    run: async (args, env) => { const clientId = intArg(args, 'client_id') ?? null; const settings = await getSettings(env.DB); const today = todayInTz(settings.timezone); const [monthly, summary] = await Promise.all([monthlyReport(env.DB, clientId), reportSummary(env.DB, today, clientId)]); return { as_of: today, summary, monthly }; },
  },
];

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

function jsonResult(value: unknown): ToolResult {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : { result: value };
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonObject { return { jsonrpc: '2.0', id, result }; }
function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonObject {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function resourceContents(uri: string, env: Bindings) {
  if (uri === 'minvoice://settings') return publicSettings(await getSettings(env.DB));
  if (uri === 'minvoice://clients') return { clients: await listClients(env.DB, true) };
  if (uri === 'minvoice://invoices') return { invoices: await listInvoices(env.DB) };
  if (uri === 'minvoice://reports') {
    const settings = await getSettings(env.DB); const today = todayInTz(settings.timezone);
    return { as_of: today, summary: await reportSummary(env.DB, today), monthly: await monthlyReport(env.DB) };
  }
  const client = /^minvoice:\/\/clients\/(\d+)$/.exec(uri);
  if (client) return { client: await checkedClient(env, Number(client[1])) };
  const invoice = /^minvoice:\/\/invoices\/(\d+)$/.exec(uri);
  if (invoice) return invoiceDetail(env, Number(invoice[1]));
  throw new Error(`resource ${uri} not found`);
}

async function dispatch(value: unknown, env: Bindings, scopes: Set<string>): Promise<JsonObject | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return rpcError(null, -32600, 'Invalid Request');
  const request = value as JsonRpcRequest;
  const id = request.id ?? null;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  if (request.method.startsWith('notifications/')) return null;
  try {
    switch (request.method) {
      case 'initialize': {
        const params = argsObject(request.params); const requested = textArg(params, 'protocolVersion');
        const protocolVersion = requested && SUPPORTED_PROTOCOLS.includes(requested as typeof SUPPORTED_PROTOCOLS[number]) ? requested : SUPPORTED_PROTOCOLS[0];
        return rpcResult(id, { protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'minvoice', title: 'Minvoice', version: SERVER_VERSION }, instructions: 'Manage the complete Minvoice workflow. Amounts are integer hundredths and reports never combine currencies. Tools with external, financial, or destructive effects require confirm=true only after explicit user approval.' });
      }
      case 'ping': return rpcResult(id, {});
      case 'tools/list': return rpcResult(id, { tools: tools
        .filter((tool) => tool.annotations?.readOnlyHint === true ? scopes.has(MCP_READ_SCOPE) : scopes.has(MCP_WRITE_SCOPE))
        .map(({ run: _run, ...tool }) => tool) });
      case 'tools/call': {
        const params = argsObject(request.params); const name = textArg(params, 'name', true)!; const tool = toolMap.get(name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
        const requiredScope = tool.annotations?.readOnlyHint === true ? MCP_READ_SCOPE : MCP_WRITE_SCOPE;
        if (!scopes.has(requiredScope)) return rpcResult(id, {
          content: [{ type: 'text', text: `This tool requires the ${requiredScope} OAuth scope. Reconnect and approve that scope.` }],
          isError: true,
        });
        try { return rpcResult(id, jsonResult(await tool.run(argsObject(params.arguments), env))); }
        catch (error) { return rpcResult(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }); }
      }
      case 'resources/list': {
        if (!scopes.has(MCP_READ_SCOPE)) return rpcError(id, -32602, `This method requires the ${MCP_READ_SCOPE} scope`);
        return rpcResult(id, { resources: [
        { uri: 'minvoice://settings', name: 'Business settings', mimeType: 'application/json' },
        { uri: 'minvoice://clients', name: 'Clients', mimeType: 'application/json' },
        { uri: 'minvoice://invoices', name: 'Invoices', mimeType: 'application/json' },
        { uri: 'minvoice://reports', name: 'Reports', mimeType: 'application/json' },
      ] });
      }
      case 'resources/templates/list': {
        if (!scopes.has(MCP_READ_SCOPE)) return rpcError(id, -32602, `This method requires the ${MCP_READ_SCOPE} scope`);
        return rpcResult(id, { resourceTemplates: [
        { uriTemplate: 'minvoice://clients/{id}', name: 'Client', mimeType: 'application/json' },
        { uriTemplate: 'minvoice://invoices/{id}', name: 'Invoice detail', mimeType: 'application/json' },
      ] });
      }
      case 'resources/read': {
        if (!scopes.has(MCP_READ_SCOPE)) return rpcError(id, -32602, `This method requires the ${MCP_READ_SCOPE} scope`);
        const uri = textArg(argsObject(request.params), 'uri', true)!; const value = await resourceContents(uri, env);
        return rpcResult(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] });
      }
      case 'prompts/list': {
        if (!scopes.has(MCP_READ_SCOPE)) return rpcError(id, -32602, `This method requires the ${MCP_READ_SCOPE} scope`);
        return rpcResult(id, { prompts: [
        { name: 'draft_invoice', title: 'Draft an invoice', description: 'Gather details and create a draft invoice', arguments: [{ name: 'request', description: 'What should be invoiced', required: true }] },
        { name: 'review_receivables', title: 'Review receivables', description: 'Review outstanding and overdue invoices' },
        { name: 'reconcile_payment', title: 'Reconcile a payment', description: 'Inspect an invoice and safely correct its payment record', arguments: [{ name: 'invoice_id', description: 'Invoice ID', required: true }] },
      ] });
      }
      case 'prompts/get': {
        if (!scopes.has(MCP_READ_SCOPE)) return rpcError(id, -32602, `This method requires the ${MCP_READ_SCOPE} scope`);
        const params = argsObject(request.params); const name = textArg(params, 'name', true)!; const promptArgs = argsObject(params.arguments);
        if (name === 'draft_invoice') return rpcResult(id, { description: 'Create a complete draft without sending it', messages: [{ role: 'user', content: { type: 'text', text: `Prepare a Minvoice draft for this request: ${textArg(promptArgs, 'request', true)}. Resolve the client first, use integer hundredths for prices, show the proposed invoice, then call create_invoice. Do not send it.` } }] });
        if (name === 'review_receivables') return rpcResult(id, { description: 'Review money owed', messages: [{ role: 'user', content: { type: 'text', text: 'Use get_reports and list_invoices to summarize outstanding and overdue receivables by currency. Never add different currencies together. Recommend follow-up actions but do not send or mutate anything.' } }] });
        if (name === 'reconcile_payment') return rpcResult(id, { description: 'Safely reconcile a payment', messages: [{ role: 'user', content: { type: 'text', text: `Inspect invoice ${intArg(promptArgs, 'invoice_id', true)} and its payments. Explain any mismatch and ask for explicit approval before recording or undoing a payment. Provider refunds happen outside Minvoice.` } }] });
        return rpcError(id, -32602, `Unknown prompt: ${name}`);
      }
      default: return rpcError(id, -32601, 'Method not found');
    }
  } catch (error) {
    return rpcError(id, -32602, error instanceof Error ? error.message : String(error));
  }
}

function responseHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra); headers.set('Cache-Control', 'no-store'); headers.set('X-Robots-Tag', 'noindex');
  return headers;
}

export async function handleMcpRequest(request: Request, env: Bindings): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return new Response('Forbidden', { status: 403, headers: responseHeaders() });
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders() });
  const authorization = await authorizeMcpRequest(request, env);
  if (!authorization.authorized) {
    return new Response('Unauthorized', {
      status: 401,
      headers: responseHeaders({ 'WWW-Authenticate': authorization.challenge }),
    });
  }
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: responseHeaders({ Allow: 'POST, OPTIONS' }) });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return new Response(JSON.stringify(rpcError(null, -32600, 'Content-Type must be application/json')), { status: 415, headers: responseHeaders({ 'Content-Type': 'application/json' }) });
  }
  let body: unknown;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error')), {
      status: 400,
      headers: responseHeaders({ 'Content-Type': 'application/json' }),
    });
  }
  const requests = Array.isArray(body) ? body : [body];
  if (requests.length === 0) return new Response(JSON.stringify(rpcError(null, -32600, 'Invalid Request')), { status: 400, headers: responseHeaders({ 'Content-Type': 'application/json' }) });
  const missingScope = requests.map((value): string | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const rpc = value as JsonRpcRequest;
    if (rpc.method === 'resources/list' || rpc.method === 'resources/templates/list'
        || rpc.method === 'resources/read' || rpc.method === 'prompts/list' || rpc.method === 'prompts/get') {
      return authorization.scopes.has(MCP_READ_SCOPE) ? null : MCP_READ_SCOPE;
    }
    if (rpc.method !== 'tools/call') return null;
    try {
      const params = argsObject(rpc.params);
      const tool = toolMap.get(textArg(params, 'name', true)!);
      if (!tool) return null;
      const required = tool.annotations?.readOnlyHint === true ? MCP_READ_SCOPE : MCP_WRITE_SCOPE;
      return authorization.scopes.has(required) ? null : required;
    } catch {
      return null;
    }
  }).find((scope): scope is string => scope !== null);
  if (missingScope) {
    const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
    return new Response('Insufficient scope', {
      status: 403,
      headers: responseHeaders({
        'WWW-Authenticate': `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="${missingScope}"`,
      }),
    });
  }
  const results = (await Promise.all(requests.map(async (value) => {
    const result = await dispatch(value, env, authorization.scopes);
    const isNotification = !!value && typeof value === 'object' && !Array.isArray(value)
      && (value as JsonRpcRequest).jsonrpc === '2.0' && typeof (value as JsonRpcRequest).method === 'string'
      && !Object.prototype.hasOwnProperty.call(value, 'id');
    return isNotification ? null : result;
  }))).filter((value): value is JsonObject => value !== null);
  if (!results.length) return new Response(null, { status: 202, headers: responseHeaders() });
  return new Response(JSON.stringify(Array.isArray(body) ? results : results[0]), { headers: responseHeaders({ 'Content-Type': 'application/json' }) });
}
