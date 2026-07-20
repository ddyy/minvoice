import type { Strings } from './index';

// Spanish (usted form). Drafted by the maintainers — native-speaker review
// welcome; corrections are a one-file PR.
export const es: Strings = {
  invoice: 'Factura',
  billedTo: 'Facturar a',
  issued: 'Fecha de emisión',
  due: 'Vencimiento',
  paid: 'Pagada',
  description: 'Descripción',
  qty: 'Cant.',
  unitPrice: 'Precio unitario',
  amount: 'Importe',
  subtotal: 'Subtotal',
  tax: 'IVA',
  total: 'Total',
  notes: 'Notas',
  subject: 'Asunto',
  statusPaid: 'PAGADA',
  statusVoid: 'ANULADA',
  payOnline: 'Pagar en línea:',
  footerThanks: (business) => (business ? `${business} — gracias por su confianza.` : 'Gracias por su confianza.'),

  print: 'Imprimir',
  downloadPdf: 'Descargar PDF',
  viewOnline: 'Ver en línea',
  paymentConfirming: '¡Gracias! Su pago se está confirmando — esta página lo mostrará en breve.',
  paymentUnderReview: 'Se ha recibido un pago por esta factura y está en revisión — por favor, no vuelva a pagar. Contáctenos si tiene preguntas.',
  invoicePaid: 'Esta factura ha sido pagada.',
  invoicePaidThanks: 'Esta factura ha sido pagada — ¡gracias!',
  invoiceVoided: 'Esta factura ha sido anulada.',
  draftHoldTitle: 'Esta factura aún no está lista',
  draftHoldBody: (business, number) =>
    `${business} todavía está preparando la factura ${number}. Este enlace mostrará la factura en cuanto esté finalizada — vuelva a consultarlo en breve.`,
  payWithCard: 'Pagar con tarjeta',
  payWithPaypal: 'Pagar con PayPal',
  trustLine: 'Los pagos son seguros y cifrados — los datos de la tarjeta nunca pasan por este sitio.',
  trustCardsPrefix: 'Las tarjetas se procesan a través de',
  trustPaypal: 'Los pagos con PayPal se completan en paypal.com.',
  noOnlinePayment: (email) =>
    `El pago en línea no está disponible para esta factura${email ? ` — por favor contacte con ${email}` : ''}.`,

  emailInvoiceSubject: (number, business, subject, total) =>
    subject
      ? `Factura ${number} de ${business} — ${subject} — ${total}`
      : `Factura ${number} de ${business} — ${total}`,
  greeting: (name) => `Estimado/a ${name}:`,
  emailInvoiceBody: (business, number, total, dueDate) =>
    `${business} le ha enviado la factura ${number} por ${total}${dueDate ? `, con vencimiento el ${dueDate}` : ''}.`,
  viewAndPay: 'Ver y pagar en línea:',
  pdfAttached: 'Se adjunta una copia en PDF.',
  viewAndPayButton: 'Ver y pagar la factura',
  orCopyLink: 'O copie este enlace:',

  reminderSubject: (number, subject, total, dueDate) =>
    `Recordatorio: la factura ${number}${subject ? ` — ${subject}` : ''} — ${total} venció el ${dueDate}`,
  reminderTitle: 'Recordatorio de pago',
  reminderBody: (number, subject, total, dueDate) =>
    `Un amable recordatorio: la factura ${number}${subject ? ` — ${subject}` : ''} por ${total} venció el ${dueDate}.`,
  reminderDisregard: 'Si ya ha realizado el pago, ignore este mensaje. ¡Gracias!',

  receiptSubject: (number) => `Pago recibido — Factura ${number}`,
  receiptBody: (amount, number) =>
    `Hemos recibido su pago de ${amount} por la factura ${number}. ¡Gracias!`,
  receiptView: 'Ver la factura pagada o descargar el PDF:',
};
