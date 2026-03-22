import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum DelayStatus {
  ACTIVE      = 'active',
  RESOLVED    = 'resolved',
  CANCELLED_DAY = 'cancelled_day',
}

export enum DelayType {
  LATE_ARRIVAL    = 'late_arrival',
  ABSENT          = 'absent',
  EARLY_DEPARTURE = 'early_departure',
}

export class DoctorDelayEvent extends Model<
  InferAttributes<DoctorDelayEvent>,
  InferCreationAttributes<DoctorDelayEvent>
> {
  declare id:               CreationOptional<string>;
  declare doctor_id:        ForeignKey<string>;
  declare hospital_id:      ForeignKey<string>;
  declare event_date:       string;               // YYYY-MM-DD
  declare delay_type:       DelayType;
  declare delay_minutes:    number | null;         // null for full absence
  declare reason:           string | null;
  declare reported_by:      ForeignKey<string>;   // → users.id (receptionist/admin)
  declare expected_arrival: Date | null;
  declare actual_arrival:   Date | null;
  declare status:           CreationOptional<DelayStatus>;
  declare affected_slots:   CreationOptional<number>;
  declare patients_notified:CreationOptional<boolean>;
  declare created_at:       CreationOptional<Date>;
  declare updated_at:       CreationOptional<Date>;
}

DoctorDelayEvent.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' } },
    event_date:  { type: DataTypes.DATEONLY, allowNull: false },
    delay_type:  { type: DataTypes.ENUM(...Object.values(DelayType)), allowNull: false },
    delay_minutes: { type: DataTypes.INTEGER, allowNull: true },
    reason:      { type: DataTypes.TEXT, allowNull: true },
    reported_by: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    expected_arrival: { type: DataTypes.DATE, allowNull: true },
    actual_arrival:   { type: DataTypes.DATE, allowNull: true },
    status: {
      type: DataTypes.ENUM(...Object.values(DelayStatus)),
      allowNull: false, defaultValue: DelayStatus.ACTIVE,
    },
    affected_slots:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    patients_notified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'doctor_delay_events',
    modelName: 'DoctorDelayEvent',
    indexes: [
      { fields: ['doctor_id', 'event_date'] },
      { fields: ['status'] },
    ],
  },
);
