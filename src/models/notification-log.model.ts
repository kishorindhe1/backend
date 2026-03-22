import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum NotificationChannel {
  SMS   = 'sms',
  PUSH  = 'push',
  EMAIL = 'email',
}

export enum NotificationStatus {
  QUEUED    = 'queued',
  SENT      = 'sent',
  DELIVERED = 'delivered',
  FAILED    = 'failed',
  BOUNCED   = 'bounced',
  OPTED_OUT = 'opted_out',
}

export class NotificationLog extends Model<
  InferAttributes<NotificationLog>,
  InferCreationAttributes<NotificationLog>
> {
  declare id:               CreationOptional<string>;
  declare user_id:          ForeignKey<string>;
  declare appointment_id:   string | null;
  declare notification_type:string;               // 'booking_confirmed', 'doctor_late', etc.
  declare channel:          NotificationChannel;
  declare recipient:        string;               // phone / device token / email
  declare rendered_body:    string;               // actual message sent
  declare provider:         string | null;        // 'msg91', 'twilio', 'fcm'
  declare provider_msg_id:  string | null;
  declare status:           CreationOptional<NotificationStatus>;
  declare attempt_count:    CreationOptional<number>;
  declare last_attempt_at:  Date | null;
  declare delivered_at:     Date | null;
  declare failure_reason:   string | null;
  declare created_at:       CreationOptional<Date>;
  declare updated_at:       CreationOptional<Date>;
}

NotificationLog.init(
  {
    id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    user_id:  { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    appointment_id:    { type: DataTypes.UUID, allowNull: true },
    notification_type: { type: DataTypes.STRING(100), allowNull: false },
    channel: {
      type: DataTypes.ENUM(...Object.values(NotificationChannel)),
      allowNull: false,
    },
    recipient:       { type: DataTypes.STRING(300), allowNull: false },
    rendered_body:   { type: DataTypes.TEXT,        allowNull: false },
    provider:        { type: DataTypes.STRING(50),  allowNull: true },
    provider_msg_id: { type: DataTypes.STRING(200), allowNull: true },
    status: {
      type: DataTypes.ENUM(...Object.values(NotificationStatus)),
      allowNull: false, defaultValue: NotificationStatus.QUEUED,
    },
    attempt_count:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    last_attempt_at: { type: DataTypes.DATE,    allowNull: true },
    delivered_at:    { type: DataTypes.DATE,    allowNull: true },
    failure_reason:  { type: DataTypes.TEXT,    allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'notification_logs',
    modelName: 'NotificationLog',
    indexes: [
      { fields: ['user_id'] },
      { fields: ['appointment_id'] },
      { fields: ['status'] },
      { fields: ['notification_type'] },
    ],
  },
);
