import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum OpdSlotStatus {
  DRAFT               = 'draft',
  PUBLISHED           = 'published',
  BOOKED              = 'booked',
  BLOCKED             = 'blocked',
  CANCELLED           = 'cancelled',
  NO_SHOW             = 'no_show',
  COMPLETED           = 'completed',
  RESERVED_EMERGENCY  = 'reserved_emergency',
}

export enum SlotCategory {
  REGULAR         = 'regular',
  FOLLOW_UP_ONLY  = 'follow_up_only',
  WALK_IN_ONLY    = 'walk_in_only',
  EMERGENCY_ONLY  = 'emergency_only',
  VIP             = 'vip',
}

export enum BookingEngine {
  FIXED_SLOTS = 'fixed_slots',
  GAP_BASED   = 'gap_based',
}

export enum SlotType {
  IN_PERSON   = 'in_person',
  TELECONSULT = 'teleconsult',
  HYBRID      = 'hybrid',
}

export class OpdSlotSession extends Model<
  InferAttributes<OpdSlotSession>,
  InferCreationAttributes<OpdSlotSession>
> {
  declare id:                       CreationOptional<string>;
  declare doctor_id:                ForeignKey<string>;
  declare hospital_id:              ForeignKey<string>;
  declare schedule_id:              ForeignKey<string> | null;
  declare date:                     string;              // YYYY-MM-DD
  declare slot_start_time:          string;              // HH:MM
  declare slot_end_time:            string;              // HH:MM
  declare duration_minutes:         number;
  declare booking_engine:           CreationOptional<BookingEngine>;
  declare slot_category:            CreationOptional<SlotCategory>;
  declare custom_duration_minutes:  number | null;
  declare custom_added:             CreationOptional<boolean>;
  declare status:                   CreationOptional<OpdSlotStatus>;
  declare slot_type:                CreationOptional<SlotType>;
  declare video_link:               string | null;
  declare appointment_id:           string | null;
  declare walk_in_token_id:         string | null;
  declare procedure_type_id:        string | null;
  declare blocked_reason:           string | null;
  declare published_at:             Date | null;
  declare created_at:               CreationOptional<Date>;
  declare updated_at:               CreationOptional<Date>;
}

OpdSlotSession.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },
    schedule_id: { type: DataTypes.UUID, allowNull: true,  references: { model: 'schedules',       key: 'id' } },

    date:             { type: DataTypes.DATEONLY, allowNull: false },
    slot_start_time:  { type: DataTypes.STRING(5), allowNull: false },
    slot_end_time:    { type: DataTypes.STRING(5), allowNull: false },
    duration_minutes: { type: DataTypes.INTEGER,   allowNull: false },

    booking_engine: {
      type: DataTypes.ENUM(...Object.values(BookingEngine)),
      allowNull: false, defaultValue: BookingEngine.FIXED_SLOTS,
    },
    slot_category: {
      type: DataTypes.ENUM(...Object.values(SlotCategory)),
      allowNull: false, defaultValue: SlotCategory.REGULAR,
    },
    custom_duration_minutes: { type: DataTypes.INTEGER,     allowNull: true },
    custom_added:            { type: DataTypes.BOOLEAN,     allowNull: false, defaultValue: false },

    status: {
      type: DataTypes.ENUM(...Object.values(OpdSlotStatus)),
      allowNull: false, defaultValue: OpdSlotStatus.DRAFT,
    },

    slot_type: {
      type: DataTypes.ENUM(...Object.values(SlotType)),
      allowNull: false, defaultValue: SlotType.IN_PERSON,
    },
    video_link:        { type: DataTypes.STRING(500), allowNull: true },

    appointment_id:    { type: DataTypes.UUID,        allowNull: true },
    walk_in_token_id:  { type: DataTypes.UUID,        allowNull: true },
    procedure_type_id: { type: DataTypes.UUID,        allowNull: true },
    blocked_reason:    { type: DataTypes.STRING(200), allowNull: true },
    published_at:      { type: DataTypes.DATE,        allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'opd_slot_sessions',
    modelName: 'OpdSlotSession',
    indexes: [
      { unique: true, fields: ['doctor_id', 'hospital_id', 'date', 'slot_start_time'] },
      { fields: ['doctor_id', 'date'] },
      { fields: ['hospital_id', 'date'] },
      { fields: ['status'] },
      { fields: ['date'] },
    ],
  },
);
