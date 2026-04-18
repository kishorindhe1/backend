import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class DoctorBookingPreference extends Model<
  InferAttributes<DoctorBookingPreference>,
  InferCreationAttributes<DoctorBookingPreference>
> {
  declare id:                         CreationOptional<string>;
  declare doctor_id:                  ForeignKey<string>;
  declare hospital_id:                ForeignKey<string>;
  declare min_booking_lead_hours:     CreationOptional<number>;
  declare booking_cutoff_hours:       CreationOptional<number>;
  declare max_new_patients_per_day:   number | null;
  declare max_followups_per_day:      number | null;
  declare new_patient_slot_positions: object | null;  // JSON array e.g. [1,2,3,4]
  declare followup_slot_positions:    object | null;  // JSON array e.g. [5,6,7,8]
  declare requires_booking_approval:  CreationOptional<boolean>;
  declare approval_timeout_hours:     CreationOptional<number>;
  declare default_slot_duration:      number | null;
  declare notes_for_patients:         string | null;
  declare created_at:                 CreationOptional<Date>;
  declare updated_at:                 CreationOptional<Date>;
}

DoctorBookingPreference.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },

    min_booking_lead_hours:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    booking_cutoff_hours:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    max_new_patients_per_day:   { type: DataTypes.INTEGER, allowNull: true },
    max_followups_per_day:      { type: DataTypes.INTEGER, allowNull: true },
    new_patient_slot_positions: { type: DataTypes.JSONB,   allowNull: true },
    followup_slot_positions:    { type: DataTypes.JSONB,   allowNull: true },
    requires_booking_approval:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    approval_timeout_hours:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
    default_slot_duration:      { type: DataTypes.INTEGER, allowNull: true },
    notes_for_patients:         { type: DataTypes.TEXT,    allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'doctor_booking_preferences',
    modelName: 'DoctorBookingPreference',
    indexes: [
      { unique: true, fields: ['doctor_id', 'hospital_id'] },
    ],
  },
);
