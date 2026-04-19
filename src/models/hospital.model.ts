import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum AppointmentApprovalMode {
  AUTO   = 'auto',
  MANUAL = 'manual',
}

export enum PaymentCollectionMode {
  ONLINE_ONLY    = 'online_only',
  PATIENT_CHOICE = 'patient_choice',
}

export enum HospitalType {
  CLINIC             = 'clinic',
  NURSING_HOME       = 'nursing_home',
  HOSPITAL           = 'hospital',
  DIAGNOSTIC_CENTER  = 'diagnostic_center',
}

export enum OnboardingStatus {
  REGISTERED          = 'registered',
  DOCUMENTS_PENDING   = 'documents_pending',
  DOCUMENTS_SUBMITTED = 'documents_submitted',
  VERIFICATION_FAILED = 'verification_failed',
  VERIFIED            = 'verified',
  AGREEMENT_PENDING   = 'agreement_pending',
  AGREEMENT_SIGNED    = 'agreement_signed',
  SETUP_IN_PROGRESS   = 'setup_in_progress',
  LIVE                = 'live',
  SUSPENDED           = 'suspended',
  DEACTIVATED         = 'deactivated',
}

export class Hospital extends Model<
  InferAttributes<Hospital>,
  InferCreationAttributes<Hospital>
> {
  declare id:                CreationOptional<string>;
  declare name:              string;
  declare legal_name:        string | null;
  declare registration_number: string | null;
  declare hospital_type:     HospitalType;
  declare onboarding_status: CreationOptional<OnboardingStatus>;

  // Contact
  declare phone_primary:     string | null;
  declare phone_secondary:   string | null;
  declare email_general:     string | null;
  declare website:           string | null;

  // Business
  declare gst_number:        string | null;
  declare established_year:  number | null;
  declare bed_count:         number | null;

  // Location
  declare address_line1:     string | null;
  declare address_line2:     string | null;
  declare city:              string;
  declare state:             string;
  declare pincode:           string | null;
  declare latitude:          number | null;
  declare longitude:         number | null;

  // Appointment settings
  declare appointment_approval:      CreationOptional<AppointmentApprovalMode>;
  declare payment_collection_mode:   CreationOptional<PaymentCollectionMode>;

  // Meta
  declare is_verified:       CreationOptional<boolean>;
  declare went_live_at:      Date | null;
  declare suspended_at:      Date | null;
  declare suspension_reason: string | null;
  declare deleted_at:        Date | null;
  declare created_at:        CreationOptional<Date>;
  declare updated_at:        CreationOptional<Date>;
}

Hospital.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    name:                { type: DataTypes.STRING(200), allowNull: false },
    legal_name:          { type: DataTypes.STRING(200), allowNull: true },
    registration_number: { type: DataTypes.STRING(100), allowNull: true, unique: true },
    hospital_type:       { type: DataTypes.ENUM(...Object.values(HospitalType)), allowNull: false },
    onboarding_status:   {
      type: DataTypes.ENUM(...Object.values(OnboardingStatus)),
      allowNull: false,
      defaultValue: OnboardingStatus.REGISTERED,
    },

    phone_primary:   { type: DataTypes.STRING(20),  allowNull: true },
    phone_secondary: { type: DataTypes.STRING(20),  allowNull: true },
    email_general:   { type: DataTypes.STRING(200), allowNull: true },
    website:         { type: DataTypes.STRING(500), allowNull: true },
    gst_number:      { type: DataTypes.STRING(20),  allowNull: true },
    established_year:{ type: DataTypes.INTEGER,     allowNull: true },
    bed_count:       { type: DataTypes.INTEGER,     allowNull: true },

    address_line1: { type: DataTypes.STRING(300), allowNull: true },
    address_line2: { type: DataTypes.STRING(300), allowNull: true },
    city:          { type: DataTypes.STRING(100), allowNull: false },
    state:         { type: DataTypes.STRING(100), allowNull: false },
    pincode:       { type: DataTypes.STRING(10),  allowNull: true },
    latitude:      { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    longitude:     { type: DataTypes.DECIMAL(11, 8), allowNull: true },

    appointment_approval: {
      type: DataTypes.ENUM(...Object.values(AppointmentApprovalMode)),
      allowNull: false,
      defaultValue: AppointmentApprovalMode.AUTO,
    },

    payment_collection_mode: {
      type: DataTypes.ENUM(...Object.values(PaymentCollectionMode)),
      allowNull: false,
      defaultValue: PaymentCollectionMode.ONLINE_ONLY,
    },

    is_verified:       { type: DataTypes.BOOLEAN,   allowNull: false, defaultValue: false },
    went_live_at:      { type: DataTypes.DATE,       allowNull: true },
    suspended_at:      { type: DataTypes.DATE,       allowNull: true },
    suspension_reason: { type: DataTypes.TEXT,       allowNull: true },
    deleted_at:        { type: DataTypes.DATE,       allowNull: true },
    created_at:        DataTypes.DATE,
    updated_at:        DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'hospitals',
    modelName: 'Hospital',
    paranoid:  false,
    indexes: [
      { fields: ['city'] },
      { fields: ['onboarding_status'] },
      { fields: ['is_verified'] },
    ],
  },
);
