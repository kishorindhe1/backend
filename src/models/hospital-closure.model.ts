import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum ClosureType {
  FULL_DAY = 'full_day',
  PARTIAL  = 'partial',
}

export class HospitalClosure extends Model<
  InferAttributes<HospitalClosure>,
  InferCreationAttributes<HospitalClosure>
> {
  declare id:           CreationOptional<string>;
  declare hospital_id:  ForeignKey<string>;
  declare closure_date: string;            // YYYY-MM-DD
  declare closure_type: CreationOptional<ClosureType>;
  declare start_time:   string | null;     // HH:MM — null for full_day
  declare end_time:     string | null;     // HH:MM — null for full_day
  declare reason:       string | null;
  declare created_by:   ForeignKey<string>;
  declare created_at:   CreationOptional<Date>;
  declare updated_at:   CreationOptional<Date>;
}

HospitalClosure.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' } },
    created_by:  { type: DataTypes.UUID, allowNull: false, references: { model: 'users',     key: 'id' } },

    closure_date: { type: DataTypes.DATEONLY, allowNull: false },
    closure_type: {
      type: DataTypes.ENUM(...Object.values(ClosureType)),
      allowNull: false, defaultValue: ClosureType.FULL_DAY,
    },
    start_time: { type: DataTypes.STRING(5),   allowNull: true },
    end_time:   { type: DataTypes.STRING(5),   allowNull: true },
    reason:     { type: DataTypes.STRING(300), allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'hospital_closures',
    modelName: 'HospitalClosure',
    indexes: [
      { fields: ['hospital_id', 'closure_date'] },
      { fields: ['closure_date'] },
    ],
  },
);
