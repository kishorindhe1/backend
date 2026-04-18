import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize }    from '../config/database';

export enum EmploymentType {
  VISITING_CONSULTANT = 'visiting_consultant',
  EMPLOYED            = 'employed',
  RESIDENT            = 'resident',
}

export enum SlotAutonomyLevel {
  FULL    = 'full',
  PARTIAL = 'partial',
  NONE    = 'none',
}

export class DoctorHospitalAffiliation extends Model<
  InferAttributes<DoctorHospitalAffiliation>,
  InferCreationAttributes<DoctorHospitalAffiliation>
> {
  declare id:               CreationOptional<string>;
  declare doctor_id:        ForeignKey<string>;   // → doctor_profiles.id
  declare hospital_id:      ForeignKey<string>;
  declare is_primary:       CreationOptional<boolean>;
  declare consultation_fee: number;
  declare room_number:      string | null;
  declare department:       string | null;
  declare employment_type:      CreationOptional<EmploymentType>;
  declare slot_autonomy_level:  CreationOptional<SlotAutonomyLevel>;
  declare is_active:            CreationOptional<boolean>;
  declare start_date:           Date;
  declare end_date:             Date | null;
  declare created_at:           CreationOptional<Date>;
  declare updated_at:           CreationOptional<Date>;
}

DoctorHospitalAffiliation.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' } },
    is_primary:       { type: DataTypes.BOOLEAN,      allowNull: false, defaultValue: false },
    consultation_fee: { type: DataTypes.DECIMAL(10,2), allowNull: false },
    room_number:      { type: DataTypes.STRING(20),    allowNull: true },
    department:       { type: DataTypes.STRING(100),   allowNull: true },
    employment_type: {
      type: DataTypes.ENUM(...Object.values(EmploymentType)),
      allowNull: false, defaultValue: EmploymentType.VISITING_CONSULTANT,
    },
    slot_autonomy_level: {
      type: DataTypes.ENUM(...Object.values(SlotAutonomyLevel)),
      allowNull: false, defaultValue: SlotAutonomyLevel.PARTIAL,
    },
    is_active:        { type: DataTypes.BOOLEAN,       allowNull: false, defaultValue: true },
    start_date:       { type: DataTypes.DATEONLY,      allowNull: false },
    end_date:         { type: DataTypes.DATEONLY,      allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'doctor_hospital_affiliations',
    modelName: 'DoctorHospitalAffiliation',
    indexes: [
      { fields: ['doctor_id'] },
      { fields: ['hospital_id'] },
      { unique: true, fields: ['doctor_id', 'hospital_id'] },
    ],
  },
);

