import {
  Model, DataTypes,
  InferAttributes, InferCreationAttributes,
  CreationOptional, ForeignKey,
} from 'sequelize';
import { sequelize } from '../config/database';

export class UserNotificationPreference extends Model<
  InferAttributes<UserNotificationPreference>,
  InferCreationAttributes<UserNotificationPreference>
> {
  declare id:                       CreationOptional<string>;
  declare user_id:                  ForeignKey<string>;
  declare sms_enabled:              CreationOptional<boolean>;
  declare push_enabled:             CreationOptional<boolean>;
  declare email_enabled:            CreationOptional<boolean>;
  declare booking_reminders:        CreationOptional<boolean>;
  declare delay_alerts:             CreationOptional<boolean>;
  declare queue_position_alerts:    CreationOptional<boolean>;
  declare promotional:              CreationOptional<boolean>;
  declare quiet_hours_enabled:      CreationOptional<boolean>;
  declare quiet_hours_start:        CreationOptional<string>;   // 'HH:MM'
  declare quiet_hours_end:          CreationOptional<string>;
  declare reminder_lead_time_hours: CreationOptional<number>;
  declare queue_notify_at_position: CreationOptional<number>;
  declare created_at:               CreationOptional<Date>;
  declare updated_at:               CreationOptional<Date>;
}

UserNotificationPreference.init(
  {
    id:      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    user_id: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: 'users', key: 'id' } },

    sms_enabled:           { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    push_enabled:          { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    email_enabled:         { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    booking_reminders:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    delay_alerts:          { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    queue_position_alerts: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    promotional:           { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    quiet_hours_enabled:       { type: DataTypes.BOOLEAN,    allowNull: false, defaultValue: false },
    quiet_hours_start:         { type: DataTypes.STRING(5),  allowNull: false, defaultValue: '22:00' },
    quiet_hours_end:           { type: DataTypes.STRING(5),  allowNull: false, defaultValue: '07:00' },
    reminder_lead_time_hours:  { type: DataTypes.INTEGER,    allowNull: false, defaultValue: 2 },
    queue_notify_at_position:  { type: DataTypes.INTEGER,    allowNull: false, defaultValue: 2 },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'user_notification_preferences',
    modelName: 'UserNotificationPreference',
    indexes: [{ fields: ['user_id'] }],
  },
);
