import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum ProcedureCategory {
  CONSULTATION = 'consultation',
  PROCEDURE    = 'procedure',
  FOLLOW_UP    = 'follow_up',
  REVIEW       = 'review',
}

export class ProcedureType extends Model<
  InferAttributes<ProcedureType>,
  InferCreationAttributes<ProcedureType>
> {
  declare id:                   CreationOptional<string>;
  declare doctor_id:            ForeignKey<string>;
  declare hospital_id:          ForeignKey<string>;
  declare name:                 string;
  declare duration_minutes:     number;
  declare category:             CreationOptional<ProcedureCategory>;
  declare prep_time_minutes:    CreationOptional<number>;
  declare cleanup_time_minutes: CreationOptional<number>;
  declare color_code:           string | null;
  declare is_active:            CreationOptional<boolean>;
  declare created_at:           CreationOptional<Date>;
  declare updated_at:           CreationOptional<Date>;
}

ProcedureType.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },

    name:             { type: DataTypes.STRING(100), allowNull: false },
    duration_minutes: { type: DataTypes.INTEGER,     allowNull: false },
    category: {
      type: DataTypes.ENUM(...Object.values(ProcedureCategory)),
      allowNull: false, defaultValue: ProcedureCategory.CONSULTATION,
    },
    prep_time_minutes:    { type: DataTypes.INTEGER,    allowNull: false, defaultValue: 0 },
    cleanup_time_minutes: { type: DataTypes.INTEGER,    allowNull: false, defaultValue: 0 },
    color_code:           { type: DataTypes.STRING(7),  allowNull: true },
    is_active:            { type: DataTypes.BOOLEAN,    allowNull: false, defaultValue: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'procedure_types',
    modelName: 'ProcedureType',
    indexes: [
      { fields: ['doctor_id', 'hospital_id'] },
      { fields: ['is_active'] },
    ],
  },
);
