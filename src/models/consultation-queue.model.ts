import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export enum QueueStatus {
  WAITING         = 'waiting',
  CALLED          = 'called',
  IN_CONSULTATION = 'in_consultation',
  COMPLETED       = 'completed',
  SKIPPED         = 'skipped',
  NO_SHOW         = 'no_show',
  CANCELLED       = 'cancelled',
}

export class ConsultationQueue extends Model<
  InferAttributes<ConsultationQueue>,
  InferCreationAttributes<ConsultationQueue>
> {
  declare id:               CreationOptional<string>;
  declare doctor_id:        ForeignKey<string>;   // → doctor_profiles.id
  declare hospital_id:      ForeignKey<string>;
  declare appointment_id:   ForeignKey<string>;   // → appointments.id
  declare patient_id:       ForeignKey<string>;   // → users.id
  declare queue_date:       string;               // YYYY-MM-DD
  declare queue_position:   number;
  declare status:           CreationOptional<QueueStatus>;
  declare estimated_start_at: Date | null;
  declare actual_start_at:  Date | null;
  declare actual_end_at:    Date | null;
  declare arrived_at:       Date | null;
  declare called_at:        Date | null;
  declare notified_at:      Date | null;          // "your turn soon" notification sent
  declare created_at:       CreationOptional<Date>;
  declare updated_at:       CreationOptional<Date>;
}

ConsultationQueue.init(
  {
    id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    doctor_id:    { type: DataTypes.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' } },
    hospital_id:  { type: DataTypes.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' } },
    appointment_id: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: 'appointments', key: 'id' } },
    patient_id:   { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
    queue_date:   { type: DataTypes.DATEONLY, allowNull: false },
    queue_position: { type: DataTypes.INTEGER, allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(QueueStatus)),
      allowNull: false, defaultValue: QueueStatus.WAITING,
    },
    estimated_start_at: { type: DataTypes.DATE, allowNull: true },
    actual_start_at:    { type: DataTypes.DATE, allowNull: true },
    actual_end_at:      { type: DataTypes.DATE, allowNull: true },
    arrived_at:         { type: DataTypes.DATE, allowNull: true },
    called_at:          { type: DataTypes.DATE, allowNull: true },
    notified_at:        { type: DataTypes.DATE, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'consultation_queue',
    modelName: 'ConsultationQueue',
    indexes: [
      { fields: ['doctor_id', 'queue_date'] },
      { fields: ['doctor_id', 'queue_date', 'status'] },
      { fields: ['patient_id'] },
      { unique: true, fields: ['appointment_id'] },
    ],
  },
);
