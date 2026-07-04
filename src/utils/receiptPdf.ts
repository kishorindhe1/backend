import PDFDocument from 'pdfkit';
import { InvoiceData } from './notificationTemplates';

const PRIMARY = '#0ea5e9';
const GRAY    = '#6b7280';
const DARK    = '#111827';
const LIGHT   = '#f3f4f6';

export function generateReceiptPdf(d: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'A4', info: { Title: `Receipt ${d.invoiceNumber}` } });
    const chunks: Buffer[] = [];

    doc.on('data',  (c: Buffer) => chunks.push(c));
    doc.on('end',   ()          => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const charges = d.charges ?? {
      consultation_fee: d.amount,
      platform_fee: 0,
      payment_gateway_fee: 0,
      gst_on_gateway_fee: 0,
      total_amount: d.amount,
    };

    // ── Header ────────────────────────────────────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').fillColor(DARK).text('TAX INVOICE', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor(GRAY).text('Healthcare Services', 50, 78);

    // Invoice meta — right column
    const R = 350;
    const metaRows: [string, string][] = [
      ['Invoice No.',   d.invoiceNumber],
      ['Invoice Date',  d.invoiceDate],
      ...(d.gstin    ? [['GSTIN',   d.gstin]    as [string, string]] : []),
      ...(d.address  ? [['Address', d.address]  as [string, string]] : []),
    ];
    metaRows.forEach(([label, value], i) => {
      const y = 50 + i * 16;
      doc.fontSize(10).font('Helvetica-Bold').fillColor(GRAY).text(label + ':', R, y, { width: 100 });
      doc.font('Helvetica').fillColor(DARK).text(value, R + 105, y, { width: 185 });
    });

    // ── Divider ───────────────────────────────────────────────────────────────
    const divY = 115;
    doc.moveTo(50, divY).lineTo(545, divY).strokeColor('#e5e7eb').lineWidth(1).stroke();

    // ── Billed To ─────────────────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY)
       .text('BILLED TO', 50, divY + 14, { characterSpacing: 0.5 });
    doc.fontSize(13).font('Helvetica-Bold').fillColor(DARK).text(d.patientName, 50, divY + 28);

    // ── Line items table ──────────────────────────────────────────────────────
    const tY = divY + 68;

    // Header row
    doc.rect(50, tY, 495, 24).fill(LIGHT);
    const th = [
      { label: 'DESCRIPTION', x: 60,  w: 240, align: 'left'  as const },
      { label: 'SAC',         x: 310, w: 50,  align: 'left'  as const },
      { label: 'GST',         x: 370, w: 60,  align: 'left'  as const },
      { label: 'AMOUNT',      x: 440, w: 100, align: 'right' as const },
    ];
    th.forEach(({ label, x, w, align }) => {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY)
         .text(label, x, tY + 8, { width: w, align, characterSpacing: 0.3 });
    });

    // Data rows
    const rY = tY + 30;
    doc.fontSize(12).font('Helvetica').fillColor(DARK).text('Medical Consultation', 60, rY);
    doc.fontSize(10).fillColor(GRAY)
       .text(`Dr. ${d.doctor}  ·  ${d.hospital}`, 60, rY + 17)
       .text(d.appointmentDate, 60, rY + 31);

    doc.fontSize(11).fillColor(GRAY).text('9993', 310, rY + 16, { width: 50 });

    // GST exempt pill
    doc.roundedRect(368, rY + 12, 52, 16, 8).fill('#dcfce7');
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#15803d')
       .text('Exempt', 369, rY + 15, { width: 50, align: 'center' });

    doc.fontSize(12).font('Helvetica-Bold').fillColor(DARK)
       .text(`Rs.${charges.consultation_fee.toFixed(2)}`, 440, rY + 16, { width: 100, align: 'right' });

    const chargeRows: [string, string][] = [
      ['Platform Fee', `Rs.${charges.platform_fee.toFixed(2)}`],
      ['Payment Gateway Fee 2%', `Rs.${charges.payment_gateway_fee.toFixed(2)}`],
      ['GST on Gateway Fee 18%', `Rs.${charges.gst_on_gateway_fee.toFixed(2)}`],
    ];
    chargeRows.forEach(([label, amount], i) => {
      const y = rY + 58 + i * 22;
      doc.fontSize(11).font('Helvetica').fillColor(DARK).text(label, 60, y);
      doc.fontSize(10).fillColor(GRAY).text('-', 310, y, { width: 50 });
      doc.fontSize(10).fillColor(GRAY).text(i === 2 ? '18%' : '-', 370, y, { width: 60 });
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK).text(amount, 440, y, { width: 100, align: 'right' });
    });

    // ── Total row ─────────────────────────────────────────────────────────────
    const totY = rY + 130;
    doc.moveTo(50, totY).lineTo(545, totY).strokeColor('#e5e7eb').lineWidth(1).stroke();
    doc.rect(50, totY, 495, 34).fill('#f9fafb');
    doc.fontSize(12).font('Helvetica-Bold').fillColor(DARK)
       .text('Total Paid', 60, totY + 10);
    doc.fontSize(14).fillColor(PRIMARY)
       .text(`Rs.${charges.total_amount.toFixed(2)}`, 440, totY + 9, { width: 100, align: 'right' });

    // ── Transaction details ───────────────────────────────────────────────────
    const txnY = totY + 52;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY)
       .text('TRANSACTION DETAILS', 50, txnY, { characterSpacing: 0.5 });
    doc.moveTo(50, txnY + 13).lineTo(545, txnY + 13).strokeColor('#e5e7eb').lineWidth(1).stroke();

    const txnRows: [string, string][] = [
      ['Transaction ID',   d.txnId],
      ['Payment Method',   'Online Payment (Razorpay)'],
      ['Status',           'Paid'],
    ];
    txnRows.forEach(([label, value], i) => {
      const y = txnY + 22 + i * 17;
      doc.fontSize(10).font('Helvetica').fillColor(GRAY).text(label + ':', 60, y, { width: 120 });
      doc.fillColor(DARK).text(value, 195, y, { width: 350 });
    });

    // ── Footer note ───────────────────────────────────────────────────────────
    doc.fontSize(8).fillColor(GRAY).text(
      'Healthcare services are exempt from GST as per notification 12/2017-Central Tax (Rate), SAC 9993.\nThis is a computer-generated invoice and does not require a physical signature.',
      50, txnY + 80, { width: 495, align: 'center', lineGap: 3 },
    );

    doc.end();
  });
}
