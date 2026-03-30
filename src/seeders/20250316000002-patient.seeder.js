'use strict';

const { v4: uuidv4 } = require('uuid');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // ── Seed users ────────────────────────────────────────────────────────────
    const patients = [
      {
        id:           uuidv4(),
        mobile:       '9876543210',
        full_name:    'Kishor Patil',
        email:        'kishor@upcharify.com',
        dob:          '1992-06-15',
        gender:       'male',
        blood_group:  'B+',
        complete:     true,
      },
      {
        id:           uuidv4(),
        mobile:       '9876543211',
        full_name:    'Priya Sharma',
        email:        'priya@upcharify.com',
        dob:          '1995-03-22',
        gender:       'female',
        blood_group:  'O+',
        complete:     true,
      },
      {
        id:           uuidv4(),
        mobile:       '9876543212',
        full_name:    null,
        email:        null,
        dob:          null,
        gender:       null,
        blood_group:  null,
        complete:     false,          // incomplete profile — useful for testing the gate
      },
    ];

    const userRows = patients.map((p) => ({
      id:             p.id,
      mobile:         p.mobile,
      country_code:   '+91',
      otp_secret:     null,
      otp_expires_at: null,
      otp_attempts:   0,
      role:           'patient',
      account_status: 'active',
      last_login_at:  null,
      deleted_at:     null,
      created_at:     new Date(),
      updated_at:     new Date(),
    }));

    await queryInterface.bulkInsert('users', userRows);

    const profileRows = patients.map((p) => ({
      id:                uuidv4(),
      user_id:           p.id,
      full_name:         p.full_name,
      email:             p.email,
      date_of_birth:     p.dob ? new Date(p.dob) : null,
      gender:            p.gender,
      blood_group:       p.blood_group,
      profile_photo_url: null,
      profile_status:    p.complete ? 'complete' : 'incomplete',
      completed_at:      p.complete ? new Date() : null,
      created_at:        new Date(),
      updated_at:        new Date(),
    }));

    await queryInterface.bulkInsert('patient_profiles', profileRows);

    console.log(`✅  ${patients.length} patient(s) seeded`);
    patients.forEach((p) =>
      console.log(`   mobile: ${p.mobile}  profile: ${p.complete ? 'complete' : 'incomplete'}`),
    );
  },

  async down(queryInterface) {
    const mobiles = ['9876543210', '9876543211', '9876543212'];

    // Delete profiles first (FK constraint)
    const users = await queryInterface.sequelize.query(
      `SELECT id FROM users WHERE mobile IN (${mobiles.map((m) => `'${m}'`).join(',')})`,
      { type: 'SELECT' },
    );
    const ids = users.map((u) => u.id);

    if (ids.length) {
      await queryInterface.bulkDelete('patient_profiles', { user_id: ids });
    }
    await queryInterface.bulkDelete('users', { mobile: mobiles });
  },
};
