/**
 * Production-grade notification templates
 *
 * SMS  — DLT-registered format (TRAI India). Keep each under 160 chars.
 *         Variables are enclosed in {{var}} and rendered before dispatch.
 *
 * Email — Responsive HTML with inline styles (Gmail/Outlook safe).
 *          Uses a shared base layout so brand changes are one-place.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TemplateSet {
  sms:     string;
  subject: string;
  /** Returns complete HTML string */
  html:    (data: Record<string, unknown>) => string;
}

// ─── Brand tokens ─────────────────────────────────────────────────────────────

const BRAND = {
  name:    'Upcharify',
  tagline: 'Your Health, Simplified',
  color:   '#4F46E5',          // indigo-600 — matches admin panel brand
  light:   '#EEF2FF',
  support: 'support@upcharify.com',
  website: 'https://upcharify.com',
};

// ─── Shared HTML layout ───────────────────────────────────────────────────────

function layout(title: string, preheader: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <!-- Preheader (hidden preview text) -->
  <span style="display:none;max-height:0;overflow:hidden;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</span>

  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">

          <!-- Header -->
          <tr>
            <td style="background-color:${BRAND.color};padding:28px 32px;text-align:center;">
              <span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">${BRAND.name}</span>
              <p style="margin:4px 0 0;font-size:12px;color:rgba(255,255,255,.7);letter-spacing:0.5px;">${BRAND.tagline}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;line-height:1.6;">
                This is an automated message from ${BRAND.name}.<br/>
                Need help? Email us at <a href="mailto:${BRAND.support}" style="color:${BRAND.color};text-decoration:none;">${BRAND.support}</a>
              </p>
              <p style="margin:8px 0 0;font-size:11px;color:#d1d5db;text-align:center;">
                &copy; ${new Date().getFullYear()} ${BRAND.name}. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Reusable HTML snippets ───────────────────────────────────────────────────

function h1(text: string): string {
  return `<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">${text}</h1>`;
}
function p(text: string, style = ''): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;${style}">${text}</p>`;
}
function detailTable(rows: [string, string][]): string {
  const trs = rows.map(([label, value]) => `
    <tr>
      <td style="padding:10px 14px;font-size:13px;color:#6b7280;width:40%;border-bottom:1px solid #f3f4f6;">${label}</td>
      <td style="padding:10px 14px;font-size:13px;color:#111827;font-weight:600;border-bottom:1px solid #f3f4f6;">${value}</td>
    </tr>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;overflow:hidden;margin-bottom:24px;">${trs}</table>`;
}
function badge(text: string, color = BRAND.color): string {
  return `<div style="display:inline-block;background:${color};color:#fff;font-size:34px;font-weight:800;letter-spacing:-1px;padding:20px 40px;border-radius:12px;font-family:monospace;margin-bottom:24px;">${text}</div>`;
}
function alertBox(text: string, bg = '#fef9c3', border = '#fde047'): string {
  return `<div style="background:${bg};border-left:4px solid ${border};padding:14px 16px;border-radius:6px;margin-bottom:20px;font-size:14px;color:#78350f;">${text}</div>`;
}
function greenBox(text: string): string {
  return `<div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:14px 16px;border-radius:6px;margin-bottom:20px;font-size:14px;color:#15803d;">${text}</div>`;
}
function divider(): string {
  return `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />`;
}

// ─── Render helper (same as in notification.service) ─────────────────────────

function r(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(data[k] ?? ''));
}

// ─── Templates ───────────────────────────────────────────────────────────────

