import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { sequelize } from '../config/database';

export class SymptomSpecialisationMap extends Model<
  InferAttributes<SymptomSpecialisationMap>,
  InferCreationAttributes<SymptomSpecialisationMap>
> {
  declare id:               CreationOptional<string>;
  declare symptom_keyword:  string;
  declare symptom_aliases:  string[];
  declare specialisations:  string[];
  declare is_emergency:     CreationOptional<boolean>;
  declare priority:         CreationOptional<number>;
  declare created_at:       CreationOptional<Date>;
}

SymptomSpecialisationMap.init(
  {
    id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    symptom_keyword:  { type: DataTypes.STRING(100), allowNull: false, unique: true },
    symptom_aliases:  { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    specialisations:  { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    is_emergency:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    priority:         { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at:       DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'symptom_specialisation_map',
    modelName: 'SymptomSpecialisationMap',
    timestamps: false,
    indexes: [{ fields: ['symptom_keyword'] }],
  },
);
