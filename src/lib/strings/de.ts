import type { Strings } from './index';

// German (Sie form). Tax is labeled "USt." — businesses preferring "MwSt."
// can edit this file; that's the supported customization path.
export const de: Strings = {
  invoice: 'Rechnung',
  billedTo: 'Rechnung an',
  issued: 'Rechnungsdatum',
  due: 'Fällig am',
  paid: 'Bezahlt',
  description: 'Beschreibung',
  qty: 'Menge',
  unitPrice: 'Einzelpreis',
  amount: 'Betrag',
  subtotal: 'Zwischensumme',
  tax: 'USt.',
  total: 'Gesamtbetrag',
  notes: 'Anmerkungen',
  subject: 'Betreff',
  statusPaid: 'BEZAHLT',
  statusVoid: 'STORNIERT',
  payOnline: 'Online bezahlen:',
  footerThanks: (business) => (business ? `${business} — vielen Dank für Ihr Vertrauen.` : 'Vielen Dank für Ihr Vertrauen.'),

  print: 'Drucken',
  downloadPdf: 'PDF herunterladen',
  viewOnline: 'Online ansehen',
  paymentConfirming: 'Vielen Dank! Ihre Zahlung wird bestätigt — diese Seite zeigt sie in Kürze an.',
  paymentUnderReview: 'Für diese Rechnung ist bereits eine Zahlung eingegangen und wird geprüft — bitte zahlen Sie nicht erneut. Bei Fragen kontaktieren Sie uns.',
  invoicePaid: 'Diese Rechnung wurde bezahlt.',
  invoicePaidThanks: 'Diese Rechnung wurde bezahlt — vielen Dank!',
  invoiceVoided: 'Diese Rechnung wurde storniert.',
  draftHoldTitle: 'Diese Rechnung ist noch nicht fertig',
  draftHoldBody: (business, number) =>
    `${business} bereitet die Rechnung ${number} noch vor. Dieser Link zeigt die Rechnung an, sobald sie fertiggestellt ist — schauen Sie in Kürze wieder vorbei.`,
  payWithCard: 'Mit Karte zahlen',
  payWithPaypal: 'Mit PayPal zahlen',
  trustLine: 'Zahlungen sind sicher und verschlüsselt — Kartendaten erreichen diese Seite nie.',
  trustCardsPrefix: 'Kartenzahlungen werden abgewickelt über',
  trustPaypal: 'PayPal-Zahlungen werden zum Abschluss zu paypal.com weitergeleitet.',
  noOnlinePayment: (email) =>
    `Online-Zahlung ist für diese Rechnung nicht verfügbar${email ? ` — bitte kontaktieren Sie ${email}` : ''}.`,

  emailInvoiceSubject: (number, business, subject, total) =>
    subject
      ? `Rechnung ${number} von ${business} — ${subject} — ${total}`
      : `Rechnung ${number} von ${business} — ${total}`,
  greeting: (name) => `Guten Tag ${name},`,
  emailInvoiceBody: (business, number, total, dueDate) =>
    `${business} hat Ihnen die Rechnung ${number} über ${total} gesendet${dueDate ? `, fällig am ${dueDate}` : ''}.`,
  viewAndPay: 'Online ansehen und bezahlen:',
  pdfAttached: 'Eine PDF-Kopie ist beigefügt.',
  viewAndPayButton: 'Rechnung ansehen & bezahlen',
  orCopyLink: 'Oder kopieren Sie diesen Link:',

  reminderSubject: (number, subject, total, dueDate) =>
    `Zahlungserinnerung: Rechnung ${number}${subject ? ` — ${subject}` : ''} — ${total} war fällig am ${dueDate}`,
  reminderTitle: 'Zahlungserinnerung',
  reminderBody: (number, subject, total, dueDate) =>
    `Eine freundliche Erinnerung: Die Rechnung ${number}${subject ? ` — ${subject}` : ''} über ${total} war am ${dueDate} fällig.`,
  reminderDisregard: 'Falls Sie die Zahlung bereits veranlasst haben, betrachten Sie diese Nachricht bitte als gegenstandslos. Vielen Dank!',

  receiptSubject: (number) => `Zahlung erhalten — Rechnung ${number}`,
  receiptBody: (amount, number) =>
    `Wir haben Ihre Zahlung über ${amount} für die Rechnung ${number} erhalten. Vielen Dank!`,
  receiptView: 'Bezahlte Rechnung ansehen oder als PDF herunterladen:',
};
