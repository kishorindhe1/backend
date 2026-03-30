'use strict';

const { v4: uuidv4 } = require('uuid');

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    // ── 1. Hospital ───────────────────────────────────────────────────────────
    const hospitalId     = uuidv4();
    const hospitalAdminId = uuidv4();

    await queryInterface.bulkInsert('users', [{
      id: hospitalAdminId, mobile: '9000000002', country_code: '+91',
      otp_secret: null, otp_expires_at: null, otp_attempts: 0,
      role: 'hospital_admin', account_status: 'active',
      last_login_at: null, deleted_at: null, created_at: now, updated_at: now,
    }]);

    await queryInterface.bulkInsert('hospitals', [{
      id: hospitalId, name: 'Nashik Care Hospital', legal_name: 'Nashik Care Pvt Ltd',
      registration_number: 'MH/2018/HC001', hospital_type: 'hospital',
      onboarding_status: 'live', phone_primary: '0253-2345678',
      email_general: 'info@upcharify.com', website: null,
      address_line1: 'Plot 42, Gangapur Road', address_line2: 'Near Old Bus Stand',
      city: 'Nashik', state: 'Maharashtra', pincode: '422013',
      latitude: 20.0059, longitude: 73.7897,
      is_verified: true, went_live_at: now, suspended_at: null,
      suspension_reason: null, deleted_at: null, created_at: now, updated_at: now,
    }]);

    await queryInterface.bulkInsert('hospital_staff', [{
      id: uuidv4(), user_id: hospitalAdminId, hospital_id: hospitalId,
      staff_role: 'hospital_admin', department: null, employee_id: 'EMP001',
      is_active: true, joined_at: now.toISOString().split('T')[0],
      created_at: now, updated_at: now,
    }]);

    // ── 2. Receptionist ───────────────────────────────────────────────────────
    const receptionistId = uuidv4();
    await queryInterface.bulkInsert('users', [{
      id: receptionistId, mobile: '9000000003', country_code: '+91',
      otp_secret: null, otp_expires_at: null, otp_attempts: 0,
      role: 'receptionist', account_status: 'active',
      last_login_at: null, deleted_at: null, created_at: now, updated_at: now,
    }]);
    await queryInterface.bulkInsert('hospital_staff', [{
      id: uuidv4(), user_id: receptionistId, hospital_id: hospitalId,
      staff_role: 'receptionist', department: 'OPD', employee_id: 'EMP002',
      is_active: true, joined_at: now.toISOString().split('T')[0],
      created_at: now, updated_at: now,
    }]);

    // ── 3. Doctors ────────────────────────────────────────────────────────────
    const doctors = [
      {
        userId:         uuidv4(),
        doctorProfileId:uuidv4(),
        mobile:         '9000000010',
        full_name:      'Dr. Priya Sharma',
        specialization: 'orthopedics',
        qualifications: ['MBBS', 'MS Ortho'],
        experience:     12,
        nmc:            'MH12345',
        fee:            800,
        room:           'OPD-3',
      },
      {
        userId:         uuidv4(),
        doctorProfileId:uuidv4(),
        mobile:         '9000000011',
        full_name:      'Dr. Amit Mehta',
        specialization: 'cardiology',
        qualifications: ['MBBS', 'MD Medicine', 'DM Cardiology'],
        experience:     15,
        nmc:            'MH12346',
        fee:            1200,
        room:           'OPD-5',
      },
      {
        userId:         uuidv4(),
        doctorProfileId:uuidv4(),
        mobile:         '9000000012',
        full_name:      'Dr. Sunita Patil',
        specialization: 'general_physician',
        qualifications: ['MBBS', 'MD General Medicine'],
        experience:     8,
        nmc:            'MH12347',
        fee:            500,
        room:           'OPD-1',
      },
    ];

    const userRows = doctors.map((d) => ({
      id: d.userId, mobile: d.mobile, country_code: '+91',
      otp_secret: null, otp_expires_at: null, otp_attempts: 0,
      role: 'doctor', account_status: 'active',
      last_login_at: null, deleted_at: null, created_at: now, updated_at: now,
    }));
    await queryInterface.bulkInsert('users', userRows);

    const profileRows = doctors.map((d) => ({
      id: d.doctorProfileId, user_id: d.userId,
      full_name: d.full_name, specialization: d.specialization,
      qualifications: `{${d.qualifications.map((q) => `"${q}"`).join(',')}}`,
      experience_years: d.experience,
      languages_spoken: '{"english","hindi","marathi"}',
      gender: null, profile_photo_url: null, bio: null,
      nmc_registration_number: d.nmc,
      verification_status: 'approved',
      verified_at: now, verified_by: null,
      default_booking_mode: 'slot_based',
      max_patients_per_day: 40,
      avg_consultation_minutes: 20,
      no_show_rate_historical: 0.20,
      reliability_score: 88, on_time_rate: 0.90,
      cancellation_rate: 0.05, completion_rate: 0.95,
      is_active: true, deleted_at: null, created_at: now, updated_at: now,
    }));
    await queryInterface.bulkInsert('doctor_profiles', profileRows);

    const affiliationRows = doctors.map((d) => ({
      id: uuidv4(), doctor_id: d.doctorProfileId, hospital_id: hospitalId,
      is_primary: true, consultation_fee: d.fee,
      room_number: d.room, department: null,
      is_active: true,
      start_date: now.toISOString().split('T')[0], end_date: null,
      created_at: now, updated_at: now,
    }));
    await queryInterface.bulkInsert('doctor_hospital_affiliations', affiliationRows);

    // ── 4. Schedules (Mon–Fri, 9am–1pm, 20-min slots) ────────────────────────
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    const scheduleRows = [];
    for (const doctor of doctors) {
      for (const day of days) {
        scheduleRows.push({
          id: uuidv4(), doctor_id: doctor.doctorProfileId, hospital_id: hospitalId,
          day_of_week: day, start_time: '09:00', end_time: '13:00',
          slot_duration_minutes: 20, max_patients: 12,
          session_type: 'opd',
          effective_from: now.toISOString().split('T')[0], effective_until: null,
          is_active: true, created_at: now, updated_at: now,
        });
      }
    }
    await queryInterface.bulkInsert('schedules', scheduleRows);

    console.log('✅  Phase 2 seed complete:');
    console.log('   Hospital: Nashik Care Hospital (live)');
    console.log('   Hospital admin mobile: 9000000002');
    console.log('   Receptionist mobile:   9000000003');
    doctors.forEach((d) => console.log(`   Doctor: ${d.full_name} — ${d.mobile}`));
    console.log('   Run slot generation via POST /api/v1/schedules/generate');
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('schedules', null, {});
    await queryInterface.bulkDelete('doctor_hospital_affiliations', null, {});
    await queryInterface.bulkDelete('doctor_profiles', null, {});
    const mobiles = ['9000000002','9000000003','9000000010','9000000011','9000000012'];
    const users = await queryInterface.sequelize.query(
      `SELECT id FROM users WHERE mobile IN (${mobiles.map((m) => `'${m}'`).join(',')})`,
      { type: 'SELECT' },
    );
    const ids = users.map((u) => u.id);
    if (ids.length) await queryInterface.bulkDelete('hospital_staff', { user_id: ids }, {});
    await queryInterface.bulkDelete('hospitals', { name: 'Nashik Care Hospital' }, {});
    await queryInterface.bulkDelete('users', { mobile: mobiles }, {});
  },
};
