import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum WaitlistStatus {
  WAITING   = 'waiting',
  OFFERED   = 'offered',
  CONFIRMED = 'confirmed',
  EXPIRED   = 'expired',
  CANCELLED = 'cancelled',
}

export class WaitlistEntry extends Model<
  InferAttributes<WaitlistEntry>,
  InferCreationAttributes<WaitlistEntry>
> {
  declare id:                   CreationOptional<string>;
  declare doctor_id:            ForeignKey<string>;
  declare hospital_id:          ForeignKey<string>;
  declare patient_id:           ForeignKey<string>;
  declare date:                 string;              // YYYY-MM-DD
  declare procedure_type_id:    string | null;       // for gap-based doctors
  declare preferred_start_time: string | null;       // HH:MM
  declare preferred_end_time:   string | null;       // HH:MM
  declare position:             number;
  declare status:               CreationOptional<WaitlistStatus>;
  declare offered_slot_id:      string | null;
  declare offered_at:           Date | null;
  declare expires_at:           Date | null;         // 15 min after offered_at
  declare created_at:           CreationOptional<Date>;
  declare updated_at:           CreationOptional<Date>;
}

WaitlistEntry.init(
  {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },
    patient_id:  { type: DataTypes.UUID, allowNull: false, references: { model: 'users',           key: 'id' } },

    date:                 { type: DataTypes.DATEONLY,   allowNull: false },
    procedure_type_id:    { type: DataTypes.UUID,       allowNull: true },
    preferred_start_time: { type: DataTypes.STRING(5),  allowNull: true },
    preferred_end_time:   { type: DataTypes.STRING(5),  allowNull: true },
    position:             { type: DataTypes.INTEGER,    allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(WaitlistStatus)),
      allowNull: false, defaultValue: WaitlistStatus.WAITING,
    },
    offered_slot_id: { type: DataTypes.UUID, allowNull: true },
    offered_at:      { type: DataTypes.DATE, allowNull: true },
    expires_at:      { type: DataTypes.DATE, allowNull: true },

    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'waitlist_entries',
    modelName: 'WaitlistEntry',
    indexes: [
      { fields: ['doctor_id', 'date'] },
      { fields: ['patient_id'] },
      { fields: ['status'] },
      { fields: ['expires_at'] },
    ],
  },
);
