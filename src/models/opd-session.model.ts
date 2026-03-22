import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum OpdBookingMode {
  SLOT_BASED  = 'slot_based',
  TOKEN_BASED = 'token_based',
}

export enum OpdSessionStatus {
  SCHEDULED = 'scheduled',
  ACTIVE    = 'active',
  PAUSED    = 'paused',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export class OpdSession extends Model<
  InferAttributes<OpdSession>,
  InferCreationAttributes<OpdSession>
> {
  declare id:                   CreationOptional<string>;
  declare doctor_id:            ForeignKey<string>;
  declare hospital_id:          ForeignKey<string>;
  declare session_date:         string;             // YYYY-MM-DD
  declare session_type:         string;             // 'morning' | 'evening' | 'full_day'
  declare booking_mode:         CreationOptional<OpdBookingMode>;
  declare start_time:           string;             // 'HH:MM'
  declare expected_end_time:    string;
  declare actual_start_time:    string | null;
  declare actual_end_time:      string | null;
  declare total_tokens:         number;
  declare online_token_limit:   number;
  declare walkin_token_limit:   number;
  declare tokens_issued:        CreationOptional<number>;
  declare current_token:        CreationOptional<number>;
  declare avg_time_per_patient: CreationOptional<number>;
  declare status:               CreationOptional<OpdSessionStatus>;
  declare created_at:           CreationOptional<Date>;
  declare updated_at:           CreationOptional<Date>;
}

OpdSession.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },
    session_date:      { type: DataTypes.DATEONLY,   allowNull: false },
    session_type:      { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'morning' },
    booking_mode: {
      type: DataTypes.ENUM(...Object.values(OpdBookingMode)),
      allowNull: false, defaultValue: OpdBookingMode.TOKEN_BASED,
    },
    start_time:         { type: DataTypes.STRING(5), allowNull: false },
    expected_end_time:  { type: DataTypes.STRING(5), allowNull: false },
    actual_start_time:  { type: DataTypes.STRING(5), allowNull: true },
    actual_end_time:    { type: DataTypes.STRING(5), allowNull: true },
    total_tokens:        { type: DataTypes.INTEGER,      allowNull: false },
    online_token_limit:  { type: DataTypes.INTEGER,      allowNull: false },
    walkin_token_limit:  { type: DataTypes.INTEGER,      allowNull: false },
    tokens_issued:       { type: DataTypes.INTEGER,      allowNull: false, defaultValue: 0 },
    current_token:       { type: DataTypes.INTEGER,      allowNull: false, defaultValue: 0 },
    avg_time_per_patient:{ type: DataTypes.DECIMAL(5,2), allowNull: false, defaultValue: 5 },
    status: {
      type: DataTypes.ENUM(...Object.values(OpdSessionStatus)),
      allowNull: false, defaultValue: OpdSessionStatus.SCHEDULED,
    },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'opd_sessions',
    modelName: 'OpdSession',
    indexes: [
      { fields: ['doctor_id', 'session_date'] },
      { fields: ['hospital_id', 'session_date'] },
      { fields: ['status'] },
    ],
  },
);
