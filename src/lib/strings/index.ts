/**
 * Customer-facing strings, one typed object per language. The admin UI stays
 * English; this covers everything a CLIENT sees: the public pay page, the
 * print view, the PDF, and the four outbound email templates.
 *
 * Design notes:
 * - Interpolations are plain functions, so word order is free per language
 *   and completeness is enforced by the compiler — a locale missing a key
 *   fails `tsc`, not a customer.
 * - The settings/client `locale` value is a BCP-47 tag. Its language part
 *   picks the strings; the FULL tag drives Intl date/number formatting, so
 *   'de-AT' gets German strings with Austrian formatting. Unknown languages
 *   fall back to English strings while keeping the tag's formatting.
 * - Adding a language = one new file implementing `Strings` + one registry
 *   entry. Latin-script languages work everywhere today; the PDF fonts
 *   (Noto Sans/Serif) also cover Greek and Cyrillic. RTL and Indic scripts
 *   need text shaping the PDF layer doesn't have — see README.
 */

export type Strings = {
  // Shared labels (pay page, print view, PDF)
  invoice: string;
  billedTo: string;
  issued: string;
  due: string;
  paid: string;
  description: string;
  qty: string;
  unitPrice: string;
  amount: string;
  subtotal: string;
  tax: string;
  total: string;
  notes: string;
  subject: string; // PDF label above the invoice subject line
  statusPaid: string; // badge + stamp
  statusVoid: string;
  payOnline: string; // PDF footer prefix before the pay link
  footerThanks: (business: string | null) => string; // PDF footer when not payable

  // Pay page
  print: string;
  downloadPdf: string;
  viewOnline: string;
  paymentConfirming: string;
  paymentUnderReview: string;
  invoicePaid: string;
  invoicePaidThanks: string;
  invoiceVoided: string;
  draftHoldTitle: string;
  draftHoldBody: (business: string, number: string) => string;
  payWithCard: string;
  payWithPaypal: string;
  trustLine: string;
  trustCardsPrefix: string; // "Cards are processed by" (Stripe name follows)
  trustPaypal: string;
  noOnlinePayment: (contactEmail: string | null) => string;

  // Invoice email
  emailInvoiceSubject: (number: string, business: string, subject: string | null, total: string) => string;
  greeting: (name: string) => string;
  emailInvoiceBody: (business: string, number: string, total: string, dueDate: string | null) => string;
  viewAndPay: string;
  pdfAttached: string;
  viewAndPayButton: string;
  orCopyLink: string;

  // Reminder email
  reminderSubject: (number: string, subject: string | null, total: string, dueDate: string) => string;
  reminderTitle: string;
  reminderBody: (number: string, subject: string | null, total: string, dueDate: string) => string;
  reminderDisregard: string;

  // Receipt email
  receiptSubject: (number: string) => string;
  receiptBody: (amount: string, number: string) => string;
  receiptView: string;
};

import { en } from './en';
import { es } from './es';
import { de } from './de';
import { fr } from './fr';

const LOCALES: Record<string, Strings> = { en, es, de, fr };

/** Language tags with built-in strings (used by the admin locale selects). */
export const SUPPORTED_LOCALES = [
  { tag: 'en', label: 'English' },
  { tag: 'es', label: 'Español' },
  { tag: 'de', label: 'Deutsch' },
  { tag: 'fr', label: 'Français' },
] as const;

/**
 * The admin dropdowns: each built-in language plus common regional variants
 * (same strings, region-specific date/number formatting). Purely a UI list —
 * any valid BCP-47 tag still works if set another way, and forks adding a
 * language extend this alongside LOCALES.
 */
export const LOCALE_OPTIONS: { tag: string; label: string }[] = [
  { tag: 'en', label: 'English (US formats)' },
  { tag: 'en-GB', label: 'English (UK formats)' },
  { tag: 'en-CA', label: 'English (Canada formats)' },
  { tag: 'en-AU', label: 'English (Australia formats)' },
  { tag: 'es', label: 'Español (España)' },
  { tag: 'es-MX', label: 'Español (México)' },
  { tag: 'es-AR', label: 'Español (Argentina)' },
  { tag: 'de', label: 'Deutsch (Deutschland)' },
  { tag: 'de-AT', label: 'Deutsch (Österreich)' },
  { tag: 'de-CH', label: 'Deutsch (Schweiz)' },
  { tag: 'fr', label: 'Français (France)' },
  { tag: 'fr-CA', label: 'Français (Canada)' },
  { tag: 'fr-CH', label: 'Français (Suisse)' },
  { tag: 'fr-BE', label: 'Français (Belgique)' },
];

/** Strings for a BCP-47 tag ('de', 'de-AT', 'fr-CA'…); English fallback. */
export function getStrings(tag: string): Strings {
  return LOCALES[(tag || 'en').toLowerCase().split('-')[0]] ?? en;
}

/** The locale a given client should see: their override, else the business default. */
export function resolveLocale(settingsLocale: string, clientLocale?: string | null): string {
  return (clientLocale ?? '').trim() || settingsLocale || 'en';
}

/** Customer-facing date: ISO 'YYYY-MM-DD' → localized medium date ('18.07.2026', 'Jul 18, 2026'). */
export function formatDateTag(iso: string, tag: string): string {
  try {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return new Intl.DateTimeFormat(tag || 'en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(Date.UTC(y, m - 1, d))
    );
  } catch {
    return iso; // unknown tag or malformed date: show the ISO string rather than throw
  }
}

/** Customer-facing money: cents → localized currency string ('1.234,56 €', '$1,234.56'). */
export function formatCentsTag(cents: number, currency: string, tag: string): string {
  try {
    return new Intl.NumberFormat(tag || 'en', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  }
}
