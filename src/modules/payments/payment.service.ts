import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Op }             from 'sequelize';
import { sequelize }       from '../../config/database';
import { Payment, PaymentGatewayStatus, WebhookEvent, WebhookStatus } from '../../models';
import { Appointment, AppointmentStatus, PaymentStatus, DoctorProfile } from '../../models';
import { env }             from '../../config/env';
import { ServiceResponse, ok, fail } from '../../types';
import { incrementCounter } from '../admin/admin.service';
import { enqueueNotification } from '../notifications/notification.service';
import { NotificationChannel } from '../../models';
import { logger }          from '../../utils/logger';
import { sendEmailWithAttachment } from '../../utils/smsProvider';
import { buildGstInvoiceHtml, gstInvoiceSubject } from '../../utils/notificationTemplates';

function getRazorpay() {
  return new Razorpay({ key_id: env.RAZORPAY_KEY_ID!, key_secret: env.RAZORPAY_KEY_SECRET! });
}

export type PaymentChargeBreakdown = {
  consultation_fee: number;
  platform_fee: number;
  payment_gateway_fee: number;
  gst_on_gateway_fee: number;
  total_amount: number;
};

function roundMoney(amount: number) {
  return Math.round(amount * 100) / 100;
}

export function calculatePaymentCharges(consultationFee: number): PaymentChargeBreakdown {
  const consultation_fee = roundMoney(consultationFee);
  const platform_fee = 0;
  const payment_gateway_fee = roundMoney(consultation_fee * (env.PAYMENT_GATEWAY_FEE_PERCENTAGE / 100));
  const gst_on_gateway_fee = roundMoney(payment_gateway_fee * (env.PAYMENT_GATEWAY_GST_PERCENTAGE / 100));
  const total_amount = roundMoney(consultation_fee + platform_fee + payment_gateway_fee + gst_on_gateway_fee);

  return {
    consultation_fee,
    platform_fee,
    payment_gateway_fee,
    gst_on_gateway_fee,
    total_amount,
  };
}

// ── Settlement split for online payments ─────────────────────────────────────
function calculateFeeSplit(consultationFee: number) {
  return {
    platform_fee: 0,
    doctor_payout: roundMoney(consultationFee),
  };
}

