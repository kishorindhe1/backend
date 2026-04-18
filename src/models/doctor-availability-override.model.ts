import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum OverrideType {
  LATE_START    = 'late_start',
  EARLY_END     = 'early_end',
  DAY_OFF       = 'day_off',
  EXTRA_HOURS   = 'extra_hours',
  BREAK         = 'break',
  RUNNING_LATE  = 'running_late',
}

export class DoctorAvailabilityOverride extends Model<
  InferAttributes<DoctorAvailabilityOverride>,
  InferCreationAttributes<DoctorAvailabilityOverride>
> {
  declare id:             CreationOptional<string>;
  declare doctor_id:      ForeignKey<string>;
  declare hospital_id:    ForeignKey<string>;
  declare date:           string;             // YYYY-MM-DD
  declare override_type:  OverrideType;
  declare start_time:     string | null;      // HH:MM — for late_start, extra_hours, break
  declare end_time:       string | null;      // HH:MM — for early_end, extra_hours, break
  declare delay_minutes:  number | null;      // for running_late
  declare reason:         string | null;
  declare created_by:     ForeignKey<string>; // receptionist user_id
  declare created_at:     CreationOptional<Date>;
  declare updated_at:     CreationOptional<Date>;
}

DoctorAvailabilityOverride.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },
    created_by:  { type: DataTypes.UUID, allowNull: false, references: { model: 'users',           key: 'id' } },

    date: { type: DataTypes.DATEONLY, allowNull: false },
    override_type: {
      type: DataTypes.ENUM(...Object.values(OverrideType)),
      allowNull: false,
    },
    start_time:    { type: DataTypes.STRING(5),   allowNull: true },
    end_time:      { type: DataTypes.STRING(5),   allowNull: true },
    delay_minutes: { type: DataTypes.INTEGER,     allowNull: true },
    reason:        { type: DataTypes.STRING(300), allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'doctor_availability_overrides',
    modelName: 'DoctorAvailabilityOverride',
    indexes: [
      { fields: ['doctor_id', 'date'] },
      { fields: ['hospital_id', 'date'] },
    ],
  },
);
