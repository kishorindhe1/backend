import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class NoShowLog extends Model<
  InferAttributes<NoShowLog>,
  InferCreationAttributes<NoShowLog>
> {
  declare id:                   CreationOptional<string>;
  declare appointment_id:       ForeignKey<string>;
  declare patient_id:           ForeignKey<string>;
  declare doctor_id:            ForeignKey<string>;
  declare slot_id:              ForeignKey<string> | null;
  declare grace_period_minutes: CreationOptional<number>;
  declare marked_by:            string;   // user_id or 'system'
  declare created_at:           CreationOptional<Date>;
  declare updated_at:           CreationOptional<Date>;
}

NoShowLog.init(
  {
    id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    appointment_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'appointments',   key: 'id' } },
    patient_id:     { type: DataTypes.UUID, allowNull: false, references: { model: 'users',          key: 'id' } },
    doctor_id:      { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    slot_id:        { type: DataTypes.UUID, allowNull: true },

    grace_period_minutes: { type: DataTypes.INTEGER,     allowNull: false, defaultValue: 15 },
    marked_by:            { type: DataTypes.STRING(100), allowNull: false },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'no_show_logs',
    modelName: 'NoShowLog',
    indexes: [
      { fields: ['patient_id'] },
      { fields: ['doctor_id'] },
      { fields: ['appointment_id'] },
    ],
  },
);