async function buildReceiptEmailData(payment: Payment, razorpayPaymentId?: string) {
  const { User, PatientProfile, Hospital } = await import('../../models');
  const appt = await Appointment.findByPk(payment.appointment_id, {
    attributes: ['patient_id', 'doctor_id', 'hospital_id', 'scheduled_at', 'consultation_fee'],
  });
  if (!appt) return null;

  const [doc, hospital, patientUser] = await Promise.all([
    DoctorProfile.findByPk(appt.doctor_id, { attributes: ['full_name'] }),
    Hospital.findByPk(appt.hospital_id, { attributes: ['name'] }),
    User.findByPk(appt.patient_id, {
      include: [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name', 'email'] }],
    }),
  ]);

  const patientProfile = (patientUser as any)?.patientProfile;
  const patientEmail = patientProfile?.email as string | undefined;
  if (!patientEmail) return null;

  const capturedAt = payment.captured_at ?? new Date();
  const invoiceDate = new Date(capturedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  const appointmentDate = new Date(appt.scheduled_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const invoiceNumber = `INV-${new Date(capturedAt).toISOString().slice(0, 10).replace(/-/g, '')}-${String(payment.appointment_id).slice(0, 8).toUpperCase()}`;
  const doctorName = doc?.full_name ?? 'Doctor';
  const hospitalName = (hospital as any)?.name ?? '—';
  const txnId = razorpayPaymentId ?? payment.razorpay_payment_id ?? '—';
  const charges = calculatePaymentCharges(Number(appt.consultation_fee));

  const html = buildGstInvoiceHtml({
    invoiceNumber,
    invoiceDate,
    patientName: patientProfile?.full_name ?? 'Patient',
    doctor: doctorName,
    hospital: hospitalName,
    appointmentDate,
    amount: Number(payment.amount),
    txnId,
    gstin: env.COMPANY_GSTIN,
    address: env.COMPANY_ADDRESS,
    charges,
  });

  const plainText = `Tax Invoice ${invoiceNumber}\nDate: ${invoiceDate}\nBilled to: ${patientProfile?.full_name ?? 'Patient'}\nDoctor: Dr. ${doctorName}\nHospital: ${hospitalName}\nAppointment: ${appointmentDate}\nConsultation Fee: Rs.${charges.consultation_fee.toFixed(2)}\nPlatform Fee: Rs.${charges.platform_fee.toFixed(2)}\nPayment Gateway Fee: Rs.${charges.payment_gateway_fee.toFixed(2)}\nGST on Gateway Fee: Rs.${charges.gst_on_gateway_fee.toFixed(2)}\nAmount Paid: Rs.${charges.total_amount.toFixed(2)}\nTransaction ID: ${txnId}`;

  const { generateReceiptPdf } = await import('../../utils/receiptPdf');
  const pdf = await generateReceiptPdf({
    invoiceNumber,
    invoiceDate,
    patientName: patientProfile?.full_name ?? 'Patient',
    doctor: doctorName,
    hospital: hospitalName,
    appointmentDate,
    amount: Number(payment.amount),
    txnId,
    gstin: env.COMPANY_GSTIN,
    address: env.COMPANY_ADDRESS,
    charges,
  });

  return { patientEmail, invoiceNumber, plainText, html, pdf };
}

export async function sendReceiptEmailForAppointment(appointmentId: string): Promise<void> {
  const payment = await Payment.findOne({
    where: { appointment_id: appointmentId, status: PaymentGatewayStatus.CAPTURED },
    order: [['captured_at', 'DESC'], ['created_at', 'DESC']],
  });
  if (!payment) {
    logger.info('Receipt email skipped: no captured payment found', { appointmentId });
    return;
  }

  const data = await buildReceiptEmailData(payment);
  if (!data) {
    logger.info('Receipt email skipped: patient email not available', { appointmentId });
    return;
  }

  await sendEmailWithAttachment(data.patientEmail, gstInvoiceSubject(data.invoiceNumber), data.plainText, data.html, {
    filename: `receipt-${String(payment.id).slice(0, 8)}.pdf`,
    contentType: 'application/pdf',
    content: data.pdf,
  });
  logger.info('Receipt email sent after consultation completion', { appointmentId, paymentId: payment.id });
}

export async function resendReceiptEmail(paymentId: string, patientId: string): Promise<ServiceResponse<{ message: string }>> {
  const payment = await Payment.findByPk(paymentId);
  if (!payment) return fail('PAYMENT_NOT_FOUND', 'Payment not found.', 404);
  if (payment.status !== PaymentGatewayStatus.CAPTURED) {
    return fail('PAYMENT_NOT_CAPTURED', 'Receipt is only available for completed payments.', 422);
  }

  const appt = await Appointment.findByPk(payment.appointment_id, { attributes: ['patient_id'] });
  if (!appt) return fail('BOOKING_NOT_FOUND', 'Appointment not found.', 404);
  if (appt.patient_id !== patientId) return fail('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.', 403);

  const data = await buildReceiptEmailData(payment);
  if (!data) return fail('EMAIL_NOT_AVAILABLE', 'Add an email to your profile to receive the receipt.', 422);

  await sendEmailWithAttachment(data.patientEmail, gstInvoiceSubject(data.invoiceNumber), data.plainText, data.html, {
    filename: `receipt-${String(payment.id).slice(0, 8)}.pdf`,
    contentType: 'application/pdf',
    content: data.pdf,
  });
  return ok({ message: 'Receipt sent to your email.' });
}

// ── Initiate payment — create Razorpay order ──────────────────────────────────
export async function initiatePayment(
  appointmentId: string,
  patientId:     string,
): Promise<ServiceResponse<{ order_id: string; amount: number; currency: string; key_id: string; charges: PaymentChargeBreakdown }>> {
  const appointment = await Appointment.findByPk(appointmentId);

  if (!appointment) return fail('BOOKING_NOT_FOUND', 'Appointment not found.', 404);
  if (appointment.patient_id !== patientId) return fail('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.', 403);
  if (appointment.payment_status !== PaymentStatus.PENDING) {
    return fail('PAYMENT_ALREADY_PROCESSED', 'Payment already initiated or completed.', 409);
  }

  const consultationFee = Number(appointment.consultation_fee);
  const charges = calculatePaymentCharges(consultationFee);

  const razorpay = getRazorpay();
  const order = await razorpay.orders.create({
    amount:   Math.round(charges.total_amount * 100), // paise
    currency: 'INR',
    receipt:  appointmentId,
  });
  const orderId = order.id;

  // Store order ID on appointment
  await appointment.update({ razorpay_order_id: orderId });

  // Create pending payment record
  const splits = calculateFeeSplit(consultationFee);
  await Payment.create({
    appointment_id:      appointmentId,
    razorpay_order_id:   orderId,
    razorpay_payment_id: null,
    amount: charges.total_amount,
    platform_fee:  splits.platform_fee,
    doctor_payout: splits.doctor_payout,
    currency:      'INR',
    status:        PaymentGatewayStatus.CREATED,
    captured_at:   null,
    refunded_at:   null,
    refund_amount: null,
  });

  logger.info('Payment initiated', { appointmentId, orderId, amount: charges.total_amount, charges });

  return ok({
    order_id: orderId,
    amount: charges.total_amount,
    currency: 'INR',
    key_id:   env.RAZORPAY_KEY_ID ?? 'rzp_test_placeholder',
    charges,
  });
}

// ── Verify payment signature (called from frontend after Razorpay checkout) ───
export async function verifyPayment(input: {
  razorpay_order_id:   string;
  razorpay_payment_id: string;
  razorpay_signature:  string;
}): Promise<ServiceResponse<{ message: string }>> {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = input;

  // Verify HMAC-SHA256 signature
  if (env.RAZORPAY_KEY_SECRET) {
    const expectedSig = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      return fail('PAYMENT_SIGNATURE_INVALID', 'Payment signature verification failed.', 400);
    }
  }

  // Update payment + appointment
  const payment = await Payment.findOne({ where: { razorpay_order_id } });
  if (!payment) return fail('PAYMENT_NOT_FOUND', 'Payment record not found.', 404);

  const apptForSplit = await Appointment.findByPk(payment.appointment_id, {
    attributes: ['consultation_fee'],
  });
  const splits = calculateFeeSplit(Number(apptForSplit?.consultation_fee ?? payment.amount));

  await sequelize.transaction(async (t) => {
    await payment.update(
      {
        razorpay_payment_id,
        status:       PaymentGatewayStatus.CAPTURED,
        platform_fee: splits.platform_fee,
        doctor_payout:splits.doctor_payout,
        captured_at:  new Date(),
      },
      { transaction: t },
    );

    await Appointment.update(
      { status: AppointmentStatus.CONFIRMED, payment_status: PaymentStatus.CAPTURED },
      { where: { id: payment.appointment_id }, transaction: t },
    );
  });

  logger.info('Payment verified and confirmed', {
    paymentId: payment.id,
    appointmentId: payment.appointment_id,
    amount: payment.amount,
    platformFee: splits.platform_fee,
    doctorPayout: splits.doctor_payout,
  });

  // Fetch appointment details for notifications
  const { User, PatientProfile, Hospital } = await import('../../models');
  const appt = await Appointment.findByPk(payment.appointment_id, {
    attributes: ['patient_id', 'doctor_id', 'hospital_id', 'scheduled_at', 'consultation_fee'],
  });

  if (appt) {
    const [doc, hospital, patientUser] = await Promise.all([
      DoctorProfile.findByPk(appt.doctor_id, { attributes: ['full_name'] }),
      Hospital.findByPk(appt.hospital_id, { attributes: ['name'] }),
      User.findByPk(appt.patient_id, {
        include: [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name', 'email'] }],
      }),
    ]);

    const doctorName  = doc?.full_name ?? 'Doctor';
    const hospitalName = (hospital as any)?.name ?? '—';
    const patientProfile = (patientUser as any)?.patientProfile;
    const patientName = patientProfile?.full_name ?? 'Patient';
    const patientEmail = patientProfile?.email as string | undefined;

    // SMS + push notification
    await enqueueNotification({
      userId:        appt.patient_id,
      appointmentId: String(payment.appointment_id),
      type:          'payment_successful',
      channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
      priority:      'high',
      data: { amount: Number(payment.amount), doctor: doctorName },
    });

    void patientName;
    void patientEmail;
  }
  await incrementCounter('payments:success');

  return ok({ message: 'Payment confirmed. Appointment is now active.' });
}

// ── Process refund ────────────────────────────────────────────────────────────
export async function processRefund(
  appointmentId: string,
  requesterId:   string,
): Promise<ServiceResponse<{ refund_id: string; amount: number; status: string }>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) return fail('BOOKING_NOT_FOUND', 'Appointment not found.', 404);

  // Only the patient or an admin can trigger a refund
  if (appointment.patient_id !== requesterId) {
    return fail('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.', 403);
  }

  if (appointment.payment_status !== PaymentStatus.REFUND_PENDING) {
    if (appointment.payment_status === PaymentStatus.REFUNDED) {
      return fail('PAYMENT_ALREADY_REFUNDED', 'Refund already processed.', 409);
    }
    return fail('PAYMENT_REFUND_NOT_ELIGIBLE', 'This appointment is not eligible for a refund.', 422);
  }

  const payment = await Payment.findOne({ where: { appointment_id: appointmentId } });
  if (!payment || !payment.razorpay_payment_id) {
    return fail('PAYMENT_NOT_FOUND', 'No captured payment found for this appointment.', 404);
  }

  if (payment.status === PaymentGatewayStatus.REFUNDED) {
    return fail('PAYMENT_ALREADY_REFUNDED', 'Refund already processed.', 409);
  }

  const refundAmount = Number(payment.amount);

  if (env.NODE_ENV === 'development') {
    // Skip real Razorpay call in dev — simulate success
    logger.debug('💸  [DEV] Simulating refund', { appointmentId, amount: refundAmount });
    await sequelize.transaction(async (t) => {
      await payment.update(
        { status: PaymentGatewayStatus.REFUNDED, refunded_at: new Date(), refund_amount: refundAmount },
        { transaction: t },
      );
      await appointment.update({ payment_status: PaymentStatus.REFUNDED }, { transaction: t });
    });

    const doctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
    await enqueueNotification({
      userId: appointment.patient_id,
      appointmentId,
      type: 'refund_initiated',
      channels: [NotificationChannel.SMS, NotificationChannel.PUSH],
      priority: 'high',
      data: { amount: refundAmount, txnId: payment.razorpay_payment_id, doctor: doctor?.full_name ?? 'Doctor' },
    });

    await incrementCounter('payments:refunds');
    logger.info('Refund simulated (dev)', { appointmentId, amount: refundAmount });
    return ok({ refund_id: `refund_dev_${Date.now()}`, amount: refundAmount, status: 'processed' });
  }

  // Call Razorpay refund API
  const razorpay = getRazorpay();
  const refund = await razorpay.payments.refund(payment.razorpay_payment_id, {
    amount: Math.round(refundAmount * 100), // paise
    speed:  'normal',
    notes:  { appointment_id: appointmentId, reason: 'Appointment cancelled' },
  });

  await sequelize.transaction(async (t) => {
    await payment.update(
      {
        status:        PaymentGatewayStatus.REFUNDED,
        refunded_at:   new Date(),
        refund_amount: refundAmount,
      },
      { transaction: t },
    );
    await appointment.update({ payment_status: PaymentStatus.REFUNDED }, { transaction: t });
  });

  const doctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
  await enqueueNotification({
    userId: appointment.patient_id,
    appointmentId,
    type: 'refund_initiated',
    channels: [NotificationChannel.SMS, NotificationChannel.PUSH],
    priority: 'high',
    data: { amount: refundAmount, txnId: refund.id, doctor: doctor?.full_name ?? 'Doctor' },
  });

  await incrementCounter('payments:refunds');
  logger.info('Refund processed', { appointmentId, refundId: refund.id, amount: refundAmount });
  return ok({ refund_id: refund.id, amount: refundAmount, status: refund.status });
}

// ── Razorpay webhook handler — full idempotency pattern ───────────────────────
export async function handleWebhook(
  rawBody:   Buffer,
  signature: string,
  payload:   Record<string, unknown>,
): Promise<ServiceResponse<{ message: string }>> {

  // 1. Verify signature using RAW body
  if (env.RAZORPAY_WEBHOOK_SECRET) {
    const expectedSig = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (expectedSig !== signature) {
      return fail('WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature.', 400);
    }
  }

  const eventId   = payload['id']   as string;
  const eventType = payload['event']as string;

  if (!eventId) {
    return fail('WEBHOOK_INVALID_PAYLOAD', 'Missing event ID in webhook payload.', 400);
  }

  // 2. Idempotency check — try INSERT, skip if duplicate
  let webhookRecord: WebhookEvent | null = null;
  try {
    webhookRecord = await WebhookEvent.create({
      event_id:      eventId,
      event_type:    eventType,
      payload:       payload as object,
      status:        WebhookStatus.RECEIVED,
      processed_at:  null,
      error_message: null,
    });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      // Duplicate event — already processed or in progress
      logger.info('Webhook duplicate skipped', { eventId, eventType });
      return ok({ message: 'Event already processed.' });
    }
    throw err;
  }

  // 3. Mark as processing
  await webhookRecord.update({ status: WebhookStatus.PROCESSING });

  try {
    await processWebhookEvent(eventType, payload);

    await webhookRecord.update({
      status:       WebhookStatus.PROCESSED,
      processed_at: new Date(),
    });

    logger.info('Webhook processed', { eventId, eventType });
    return ok({ message: 'Webhook processed successfully.' });

  } catch (err) {
    await webhookRecord.update({
      status:        WebhookStatus.FAILED,
      error_message: err instanceof Error ? err.message : String(err),
    });

    logger.error('Webhook processing failed', { eventId, eventType, error: err });
    // CRITICAL: always return ok to prevent Razorpay retrying
    // Let internal alerting handle the failure
    return ok({ message: 'Webhook received.' });
  }
}

