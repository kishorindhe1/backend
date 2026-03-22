import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class DoctorReview extends Model<
  InferAttributes<DoctorReview>,
  InferCreationAttributes<DoctorReview>
> {
  declare id:             CreationOptional<string>;
  declare patient_id:     ForeignKey<string>;
  declare doctor_id:      ForeignKey<string>;
  declare appointment_id: ForeignKey<string> | null;
  declare rating:         number;
  declare comment:        string | null;
  declare created_at:     CreationOptional<Date>;
  declare updated_at:     CreationOptional<Date>;
}

DoctorReview.init(
  {
    id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    patient_id:     { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    doctor_id:      { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    appointment_id: { type: DataTypes.UUID, allowNull: true,  references: { model: 'appointments', key: 'id' } },
    rating:         { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
    comment:        { type: DataTypes.TEXT, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName:  'doctor_reviews',
    modelName:  'DoctorReview',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['doctor_id'] },
      { fields: ['patient_id'] },
    ],
  },
);
