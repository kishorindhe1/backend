import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';
import { User }      from './user.model';

export enum BookingMode {
  SLOT_BASED  = 'slot_based',
  TOKEN_BASED = 'token_based',
}

export enum VerificationStatus {
  PENDING  = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export class DoctorProfile extends Model<
  InferAttributes<DoctorProfile>,
  InferCreationAttributes<DoctorProfile>
> {
  declare id:                   CreationOptional<string>;
  declare user_id:              ForeignKey<string>;

  // Professional info
  declare full_name:            string;
  declare specialization:       string;
  declare qualifications:       string[];
  declare experience_years:     CreationOptional<number>;
  declare languages_spoken:     CreationOptional<string[]>;
  declare gender:               string | null;
  declare profile_photo_url:    string | null;
  declare bio:                  string | null;

  // Credentials
  declare nmc_registration_number: string | null;
  declare verification_status:     CreationOptional<VerificationStatus>;
  declare verified_at:             Date | null;
  declare verified_by:             string | null;

  // OPD config
  declare default_booking_mode:     CreationOptional<BookingMode>;
  declare max_patients_per_day:      CreationOptional<number>;
  declare avg_consultation_minutes:  CreationOptional<number>;
  declare no_show_rate_historical:   CreationOptional<number>;

  // Reliability (computed nightly)
  declare reliability_score:     CreationOptional<number>;
  declare on_time_rate:          CreationOptional<number>;
  declare cancellation_rate:     CreationOptional<number>;
  declare completion_rate:       CreationOptional<number>;

  declare is_active:   CreationOptional<boolean>;
  declare deleted_at:  Date | null;
  declare created_at:  CreationOptional<Date>;
  declare updated_at:  CreationOptional<Date>;
}

DoctorProfile.init(
  {
    id:      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    user_id: { type: DataTypes.UUID, allowNull: false, unique: true,
               references: { model: 'users', key: 'id' } },

    full_name:         { type: DataTypes.STRING(100), allowNull: false },
    specialization:    { type: DataTypes.STRING(100), allowNull: false },
    qualifications:    { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    experience_years:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    languages_spoken:  { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: ['english'] },
    gender:            { type: DataTypes.STRING(20), allowNull: true },
    profile_photo_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
      get() {
        const stored = this.getDataValue('profile_photo_url');
        if (stored) return stored;
        const name = this.getDataValue('full_name') ?? 'Doctor';
        return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=4F46E5&color=fff&size=200&bold=true&rounded=true`;
      },
    },
    bio:               { type: DataTypes.TEXT, allowNull: true },

    nmc_registration_number: { type: DataTypes.STRING(50),  allowNull: true },
    verification_status: {
      type: DataTypes.ENUM(...Object.values(VerificationStatus)),
      allowNull: false, defaultValue: VerificationStatus.PENDING,
    },
    verified_at: { type: DataTypes.DATE, allowNull: true },
    verified_by: { type: DataTypes.UUID, allowNull: true },

    default_booking_mode: {
      type: DataTypes.ENUM(...Object.values(BookingMode)),
      allowNull: false, defaultValue: BookingMode.SLOT_BASED,
    },
    max_patients_per_day:     { type: DataTypes.INTEGER,      allowNull: false, defaultValue: 40 },
    avg_consultation_minutes: { type: DataTypes.DECIMAL(5,2), allowNull: false, defaultValue: 20 },
    no_show_rate_historical:  { type: DataTypes.DECIMAL(5,2), allowNull: false, defaultValue: 0.20 },

    reliability_score:  { type: DataTypes.DECIMAL(5,2), allowNull: false, defaultValue: 80 },
    on_time_rate:       { type: DataTypes.DECIMAL(5,2), allowNull: false, defaultValue: 0.90 },
    cancellation_rate:  { type: DataTypes.DECIMAL(5,2), allowNull: false, defaultValue: 0.05 },
    completion_rate:    { type: DataTypes.DECIMAL(5,2), allowNull: false, defaultValue: 0.95 },

    is_active:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'doctor_profiles',
    modelName: 'DoctorProfile',
    indexes: [
      { fields: ['user_id'] },
      { fields: ['specialization'] },
      { fields: ['verification_status'] },
    ],
  },
);

