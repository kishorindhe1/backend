'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {

    // ── doctor_search_index ───────────────────────────────────────────────────
    await queryInterface.createTable('doctor_search_index', {
      id:          { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      doctor_id:   { type: Sequelize.UUID, allowNull: false, references: { model: 'doctor_profiles', key: 'id' }, onDelete: 'CASCADE' },
      hospital_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' }, onDelete: 'CASCADE' },

      doctor_name:            { type: Sequelize.STRING(100), allowNull: false },
      doctor_name_normalized: { type: Sequelize.STRING(100), allowNull: false },
      specialization:         { type: Sequelize.STRING(100), allowNull: false },
      qualifications:         { type: Sequelize.ARRAY(Sequelize.STRING), allowNull: false, defaultValue: [] },
      languages_spoken:       { type: Sequelize.ARRAY(Sequelize.STRING), allowNull: false, defaultValue: ['english'] },
      gender:                 { type: Sequelize.STRING(20), allowNull: true },
      experience_years:       { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },

      hospital_name: { type: Sequelize.STRING(200), allowNull: false },
      city:          { type: Sequelize.STRING(100), allowNull: false },
      area:          { type: Sequelize.STRING(300), allowNull: true },
      latitude:      { type: Sequelize.DECIMAL(10, 8), allowNull: true },
      longitude:     { type: Sequelize.DECIMAL(11, 8), allowNull: true },

      consultation_fee:      { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      next_available_slot:   { type: Sequelize.DATE,    allowNull: true },
      available_today:       { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      available_slots_today: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },

      avg_rating:           { type: Sequelize.DECIMAL(3, 2), allowNull: false, defaultValue: 0 },
      total_reviews:        { type: Sequelize.INTEGER,       allowNull: false, defaultValue: 0 },
      wilson_rating_score:  { type: Sequelize.DECIMAL(5, 4), allowNull: false, defaultValue: 0 },
      reliability_score:    { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 80 },
      total_consultations:  { type: Sequelize.INTEGER,       allowNull: false, defaultValue: 0 },

      is_active:        { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      is_verified:      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      hospital_is_live: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      last_indexed_at:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('doctor_search_index', ['doctor_id', 'hospital_id'], { unique: true });
    await queryInterface.addIndex('doctor_search_index', ['city']);
    await queryInterface.addIndex('doctor_search_index', ['specialization']);
    await queryInterface.addIndex('doctor_search_index', ['is_active', 'is_verified', 'hospital_is_live']);
    await queryInterface.addIndex('doctor_search_index', ['available_today']);
    await queryInterface.addIndex('doctor_search_index', ['wilson_rating_score']);
    await queryInterface.addIndex('doctor_search_index', ['reliability_score']);
    await queryInterface.addIndex('doctor_search_index', ['doctor_name_normalized']);

    // ── symptom_specialisation_map ────────────────────────────────────────────
    await queryInterface.createTable('symptom_specialisation_map', {
      id:               { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      symptom_keyword:  { type: Sequelize.STRING(100), allowNull: false, unique: true },
      symptom_aliases:  { type: Sequelize.ARRAY(Sequelize.STRING), allowNull: false, defaultValue: [] },
      specialisations:  { type: Sequelize.ARRAY(Sequelize.STRING), allowNull: false, defaultValue: [] },
      is_emergency:     { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      priority:         { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at:       { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('symptom_specialisation_map', ['symptom_keyword']);

    // ── daily_platform_stats ──────────────────────────────────────────────────
    await queryInterface.createTable('daily_platform_stats', {
      id:               { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      stat_date:        { type: Sequelize.DATEONLY, allowNull: false, unique: true },
      bookings:         { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      cancellations:    { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      registrations:    { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      sms_sent:         { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      sms_delivered:    { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      payments_success: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      payments_failed:  { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at:       { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('daily_platform_stats', ['stat_date']);

    // ── Make slot_id nullable (walk-in fix) ───────────────────────────────────
    await queryInterface.changeColumn('appointments', 'slot_id', {
      type: Sequelize.UUID, allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('daily_platform_stats');
    await queryInterface.dropTable('symptom_specialisation_map');
    await queryInterface.dropTable('doctor_search_index');
    await queryInterface.changeColumn('appointments', 'slot_id', {
      type: Sequelize.UUID, allowNull: false,
    });
  },
};
