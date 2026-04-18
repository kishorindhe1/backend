import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';
import { DayOfWeek } from './schedule.model';

export enum TemplateAppliesTo {
  ALL_DOCTORS              = 'all_doctors',
  SPECIFIC_DOCTORS         = 'specific_doctors',
  SPECIFIC_SPECIALISATION  = 'specific_specialisation',
}

export class SlotTemplate extends Model<
  InferAttributes<SlotTemplate>,
  InferCreationAttributes<SlotTemplate>
> {
  declare id:                     CreationOptional<string>;
  declare hospital_id:            ForeignKey<string>;
  declare name:                   string;
  declare applies_to:             CreationOptional<TemplateAppliesTo>;
  declare doctor_ids:             object | null;    // JSON array of doctor UUIDs
  declare specialisation:         string | null;
  declare day_of_week:            DayOfWeek | null; // null = applied manually
  declare override_start_time:    string | null;    // HH:MM
  declare override_end_time:      string | null;    // HH:MM
  declare capacity_percent:       CreationOptional<number>;
  declare emergency_reserve_slots: CreationOptional<number>;
  declare notes:                  string | null;
  declare created_by:             ForeignKey<string>;
  declare created_at:             CreationOptional<Date>;
  declare updated_at:             CreationOptional<Date>;
}

SlotTemplate.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' } },
    created_by:  { type: DataTypes.UUID, allowNull: false, references: { model: 'users',     key: 'id' } },

    name:       { type: DataTypes.STRING(100), allowNull: false },
    applies_to: {
      type: DataTypes.ENUM(...Object.values(TemplateAppliesTo)),
      allowNull: false, defaultValue: TemplateAppliesTo.ALL_DOCTORS,
    },
    doctor_ids:      { type: DataTypes.JSONB,    allowNull: true },
    specialisation:  { type: DataTypes.STRING(100), allowNull: true },
    day_of_week:     { type: DataTypes.ENUM(...Object.values(DayOfWeek)), allowNull: true },
    override_start_time:     { type: DataTypes.STRING(5),   allowNull: true },
    override_end_time:       { type: DataTypes.STRING(5),   allowNull: true },
    capacity_percent:        { type: DataTypes.INTEGER,     allowNull: false, defaultValue: 100 },
    emergency_reserve_slots: { type: DataTypes.INTEGER,     allowNull: false, defaultValue: 1 },
    notes:                   { type: DataTypes.TEXT,        allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'slot_templates',
    modelName: 'SlotTemplate',
    indexes: [
      { fields: ['hospital_id'] },
    ],
  },
);
