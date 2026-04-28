import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export type DurationSetByRole = 'doctor' | 'receptionist';

export class PatientDoctorDuration extends Model<
  InferAttributes<PatientDoctorDuration>,
  InferCreationAttributes<PatientDoctorDuration>
> {
  declare id:               CreationOptional<string>;
  declare patient_id:       ForeignKey<string>;
  declare doctor_id:        ForeignKey<string>;
  declare duration_minutes: number;
  declare set_by_user_id:   ForeignKey<string>;
  declare set_by_role:      DurationSetByRole;
  declare set_at:           CreationOptional<Date>;
  declare notes:            string | null;
  declare created_at:       CreationOptional<Date>;
  declare updated_at:       CreationOptional<Date>;
}

PatientDoctorDuration.init(
  {
    id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    patient_id:       { type: DataTypes.UUID, allowNull: false, references: { model: 'users',           key: 'id' } },
    doctor_id:        { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    duration_minutes: { type: DataTypes.INTEGER, allowNull: false },
    set_by_user_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    set_by_role:      {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: { isIn: [['doctor', 'receptionist']] },
    },
    set_at:  { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    notes:   { type: DataTypes.TEXT, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'patient_doctor_durations',
    modelName: 'PatientDoctorDuration',
    indexes: [
      { unique: true, fields: ['patient_id', 'doctor_id'] },
      { fields: ['doctor_id'] },
    ],
  },
);
