'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {

    // ── consultation_queue ────────────────────────────────────────────────────
    await queryInterface.createTable('consultation_queue', {
      id:             { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:      { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id:    { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' }, onDelete: 'RESTRICT' },
      appointment_id: { type: Sequelize.UUID, allowNull: false, unique: true, references: { model: 'appointments', key: 'id' }, onDelete: 'RESTRICT' },
      patient_id:     { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      queue_date:      { type: Sequelize.DATEONLY, allowNull: false },
      queue_position:  { type: Sequelize.INTEGER,  allowNull: false },
      status:          { type: Sequelize.ENUM('waiting','called','in_consultation','completed','skipped','no_show','cancelled'), allowNull: false, defaultValue: 'waiting' },
      estimated_start_at: { type: Sequelize.DATE, allowNull: true },
      actual_start_at:    { type: Sequelize.DATE, allowNull: true },
      actual_end_at:      { type: Sequelize.DATE, allowNull: true },
      arrived_at:         { type: Sequelize.DATE, allowNull: true },
      called_at:          { type: Sequelize.DATE, allowNull: true },
      notified_at:        { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('consultation_queue', ['doctor_id', 'queue_date']);
    await queryInterface.addIndex('consultation_queue', ['doctor_id', 'queue_date', 'status']);

    // ── doctor_delay_events ───────────────────────────────────────────────────
    await queryInterface.createTable('doctor_delay_events', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' }, onDelete: 'RESTRICT' },
      event_date:  { type: Sequelize.DATEONLY, allowNull: false },
      delay_type:  { type: Sequelize.ENUM('late_arrival','absent','early_departure'), allowNull: false },
      delay_minutes:   { type: Sequelize.INTEGER, allowNull: true },
      reason:          { type: Sequelize.TEXT, allowNull: true },
      reported_by:     { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
      expected_arrival:{ type: Sequelize.DATE, allowNull: true },
      actual_arrival:  { type: Sequelize.DATE, allowNull: true },
      status:          { type: Sequelize.ENUM('active','resolved','cancelled_day'), allowNull: false, defaultValue: 'active' },
      affected_slots:   { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      patients_notified:{ type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('doctor_delay_events', ['doctor_id', 'event_date']);

    // ── user_notification_preferences ─────────────────────────────────────────
    await queryInterface.createTable('user_notification_preferences', {
      id:      { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      user_id: { type: Sequelize.UUID, allowNull: false, unique: true, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      sms_enabled:           { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      push_enabled:          { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      email_enabled:         { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      booking_reminders:     { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      delay_alerts:          { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      queue_position_alerts: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      promotional:           { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      quiet_hours_enabled:      { type: Sequelize.BOOLEAN,   allowNull: false, defaultValue: false },
      quiet_hours_start:        { type: Sequelize.STRING(5),  allowNull: false, defaultValue: '22:00' },
      quiet_hours_end:          { type: Sequelize.STRING(5),  allowNull: false, defaultValue: '07:00' },
      reminder_lead_time_hours: { type: Sequelize.INTEGER,    allowNull: false, defaultValue: 2 },
      queue_notify_at_position: { type: Sequelize.INTEGER,    allowNull: false, defaultValue: 2 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    // ── notification_logs ─────────────────────────────────────────────────────
    await queryInterface.createTable('notification_logs', {
      id:       { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      user_id:  { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      appointment_id:    { type: Sequelize.UUID,         allowNull: true },
      notification_type: { type: Sequelize.STRING(100),  allowNull: false },
      channel:           { type: Sequelize.ENUM('sms','push','email'), allowNull: false },
      recipient:         { type: Sequelize.STRING(300),  allowNull: false },
      rendered_body:     { type: Sequelize.TEXT,         allowNull: false },
      provider:          { type: Sequelize.STRING(50),   allowNull: true },
      provider_msg_id:   { type: Sequelize.STRING(200),  allowNull: true },
      status:            { type: Sequelize.ENUM('queued','sent','delivered','failed','bounced','opted_out'), allowNull: false, defaultValue: 'queued' },
      attempt_count:     { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      last_attempt_at:   { type: Sequelize.DATE, allowNull: true },
      delivered_at:      { type: Sequelize.DATE, allowNull: true },
      failure_reason:    { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('notification_logs', ['user_id']);
    await queryInterface.addIndex('notification_logs', ['status']);

    // ── opd_sessions ──────────────────────────────────────────────────────────
    await queryInterface.createTable('opd_sessions', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' }, onDelete: 'RESTRICT' },
      session_date:       { type: Sequelize.DATEONLY,   allowNull: false },
      session_type:       { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'morning' },
      booking_mode:       { type: Sequelize.ENUM('slot_based','token_based'), allowNull: false, defaultValue: 'token_based' },
      start_time:         { type: Sequelize.STRING(5), allowNull: false },
      expected_end_time:  { type: Sequelize.STRING(5), allowNull: false },
      actual_start_time:  { type: Sequelize.STRING(5), allowNull: true },
      actual_end_time:    { type: Sequelize.STRING(5), allowNull: true },
      total_tokens:        { type: Sequelize.INTEGER,      allowNull: false },
      online_token_limit:  { type: Sequelize.INTEGER,      allowNull: false },
      walkin_token_limit:  { type: Sequelize.INTEGER,      allowNull: false },
      tokens_issued:       { type: Sequelize.INTEGER,      allowNull: false, defaultValue: 0 },
      current_token:       { type: Sequelize.INTEGER,      allowNull: false, defaultValue: 0 },
      avg_time_per_patient:{ type: Sequelize.DECIMAL(5,2), allowNull: false, defaultValue: 5 },
      status:              { type: Sequelize.ENUM('scheduled','active','paused','completed','cancelled'), allowNull: false, defaultValue: 'scheduled' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('opd_sessions', ['doctor_id', 'session_date']);

    // ── opd_tokens ────────────────────────────────────────────────────────────
    await queryInterface.createTable('opd_tokens', {
      id:         { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      session_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'opd_sessions', key: 'id' }, onDelete: 'RESTRICT' },
      token_number:   { type: Sequelize.INTEGER, allowNull: false },
      patient_id:     { type: Sequelize.UUID,    allowNull: true, references: { model: 'users', key: 'id' } },
      appointment_id: { type: Sequelize.UUID,    allowNull: true, references: { model: 'appointments', key: 'id' } },
      token_type:  { type: Sequelize.ENUM('online','walkin','bulk','emergency','vip'), allowNull: false, defaultValue: 'online' },
      issued_at:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      issued_by:   { type: Sequelize.STRING(50), allowNull: false },
      arrived_at:         { type: Sequelize.DATE, allowNull: true },
      called_at:          { type: Sequelize.DATE, allowNull: true },
      consultation_start: { type: Sequelize.DATE, allowNull: true },
      consultation_end:   { type: Sequelize.DATE, allowNull: true },
      status: { type: Sequelize.ENUM('issued','arrived','waiting','called','in_progress','completed','skipped','cancelled','no_show'), allowNull: false, defaultValue: 'issued' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('opd_tokens', ['session_id', 'token_number'], { unique: true });
    await queryInterface.addIndex('opd_tokens', ['session_id', 'status']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('opd_tokens');
    await queryInterface.dropTable('opd_sessions');
    await queryInterface.dropTable('notification_logs');
    await queryInterface.dropTable('user_notification_preferences');
    await queryInterface.dropTable('doctor_delay_events');
    await queryInterface.dropTable('consultation_queue');
  },
};
