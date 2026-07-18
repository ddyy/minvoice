import type { Strings } from './index';

export const en: Strings = {
  invoice: 'Invoice',
  billedTo: 'Billed to',
  issued: 'Issued',
  due: 'Due',
  paid: 'Paid',
  description: 'Description',
  qty: 'Qty',
  unitPrice: 'Unit price',
  amount: 'Amount',
  subtotal: 'Subtotal',
  tax: 'Tax',
  total: 'Total',
  notes: 'Notes',
  subject: 'Subject',
  statusPaid: 'PAID',
  statusVoid: 'VOID',
  payOnline: 'Pay online:',
  footerThanks: (business) => (business ? `${business} — thank you for your business.` : 'Thank you for your business.'),

  print: 'Print',
  downloadPdf: 'Download PDF',
  viewOnline: 'View online',
  paymentConfirming: 'Thank you! Your payment is being confirmed — this page will show it shortly.',
  invoicePaid: 'This invoice has been paid.',
  invoicePaidThanks: 'This invoice has been paid — thank you!',
  invoiceVoided: 'This invoice has been voided.',
  draftHoldTitle: "This invoice isn't ready yet",
  draftHoldBody: (business, number) =>
    `${business} is still preparing invoice ${number}. This link will show the invoice as soon as it's finalized — check back shortly.`,
  payWithCard: 'Pay with card',
  payWithPaypal: 'Pay with PayPal',
  trustLine: 'Payments are secure and encrypted — card details never touch this site.',
  trustCardsPrefix: 'Cards are processed by',
  trustPaypal: 'PayPal payments redirect to paypal.com to complete.',
  noOnlinePayment: (email) =>
    `Online payment isn't available for this invoice${email ? ` — please contact ${email}` : ''}.`,

  emailInvoiceSubject: (number, business, subject, total) =>
    subject
      ? `Invoice ${number} from ${business} — ${subject} — ${total}`
      : `Invoice ${number} from ${business} — ${total}`,
  greeting: (name) => `Hi ${name},`,
  emailInvoiceBody: (business, number, total, dueDate) =>
    `${business} has sent you invoice ${number} for ${total}${dueDate ? `, due by ${dueDate}` : ''}.`,
  viewAndPay: 'View and pay online:',
  pdfAttached: 'A PDF copy is attached.',
  viewAndPayButton: 'View & pay invoice',
  orCopyLink: 'Or copy this link:',

  reminderSubject: (number, subject, total, dueDate) =>
    `Reminder: invoice ${number}${subject ? ` — ${subject}` : ''} — ${total} was due ${dueDate}`,
  reminderTitle: 'Payment reminder',
  reminderBody: (number, subject, total, dueDate) =>
    `A friendly reminder that invoice ${number}${subject ? ` — ${subject}` : ''} for ${total} was due on ${dueDate}.`,
  reminderDisregard: "If you've already sent payment, please disregard this note. Thank you!",

  receiptSubject: (number) => `Payment received — Invoice ${number}`,
  receiptBody: (amount, number) =>
    `We received your payment of ${amount} for invoice ${number}. Thank you!`,
  receiptView: 'View the paid invoice or download a PDF:',
};
