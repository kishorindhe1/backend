import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum CollectionMode {
  CASH      = 'cash',
  CARD      = 'card',
  UPI       = 'upi',
  INSURANCE = 'insurance',
}

export class HospitalCollection extends Model<
  InferAttributes<HospitalCollection>,
  InferCreationAttributes<HospitalCollection>
> {
  declare id:             CreationOptional<string>;
  declare hospital_id:    ForeignKey<string>;
  declare patient_id:     ForeignKey<string> | null;
  declare appointment_id: ForeignKey<string> | null;
  declare opd_token_id:   ForeignKey<string> | null;
  declare amount:         number;
  declare mode:           CollectionMode;
  declare collected_by:   ForeignKey<string>;
  declare collected_at:   CreationOptional<Date>;
  declare notes:          string | null;
  declare created_at:     CreationOptional<Date>;
}

HospitalCollection.init(
  {
    id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    hospital_id:    { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',    key: 'id' } },
    patient_id:     { type: DataTypes.UUID, allowNull: true,  references: { model: 'users',        key: 'id' } },
    appointment_id: { type: DataTypes.UUID, allowNull: true,  references: { model: 'appointments', key: 'id' } },
    opd_token_id:   { type: DataTypes.UUID, allowNull: true,  references: { model: 'opd_tokens',   key: 'id' } },
    amount:         { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    mode:           { type: DataTypes.ENUM(...Object.values(CollectionMode)), allowNull: false },
    collected_by:   { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    collected_at:   { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    notes:          { type: DataTypes.STRING(200), allowNull: true },
    created_at:     DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'hospital_collections',
    modelName: 'HospitalCollection',
    updatedAt: false,
    indexes: [
      { fields: ['hospital_id']  },
      { fields: ['patient_id']   },
      { fields: ['collected_at'] },
    ],
  },
);
