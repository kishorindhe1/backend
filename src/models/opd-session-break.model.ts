import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class OpdSessionBreak extends Model<
  InferAttributes<OpdSessionBreak>,
  InferCreationAttributes<OpdSessionBreak>
> {
  declare id:         CreationOptional<string>;
  declare session_id: ForeignKey<string>;
  declare start_time: string;   // HH:MM
  declare end_time:   string;   // HH:MM
  declare reason:     string | null;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
}

OpdSessionBreak.init(
  {
    id:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    session_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'opd_sessions', key: 'id' } },
    start_time: { type: DataTypes.STRING(5), allowNull: false },
    end_time:   { type: DataTypes.STRING(5), allowNull: false },
    reason:     { type: DataTypes.STRING(100), allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName:  'opd_session_breaks',
    modelName:  'OpdSessionBreak',
    indexes: [{ fields: ['session_id'] }],
  },
);
