import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum RecordType {
  LAB_REPORT   = 'lab_report',
  PRESCRIPTION = 'prescription',
  IMAGING      = 'imaging',
  VACCINATION  = 'vaccination',
  DISCHARGE    = 'discharge',
  OTHER        = 'other',
}

export class HealthRecord extends Model<
  InferAttributes<HealthRecord>,
  InferCreationAttributes<HealthRecord>
> {
  declare id:          CreationOptional<string>;
  declare patient_id:  ForeignKey<string>;
  declare title:       string;
  declare record_type: RecordType;
  declare file_url:    string;
  declare file_name:   string;
  declare file_size:   number | null;
  declare mime_type:   string | null;
  declare notes:       string | null;
  declare record_date: Date | null;
  declare created_at:  CreationOptional<Date>;
  declare updated_at:  CreationOptional<Date>;
}

HealthRecord.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    patient_id:  { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    title:       { type: DataTypes.STRING(200), allowNull: false },
    record_type: { type: DataTypes.ENUM(...Object.values(RecordType)), allowNull: false },
    file_url:    { type: DataTypes.TEXT, allowNull: false },
    file_name:   { type: DataTypes.STRING(255), allowNull: false },
    file_size:   { type: DataTypes.INTEGER, allowNull: true },
    mime_type:   { type: DataTypes.STRING(100), allowNull: true },
    notes:       { type: DataTypes.TEXT, allowNull: true },
    record_date: { type: DataTypes.DATEONLY, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName:  'health_records',
    modelName:  'HealthRecord',
    timestamps: true,
    underscored: true,
    indexes: [{ fields: ['patient_id'] }],
  },
);
