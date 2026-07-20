import type { Strings } from './index';

// French (vous form). Drafted by the maintainers — native-speaker review
// welcome; corrections are a one-file PR.
export const fr: Strings = {
  invoice: 'Facture',
  billedTo: 'Facturé à',
  issued: "Date d'émission",
  due: 'Échéance',
  paid: 'Payée',
  description: 'Description',
  qty: 'Qté',
  unitPrice: 'Prix unitaire',
  amount: 'Montant',
  subtotal: 'Sous-total',
  tax: 'TVA',
  total: 'Total',
  notes: 'Remarques',
  subject: 'Objet',
  statusPaid: 'PAYÉE',
  statusVoid: 'ANNULÉE',
  payOnline: 'Payer en ligne :',
  footerThanks: (business) => (business ? `${business} — merci de votre confiance.` : 'Merci de votre confiance.'),

  print: 'Imprimer',
  downloadPdf: 'Télécharger le PDF',
  viewOnline: 'Voir en ligne',
  paymentConfirming: 'Merci ! Votre paiement est en cours de confirmation — cette page l’affichera sous peu.',
  paymentUnderReview: 'Un paiement pour cette facture a été reçu et est en cours de vérification — merci de ne pas payer à nouveau. Contactez-nous pour toute question.',
  invoicePaid: 'Cette facture a été payée.',
  invoicePaidThanks: 'Cette facture a été payée — merci !',
  invoiceVoided: 'Cette facture a été annulée.',
  draftHoldTitle: "Cette facture n'est pas encore prête",
  draftHoldBody: (business, number) =>
    `${business} prépare encore la facture ${number}. Ce lien affichera la facture dès qu'elle sera finalisée — revenez sous peu.`,
  payWithCard: 'Payer par carte',
  payWithPaypal: 'Payer avec PayPal',
  trustLine: 'Les paiements sont sécurisés et chiffrés — les données de carte ne transitent jamais par ce site.',
  trustCardsPrefix: 'Les cartes sont traitées par',
  trustPaypal: 'Les paiements PayPal se terminent sur paypal.com.',
  noOnlinePayment: (email) =>
    `Le paiement en ligne n'est pas disponible pour cette facture${email ? ` — veuillez contacter ${email}` : ''}.`,

  emailInvoiceSubject: (number, business, subject, total) =>
    subject
      ? `Facture ${number} de ${business} — ${subject} — ${total}`
      : `Facture ${number} de ${business} — ${total}`,
  greeting: (name) => `Bonjour ${name},`,
  emailInvoiceBody: (business, number, total, dueDate) =>
    `${business} vous a envoyé la facture ${number} d'un montant de ${total}${dueDate ? `, à régler avant le ${dueDate}` : ''}.`,
  viewAndPay: 'Voir et payer en ligne :',
  pdfAttached: 'Une copie PDF est jointe.',
  viewAndPayButton: 'Voir et payer la facture',
  orCopyLink: 'Ou copiez ce lien :',

  reminderSubject: (number, subject, total, dueDate) =>
    `Rappel : la facture ${number}${subject ? ` — ${subject}` : ''} — ${total} était due le ${dueDate}`,
  reminderTitle: 'Rappel de paiement',
  reminderBody: (number, subject, total, dueDate) =>
    `Petit rappel : la facture ${number}${subject ? ` — ${subject}` : ''} d'un montant de ${total} était due le ${dueDate}.`,
  reminderDisregard: 'Si vous avez déjà effectué le paiement, veuillez ignorer ce message. Merci !',

  receiptSubject: (number) => `Paiement reçu — Facture ${number}`,
  receiptBody: (amount, number) =>
    `Nous avons bien reçu votre paiement de ${amount} pour la facture ${number}. Merci !`,
  receiptView: 'Voir la facture payée ou télécharger le PDF :',
};
