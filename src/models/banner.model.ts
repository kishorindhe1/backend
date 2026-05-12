import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes, CreationOptional,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum BannerLinkType {
  NONE     = 'none',
  EXTERNAL = 'external',
  SEARCH   = 'search',
  HOSPITAL = 'hospital',
  DOCTOR   = 'doctor',
}

export class Banner extends Model<
  InferAttributes<Banner>,
  InferCreationAttributes<Banner>
> {
  declare id:            CreationOptional<string>;
  declare title:         string | null;
  declare subtitle:      string | null;
  declare image_url:     string;
  declare link_type:     CreationOptional<BannerLinkType>;
  declare link_value:    string | null;
  declare cta_label:     string | null;
  declare is_active:     CreationOptional<boolean>;
  declare display_order: CreationOptional<number>;
  declare starts_at:     Date | null;
  declare ends_at:       Date | null;
  declare created_by:    string | null;
  declare created_at:    CreationOptional<Date>;
  declare updated_at:    CreationOptional<Date>;
}

Banner.init(
  {
    id:            { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    title:         { type: DataTypes.STRING(120), allowNull: true },
    subtitle:      { type: DataTypes.STRING(200), allowNull: true },
    image_url:     { type: DataTypes.STRING(500), allowNull: false },
    link_type:     { type: DataTypes.ENUM(...Object.values(BannerLinkType)), defaultValue: BannerLinkType.NONE, allowNull: false },
    link_value:    { type: DataTypes.STRING(500), allowNull: true },
    cta_label:     { type: DataTypes.STRING(60),  allowNull: true },
    is_active:     { type: DataTypes.BOOLEAN,     defaultValue: false, allowNull: false },
    display_order: { type: DataTypes.INTEGER,     defaultValue: 0,     allowNull: false },
    starts_at:     { type: DataTypes.DATE,        allowNull: true },
    ends_at:       { type: DataTypes.DATE,        allowNull: true },
    created_by:    { type: DataTypes.UUID,        allowNull: true },
    created_at:    { type: DataTypes.DATE,        defaultValue: DataTypes.NOW },
    updated_at:    { type: DataTypes.DATE,        defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName:  'banners',
    timestamps: true,
    createdAt:  'created_at',
    updatedAt:  'updated_at',
  },
);
