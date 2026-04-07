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
import { sendEmail }       from '../../utils/smsProvider';
import { buildGstInvoiceHtml, gstInvoiceSubject } from '../../utils/notificationTemplates';

function getRazorpay() {
  return new Razorpay({ key_id: env.RAZORPAY_KEY_ID!, key_secret: env.RAZORPAY_KEY_SECRET! });
}

// ── Fee split helper (same rule as appointment service) ───────────────────────
function calculateFeeSplit(amount: number) {
  const platform_fee  = Math.round(amount * (env.PLATFORM_FEE_PERCENTAGE / 100) * 100) / 100;
  const doctor_payout = amount - platform_fee;
  return { platform_fee, doctor_payout };
}

// ── Initiate payment — create Razorpay order ──────────────────────────────────
export async function initiatePayment(
  appointmentId: string,
  patientId:     string,
): Promise<ServiceResponse<{ order_id: string; amount: number; currency: string; key_id: string }>> {
  const appointment = await Appointment.findByPk(appointmentId);

  if (!appointment) return fail('BOOKING_NOT_FOUND', 'Appointment not found.', 404);
  if (appointment.patient_id !== patientId) return fail('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.', 403);
  if (appointment.payment_status !== PaymentStatus.PENDING) {
    return fail('PAYMENT_ALREADY_PROCESSED', 'Payment already initiated or completed.', 409);
  }

  const amount = Number(appointment.consultation_fee);

  const razorpay = getRazorpay();
  const order = await razorpay.orders.create({
    amount:   Math.round(amount * 100), // paise
    currency: 'INR',
    receipt:  appointmentId,
  });
  const orderId = order.id;

  // Store order ID on appointment
  await appointment.update({ razorpay_order_id: orderId });

  // Create pending payment record
  const splits = calculateFeeSplit(amount);
  await Payment.create({
    appointment_id:      appointmentId,
    razorpay_order_id:   orderId,
    razorpay_payment_id: null,
    amount,
    platform_fee:  splits.platform_fee,
    doctor_payout: splits.doctor_payout,
    currency:      'INR',
    status:        PaymentGatewayStatus.CREATED,
    captured_at:   null,
    refunded_at:   null,
    refund_amount: null,
  });

  logger.info('Payment initiated', { appointmentId, orderId, amount });

  return ok({
    order_id: orderId,
    amount,
    currency: 'INR',
    key_id:   env.RAZORPAY_KEY_ID ?? 'rzp_test_placeholder',
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

  const splits = calculateFeeSplit(Number(payment.amount));

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

    // GST invoice email (only if patient has an email on file)
    if (patientEmail) {
      const invoiceDate    = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
      const appointmentDate = new Date(appt.scheduled_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const invoiceNumber  = `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(payment.appointment_id).slice(0, 8).toUpperCase()}`;

      const html = buildGstInvoiceHtml({
        invoiceNumber,
        invoiceDate,
        patientName,
        doctor:          doctorName,
        hospital:        hospitalName,
        appointmentDate,
        amount:          Number(payment.amount),
        txnId:           razorpay_payment_id,
        gstin:           env.COMPANY_GSTIN,
        address:         env.COMPANY_ADDRESS,
      });

      const plainText = `Tax Invoice ${invoiceNumber}\nDate: ${invoiceDate}\nBilled to: ${patientName}\nDoctor: Dr. ${doctorName}\nHospital: ${hospitalName}\nAppointment: ${appointmentDate}\nAmount Paid: Rs.${Number(payment.amount).toFixed(2)}\nTransaction ID: ${razorpay_payment_id}\nGST: Exempt (SAC 9993 - Healthcare Services)`;

      await sendEmail(patientEmail, gstInvoiceSubject(invoiceNumber), plainText, html)
        .catch((err) => logger.warn('GST invoice email failed', { appointmentId: payment.appointment_id, err }));
    }
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
      const amount            = (entity['amount']  as number) / 100; // paise → rupees

      if (!razorpayPaymentId || !razorpayOrderId) return;

      const payment = await Payment.findOne({ where: { razorpay_order_id: razorpayOrderId } });
      if (!payment || payment.status === PaymentGatewayStatus.CAPTURED) return;

      const splits = calculateFeeSplit(amount);
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
