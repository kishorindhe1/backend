import fs   from 'fs';
import path from 'path';

const TEMPLATE_DIR = path.join(__dirname);

/**
 * Loads an HTML email template and replaces all {{variable}} placeholders.
 *
 * @param templateName  - filename without .html (e.g. 'otp', 'booking_confirmed')
 * @param variables     - key/value map matching the placeholders in the template
 * @returns rendered HTML string
 *
 * Template → variable mapping:
 *
 *  otp                      → otp, expiry
 *  booking_confirmed        → name, doctor, date, time, token
 *  booking_cancelled_patient→ name, doctor, date
 *  booking_cancelled_doctor → name, doctor, date
 *  booking_rescheduled      → name, doctor, old_date, old_time, new_date, new_time, token
 *  appointment_reminder     → name, doctor, date, time, token, hours
 *  doctor_late              → name, doctor, delay, estimatedTime
 *  doctor_absent            → name, doctor
 *  queue_position_alert     → name, doctor, position
 *  payment_successful       → amount, doctor, transaction_id, date
 *  refund_initiated         → amount, date
 */
export function renderEmailTemplate(
  templateName: string,
  variables: Record<string, string | number>,
): string {
  const filePath = path.join(TEMPLATE_DIR, `${templateName}.html`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Email template not found: ${templateName}`);
  }

  let html = fs.readFileSync(filePath, 'utf-8');

  for (const [key, value] of Object.entries(variables)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
  }

  return html;
}

/**
 * Subject lines for each template type.
 */
export const EMAIL_SUBJECTS: Record<string, string> = {
  otp:                       'Your Upcharify OTP',
  booking_confirmed:         'Appointment Confirmed ✓ — Upcharify',
  booking_cancelled_patient: 'Appointment Cancelled — Upcharify',
  booking_cancelled_doctor:  'Your Appointment Has Been Cancelled — Upcharify',
  booking_rescheduled:       'Appointment Rescheduled — Upcharify',
  appointment_reminder:      'Reminder: Your Appointment is Coming Up — Upcharify',
  doctor_late:               'Your Doctor is Running Late — Upcharify',
  doctor_absent:             'Important: Doctor Unavailable Today — Upcharify',
  queue_position_alert:      'Your Turn is Almost Here — Head to the Clinic',
  payment_successful:        'Payment Confirmed ₹{{amount}} — Upcharify',
  refund_initiated:          'Refund Initiated ₹{{amount}} — Upcharify',
};
