import {
  Model, DataTypes, InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';
import { User } from './user.model';
import { ProfileStatus } from '../types';

export enum Gender {
  MALE               = 'male',
  FEMALE             = 'female',
  OTHER              = 'other',
  PREFER_NOT_TO_SAY  = 'prefer_not_to_say',
}

export class PatientProfile extends Model<
  InferAttributes<PatientProfile>,
  InferCreationAttributes<PatientProfile>
> {
  declare id:                CreationOptional<string>;
  declare user_id:           ForeignKey<string>;
  declare full_name:         string | null;
  declare email:             string | null;
  declare date_of_birth:     Date | null;
  declare gender:            Gender | null;
  declare blood_group:       string | null;
  declare profile_photo_url: string | null;
  declare profile_status:    CreationOptional<ProfileStatus>;
  declare completed_at:      Date | null;
  declare created_at:        CreationOptional<Date>;
  declare updated_at:        CreationOptional<Date>;
}

PatientProfile.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: { model: 'users', key: 'id' },
    },
    full_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: { isEmail: true },
    },
    date_of_birth: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    gender: {
      type: DataTypes.ENUM(...Object.values(Gender)),
      allowNull: true,
    },
    blood_group: {
      type: DataTypes.STRING(5),
      allowNull: true,
    },
    profile_photo_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    profile_status: {
      type: DataTypes.ENUM(...Object.values(ProfileStatus)),
      allowNull: false,
      defaultValue: ProfileStatus.INCOMPLETE,
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'patient_profiles',
    modelName: 'PatientProfile',
    indexes:   [{ fields: ['user_id'] }],
  },
);