export const templates: Record<string, TemplateSet> = {

  // ── OTP ──────────────────────────────────────────────────────────────────────
  otp: {
    subject: `Your OTP – ${BRAND.name}`,
    sms: `{{otp}} is your OTP for Upcharify login. Valid for {{expiry}} mins. DO NOT share with anyone. -UPCHARIFY`,
    html: (d) => layout(
      'Your One-Time Password',
      `Use OTP ${d.otp} to log in. Valid for ${d.expiry} minutes.`,
      `
      ${h1('Your One-Time Password')}
      ${p('Use the code below to complete your login. This code is valid for <strong>{{expiry}} minutes</strong>.'.replace(/{{expiry}}/g, String(d.expiry)))}
      <div style="text-align:center;">${badge(String(d.otp), '#111827')}</div>
      ${alertBox('Never share this code with anyone — including Upcharify staff.')}
      ${p(`If you didn't request this, you can safely ignore this message.`, 'color:#9ca3af;font-size:13px;')}
    `,
    ),
  },

  // ── Booking confirmed ─────────────────────────────────────────────────────
  booking_confirmed: {
    subject: `Appointment Confirmed – ${BRAND.name}`,
    sms: `Confirmed: Appt with Dr. {{doctor}} on {{date}} at {{time}}. Token #{{token}}. Hospital: {{hospital}}. -UPCHARIFY`,
    html: (d) => layout(
      'Appointment Confirmed',
      `Your appointment with Dr. ${d.doctor} on ${d.date} is confirmed.`,
      `
      ${greenBox('&#10003;&nbsp; Your appointment is confirmed!')}
      ${h1('Appointment Details')}
      ${detailTable([
        ['Patient',   String(d.name)],
        ['Doctor',    `Dr. ${d.doctor}`],
        ['Hospital',  String(d.hospital)],
        ['Date',      String(d.date)],
        ['Time',      String(d.time)],
        ['Token No.', `#${d.token}`],
      ])}
      ${p('Please arrive 10 minutes before your scheduled time. Carry a valid ID and any previous reports.')}
      ${divider()}
      ${p('Need to reschedule? Cancel from the Upcharify app at least 2 hours in advance.', 'color:#9ca3af;font-size:13px;')}
    `,
    ),
  },

  // ── Booking cancelled — doctor/hospital side ──────────────────────────────
  booking_cancelled_doctor: {
    subject: `Appointment Cancelled – ${BRAND.name}`,
    sms: `Sorry {{name}}, your appt with Dr. {{doctor}} on {{date}} is cancelled by hospital. Refund initiated in 3-5 days. -UPCHARIFY`,
    html: (d) => layout(
      'Appointment Cancelled',
      `Your appointment with Dr. ${d.doctor} on ${d.date} has been cancelled.`,
      `
      ${alertBox('&#9888;&nbsp; Your appointment has been cancelled by the hospital.', '#fef2f2', '#f87171')}
      ${h1('Appointment Cancelled')}
      ${detailTable([
        ['Patient',   String(d.name)],
        ['Doctor',    `Dr. ${d.doctor}`],
        ['Hospital',  String(d.hospital)],
        ['Date',      String(d.date)],
        ['Reason',    'Cancelled by hospital'],
      ])}
      ${greenBox('A full refund of <strong>&#8377;{{amount}}</strong> has been initiated and will reflect in 3–5 business days.'.replace(/{{amount}}/g, String(d.amount ?? '—')))}
      ${p('We apologise for the inconvenience. Please book a new appointment at your convenience.')}
    `,
    ),
  },

  // ── Booking cancelled — patient side ─────────────────────────────────────
  booking_cancelled_patient: {
    subject: `Appointment Cancelled – ${BRAND.name}`,
    sms: `Hi {{name}}, your appt with Dr. {{doctor}} on {{date}} has been cancelled as requested. -UPCHARIFY`,
    html: (d) => layout(
      'Appointment Cancelled',
      `Your appointment with Dr. ${d.doctor} on ${d.date} has been cancelled.`,
      `
      ${h1('Appointment Cancelled')}
      ${p(`Hi <strong>${d.name}</strong>, your appointment has been successfully cancelled.`)}
      ${detailTable([
        ['Doctor',   `Dr. ${d.doctor}`],
        ['Hospital', String(d.hospital)],
        ['Date',     String(d.date)],
      ])}
      ${d.amount ? greenBox(`A refund of <strong>&#8377;${d.amount}</strong> has been initiated and will reflect in 3–5 business days.`) : ''}
    `,
    ),
  },

  // ── Doctor running late ───────────────────────────────────────────────────
  doctor_late: {
    subject: `Doctor Running Late – ${BRAND.name}`,
    sms: `Hi {{name}}, Dr. {{doctor}} is running {{delay}} mins late. Estimated time: {{estimatedTime}}. -UPCHARIFY`,
    html: (d) => layout(
      'Doctor Running Late',
      `Dr. ${d.doctor} is running ${d.delay} minutes late.`,
      `
      ${alertBox(`&#9203;&nbsp; Dr. <strong>${d.doctor}</strong> is running <strong>${d.delay} minutes</strong> late today.`)}
      ${h1('Updated Schedule')}
      ${detailTable([
        ['Patient',        String(d.name)],
        ['Doctor',         `Dr. ${d.doctor}`],
        ['Original Time',  String(d.time ?? '—')],
        ['New Est. Time',  String(d.estimatedTime)],
        ['Delay',          `${d.delay} minutes`],
        ['Token No.',      `#${d.token}`],
      ])}
      ${p('You may wait comfortably or arrive closer to your updated estimated time.')}
    `,
    ),
  },

  // ── Doctor absent ─────────────────────────────────────────────────────────
  doctor_absent: {
    subject: `Doctor Unavailable – ${BRAND.name}`,
    sms: `Hi {{name}}, Dr. {{doctor}} is unavailable today. Appt cancelled. Full refund in 3-5 days. -UPCHARIFY`,
    html: (d) => layout(
      'Doctor Unavailable Today',
      `Dr. ${d.doctor} is unavailable today. Your appointment has been cancelled.`,
      `
      ${alertBox('&#9888;&nbsp; Doctor unavailable — your appointment has been cancelled.', '#fef2f2', '#f87171')}
      ${h1('Appointment Cancelled')}
      ${p(`We regret to inform you that Dr. <strong>${d.doctor}</strong> is unavailable on <strong>${d.date}</strong>.`)}
      ${detailTable([
        ['Patient',  String(d.name)],
        ['Doctor',   `Dr. ${d.doctor}`],
        ['Date',     String(d.date)],
      ])}
      ${greenBox('A full refund has been initiated and will reflect in 3–5 business days.')}
      ${p('We apologise for the inconvenience. Please book again when a slot is available.')}
    `,
    ),
  },

  // ── Queue position alert ──────────────────────────────────────────────────
  queue_position_alert: {
    subject: `Your Turn is Approaching – ${BRAND.name}`,
    sms: `Hi {{name}}, you are {{position}} patient(s) away from Dr. {{doctor}}. Token #{{token}}. Please proceed to clinic. -UPCHARIFY`,
    html: (d) => layout(
      'Your Turn is Approaching',
      `${d.position} patients ahead of you — please head to the clinic.`,
      `
      ${greenBox(`&#128276;&nbsp; Only <strong>${d.position}</strong> patient(s) ahead of you!`)}
      ${h1('Time to Head to the Clinic')}
      ${detailTable([
        ['Patient',         String(d.name)],
        ['Doctor',          `Dr. ${d.doctor}`],
        ['Hospital',        String(d.hospital)],
        ['Your Token No.',  `#${d.token}`],
        ['Patients Ahead',  String(d.position)],
      ])}
      ${p('Please proceed to the waiting area now to avoid missing your turn.')}
    `,
    ),
  },

  // ── Payment successful ────────────────────────────────────────────────────
  payment_successful: {
    subject: `Payment Confirmed – ${BRAND.name}`,
    sms: `Payment of Rs.{{amount}} confirmed. Txn ID: {{txnId}}. Appt with Dr. {{doctor}} on {{date}}. -UPCHARIFY`,
    html: (d) => layout(
      'Payment Confirmed',
      `Payment of ₹${d.amount} confirmed for your appointment with Dr. ${d.doctor}.`,
      `
      ${greenBox('&#10003;&nbsp; Payment received successfully!')}
      ${h1('Payment Confirmation')}
      ${detailTable([
        ['Amount',       `&#8377;${d.amount}`],
        ['Transaction',  String(d.txnId ?? '—')],
        ['Doctor',       `Dr. ${d.doctor}`],
        ['Hospital',     String(d.hospital)],
        ['Date',         String(d.date)],
        ['Token No.',    `#${d.token}`],
      ])}
      ${p('Your booking is confirmed. Please save this email for your records.')}
    `,
    ),
  },

  // ── Refund initiated ──────────────────────────────────────────────────────
  refund_initiated: {
    subject: `Refund Initiated – ${BRAND.name}`,
    sms: `Rs.{{amount}} refund initiated for Txn {{txnId}}. Will reflect in 3-5 business days. -UPCHARIFY`,
    html: (d) => layout(
      'Refund Initiated',
      `₹${d.amount} refund has been initiated.`,
      `
      ${greenBox('&#8635;&nbsp; Your refund has been initiated.')}
      ${h1('Refund Details')}
      ${detailTable([
        ['Refund Amount',   `&#8377;${d.amount}`],
        ['Transaction ID',  String(d.txnId ?? '—')],
        ['Reason',          String(d.reason ?? 'Appointment Cancelled')],
        ['Timeline',        '3–5 business days'],
      ])}
      ${p('The refund will be credited to your original payment method. Please contact your bank if it doesn\'t reflect after 5 business days.')}
      ${divider()}
      ${p(`For queries, email <a href="mailto:${BRAND.support}" style="color:${BRAND.color};">${BRAND.support}</a>`, 'font-size:13px;color:#9ca3af;')}
    `,
    ),
  },

  // ── Appointment reminder ──────────────────────────────────────────────────
  appointment_reminder: {
    subject: `Appointment Reminder – ${BRAND.name}`,
    sms: `Reminder: Appt with Dr. {{doctor}} in {{hours}} hrs at {{hospital}}. Token #{{token}}. -UPCHARIFY`,
    html: (d) => layout(
      'Appointment Reminder',
      `Reminder: Your appointment with Dr. ${d.doctor} is in ${d.hours} hours.`,
      `
      ${alertBox(`&#128337;&nbsp; Reminder — your appointment is in <strong>${d.hours} hour(s)</strong>.`)}
      ${h1('Appointment Reminder')}
      ${detailTable([
        ['Patient',     String(d.name)],
        ['Doctor',      `Dr. ${d.doctor}`],
        ['Hospital',    String(d.hospital)],
        ['Date',        String(d.date)],
        ['Time',        String(d.time)],
        ['Token No.',   `#${d.token}`],
      ])}
      ${p('Please carry a valid ID and any previous medical reports.')}
    `,
    ),
  },
};

// ─── Render helper ────────────────────────────────────────────────────────────

/** Returns { sms, subject, htmlBody } rendered with data. */
export function renderNotification(
  type: string,
  data: Record<string, unknown>,
): { sms: string; subject: string; htmlBody: string } | null {
  const t = templates[type];
  if (!t) return null;
  return {
    sms:      r(t.sms, data),
    subject:  t.subject,
    htmlBody: t.html(data),
  };
}
