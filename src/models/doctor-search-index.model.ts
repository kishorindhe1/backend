import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class DoctorSearchIndex extends Model<
  InferAttributes<DoctorSearchIndex>,
  InferCreationAttributes<DoctorSearchIndex>
> {
  declare id:                  CreationOptional<string>;
  declare doctor_id:           ForeignKey<string>;   // → doctor_profiles.id
  declare hospital_id:         ForeignKey<string>;

  // Identity
  declare doctor_name:         string;
  declare doctor_name_normalized: string;            // lowercase, no Dr. prefix
  declare specialization:      string;
  declare qualifications:      string[];
  declare languages_spoken:    string[];
  declare gender:              string | null;
  declare experience_years:    number;

  // Location
  declare hospital_name:       string;
  declare city:                string;
  declare area:                string | null;
  declare latitude:            number | null;
  declare longitude:           number | null;

  // Availability (refreshed every 5 min)
  declare consultation_fee:    number;
  declare next_available_slot: Date | null;
  declare available_today:     boolean;
  declare available_slots_today: number;

  // Ranking signals
  declare avg_rating:          CreationOptional<number>;
  declare total_reviews:       CreationOptional<number>;
  declare wilson_rating_score: CreationOptional<number>;
  declare reliability_score:   CreationOptional<number>;
  declare total_consultations: CreationOptional<number>;

  // Flags
  declare is_active:           boolean;
  declare is_verified:         boolean;
  declare hospital_is_live:    boolean;
  declare last_indexed_at:     CreationOptional<Date>;
  declare created_at:          CreationOptional<Date>;
  declare updated_at:          CreationOptional<Date>;
}

DoctorSearchIndex.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' } },

    doctor_name:            { type: DataTypes.STRING(100), allowNull: false },
    doctor_name_normalized: { type: DataTypes.STRING(100), allowNull: false },
    specialization:         { type: DataTypes.STRING(100), allowNull: false },
    qualifications:         { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    languages_spoken:       { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: ['english'] },
    gender:                 { type: DataTypes.STRING(20), allowNull: true },
    experience_years:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    hospital_name: { type: DataTypes.STRING(200), allowNull: false },
    city:          { type: DataTypes.STRING(100), allowNull: false },
    area:          { type: DataTypes.STRING(200), allowNull: true },
    latitude:      { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    longitude:     { type: DataTypes.DECIMAL(11, 8), allowNull: true },

    consultation_fee:      { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    next_available_slot:   { type: DataTypes.DATE, allowNull: true },
    available_today:       { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    available_slots_today: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    avg_rating:           { type: DataTypes.DECIMAL(3, 2), allowNull: false, defaultValue: 0 },
    total_reviews:        { type: DataTypes.INTEGER,       allowNull: false, defaultValue: 0 },
    wilson_rating_score:  { type: DataTypes.DECIMAL(5, 4), allowNull: false, defaultValue: 0 },
    reliability_score:    { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 80 },
    total_consultations:  { type: DataTypes.INTEGER,       allowNull: false, defaultValue: 0 },

    is_active:        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    is_verified:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    hospital_is_live: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    last_indexed_at:  { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'doctor_search_index',
    modelName: 'DoctorSearchIndex',
    indexes: [
      { unique: true, fields: ['doctor_id', 'hospital_id'] },
      { fields: ['city'] },
      { fields: ['specialization'] },
      { fields: ['is_active', 'is_verified', 'hospital_is_live'] },
      { fields: ['available_today'] },
      { fields: ['wilson_rating_score'] },
      { fields: ['reliability_score'] },
    ],
  },
);
