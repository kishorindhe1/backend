import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum SlotChangeType {
  OVERRIDE_APPLIED       = 'override_applied',
  SCHEDULE_UPDATED       = 'schedule_updated',
  MANUAL_BLOCK           = 'manual_block',
  CANCELLATION           = 'cancellation',
  ROLLBACK               = 'rollback',
}

export enum SlotChangeScope {
  TODAY          = 'today',
  SPECIFIC_DATE  = 'specific_date',
  FROM_DATE      = 'from_date',
  PERMANENT      = 'permanent',
}

export class SlotChangeLog extends Model<
  InferAttributes<SlotChangeLog>,
  InferCreationAttributes<SlotChangeLog>
> {
  declare id:                       CreationOptional<string>;
  declare hospital_id:              ForeignKey<string>;
  declare doctor_id:                ForeignKey<string>;
  declare date:                     string;             // YYYY-MM-DD — primary affected date
  declare change_type:              SlotChangeType;
  declare scope:                    SlotChangeScope;
  declare slots_affected:           CreationOptional<number>;
  declare booked_patients_notified: CreationOptional<number>;
  declare previous_state_snapshot:  object | null;     // JSON — for rollback
  declare reason:                   string | null;
  declare created_by:               ForeignKey<string>;
  declare created_at:               CreationOptional<Date>;
  declare updated_at:               CreationOptional<Date>;
}

SlotChangeLog.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    created_by:  { type: DataTypes.UUID, allowNull: false, references: { model: 'users',           key: 'id' } },

    date: { type: DataTypes.DATEONLY, allowNull: false },
    change_type: {
      type: DataTypes.ENUM(...Object.values(SlotChangeType)),
      allowNull: false,
    },
    scope: {
      type: DataTypes.ENUM(...Object.values(SlotChangeScope)),
      allowNull: false,
    },
    slots_affected:           { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    booked_patients_notified: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    previous_state_snapshot:  { type: DataTypes.JSONB,   allowNull: true },
    reason:                   { type: DataTypes.TEXT,    allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'slot_change_logs',
    modelName: 'SlotChangeLog',
    indexes: [
      { fields: ['hospital_id', 'date'] },
      { fields: ['doctor_id', 'date'] },
      { fields: ['created_at'] },
    ],
  },
);
