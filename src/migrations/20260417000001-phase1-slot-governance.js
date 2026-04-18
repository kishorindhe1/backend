'use strict';

/** Phase 1 — Slot Governance Foundation
 *
 *  New tables:
 *    opd_slot_sessions, procedure_types, doctor_availability_windows,
 *    doctor_availability_overrides, doctor_booking_preferences,
 *    opd_review_logs, slot_change_logs, hospital_closures,
 *    walk_in_tokens, no_show_logs, waitlist_entries,
 *    opd_daily_stats, slot_templates
 *
 *  Modified tables:
 *    schedules           — + booking_mode, buffer_minutes, end_buffer_minutes, emergency_reserve_slots
 *    appointments        — + chief_complaint, visit_type, visit_subtype, procedure_type_id,
 *                            referred_by_doctor_id, referring_hospital_id, original_doctor_id,
 *                            substitution_reason, checked_in_at, priority_tier, priority_reason
 *    doctor_hospital_affiliations — + employment_type, slot_autonomy_level
 */

module.exports = {
  async up(queryInterface, Sequelize) {

    // ── 1. opd_slot_sessions ────────────────────────────────────────────────
    await queryInterface.createTable('opd_slot_sessions', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },
      schedule_id: { type: Sequelize.UUID, allowNull: true,  references: { model: 'schedules',       key: 'id' }, onDelete: 'SET NULL' },

      date:             { type: Sequelize.DATEONLY,   allowNull: false },
      slot_start_time:  { type: Sequelize.STRING(5),  allowNull: false },
      slot_end_time:    { type: Sequelize.STRING(5),  allowNull: false },
      duration_minutes: { type: Sequelize.INTEGER,    allowNull: false },

      booking_engine: {
        type: Sequelize.ENUM('fixed_slots', 'gap_based'),
        allowNull: false, defaultValue: 'fixed_slots',
      },
      slot_category: {
        type: Sequelize.ENUM('regular', 'follow_up_only', 'walk_in_only', 'emergency_only', 'vip'),
        allowNull: false, defaultValue: 'regular',
      },
      custom_duration_minutes: { type: Sequelize.INTEGER,     allowNull: true },
      custom_added:            { type: Sequelize.BOOLEAN,     allowNull: false, defaultValue: false },

      status: {
        type: Sequelize.ENUM('draft', 'published', 'booked', 'blocked', 'cancelled', 'no_show', 'completed', 'reserved_emergency'),
        allowNull: false, defaultValue: 'draft',
      },

      appointment_id:    { type: Sequelize.UUID,        allowNull: true },
      walk_in_token_id:  { type: Sequelize.UUID,        allowNull: true },
      procedure_type_id: { type: Sequelize.UUID,        allowNull: true },
      blocked_reason:    { type: Sequelize.STRING(200), allowNull: true },
      published_at:      { type: Sequelize.DATE,        allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('opd_slot_sessions', ['doctor_id', 'hospital_id', 'date', 'slot_start_time'], { unique: true, name: 'opd_slot_sessions_unique' });
    await queryInterface.addIndex('opd_slot_sessions', ['doctor_id', 'date']);
    await queryInterface.addIndex('opd_slot_sessions', ['hospital_id', 'date']);
    await queryInterface.addIndex('opd_slot_sessions', ['status']);
    await queryInterface.addIndex('opd_slot_sessions', ['date']);

    // ── 2. procedure_types ──────────────────────────────────────────────────
    await queryInterface.createTable('procedure_types', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },

      name:             { type: Sequelize.STRING(100), allowNull: false },
      duration_minutes: { type: Sequelize.INTEGER,     allowNull: false },
      category: {
        type: Sequelize.ENUM('consultation', 'procedure', 'follow_up', 'review'),
        allowNull: false, defaultValue: 'consultation',
      },
      prep_time_minutes:    { type: Sequelize.INTEGER,   allowNull: false, defaultValue: 0 },
      cleanup_time_minutes: { type: Sequelize.INTEGER,   allowNull: false, defaultValue: 0 },
      color_code:           { type: Sequelize.STRING(7), allowNull: true },
      is_active:            { type: Sequelize.BOOLEAN,   allowNull: false, defaultValue: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('procedure_types', ['doctor_id', 'hospital_id']);
    await queryInterface.addIndex('procedure_types', ['is_active']);

    // ── 3. doctor_availability_windows ──────────────────────────────────────
    await queryInterface.createTable('doctor_availability_windows', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },

      day_of_week:   { type: Sequelize.ENUM('monday','tuesday','wednesday','thursday','friday','saturday','sunday'), allowNull: false },
      window_start:  { type: Sequelize.STRING(5), allowNull: false },
      window_end:    { type: Sequelize.STRING(5), allowNull: false },
      booking_mode: {
        type: Sequelize.ENUM('fixed_slots', 'gap_based'),
        allowNull: false, defaultValue: 'fixed_slots',
      },
      effective_from:  { type: Sequelize.DATEONLY, allowNull: false },
      effective_until: { type: Sequelize.DATEONLY, allowNull: true },
      is_active:       { type: Sequelize.BOOLEAN,  allowNull: false, defaultValue: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('doctor_availability_windows', ['doctor_id', 'hospital_id']);
    await queryInterface.addIndex('doctor_availability_windows', ['doctor_id', 'day_of_week']);

    // ── 4. doctor_availability_overrides ────────────────────────────────────
    await queryInterface.createTable('doctor_availability_overrides', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },
      created_by:  { type: Sequelize.UUID, allowNull: false, references: { model: 'users',           key: 'id' }, onDelete: 'RESTRICT' },

      date: { type: Sequelize.DATEONLY, allowNull: false },
      override_type: {
        type: Sequelize.ENUM('late_start', 'early_end', 'day_off', 'extra_hours', 'break', 'running_late'),
        allowNull: false,
      },
      start_time:    { type: Sequelize.STRING(5),   allowNull: true },
      end_time:      { type: Sequelize.STRING(5),   allowNull: true },
      delay_minutes: { type: Sequelize.INTEGER,     allowNull: true },
      reason:        { type: Sequelize.STRING(300), allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('doctor_availability_overrides', ['doctor_id', 'date']);
    await queryInterface.addIndex('doctor_availability_overrides', ['hospital_id', 'date']);

    // ── 5. doctor_booking_preferences ───────────────────────────────────────
    await queryInterface.createTable('doctor_booking_preferences', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },

      min_booking_lead_hours:     { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      booking_cutoff_hours:       { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      max_new_patients_per_day:   { type: Sequelize.INTEGER, allowNull: true },
      max_followups_per_day:      { type: Sequelize.INTEGER, allowNull: true },
      new_patient_slot_positions: { type: Sequelize.JSONB,   allowNull: true },
      followup_slot_positions:    { type: Sequelize.JSONB,   allowNull: true },
      requires_booking_approval:  { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      approval_timeout_hours:     { type: Sequelize.INTEGER, allowNull: false, defaultValue: 2 },
      default_slot_duration:      { type: Sequelize.INTEGER, allowNull: true },
      notes_for_patients:         { type: Sequelize.TEXT,    allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('doctor_booking_preferences', ['doctor_id', 'hospital_id'], { unique: true, name: 'doctor_booking_pref_unique' });

    // ── 6. opd_review_logs ──────────────────────────────────────────────────
    await queryInterface.createTable('opd_review_logs', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' }, onDelete: 'RESTRICT' },
      reviewed_by: { type: Sequelize.UUID, allowNull: true,  references: { model: 'users',     key: 'id' }, onDelete: 'SET NULL' },

      date:           { type: Sequelize.DATEONLY, allowNull: false },
      reviewed_at:    { type: Sequelize.DATE,     allowNull: true },
      auto_published: { type: Sequelize.BOOLEAN,  allowNull: false, defaultValue: false },
      notes:          { type: Sequelize.TEXT,     allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('opd_review_logs', ['hospital_id', 'date'], { unique: true, name: 'opd_review_logs_unique' });
    await queryInterface.addIndex('opd_review_logs', ['date']);

    // ── 7. slot_change_logs ─────────────────────────────────────────────────
    await queryInterface.createTable('slot_change_logs', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      created_by:  { type: Sequelize.UUID, allowNull: false, references: { model: 'users',           key: 'id' }, onDelete: 'RESTRICT' },

      date: { type: Sequelize.DATEONLY, allowNull: false },
      change_type: {
        type: Sequelize.ENUM('override_applied', 'schedule_updated', 'manual_block', 'cancellation', 'rollback'),
        allowNull: false,
      },
      scope: {
        type: Sequelize.ENUM('today', 'specific_date', 'from_date', 'permanent'),
        allowNull: false,
      },
      slots_affected:           { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      booked_patients_notified: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      previous_state_snapshot:  { type: Sequelize.JSONB,   allowNull: true },
      reason:                   { type: Sequelize.TEXT,    allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('slot_change_logs', ['hospital_id', 'date']);
    await queryInterface.addIndex('slot_change_logs', ['doctor_id', 'date']);
    await queryInterface.addIndex('slot_change_logs', ['created_at']);

    // ── 8. hospital_closures ────────────────────────────────────────────────
    await queryInterface.createTable('hospital_closures', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' }, onDelete: 'RESTRICT' },
      created_by:  { type: Sequelize.UUID, allowNull: false, references: { model: 'users',     key: 'id' }, onDelete: 'RESTRICT' },

      closure_date: { type: Sequelize.DATEONLY, allowNull: false },
      closure_type: {
        type: Sequelize.ENUM('full_day', 'partial'),
        allowNull: false, defaultValue: 'full_day',
      },
      start_time: { type: Sequelize.STRING(5),   allowNull: true },
      end_time:   { type: Sequelize.STRING(5),   allowNull: true },
      reason:     { type: Sequelize.STRING(300), allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('hospital_closures', ['hospital_id', 'closure_date']);
    await queryInterface.addIndex('hospital_closures', ['closure_date']);

    // ── 9. walk_in_tokens ───────────────────────────────────────────────────
    await queryInterface.createTable('walk_in_tokens', {
      id:          { type: Sequelize.UUID,    defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID,    allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID,    allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },
      patient_id:  { type: Sequelize.UUID,    allowNull: true,  references: { model: 'users',           key: 'id' }, onDelete: 'SET NULL' },
      created_by:  { type: Sequelize.UUID,    allowNull: false, references: { model: 'users',           key: 'id' }, onDelete: 'RESTRICT' },

      date:         { type: Sequelize.DATEONLY,    allowNull: false },
      token_number: { type: Sequelize.INTEGER,     allowNull: false },
      patient_name: { type: Sequelize.STRING(100), allowNull: true },
      status: {
        type: Sequelize.ENUM('waiting', 'called', 'completed', 'left'),
        allowNull: false, defaultValue: 'waiting',
      },
      slot_id: { type: Sequelize.UUID, allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('walk_in_tokens', ['doctor_id', 'hospital_id', 'date', 'token_number'], { unique: true, name: 'walk_in_tokens_unique' });
    await queryInterface.addIndex('walk_in_tokens', ['doctor_id', 'date']);
    await queryInterface.addIndex('walk_in_tokens', ['status']);

    // ── 10. no_show_logs ────────────────────────────────────────────────────
    await queryInterface.createTable('no_show_logs', {
      id:             { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      appointment_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'appointments',    key: 'id' }, onDelete: 'RESTRICT' },
      patient_id:     { type: Sequelize.UUID, allowNull: false, references: { model: 'users',           key: 'id' }, onDelete: 'RESTRICT' },
      doctor_id:      { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      slot_id:        { type: Sequelize.UUID, allowNull: true },

      grace_period_minutes: { type: Sequelize.INTEGER,     allowNull: false, defaultValue: 15 },
      marked_by:            { type: Sequelize.STRING(100), allowNull: false },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('no_show_logs', ['patient_id']);
    await queryInterface.addIndex('no_show_logs', ['doctor_id']);
    await queryInterface.addIndex('no_show_logs', ['appointment_id']);

    // ── 11. waitlist_entries ────────────────────────────────────────────────
    await queryInterface.createTable('waitlist_entries', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },
      patient_id:  { type: Sequelize.UUID, allowNull: false, references: { model: 'users',           key: 'id' }, onDelete: 'RESTRICT' },

      date:                 { type: Sequelize.DATEONLY,  allowNull: false },
      procedure_type_id:    { type: Sequelize.UUID,      allowNull: true },
      preferred_start_time: { type: Sequelize.STRING(5), allowNull: true },
      preferred_end_time:   { type: Sequelize.STRING(5), allowNull: true },
      position:             { type: Sequelize.INTEGER,   allowNull: false },
      status: {
        type: Sequelize.ENUM('waiting', 'offered', 'confirmed', 'expired', 'cancelled'),
        allowNull: false, defaultValue: 'waiting',
      },
      offered_slot_id: { type: Sequelize.UUID, allowNull: true },
      offered_at:      { type: Sequelize.DATE, allowNull: true },
      expires_at:      { type: Sequelize.DATE, allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('waitlist_entries', ['doctor_id', 'date']);
    await queryInterface.addIndex('waitlist_entries', ['patient_id']);
    await queryInterface.addIndex('waitlist_entries', ['status']);
    await queryInterface.addIndex('waitlist_entries', ['expires_at']);

    // ── 12. opd_daily_stats ─────────────────────────────────────────────────
    await queryInterface.createTable('opd_daily_stats', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',       key: 'id' }, onDelete: 'RESTRICT' },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'RESTRICT' },

      date:                  { type: Sequelize.DATEONLY,      allowNull: false },
      total_slots_published: { type: Sequelize.INTEGER,       allowNull: false, defaultValue: 0 },
      total_booked:          { type: Sequelize.INTEGER,       allowNull: false, defaultValue: 0 },
      total_walk_ins:        { type: Sequelize.INTEGER,       allowNull: false, defaultValue: 0 },
      total_no_shows:        { type: Sequelize.INTEGER,       allowNull: false, defaultValue: 0 },
      total_cancellations:   { type: Sequelize.INTEGER,       allowNull: false, defaultValue: 0 },
      total_completed:       { type: Sequelize.INTEGER,       allowNull: false, defaultValue: 0 },
      utilisation_rate:      { type: Sequelize.DECIMAL(5,2),  allowNull: true },
      avg_delay_minutes:     { type: Sequelize.DECIMAL(6,2),  allowNull: true },
      avg_wait_minutes:      { type: Sequelize.DECIMAL(6,2),  allowNull: true },
      revenue_collected:     { type: Sequelize.DECIMAL(12,2), allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('opd_daily_stats', ['hospital_id', 'doctor_id', 'date'], { unique: true, name: 'opd_daily_stats_unique' });
    await queryInterface.addIndex('opd_daily_stats', ['date']);
    await queryInterface.addIndex('opd_daily_stats', ['hospital_id']);

    // ── 13. slot_templates ──────────────────────────────────────────────────
    await queryInterface.createTable('slot_templates', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' }, onDelete: 'RESTRICT' },
      created_by:  { type: Sequelize.UUID, allowNull: false, references: { model: 'users',     key: 'id' }, onDelete: 'RESTRICT' },

      name:       { type: Sequelize.STRING(100), allowNull: false },
      applies_to: {
        type: Sequelize.ENUM('all_doctors', 'specific_doctors', 'specific_specialisation'),
        allowNull: false, defaultValue: 'all_doctors',
      },
      doctor_ids:              { type: Sequelize.JSONB,    allowNull: true },
      specialisation:          { type: Sequelize.STRING(100), allowNull: true },
      day_of_week:             { type: Sequelize.ENUM('monday','tuesday','wednesday','thursday','friday','saturday','sunday'), allowNull: true },
      override_start_time:     { type: Sequelize.STRING(5),   allowNull: true },
      override_end_time:       { type: Sequelize.STRING(5),   allowNull: true },
      capacity_percent:        { type: Sequelize.INTEGER,     allowNull: false, defaultValue: 100 },
      emergency_reserve_slots: { type: Sequelize.INTEGER,     allowNull: false, defaultValue: 1 },
      notes:                   { type: Sequelize.TEXT,        allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('slot_templates', ['hospital_id']);

    // ── 14. Modify schedules ────────────────────────────────────────────────
    await queryInterface.addColumn('schedules', 'booking_mode', {
      type: Sequelize.ENUM('fixed_slots', 'gap_based'),
      allowNull: false, defaultValue: 'fixed_slots',
    });
    await queryInterface.addColumn('schedules', 'buffer_minutes',          { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('schedules', 'end_buffer_minutes',      { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('schedules', 'emergency_reserve_slots', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 });

    // ── 15. Modify appointments ─────────────────────────────────────────────
    await queryInterface.addColumn('appointments', 'chief_complaint',       { type: Sequelize.STRING(500), allowNull: true });
    await queryInterface.addColumn('appointments', 'visit_type', {
      type: Sequelize.ENUM('new_consultation', 'follow_up', 'test_review', 'procedure', 'emergency'),
      allowNull: true,
    });
    await queryInterface.addColumn('appointments', 'visit_subtype',         { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn('appointments', 'procedure_type_id',     { type: Sequelize.UUID,        allowNull: true });
    await queryInterface.addColumn('appointments', 'referred_by_doctor_id', { type: Sequelize.UUID,        allowNull: true });
    await queryInterface.addColumn('appointments', 'referring_hospital_id', { type: Sequelize.UUID,        allowNull: true });
    await queryInterface.addColumn('appointments', 'original_doctor_id',    { type: Sequelize.UUID,        allowNull: true });
    await queryInterface.addColumn('appointments', 'substitution_reason',   { type: Sequelize.STRING(300), allowNull: true });
    await queryInterface.addColumn('appointments', 'checked_in_at',         { type: Sequelize.DATE,        allowNull: true });
    await queryInterface.addColumn('appointments', 'priority_tier', {
      type: Sequelize.ENUM('emergency', 'senior', 'differently_abled', 'pregnant', 'follow_up', 'regular'),
      allowNull: false, defaultValue: 'regular',
    });
    await queryInterface.addColumn('appointments', 'priority_reason',       { type: Sequelize.STRING(200), allowNull: true });

    // ── 16. Modify doctor_hospital_affiliations ─────────────────────────────
    await queryInterface.addColumn('doctor_hospital_affiliations', 'employment_type', {
      type: Sequelize.ENUM('visiting_consultant', 'employed', 'resident'),
      allowNull: false, defaultValue: 'visiting_consultant',
    });
    await queryInterface.addColumn('doctor_hospital_affiliations', 'slot_autonomy_level', {
      type: Sequelize.ENUM('full', 'partial', 'none'),
      allowNull: false, defaultValue: 'partial',
    });
  },

  async down(queryInterface, Sequelize) {
    // Remove columns from existing tables first
    await queryInterface.removeColumn('doctor_hospital_affiliations', 'slot_autonomy_level');
    await queryInterface.removeColumn('doctor_hospital_affiliations', 'employment_type');

    await queryInterface.removeColumn('appointments', 'priority_reason');
    await queryInterface.removeColumn('appointments', 'priority_tier');
    await queryInterface.removeColumn('appointments', 'checked_in_at');
    await queryInterface.removeColumn('appointments', 'substitution_reason');
    await queryInterface.removeColumn('appointments', 'original_doctor_id');
    await queryInterface.removeColumn('appointments', 'referring_hospital_id');
    await queryInterface.removeColumn('appointments', 'referred_by_doctor_id');
    await queryInterface.removeColumn('appointments', 'procedure_type_id');
    await queryInterface.removeColumn('appointments', 'visit_subtype');
    await queryInterface.removeColumn('appointments', 'visit_type');
    await queryInterface.removeColumn('appointments', 'chief_complaint');

    await queryInterface.removeColumn('schedules', 'emergency_reserve_slots');
    await queryInterface.removeColumn('schedules', 'end_buffer_minutes');
    await queryInterface.removeColumn('schedules', 'buffer_minutes');
    await queryInterface.removeColumn('schedules', 'booking_mode');

    // Drop new tables in reverse FK dependency order
    await queryInterface.dropTable('slot_templates');
    await queryInterface.dropTable('opd_daily_stats');
    await queryInterface.dropTable('waitlist_entries');
    await queryInterface.dropTable('no_show_logs');
    await queryInterface.dropTable('walk_in_tokens');
    await queryInterface.dropTable('hospital_closures');
    await queryInterface.dropTable('slot_change_logs');
    await queryInterface.dropTable('opd_review_logs');
    await queryInterface.dropTable('doctor_booking_preferences');
    await queryInterface.dropTable('doctor_availability_overrides');
    await queryInterface.dropTable('doctor_availability_windows');
    await queryInterface.dropTable('procedure_types');
    await queryInterface.dropTable('opd_slot_sessions');
  },
};
