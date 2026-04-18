import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class OpdReviewLog extends Model<
  InferAttributes<OpdReviewLog>,
  InferCreationAttributes<OpdReviewLog>
> {
  declare id:             CreationOptional<string>;
  declare hospital_id:    ForeignKey<string>;
  declare date:           string;              // YYYY-MM-DD
  declare reviewed_by:    ForeignKey<string> | null;  // null if auto-published
  declare reviewed_at:    Date | null;
  declare auto_published: CreationOptional<boolean>;
  declare notes:          string | null;
  declare created_at:     CreationOptional<Date>;
  declare updated_at:     CreationOptional<Date>;
}

OpdReviewLog.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' } },
    reviewed_by: { type: DataTypes.UUID, allowNull: true,  references: { model: 'users',     key: 'id' } },

    date:           { type: DataTypes.DATEONLY, allowNull: false },
    reviewed_at:    { type: DataTypes.DATE,     allowNull: true },
    auto_published: { type: DataTypes.BOOLEAN,  allowNull: false, defaultValue: false },
    notes:          { type: DataTypes.TEXT,     allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'opd_review_logs',
    modelName: 'OpdReviewLog',
    indexes: [
      { unique: true, fields: ['hospital_id', 'date'] },
      { fields: ['date'] },
    ],
  },
);
