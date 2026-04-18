import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum DayOfWeek {
  MONDAY    = 'monday',
  TUESDAY   = 'tuesday',
  WEDNESDAY = 'wednesday',
  THURSDAY  = 'thursday',
  FRIDAY    = 'friday',
  SATURDAY  = 'saturday',
  SUNDAY    = 'sunday',
}

export enum SessionType {
  OPD       = 'opd',
  EMERGENCY = 'emergency',
  SURGERY   = 'surgery',
}

export enum ScheduleBookingMode {
  FIXED_SLOTS = 'fixed_slots',
  GAP_BASED   = 'gap_based',
}

export class Schedule extends Model<
  InferAttributes<Schedule>,
  InferCreationAttributes<Schedule>
> {
  declare id:               CreationOptional<string>;
  declare doctor_id:        ForeignKey<string>;   // → doctor_profiles.id
  declare hospital_id:      ForeignKey<string>;
  declare day_of_week:      DayOfWeek;
  declare start_time:       string;               // "09:00"
  declare end_time:         string;               // "13:00"
  declare slot_duration_minutes: number;
  declare max_patients:     number;
  declare session_type:     CreationOptional<SessionType>;
  declare effective_from:          Date;
  declare effective_until:         Date | null;
  declare booking_mode:            CreationOptional<ScheduleBookingMode>;
  declare buffer_minutes:          CreationOptional<number>;
  declare end_buffer_minutes:      CreationOptional<number>;
  declare emergency_reserve_slots: CreationOptional<number>;
  declare is_active:               CreationOptional<boolean>;
  declare created_at:              CreationOptional<Date>;
  declare updated_at:              CreationOptional<Date>;
}

Schedule.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },

    day_of_week:            { type: DataTypes.ENUM(...Object.values(DayOfWeek)), allowNull: false },
    start_time:             { type: DataTypes.STRING(5),  allowNull: false },  // HH:MM
    end_time:               { type: DataTypes.STRING(5),  allowNull: false },
    slot_duration_minutes:  { type: DataTypes.INTEGER,    allowNull: false, defaultValue: 20 },
    max_patients:           { type: DataTypes.INTEGER,    allowNull: false, defaultValue: 20 },
    session_type: {
      type: DataTypes.ENUM(...Object.values(SessionType)),
      allowNull: false, defaultValue: SessionType.OPD,
    },

    effective_from:  { type: DataTypes.DATEONLY, allowNull: false },
    effective_until: { type: DataTypes.DATEONLY, allowNull: true },
    booking_mode: {
      type: DataTypes.ENUM(...Object.values(ScheduleBookingMode)),
      allowNull: false, defaultValue: ScheduleBookingMode.FIXED_SLOTS,
    },
    buffer_minutes:          { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    end_buffer_minutes:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    emergency_reserve_slots: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    is_active:               { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'schedules',
    modelName: 'Schedule',
    indexes: [
      { fields: ['doctor_id'] },
      { fields: ['hospital_id'] },
      { fields: ['doctor_id', 'hospital_id', 'day_of_week'] },
    ],
  },
);

