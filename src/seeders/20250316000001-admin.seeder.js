'use strict';

const { v4: uuidv4 } = require('uuid');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const adminId = uuidv4();

    await queryInterface.bulkInsert('users', [
      {
        id:             adminId,
        mobile:         '9000000001',
        country_code:   '+91',
        otp_secret:     null,
        otp_expires_at: null,
        otp_attempts:   0,
        role:           'super_admin',
        account_status: 'active',
        last_login_at:  null,
        deleted_at:     null,
        created_at:     new Date(),
        updated_at:     new Date(),
      },
    ]);

    console.log(`✅  Super admin seeded — mobile: 9000000001, id: ${adminId}`);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('users', { mobile: '9000000001' });
  },
};