// ── Internal event router ─────────────────────────────────────────────────────
async function processWebhookEvent(
  eventType: string,
  payload:   Record<string, unknown>,
): Promise<void> {
  switch (eventType) {
    case 'payment.captured': {
      const paymentEntity = (payload['payload'] as Record<string, unknown>)?.['payment'] as Record<string, unknown> | undefined;
      const entity = (paymentEntity?.['entity'] ?? {}) as Record<string, unknown>;

      const razorpayPaymentId = entity['id']       as string;
      const razorpayOrderId   = entity['order_id'] as string;
      if (!razorpayPaymentId || !razorpayOrderId) return;

      const payment = await Payment.findOne({ where: { razorpay_order_id: razorpayOrderId } });
      if (!payment || payment.status === PaymentGatewayStatus.CAPTURED) return;

      const appointment = await Appointment.findByPk(payment.appointment_id, { attributes: ['consultation_fee'] });
      const splits = calculateFeeSplit(Number(appointment?.consultation_fee ?? payment.amount));
      await sequelize.transaction(async (t) => {
        await payment.update(
          {
            razorpay_payment_id: razorpayPaymentId,
            status:        PaymentGatewayStatus.CAPTURED,
            platform_fee:  splits.platform_fee,
            doctor_payout: splits.doctor_payout,
            captured_at:   new Date(),
          },
          { transaction: t },
        );

        await Appointment.update(
          { status: AppointmentStatus.CONFIRMED, payment_status: PaymentStatus.CAPTURED },
          { where: { id: payment.appointment_id }, transaction: t },
        );
      });
      break;
    }

    case 'payment.failed': {
      const paymentEntity = (payload['payload'] as Record<string, unknown>)?.['payment'] as Record<string, unknown> | undefined;
      const entity = (paymentEntity?.['entity'] ?? {}) as Record<string, unknown>;
      const razorpayOrderId = entity['order_id'] as string;

      if (razorpayOrderId) {
        const payment = await Payment.findOne({ where: { razorpay_order_id: razorpayOrderId } });
        if (payment) {
          await payment.update({ status: PaymentGatewayStatus.FAILED });
          await Appointment.update(
            { payment_status: PaymentStatus.FAILED },
            { where: { id: payment.appointment_id } },
          );
        }
      }
      break;
    }

    case 'payment.refunded': {
      const paymentEntity = (payload['payload'] as Record<string, unknown>)?.['payment'] as Record<string, unknown> | undefined;
      const entity = (paymentEntity?.['entity'] ?? {}) as Record<string, unknown>;
      const razorpayPaymentId = entity['id'] as string;
      const refundedAmount    = ((entity['amount_refunded'] as number) ?? 0) / 100;

      if (razorpayPaymentId) {
        const payment = await Payment.findOne({ where: { razorpay_payment_id: razorpayPaymentId } });
        if (payment && payment.status !== PaymentGatewayStatus.REFUNDED) {
          await sequelize.transaction(async (t) => {
            await payment.update(
              { status: PaymentGatewayStatus.REFUNDED, refunded_at: new Date(), refund_amount: refundedAmount },
              { transaction: t },
            );
            await Appointment.update(
              { payment_status: PaymentStatus.REFUNDED },
              { where: { id: payment.appointment_id }, transaction: t },
            );
          });
          await incrementCounter('payments:refunds');
          logger.info('Refund confirmed via webhook', { paymentId: payment.id, amount: refundedAmount });
        }
      }
      break;
    }

    default:
      logger.debug('Unhandled webhook event type', { eventType });
  }
}

