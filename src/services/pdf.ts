import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';
import type { InvoiceItem, InvoiceWithClient, Settings } from '../db/queries';
import { formatCents, formatTaxRate } from '../lib/money';

// US Letter, "Ledger" palette — mirrors public/styles.css
const PAGE = { width: 612, height: 792 };
const MARGIN = 54;
const COL = { desc: MARGIN, qty: 330, unit: 408, amountRight: PAGE.width - MARGIN };
const INK = rgb(0.114, 0.102, 0.082); // #1d1a15
const SOFT = rgb(0.42, 0.39, 0.35); // #6b6459
const FAINT = rgb(0.56, 0.53, 0.49); // #8f887c
const LINE = rgb(0.9, 0.88, 0.84); // #e6e1d6
const LINE_STRONG = rgb(0.81, 0.78, 0.72); // #cfc7b8
const GREEN = rgb(0.118, 0.357, 0.263); // #1e5b43
const PAPER_TINT = rgb(0.973, 0.965, 0.945); // #f8f6f1 header band
const RUST = rgb(0.659, 0.251, 0.165); // #a8402a

type Ctx = {
  doc: PDFDocument;
  page: ReturnType<PDFDocument['addPage']>;
  regular: PDFFont;
  bold: PDFFont;
  serif: PDFFont;
  serifBold: PDFFont;
  y: number;
};

