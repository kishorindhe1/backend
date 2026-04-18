import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class OpdDailyStats extends Model<
  InferAttributes<OpdDailyStats>,
  InferCreationAttributes<OpdDailyStats>
> {
  declare id:                     CreationOptional<string>;
  declare hospital_id:            ForeignKey<string>;
  declare doctor_id:              ForeignKey<string>;
  declare date:                   string;              // YYYY-MM-DD
  declare total_slots_published:  CreationOptional<number>;
  declare total_booked:           CreationOptional<number>;
  declare total_walk_ins:         CreationOptional<number>;
  declare total_no_shows:         CreationOptional<number>;
  declare total_cancellations:    CreationOptional<number>;
  declare total_completed:        CreationOptional<number>;
  declare utilisation_rate:       number | null;       // percentage
  declare avg_delay_minutes:      number | null;
  declare avg_wait_minutes:       number | null;
  declare revenue_collected:      number | null;
  declare created_at:             CreationOptional<Date>;
  declare updated_at:             CreationOptional<Date>;
}

OpdDailyStats.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },

    date:                  { type: DataTypes.DATEONLY,     allowNull: false },
    total_slots_published: { type: DataTypes.INTEGER,      allowNull: false, defaultValue: 0 },
    total_booked:          { type: DataTypes.INTEGER,      allowNull: false, defaultValue: 0 },
    total_walk_ins:        { type: DataTypes.INTEGER,      allowNull: false, defaultValue: 0 },
    total_no_shows:        { type: DataTypes.INTEGER,      allowNull: false, defaultValue: 0 },
    total_cancellations:   { type: DataTypes.INTEGER,      allowNull: false, defaultValue: 0 },
    total_completed:       { type: DataTypes.INTEGER,      allowNull: false, defaultValue: 0 },
    utilisation_rate:      { type: DataTypes.DECIMAL(5,2), allowNull: true },
    avg_delay_minutes:     { type: DataTypes.DECIMAL(6,2), allowNull: true },
    avg_wait_minutes:      { type: DataTypes.DECIMAL(6,2), allowNull: true },
    revenue_collected:     { type: DataTypes.DECIMAL(12,2), allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'opd_daily_stats',
    modelName: 'OpdDailyStats',
    indexes: [
      { unique: true, fields: ['hospital_id', 'doctor_id', 'date'] },
      { fields: ['date'] },
      { fields: ['hospital_id'] },
    ],
  },
);
