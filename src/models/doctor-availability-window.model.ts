import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';
import { DayOfWeek } from './schedule.model';

export enum WindowBookingMode {
  FIXED_SLOTS = 'fixed_slots',
  GAP_BASED   = 'gap_based',
}

export class DoctorAvailabilityWindow extends Model<
  InferAttributes<DoctorAvailabilityWindow>,
  InferCreationAttributes<DoctorAvailabilityWindow>
> {
  declare id:             CreationOptional<string>;
  declare doctor_id:      ForeignKey<string>;
  declare hospital_id:    ForeignKey<string>;
  declare day_of_week:    DayOfWeek;
  declare window_start:   string;   // HH:MM
  declare window_end:     string;   // HH:MM
  declare booking_mode:   CreationOptional<WindowBookingMode>;
  declare effective_from: string;   // YYYY-MM-DD
  declare effective_until: string | null;
  declare is_active:      CreationOptional<boolean>;
  declare created_at:     CreationOptional<Date>;
  declare updated_at:     CreationOptional<Date>;
}

DoctorAvailabilityWindow.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },

    day_of_week:   { type: DataTypes.ENUM(...Object.values(DayOfWeek)), allowNull: false },
    window_start:  { type: DataTypes.STRING(5), allowNull: false },
    window_end:    { type: DataTypes.STRING(5), allowNull: false },
    booking_mode: {
      type: DataTypes.ENUM(...Object.values(WindowBookingMode)),
      allowNull: false, defaultValue: WindowBookingMode.FIXED_SLOTS,
    },
    effective_from:  { type: DataTypes.DATEONLY, allowNull: false },
    effective_until: { type: DataTypes.DATEONLY, allowNull: true },
    is_active:       { type: DataTypes.BOOLEAN,  allowNull: false, defaultValue: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'doctor_availability_windows',
    modelName: 'DoctorAvailabilityWindow',
    indexes: [
      { fields: ['doctor_id', 'hospital_id'] },
      { fields: ['doctor_id', 'day_of_week'] },
      { fields: ['is_active'] },
    ],
  },
);
