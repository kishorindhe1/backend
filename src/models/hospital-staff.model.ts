import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';
import { User }     from './user.model';
import { Hospital } from './hospital.model';

export enum StaffRole {
  HOSPITAL_ADMIN = 'hospital_admin',
  RECEPTIONIST   = 'receptionist',
}

export class HospitalStaff extends Model<
  InferAttributes<HospitalStaff>,
  InferCreationAttributes<HospitalStaff>
> {
  declare id:          CreationOptional<string>;
  declare user_id:     ForeignKey<string>;
  declare hospital_id: ForeignKey<string>;
  declare staff_role:  StaffRole;
  declare department:  string | null;
  declare employee_id: string | null;
  declare is_active:   CreationOptional<boolean>;
  declare joined_at:   Date | null;
  declare created_at:  CreationOptional<Date>;
  declare updated_at:  CreationOptional<Date>;
}

HospitalStaff.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    user_id:     { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' } },
    staff_role:  { type: DataTypes.ENUM(...Object.values(StaffRole)), allowNull: false },
    department:  { type: DataTypes.STRING(100), allowNull: true },
    employee_id: { type: DataTypes.STRING(50),  allowNull: true },
    is_active:   { type: DataTypes.BOOLEAN,     allowNull: false, defaultValue: true },
    joined_at:   { type: DataTypes.DATEONLY,    allowNull: true },
    created_at:  DataTypes.DATE,
    updated_at:  DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'hospital_staff',
    modelName: 'HospitalStaff',
    indexes: [
      { fields: ['user_id'] },
      { fields: ['hospital_id'] },
      { unique: true, fields: ['user_id', 'hospital_id'] },
    ],
  },
);

