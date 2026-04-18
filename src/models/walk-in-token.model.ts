import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum WalkInTokenStatus {
  WAITING   = 'waiting',
  CALLED    = 'called',
  COMPLETED = 'completed',
  LEFT      = 'left',
}

export class WalkInToken extends Model<
  InferAttributes<WalkInToken>,
  InferCreationAttributes<WalkInToken>
> {
  declare id:           CreationOptional<string>;
  declare doctor_id:    ForeignKey<string>;
  declare hospital_id:  ForeignKey<string>;
  declare date:         string;                    // YYYY-MM-DD
  declare token_number: number;
  declare patient_id:   ForeignKey<string> | null; // null if unregistered
  declare patient_name: string | null;             // for unregistered walk-ins
  declare status:       CreationOptional<WalkInTokenStatus>;
  declare slot_id:      string | null;             // FK to opd_slot_sessions when assigned
  declare created_by:   ForeignKey<string>;
  declare created_at:   CreationOptional<Date>;
  declare updated_at:   CreationOptional<Date>;
}

WalkInToken.init(
  {
    id:          { type: DataTypes.UUID,    defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID,    allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID,    allowNull: false, references: { model: 'hospitals',       key: 'id' } },
    patient_id:  { type: DataTypes.UUID,    allowNull: true,  references: { model: 'users',           key: 'id' } },
    created_by:  { type: DataTypes.UUID,    allowNull: false, references: { model: 'users',           key: 'id' } },

    date:         { type: DataTypes.DATEONLY,    allowNull: false },
    token_number: { type: DataTypes.INTEGER,     allowNull: false },
    patient_name: { type: DataTypes.STRING(100), allowNull: true },
    status: {
      type: DataTypes.ENUM(...Object.values(WalkInTokenStatus)),
      allowNull: false, defaultValue: WalkInTokenStatus.WAITING,
    },
    slot_id: { type: DataTypes.UUID, allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'walk_in_tokens',
    modelName: 'WalkInToken',
    indexes: [
      { unique: true, fields: ['doctor_id', 'hospital_id', 'date', 'token_number'] },
      { fields: ['doctor_id', 'date'] },
      { fields: ['status'] },
    ],
  },
);
