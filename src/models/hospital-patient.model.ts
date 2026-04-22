import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class HospitalPatient extends Model<
  InferAttributes<HospitalPatient>,
  InferCreationAttributes<HospitalPatient>
> {
  declare id:             CreationOptional<string>;
  declare hospital_id:    ForeignKey<string>;
  declare patient_id:     ForeignKey<string>;
  declare first_visit_at: string;   // YYYY-MM-DD
  declare last_visit_at:  string;   // YYYY-MM-DD
  declare total_visits:   CreationOptional<number>;
  declare notes:          string | null;
  declare created_at:     CreationOptional<Date>;
  declare updated_at:     CreationOptional<Date>;
}

HospitalPatient.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' } },
    patient_id:  { type: DataTypes.UUID, allowNull: false, references: { model: 'users',     key: 'id' } },
    first_visit_at: { type: DataTypes.DATEONLY, allowNull: false },
    last_visit_at:  { type: DataTypes.DATEONLY, allowNull: false },
    total_visits:   { type: DataTypes.INTEGER,  allowNull: false, defaultValue: 1 },
    notes:          { type: DataTypes.TEXT,     allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'hospital_patients',
    modelName: 'HospitalPatient',
    indexes: [
      { unique: true, fields: ['hospital_id', 'patient_id'], name: 'hospital_patients_unique' },
      { fields: ['hospital_id'] },
      { fields: ['patient_id']  },
    ],
  },
);