export async function generateInvoicePdf(
  invoice: InvoiceWithClient,
  items: InvoiceItem[],
  settings: Settings,
  payUrl?: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE.width, PAGE.height]),
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    y: PAGE.height,
  };
  doc.setTitle(`Invoice ${invoice.number}`);
  if (settings.business_name) doc.setAuthor(settings.business_name);

  const text = (
    str: string,
    x: number,
    opts: {
      size?: number;
      font?: PDFFont;
      color?: ReturnType<typeof rgb>;
      rightAlignTo?: number;
      tracking?: boolean;
    } = {}
  ) => {
    const font = opts.font ?? ctx.regular;
    const size = opts.size ?? 9.5;
    const content = opts.tracking ? str.split('').join(' ') : str; // faux letterspacing for labels
    const drawX =
      opts.rightAlignTo !== undefined ? opts.rightAlignTo - font.widthOfTextAtSize(content, size) : x;
    ctx.page.drawText(content, { x: drawX, y: ctx.y, size, font, color: opts.color ?? INK });
  };

  const label = (str: string, x: number, rightAlignTo?: number) =>
    text(str.toUpperCase(), x, { size: 7, font: ctx.bold, color: FAINT, rightAlignTo });

  const hr = (color = LINE, x1 = MARGIN, x2 = PAGE.width - MARGIN) =>
    ctx.page.drawLine({ start: { x: x1, y: ctx.y }, end: { x: x2, y: ctx.y }, thickness: 0.7, color });

  // ---- Brand tape: the green bar from the pay page ----
  ctx.page.drawRectangle({ x: 0, y: PAGE.height - 6, width: PAGE.width, height: 6, color: GREEN });

  // ---- Header: identity left, document meta right ----
  ctx.y = PAGE.height - 64;
  const logo = await tryEmbedLogo(doc, settings.logo_url);
  if (logo) {
    const dims = logo.scaleToFit(110, 36);
    ctx.page.drawImage(logo, { x: MARGIN, y: ctx.y - 6, width: dims.width, height: dims.height });
    ctx.y -= dims.height + 10;
  }
  text(settings.business_name || 'Invoice', MARGIN, { size: 22, font: ctx.serifBold });
  text('INVOICE', 0, { size: 11, font: ctx.bold, color: FAINT, rightAlignTo: COL.amountRight, tracking: true });
  ctx.y -= 15;
  text(invoice.number, 0, { size: 13, font: ctx.serifBold, rightAlignTo: COL.amountRight });

  ctx.y -= 14;
  const addressLines = (settings.business_address || '').split('\n').filter(Boolean);
  const headerLeftY = ctx.y;
  for (const line of addressLines) {
    text(line, MARGIN, { color: SOFT });
    ctx.y -= 12;
  }
  if (settings.business_email) {
    text(settings.business_email, MARGIN, { color: SOFT });
    ctx.y -= 12;
  }
  // dates on the right, independent of address height
  const leftEndY = ctx.y;
  ctx.y = headerLeftY;
  text(`Issued  ${invoice.issue_date}`, 0, { color: SOFT, rightAlignTo: COL.amountRight });
  if (invoice.due_date) {
    ctx.y -= 12;
    text(`Due  ${invoice.due_date}`, 0, { color: SOFT, rightAlignTo: COL.amountRight });
  }
  ctx.y = Math.min(leftEndY, ctx.y) - 24;

  // ---- Bill to ----
  label('Bill to', MARGIN);
  ctx.y -= 14;
  text(invoice.client_name, MARGIN, { size: 11, font: ctx.bold });
  if (invoice.client_email) {
    ctx.y -= 12;
    text(invoice.client_email, MARGIN, { color: SOFT });
  }
  ctx.y -= 26;

  // ---- Subject ----
  if (invoice.subject) {
    label('Subject', MARGIN);
    ctx.y -= 14;
    text(truncate(invoice.subject, ctx.serifBold, 11.5, PAGE.width - 2 * MARGIN), MARGIN, {
      size: 11.5,
      font: ctx.serifBold,
    });
    ctx.y -= 26;
  }

  // ---- Items table ----
  const tableHeader = () => {
    // warm band behind the header row
    ctx.page.drawRectangle({
      x: MARGIN - 8,
      y: ctx.y - 6,
      width: PAGE.width - 2 * (MARGIN - 8),
      height: 20,
      color: PAPER_TINT,
    });
    ctx.y += 1;
    label('Description', COL.desc);
    label('Qty', 0, COL.qty + 18);
    label('Unit price', 0, COL.unit + 30);
    label('Amount', 0, COL.amountRight);
    ctx.y -= 7;
    hr(LINE_STRONG, MARGIN - 8, PAGE.width - MARGIN + 8);
    ctx.y -= 16;
  };
  tableHeader();

  for (const item of items) {
    const descLines = wrapText(item.description, ctx.regular, 9.5, COL.qty - COL.desc - 24);
    if (ctx.y < 130 + (descLines.length - 1) * 12) {
      ctx.page = doc.addPage([PAGE.width, PAGE.height]);
      ctx.y = PAGE.height - MARGIN;
      tableHeader();
    }
    // First description line shares the row with the numbers; extra lines follow
    text(descLines[0], COL.desc);
    text(String(item.quantity), 0, { rightAlignTo: COL.qty + 18, color: SOFT });
    text(formatCents(item.unit_price_cents, invoice.currency), 0, { rightAlignTo: COL.unit + 30, color: SOFT });
    text(formatCents(item.amount_cents, invoice.currency), 0, { rightAlignTo: COL.amountRight });
    for (const line of descLines.slice(1)) {
      ctx.y -= 12;
      text(line, COL.desc, { color: SOFT, size: 9 });
    }
    ctx.y -= 6;
    hr();
    ctx.y -= 14;
  }

  // ---- Totals ----
  if (ctx.y < 150) {
    ctx.page = doc.addPage([PAGE.width, PAGE.height]);
    ctx.y = PAGE.height - MARGIN;
  }
  ctx.y -= 6;
  const totalsX = COL.qty;
  text('Subtotal', totalsX, { color: SOFT });
  text(formatCents(invoice.subtotal_cents, invoice.currency), 0, { rightAlignTo: COL.amountRight });
  if (invoice.tax_cents > 0) {
    ctx.y -= 15;
    text(`Tax (${formatTaxRate(invoice.tax_rate_bps)})`, totalsX, { color: SOFT });
    text(formatCents(invoice.tax_cents, invoice.currency), 0, { rightAlignTo: COL.amountRight });
  }
  ctx.y -= 10;
  hr(INK, totalsX, COL.amountRight);
  ctx.y -= 18;
  text('Total', totalsX, { size: 14, font: ctx.serifBold });
  text(formatCents(invoice.total_cents, invoice.currency), 0, {
    size: 14,
    font: ctx.serifBold,
    rightAlignTo: COL.amountRight,
  });

  // ---- Status stamp ----
  if (invoice.status === 'paid' || invoice.status === 'void') {
    const stamp = invoice.status === 'paid' ? `PAID${invoice.paid_at ? `  ${invoice.paid_at.slice(0, 10)}` : ''}` : 'VOID';
    const color = invoice.status === 'paid' ? GREEN : RUST;
    ctx.y -= 26;
    const w = ctx.bold.widthOfTextAtSize(stamp, 10) + 20;
    ctx.page.drawRectangle({
      x: COL.amountRight - w,
      y: ctx.y - 7,
      width: w,
      height: 24,
      borderColor: color,
      borderWidth: 1.2,
      opacity: 0,
      borderOpacity: 0.9,
    });
    text(stamp, 0, { size: 10, font: ctx.bold, color, rightAlignTo: COL.amountRight - 10 });
  }

  // ---- Notes ----
  if (invoice.notes) {
    ctx.y -= 34;
    label('Notes', MARGIN);
    ctx.y -= 13;
    for (const line of invoice.notes.split('\n')) {
      if (ctx.y < 90) break;
      text(truncate(line, ctx.regular, 9, PAGE.width - 2 * MARGIN), MARGIN, { size: 9, color: SOFT });
      ctx.y -= 12;
    }
  }

  // ---- Footer: pay link on every page ----
  const pages = doc.getPages();
  for (const p of pages) {
    ctx.page = p;
    ctx.y = 46;
    hr();
    ctx.y = 32;
    if (payUrl && invoice.status === 'sent') {
      const msg = `Pay online: ${payUrl}`;
      text(msg, 0, {
        size: 8.5,
        color: SOFT,
        rightAlignTo: PAGE.width / 2 + ctx.regular.widthOfTextAtSize(msg, 8.5) / 2,
      });
    } else {
      const msg = settings.business_name ? `${settings.business_name} — thank you for your business.` : 'Thank you for your business.';
      text(msg, 0, {
        size: 8.5,
        color: FAINT,
        rightAlignTo: PAGE.width / 2 + ctx.regular.widthOfTextAtSize(msg, 8.5) / 2,
      });
    }
  }

  return doc.save();
}

export function pdfResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

async function tryEmbedLogo(doc: PDFDocument, url: string | null) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    const type = res.headers.get('content-type') ?? '';
    return type.includes('png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    return null; // bad logo never blocks invoice rendering
  }
}

/**
 * Wrap text to a column width, honoring explicit newlines and breaking on
 * spaces (falls back to hard truncation for a single unbreakable word).
 */
function wrapText(str: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of str.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(truncate(candidate, font, size, Infinity), size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return (out.length ? out : ['']).map((l) => truncate(l, font, size, maxWidth));
}

// Printable CP1252 characters above Latin-1 — WinAnsi encodes these fine.
const CP1252_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Helvetica/Times cover WinAnsi only; replace unsupported chars and ellipsize overflow. */
function truncate(str: string, font: PDFFont, size: number, maxWidth: number): string {
  let s = [...str].map((ch) => (ch.charCodeAt(0) <= 0xff || CP1252_EXTRAS.has(ch) ? ch : '?')).join('');
  if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
  while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxWidth) s = s.slice(0, -1);
  return s + '…';
}
