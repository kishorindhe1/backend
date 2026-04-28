import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class PatientDoctorDurationHistory extends Model<
  InferAttributes<PatientDoctorDurationHistory>,
  InferCreationAttributes<PatientDoctorDurationHistory>
> {
  declare id:                         CreationOptional<string>;
  declare patient_doctor_duration_id: ForeignKey<string>;
  declare old_duration:               number;
  declare new_duration:               number;
  declare changed_by_user_id:         ForeignKey<string>;
  declare changed_by_role:            string;
  declare changed_at:                 CreationOptional<Date>;
  declare reason:                     string | null;
  declare created_at:                 CreationOptional<Date>;
  declare updated_at:                 CreationOptional<Date>;
}

PatientDoctorDurationHistory.init(
  {
    id:                         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    patient_doctor_duration_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'patient_doctor_durations', key: 'id' } },
    old_duration:               { type: DataTypes.INTEGER, allowNull: false },
    new_duration:               { type: DataTypes.INTEGER, allowNull: false },
    changed_by_user_id:         { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    changed_by_role:            { type: DataTypes.STRING(20), allowNull: false },
    changed_at:                 { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    reason:                     { type: DataTypes.TEXT, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'patient_doctor_duration_history',
    modelName: 'PatientDoctorDurationHistory',
    indexes: [
      { fields: ['patient_doctor_duration_id'] },
    ],
  },
);
