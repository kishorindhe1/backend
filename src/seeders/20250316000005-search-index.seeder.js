'use strict';

const { v4: uuidv4 } = require('uuid');

module.exports = {
  async up(queryInterface) {
    // Fetch all active doctor affiliations with hospital + doctor data
    const rows = await queryInterface.sequelize.query(
      `SELECT
         dp.id           AS doctor_id,
         h.id            AS hospital_id,
         dp.full_name,
         dp.specialization,
         dp.experience_years,
         dp.reliability_score,
         h.name          AS hospital_name,
         h.city,
         h.address_line1 AS area,
         h.latitude,
         h.longitude,
         dha.consultation_fee,
         dp.verification_status,
         h.onboarding_status
       FROM doctor_hospital_affiliations dha
       JOIN doctor_profiles dp ON dp.id = dha.doctor_id
       JOIN hospitals h        ON h.id  = dha.hospital_id
       WHERE dha.is_active = true`,
      { type: 'SELECT' },
    );

    if (!rows.length) {
      console.log('No doctor affiliations found — run Phase 2 seeder first');
      return;
    }

    const now        = new Date();
    const indexRows  = rows.map((r) => ({
      id:                     uuidv4(),
      doctor_id:              r.doctor_id,
      hospital_id:            r.hospital_id,
      doctor_name:            r.full_name,
      doctor_name_normalized: r.full_name.toLowerCase().replace(/^dr\.?\s*/i, '').trim(),
      specialization:         r.specialization,
      qualifications:         '{}',
      languages_spoken:       '{"english","hindi","marathi"}',
      gender:                 null,
      experience_years:       r.experience_years,
      hospital_name:          r.hospital_name,
      city:                   r.city,
      area:                   r.area,
      latitude:               r.latitude,
      longitude:              r.longitude,
      consultation_fee:       r.consultation_fee,
      next_available_slot:    null,
      available_today:        false,
      available_slots_today:  0,
      avg_rating:             4.5,
      total_reviews:          25,
      wilson_rating_score:    0.78,
      reliability_score:      r.reliability_score ?? 88,
      total_consultations:    120,
      is_active:              true,
      is_verified:            r.verification_status === 'approved',
      hospital_is_live:       r.onboarding_status === 'live',
      last_indexed_at:        now,
      created_at:             now,
      updated_at:             now,
    }));

    await queryInterface.bulkInsert('doctor_search_index', indexRows);
    console.log(`✅  ${indexRows.length} doctor(s) added to search index`);
    console.log('   Run POST /api/v1/search/rebuild to refresh availability counts');
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('doctor_search_index', null, {});
  },
};
