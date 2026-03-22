'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {

    // ── hospital_staff ────────────────────────────────────────────────────────
    await queryInterface.createTable('hospital_staff', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      user_id:     { type: Sequelize.UUID, allowNull: false, references: { model: 'users',     key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' }, onDelete: 'RESTRICT' },
      staff_role:  { type: Sequelize.ENUM('hospital_admin','receptionist'), allowNull: false },
      department:  { type: Sequelize.STRING(100), allowNull: true },
      employee_id: { type: Sequelize.STRING(50),  allowNull: true },
      is_active:   { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      joined_at:   { type: Sequelize.DATEONLY, allowNull: true },
      created_at:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('hospital_staff', ['user_id']);
    await queryInterface.addIndex('hospital_staff', ['hospital_id']);
    await queryInterface.addIndex('hospital_staff', ['user_id','hospital_id'], { unique: true });

    // ── doctor_profiles ───────────────────────────────────────────────────────
    await queryInterface.createTable('doctor_profiles', {
      id:      { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      user_id: { type: Sequelize.UUID, allowNull: false, unique: true, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      full_name:               { type: Sequelize.STRING(100), allowNull: false },
      specialization:          { type: Sequelize.STRING(100), allowNull: false },
      qualifications:          { type: Sequelize.ARRAY(Sequelize.STRING), allowNull: false, defaultValue: [] },
      experience_years:        { type: Sequelize.INTEGER,    allowNull: false, defaultValue: 0 },
      languages_spoken:        { type: Sequelize.ARRAY(Sequelize.STRING), allowNull: false, defaultValue: ['english'] },
      gender:                  { type: Sequelize.STRING(20), allowNull: true },
      profile_photo_url:       { type: Sequelize.STRING(500), allowNull: true },
      bio:                     { type: Sequelize.TEXT,        allowNull: true },
      nmc_registration_number: { type: Sequelize.STRING(50),  allowNull: true },
      verification_status:     { type: Sequelize.ENUM('pending','approved','rejected'), allowNull: false, defaultValue: 'pending' },
      verified_at:             { type: Sequelize.DATE, allowNull: true },
      verified_by:             { type: Sequelize.UUID, allowNull: true },
      default_booking_mode:    { type: Sequelize.ENUM('slot_based','token_based'), allowNull: false, defaultValue: 'slot_based' },
      max_patients_per_day:     { type: Sequelize.INTEGER,      allowNull: false, defaultValue: 40 },
      avg_consultation_minutes: { type: Sequelize.DECIMAL(5,2), allowNull: false, defaultValue: 20 },
      no_show_rate_historical:  { type: Sequelize.DECIMAL(5,2), allowNull: false, defaultValue: 0.20 },
      reliability_score:   { type: Sequelize.DECIMAL(5,2), allowNull: false, defaultValue: 80 },
      on_time_rate:        { type: Sequelize.DECIMAL(5,2), allowNull: false, defaultValue: 0.90 },
      cancellation_rate:   { type: Sequelize.DECIMAL(5,2), allowNull: false, defaultValue: 0.05 },
      completion_rate:     { type: Sequelize.DECIMAL(5,2), allowNull: false, defaultValue: 0.95 },
      is_active:   { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      deleted_at:  { type: Sequelize.DATE,    allowNull: true },
      created_at:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('doctor_profiles', ['specialization']);
    await queryInterface.addIndex('doctor_profiles', ['verification_status']);

    // ── doctor_hospital_affiliations ──────────────────────────────────────────
    await queryInterface.createTable('doctor_hospital_affiliations', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },
      is_primary:       { type: Sequelize.BOOLEAN,       allowNull: false, defaultValue: false },
      consultation_fee: { type: Sequelize.DECIMAL(10,2), allowNull: false },
      room_number:      { type: Sequelize.STRING(20),    allowNull: true },
      department:       { type: Sequelize.STRING(100),   allowNull: true },
      is_active:        { type: Sequelize.BOOLEAN,       allowNull: false, defaultValue: true },
      start_date:       { type: Sequelize.DATEONLY,      allowNull: false },
      end_date:         { type: Sequelize.DATEONLY,      allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('doctor_hospital_affiliations', ['doctor_id', 'hospital_id'], { unique: true });

    // ── schedules ─────────────────────────────────────────────────────────────
    await queryInterface.createTable('schedules', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },
      day_of_week:            { type: Sequelize.ENUM('monday','tuesday','wednesday','thursday','friday','saturday','sunday'), allowNull: false },
      start_time:             { type: Sequelize.STRING(5),  allowNull: false },
      end_time:               { type: Sequelize.STRING(5),  allowNull: false },
      slot_duration_minutes:  { type: Sequelize.INTEGER,    allowNull: false, defaultValue: 20 },
      max_patients:           { type: Sequelize.INTEGER,    allowNull: false, defaultValue: 20 },
      session_type:           { type: Sequelize.ENUM('opd','emergency','surgery'), allowNull: false, defaultValue: 'opd' },
      effective_from:         { type: Sequelize.DATEONLY,   allowNull: false },
      effective_until:        { type: Sequelize.DATEONLY,   allowNull: true },
      is_active:              { type: Sequelize.BOOLEAN,    allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('schedules', ['doctor_id', 'hospital_id', 'day_of_week']);

    // ── generated_slots ───────────────────────────────────────────────────────
    await queryInterface.createTable('generated_slots', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },
      schedule_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'schedules',       key: 'id' }, onDelete: 'RESTRICT' },
      slot_datetime:    { type: Sequelize.DATE,    allowNull: false },
      duration_minutes: { type: Sequelize.INTEGER, allowNull: false },
      status:           { type: Sequelize.ENUM('available','booked','blocked','expired'), allowNull: false, defaultValue: 'available' },
      appointment_id:   { type: Sequelize.UUID,         allowNull: true },
      blocked_reason:   { type: Sequelize.STRING(100),  allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('generated_slots', ['doctor_id','hospital_id','slot_datetime'], { unique: true });
    await queryInterface.addIndex('generated_slots', ['status']);

    // ── appointments ──────────────────────────────────────────────────────────
    await queryInterface.createTable('appointments', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      patient_id:  { type: Sequelize.UUID, allowNull: false, references: { model: 'users',            key: 'id' }, onDelete: 'RESTRICT' },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles',  key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',        key: 'id' }, onDelete: 'RESTRICT' },
      slot_id:     { type: Sequelize.UUID, allowNull: true, references: { model: 'generated_slots', key: 'id' }, onDelete: 'SET NULL' },
      scheduled_at: { type: Sequelize.DATE, allowNull: false },
      status:         { type: Sequelize.ENUM('pending','confirmed','delayed','in_progress','completed','cancelled','missed','rescheduled'), allowNull: false, defaultValue: 'pending' },
      payment_status: { type: Sequelize.ENUM('pending','captured','failed','refund_pending','refunded'), allowNull: false, defaultValue: 'pending' },
      appointment_type: { type: Sequelize.ENUM('online_booking','walk_in','emergency','follow_up'), allowNull: false, defaultValue: 'online_booking' },
      payment_mode:     { type: Sequelize.ENUM('online_prepaid','cash','card'), allowNull: false, defaultValue: 'online_prepaid' },
      consultation_fee: { type: Sequelize.DECIMAL(10,2), allowNull: false },
      platform_fee:     { type: Sequelize.DECIMAL(10,2), allowNull: false, defaultValue: 0 },
      doctor_payout:    { type: Sequelize.DECIMAL(10,2), allowNull: false, defaultValue: 0 },
      notes:               { type: Sequelize.TEXT, allowNull: true },
      cancellation_reason: { type: Sequelize.TEXT, allowNull: true },
      cancelled_by:        { type: Sequelize.ENUM('patient','doctor','admin','system'), allowNull: true },
      cancelled_at:        { type: Sequelize.DATE, allowNull: true },
      razorpay_order_id:   { type: Sequelize.STRING(100), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('appointments', ['patient_id']);
    await queryInterface.addIndex('appointments', ['doctor_id']);
    await queryInterface.addIndex('appointments', ['scheduled_at']);
    await queryInterface.addIndex('appointments', ['status']);

    // ── payments ──────────────────────────────────────────────────────────────
    await queryInterface.createTable('payments', {
      id:             { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      appointment_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'appointments', key: 'id' }, onDelete: 'RESTRICT' },
      razorpay_order_id:   { type: Sequelize.STRING(100), allowNull: false },
      razorpay_payment_id: { type: Sequelize.STRING(100), allowNull: true, unique: true },
      amount:        { type: Sequelize.DECIMAL(10,2), allowNull: false },
      platform_fee:  { type: Sequelize.DECIMAL(10,2), allowNull: false },
      doctor_payout: { type: Sequelize.DECIMAL(10,2), allowNull: false },
      currency:      { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'INR' },
      status:        { type: Sequelize.ENUM('created','captured','failed','refunded'), allowNull: false, defaultValue: 'created' },
      captured_at:   { type: Sequelize.DATE, allowNull: true },
      refunded_at:   { type: Sequelize.DATE, allowNull: true },
      refund_amount: { type: Sequelize.DECIMAL(10,2), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    // ── webhook_events ────────────────────────────────────────────────────────
    await queryInterface.createTable('webhook_events', {
      id:            { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      event_id:      { type: Sequelize.STRING(100), allowNull: false, unique: true },
      event_type:    { type: Sequelize.STRING(100), allowNull: false },
      payload:       { type: Sequelize.JSONB,       allowNull: false },
      status:        { type: Sequelize.ENUM('received','processing','processed','failed'), allowNull: false, defaultValue: 'received' },
      processed_at:  { type: Sequelize.DATE, allowNull: true },
      error_message: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('webhook_events', ['status']);
    await queryInterface.addIndex('webhook_events', ['event_type']);
  },

  async down(queryInterface) {
    // Drop in reverse FK order
    await queryInterface.dropTable('webhook_events');
    await queryInterface.dropTable('payments');
    await queryInterface.dropTable('appointments');
    await queryInterface.dropTable('generated_slots');
    await queryInterface.dropTable('schedules');
    await queryInterface.dropTable('doctor_hospital_affiliations');
    await queryInterface.dropTable('doctor_profiles');
    await queryInterface.dropTable('hospital_staff');
  },
};
