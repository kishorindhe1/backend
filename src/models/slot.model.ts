import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum SlotStatus {
  AVAILABLE = 'available',
  BOOKED    = 'booked',
  BLOCKED   = 'blocked',
  EXPIRED   = 'expired',
}

export class GeneratedSlot extends Model<
  InferAttributes<GeneratedSlot>,
  InferCreationAttributes<GeneratedSlot>
> {
  declare id:               CreationOptional<string>;
  declare doctor_id:        ForeignKey<string>;   // → doctor_profiles.id
  declare hospital_id:      ForeignKey<string>;
  declare schedule_id:      ForeignKey<string>;
  declare slot_datetime:    Date;
  declare duration_minutes: number;
  declare status:           CreationOptional<SlotStatus>;
  declare appointment_id:   string | null;
  declare blocked_reason:   string | null;
  declare created_at:       CreationOptional<Date>;
  declare updated_at:       CreationOptional<Date>;
}

GeneratedSlot.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },
    schedule_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'schedules',       key: 'id' } },

    slot_datetime:    { type: DataTypes.DATE,    allowNull: false },
    duration_minutes: { type: DataTypes.INTEGER, allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(SlotStatus)),
      allowNull: false, defaultValue: SlotStatus.AVAILABLE,
    },
    appointment_id: { type: DataTypes.UUID, allowNull: true },
    blocked_reason: { type: DataTypes.STRING(100), allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'generated_slots',
    modelName: 'GeneratedSlot',
    indexes: [
      // Unique constraint — prevents duplicate slot generation
      { unique: true, fields: ['doctor_id', 'hospital_id', 'slot_datetime'] },
      { fields: ['doctor_id', 'slot_datetime'] },
      { fields: ['status'] },
    ],
  },
);

