import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

// ── Payment ───────────────────────────────────────────────────────────────────
export enum PaymentGatewayStatus {
  CREATED   = 'created',
  CAPTURED  = 'captured',
  FAILED    = 'failed',
  REFUNDED  = 'refunded',
}

export class Payment extends Model<
  InferAttributes<Payment>,
  InferCreationAttributes<Payment>
> {
  declare id:                    CreationOptional<string>;
  declare appointment_id:        ForeignKey<string>;
  declare razorpay_order_id:     string;
  declare razorpay_payment_id:   string | null;   // UNIQUE — idempotency guard
  declare amount:                number;           // full amount patient paid
  declare platform_fee:          number;           // 2%
  declare doctor_payout:         number;           // 98%
  declare currency:              CreationOptional<string>;
  declare status:                CreationOptional<PaymentGatewayStatus>;
  declare captured_at:           Date | null;
  declare refunded_at:           Date | null;
  declare refund_amount:         number | null;
  declare created_at:            CreationOptional<Date>;
  declare updated_at:            CreationOptional<Date>;
}

Payment.init(
  {
    id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    appointment_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'appointments', key: 'id' } },

    razorpay_order_id:   { type: DataTypes.STRING(100), allowNull: false },
    razorpay_payment_id: { type: DataTypes.STRING(100), allowNull: true, unique: true },

    amount:        { type: DataTypes.DECIMAL(10,2), allowNull: false },
    platform_fee:  { type: DataTypes.DECIMAL(10,2), allowNull: false },
    doctor_payout: { type: DataTypes.DECIMAL(10,2), allowNull: false },
    currency:      { type: DataTypes.STRING(3),     allowNull: false, defaultValue: 'INR' },

    status: {
      type: DataTypes.ENUM(...Object.values(PaymentGatewayStatus)),
      allowNull: false, defaultValue: PaymentGatewayStatus.CREATED,
    },
    captured_at:   { type: DataTypes.DATE,       allowNull: true },
    refunded_at:   { type: DataTypes.DATE,       allowNull: true },
    refund_amount: { type: DataTypes.DECIMAL(10,2), allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'payments',
    modelName: 'Payment',
    indexes: [
      { fields: ['appointment_id'] },
      { fields: ['razorpay_order_id'] },
      { unique: true, fields: ['razorpay_payment_id'] },
    ],
  },
);

// ── Webhook events — idempotency table ────────────────────────────────────────
export enum WebhookStatus {
  RECEIVED    = 'received',
  PROCESSING  = 'processing',
  PROCESSED   = 'processed',
  FAILED      = 'failed',
}

export class WebhookEvent extends Model<
  InferAttributes<WebhookEvent>,
  InferCreationAttributes<WebhookEvent>
> {
  declare id:           CreationOptional<string>;
  declare event_id:     string;        // Razorpay event ID — UNIQUE
  declare event_type:   string;        // 'payment.captured' etc.
  declare payload:      object;
  declare status:       CreationOptional<WebhookStatus>;
  declare processed_at: Date | null;
  declare error_message:string | null;
  declare created_at:   CreationOptional<Date>;
  declare updated_at:   CreationOptional<Date>;
}

WebhookEvent.init(
  {
    id:        { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    event_id:  { type: DataTypes.STRING(100), allowNull: false, unique: true },
    event_type:{ type: DataTypes.STRING(100), allowNull: false },
    payload:   { type: DataTypes.JSONB,       allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(WebhookStatus)),
      allowNull: false, defaultValue: WebhookStatus.RECEIVED,
    },
    processed_at:  { type: DataTypes.DATE, allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'webhook_events',
    modelName: 'WebhookEvent',
    indexes: [
      { unique: true, fields: ['event_id'] },
      { fields: ['status'] },
      { fields: ['event_type'] },
    ],
  },
);

