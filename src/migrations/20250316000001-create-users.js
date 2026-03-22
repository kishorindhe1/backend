'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      mobile: {
        type: Sequelize.STRING(15),
        allowNull: false,
        unique: true,
      },
      country_code: {
        type: Sequelize.STRING(5),
        allowNull: false,
        defaultValue: '+91',
      },
      otp_secret: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      otp_expires_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      otp_attempts: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      role: {
        type: Sequelize.ENUM('patient', 'doctor', 'receptionist', 'hospital_admin', 'super_admin'),
        allowNull: false,
        defaultValue: 'patient',
      },
      account_status: {
        type: Sequelize.ENUM('otp_verified', 'active', 'suspended', 'deactivated'),
        allowNull: false,
        defaultValue: 'otp_verified',
      },
      last_login_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      deleted_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('users', ['mobile']);
    await queryInterface.addIndex('users', ['role']);
    await queryInterface.addIndex('users', ['account_status']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('users');
  },
};
