import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum AppointmentStatus {
  AWAITING_HOSPITAL_APPROVAL = 'awaiting_hospital_approval',
  PENDING    = 'pending',
  CONFIRMED  = 'confirmed',
  DELAYED    = 'delayed',
  IN_PROGRESS= 'in_progress',
  COMPLETED  = 'completed',
  CANCELLED  = 'cancelled',
  MISSED     = 'missed',
  RESCHEDULED= 'rescheduled',
}

export enum PaymentStatus {
  PENDING        = 'pending',
  CAPTURED       = 'captured',
  FAILED         = 'failed',
  REFUND_PENDING = 'refund_pending',
  REFUNDED       = 'refunded',
}

export enum AppointmentType {
  ONLINE_BOOKING = 'online_booking',
  WALK_IN        = 'walk_in',
  EMERGENCY      = 'emergency',
  FOLLOW_UP      = 'follow_up',
}

export enum PaymentMode {
  ONLINE_PREPAID = 'online_prepaid',
  CASH           = 'cash',
  CARD           = 'card',
}

export enum CancellationBy {
  PATIENT = 'patient',
  DOCTOR  = 'doctor',
  ADMIN   = 'admin',
  SYSTEM  = 'system',
}

export enum VisitType {
  NEW_CONSULTATION = 'new_consultation',
  FOLLOW_UP        = 'follow_up',
  TEST_REVIEW      = 'test_review',
  PROCEDURE        = 'procedure',
  EMERGENCY        = 'emergency',
}

export enum PriorityTier {
  EMERGENCY         = 'emergency',
  SENIOR            = 'senior',
  DIFFERENTLY_ABLED = 'differently_abled',
  PREGNANT          = 'pregnant',
  FOLLOW_UP         = 'follow_up',
  REGULAR           = 'regular',
}

export class Appointment extends Model<
  InferAttributes<Appointment>,
  InferCreationAttributes<Appointment>
> {
  declare id:               CreationOptional<string>;
  declare patient_id:       ForeignKey<string>;   // → users.id
  declare doctor_id:        ForeignKey<string>;   // → doctor_profiles.id
  declare hospital_id:      ForeignKey<string>;
  declare slot_id:          ForeignKey<string> | null;  // null for walk-ins

  declare scheduled_at:        Date;
  declare status:              CreationOptional<AppointmentStatus>;
  declare payment_status:      CreationOptional<PaymentStatus>;
  declare appointment_type:    CreationOptional<AppointmentType>;
  declare payment_mode:        CreationOptional<PaymentMode>;

  declare consultation_fee:    number;
  declare platform_fee:        CreationOptional<number>;
  declare doctor_payout:       CreationOptional<number>;

  declare notes:               string | null;
  declare cancellation_reason: string | null;
  declare cancelled_by:        CancellationBy | null;
  declare cancelled_at:        Date | null;

  declare razorpay_order_id:   string | null;

  // Phase 1 additions
  declare chief_complaint:        string | null;
  declare visit_type:             VisitType | null;
  declare visit_subtype:          string | null;       // procedure name for gap-based
  declare procedure_type_id:      string | null;
  declare referred_by_doctor_id:  string | null;
  declare referring_hospital_id:  string | null;
  declare original_doctor_id:     string | null;       // set on substitution
  declare substitution_reason:    string | null;
  declare checked_in_at:          Date | null;
  declare priority_tier:          CreationOptional<PriorityTier>;
  declare priority_reason:        string | null;

  declare created_at:  CreationOptional<Date>;
  declare updated_at:  CreationOptional<Date>;
}

Appointment.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    patient_id:  { type: DataTypes.UUID, allowNull: false, references: { model: 'users',            key: 'id' } },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles',  key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',        key: 'id' } },
    slot_id:     { type: DataTypes.UUID, allowNull: true,  references: { model: 'generated_slots',  key: 'id' } },

    scheduled_at: { type: DataTypes.DATE, allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(AppointmentStatus)),
      allowNull: false, defaultValue: AppointmentStatus.PENDING,
    },
    payment_status: {
      type: DataTypes.ENUM(...Object.values(PaymentStatus)),
      allowNull: false, defaultValue: PaymentStatus.PENDING,
    },
    appointment_type: {
      type: DataTypes.ENUM(...Object.values(AppointmentType)),
      allowNull: false, defaultValue: AppointmentType.ONLINE_BOOKING,
    },
    payment_mode: {
      type: DataTypes.ENUM(...Object.values(PaymentMode)),
      allowNull: false, defaultValue: PaymentMode.ONLINE_PREPAID,
    },

    consultation_fee: { type: DataTypes.DECIMAL(10,2), allowNull: false },
    platform_fee:     { type: DataTypes.DECIMAL(10,2), allowNull: false, defaultValue: 0 },
    doctor_payout:    { type: DataTypes.DECIMAL(10,2), allowNull: false, defaultValue: 0 },

    notes:               { type: DataTypes.TEXT,       allowNull: true },
    cancellation_reason: { type: DataTypes.TEXT,       allowNull: true },
    cancelled_by:        { type: DataTypes.ENUM(...Object.values(CancellationBy)), allowNull: true },
    cancelled_at:        { type: DataTypes.DATE,       allowNull: true },

    razorpay_order_id:   { type: DataTypes.STRING(100), allowNull: true },

    // Phase 1 additions
    chief_complaint:       { type: DataTypes.STRING(500), allowNull: true },
    visit_type: {
      type: DataTypes.ENUM(...Object.values(VisitType)),
      allowNull: true,
    },
    visit_subtype:         { type: DataTypes.STRING(100), allowNull: true },
    procedure_type_id:     { type: DataTypes.UUID,        allowNull: true },
    referred_by_doctor_id: { type: DataTypes.UUID,        allowNull: true },
    referring_hospital_id: { type: DataTypes.UUID,        allowNull: true },
    original_doctor_id:    { type: DataTypes.UUID,        allowNull: true },
    substitution_reason:   { type: DataTypes.STRING(300), allowNull: true },
    checked_in_at:         { type: DataTypes.DATE,        allowNull: true },
    priority_tier: {
      type: DataTypes.ENUM(...Object.values(PriorityTier)),
      allowNull: false, defaultValue: PriorityTier.REGULAR,
    },
    priority_reason:       { type: DataTypes.STRING(200), allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'appointments',
    modelName: 'Appointment',
    indexes: [
      { fields: ['patient_id'] },
      { fields: ['doctor_id'] },
      { fields: ['hospital_id'] },
      { fields: ['status'] },
      { fields: ['scheduled_at'] },
      { fields: ['slot_id'], unique: true },   // one appointment per slot
    ],
  },
);

