import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum OpdTokenType {
  ONLINE    = 'online',
  WALKIN    = 'walkin',
  BULK      = 'bulk',
  EMERGENCY = 'emergency',
  VIP       = 'vip',
}

export enum OpdTokenStatus {
  ISSUED      = 'issued',
  ARRIVED     = 'arrived',
  WAITING     = 'waiting',
  CALLED      = 'called',
  IN_PROGRESS = 'in_progress',
  COMPLETED   = 'completed',
  SKIPPED     = 'skipped',
  CANCELLED   = 'cancelled',
  NO_SHOW     = 'no_show',
}

export class OpdToken extends Model<
  InferAttributes<OpdToken>,
  InferCreationAttributes<OpdToken>
> {
  declare id:              CreationOptional<string>;
  declare session_id:      ForeignKey<string>;
  declare token_number:    number;
  declare patient_id:      ForeignKey<string> | null;
  declare appointment_id:  ForeignKey<string> | null;
  declare token_type:      CreationOptional<OpdTokenType>;
  declare issued_at:       CreationOptional<Date>;
  declare issued_by:       string;                   // 'online_booking' | 'receptionist'
  declare arrived_at:      Date | null;
  declare called_at:       Date | null;
  declare consultation_start: Date | null;
  declare consultation_end:   Date | null;
  declare status:          CreationOptional<OpdTokenStatus>;
  declare created_at:      CreationOptional<Date>;
  declare updated_at:      CreationOptional<Date>;
}

OpdToken.init(
  {
    id:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    session_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'opd_sessions', key: 'id' } },
    token_number: { type: DataTypes.INTEGER, allowNull: false },
    patient_id:   { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
    appointment_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'appointments', key: 'id' } },
    token_type: {
      type: DataTypes.ENUM(...Object.values(OpdTokenType)),
      allowNull: false, defaultValue: OpdTokenType.ONLINE,
    },
    issued_at:  { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    issued_by:  { type: DataTypes.STRING(50), allowNull: false },
    arrived_at:         { type: DataTypes.DATE, allowNull: true },
    called_at:          { type: DataTypes.DATE, allowNull: true },
    consultation_start: { type: DataTypes.DATE, allowNull: true },
    consultation_end:   { type: DataTypes.DATE, allowNull: true },
    status: {
      type: DataTypes.ENUM(...Object.values(OpdTokenStatus)),
      allowNull: false, defaultValue: OpdTokenStatus.ISSUED,
    },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'opd_tokens',
    modelName: 'OpdToken',
    indexes: [
      { unique: true, fields: ['session_id', 'token_number'] },
      { fields: ['session_id', 'status'] },
      { fields: ['patient_id'] },
    ],
  },
);