// ── Payment receipt (PDF) ─────────────────────────────────────────────────────
export async function getPaymentReceipt(
  paymentId: string,
  patientId: string,
): Promise<ServiceResponse<Buffer>> {
  const { User, PatientProfile, Hospital } = await import('../../models');

  const payment = await Payment.findByPk(paymentId);
  if (!payment) return fail('PAYMENT_NOT_FOUND', 'Payment not found.', 404);
  if (payment.status !== PaymentGatewayStatus.CAPTURED) {
    return fail('PAYMENT_NOT_CAPTURED', 'Receipt is only available for completed payments.', 422);
  }

  const appt = await Appointment.findByPk(payment.appointment_id, {
    attributes: ['patient_id', 'doctor_id', 'hospital_id', 'scheduled_at', 'consultation_fee'],
  });
  if (!appt) return fail('BOOKING_NOT_FOUND', 'Appointment not found.', 404);
  if (appt.patient_id !== patientId) return fail('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.', 403);

  const [doc, hospital, patientUser] = await Promise.all([
    DoctorProfile.findByPk(appt.doctor_id, { attributes: ['full_name'] }),
    Hospital.findByPk(appt.hospital_id,    { attributes: ['name'] }),
    User.findByPk(appt.patient_id, {
      include: [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name'] }],
    }),
  ]);

  const capturedAt    = payment.captured_at ?? new Date();
  const invoiceDate   = new Date(capturedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  const apptDate      = new Date(appt.scheduled_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const invoiceNumber = `INV-${new Date(capturedAt).toISOString().slice(0, 10).replace(/-/g, '')}-${String(payment.appointment_id).slice(0, 8).toUpperCase()}`;
  const charges       = calculatePaymentCharges(Number(appt.consultation_fee));

  const { generateReceiptPdf } = await import('../../utils/receiptPdf');
  const pdfBuffer = await generateReceiptPdf({
    invoiceNumber,
    invoiceDate,
    patientName:     (patientUser as any)?.patientProfile?.full_name ?? 'Patient',
    doctor:          doc?.full_name ?? 'Doctor',
    hospital:        (hospital as any)?.name ?? '—',
    appointmentDate: apptDate,
    amount:          Number(payment.amount),
    txnId:           payment.razorpay_payment_id ?? '—',
    gstin:           env.COMPANY_GSTIN,
    address:         env.COMPANY_ADDRESS,
    charges,
  });

  return ok(pdfBuffer);
}

// ── Payment history for a patient ─────────────────────────────────────────────
export async function getPaymentHistory(
  patientId: string,
  page      = 1,
  per_page  = 20,
): Promise<ServiceResponse<{ data: object[]; total: number }>> {
  const { Hospital } = await import('../../models');

  // All appointments for this patient
  const appts = await Appointment.findAll({
    where:      { patient_id: patientId },
    attributes: ['id', 'scheduled_at', 'appointment_type', 'doctor_id', 'hospital_id'],
  });

  if (!appts.length) return ok({ data: [], total: 0 });

  const apptIds   = appts.map((a) => a.id);
  const apptMap   = new Map(appts.map((a) => [String(a.id), a]));

  const statusFilter = { [Op.in]: [PaymentGatewayStatus.CAPTURED, PaymentGatewayStatus.REFUNDED] };

  const [total, payments] = await Promise.all([
    Payment.count({ where: { appointment_id: { [Op.in]: apptIds }, status: statusFilter } }),
    Payment.findAll({
      where:   { appointment_id: { [Op.in]: apptIds }, status: statusFilter },
      order:   [['created_at', 'DESC']],
      limit:   per_page,
      offset:  (page - 1) * per_page,
    }),
  ]);

  if (!payments.length) return ok({ data: [], total });

  // Fetch doctor + hospital info in bulk
  const doctorIds   = [...new Set(appts.map((a) => a.doctor_id))];
  const hospitalIds = [...new Set(appts.map((a) => a.hospital_id))];

  const [doctors, hospitals] = await Promise.all([
    DoctorProfile.findAll({ where: { id: { [Op.in]: doctorIds } }, attributes: ['id', 'full_name', 'specialization'] }),
    Hospital.findAll({ where: { id: { [Op.in]: hospitalIds } }, attributes: ['id', 'name'] }),
  ]);

  const doctorMap   = new Map(doctors.map((d) => [d.id, d]));
  const hospitalMap = new Map((hospitals as any[]).map((h) => [h.id, h]));

  const data = payments.map((p) => {
    const appt     = apptMap.get(String(p.appointment_id));
    const doctor   = appt ? doctorMap.get(appt.doctor_id)     : null;
    const hospital = appt ? hospitalMap.get(appt.hospital_id) : null;
    return {
      id:                  p.id,
      amount:              Number(p.amount),
      currency:            p.currency,
      status:              p.status,
      razorpay_payment_id: p.razorpay_payment_id,
      captured_at:         p.captured_at,
      refunded_at:         p.refunded_at,
      refund_amount:       p.refund_amount ? Number(p.refund_amount) : null,
      appointment: appt ? {
        id:               appt.id,
        scheduled_at:     appt.scheduled_at,
        appointment_type: appt.appointment_type,
      } : null,
      doctor:   doctor   ? { full_name: (doctor as any).full_name,   specialization: (doctor as any).specialization } : null,
      hospital: hospital ? { name: (hospital as any).name } : null,
    };
  });

  return ok({ data, total });
}
