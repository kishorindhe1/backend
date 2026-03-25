import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum AdminAction {
  DOCTOR_SUSPENDED        = 'doctor_suspended',
  DOCTOR_REACTIVATED      = 'doctor_reactivated',
  DOCTOR_VERIFIED         = 'doctor_verified',
  DOCTOR_REJECTED         = 'doctor_rejected',
  HOSPITAL_SUSPENDED      = 'hospital_suspended',
  HOSPITAL_ACTIVATED      = 'hospital_activated',
  HOSPITAL_STATUS_CHANGED = 'hospital_status_changed',
  PATIENT_SUSPENDED       = 'patient_suspended',
  PATIENT_ACTIVATED       = 'patient_activated',
  APPOINTMENT_CANCELLED   = 'appointment_cancelled',
}

export class AdminAuditLog extends Model<
  InferAttributes<AdminAuditLog>,
  InferCreationAttributes<AdminAuditLog>
> {
  declare id:            CreationOptional<string>;
  declare admin_id:      ForeignKey<string>;       // → users.id
  declare action:        AdminAction;
  declare resource_type: string;                   // 'doctor' | 'hospital' | 'patient' | 'appointment'
  declare resource_id:   string;
  declare meta:          object | null;            // before/after state, notes
  declare ip_address:    string | null;
  declare created_at:    CreationOptional<Date>;
}

AdminAuditLog.init(
  {
    id:            { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    admin_id:      { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    action:        { type: DataTypes.ENUM(...Object.values(AdminAction)), allowNull: false },
    resource_type: { type: DataTypes.STRING(50), allowNull: false },
    resource_id:   { type: DataTypes.UUID, allowNull: false },
    meta:          { type: DataTypes.JSONB, allowNull: true },
    ip_address:    { type: DataTypes.STRING(45), allowNull: true },
    created_at:    DataTypes.DATE,
  },
  {
    sequelize,
    tableName:  'admin_audit_logs',
    modelName:  'AdminAuditLog',
    updatedAt:  false,
    indexes: [
      { fields: ['admin_id'] },
      { fields: ['resource_type', 'resource_id'] },
      { fields: ['action'] },
      { fields: ['created_at'] },
    ],
  },
);
