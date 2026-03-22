import {
  Model, DataTypes, InferAttributes, InferCreationAttributes,
  CreationOptional, NonAttribute,
} from 'sequelize';
import { sequelize } from '../config/database';
import { UserRole, AccountStatus } from '../types';

export class User extends Model<
  InferAttributes<User>,
  InferCreationAttributes<User>
> {
  declare id: CreationOptional<string>;
  declare mobile: string;
  declare country_code: CreationOptional<string>;
  declare otp_secret: string | null;
  declare otp_expires_at: Date | null;
  declare otp_attempts: CreationOptional<number>;
  declare role: CreationOptional<UserRole>;
  declare account_status: CreationOptional<AccountStatus>;
  declare last_login_at: Date | null;
  declare deleted_at: Date | null;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;

  // Virtual — not stored in DB
  declare patientProfile?: NonAttribute<unknown>;
}

User.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    mobile: {
      type: DataTypes.STRING(15),
      allowNull: false,
      unique: true,
      validate: { notEmpty: true },
    },
    country_code: {
      type: DataTypes.STRING(5),
      allowNull: false,
      defaultValue: '+91',
    },
    otp_secret: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    otp_expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    otp_attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    role: {
      type: DataTypes.ENUM(...Object.values(UserRole)),
      allowNull: false,
      defaultValue: UserRole.PATIENT,
    },
    account_status: {
      type: DataTypes.ENUM(...Object.values(AccountStatus)),
      allowNull: false,
      defaultValue: AccountStatus.OTP_VERIFIED,
    },
    last_login_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'users',
    modelName: 'User',
    paranoid: false,      // manual soft delete via deleted_at
    indexes: [
      { fields: ['mobile'] },
      { fields: ['role'] },
      { fields: ['account_status'] },
    ],
  },
);
