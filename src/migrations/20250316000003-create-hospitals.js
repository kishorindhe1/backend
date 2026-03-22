'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('hospitals', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      name:                { type: Sequelize.STRING(200), allowNull: false },
      legal_name:          { type: Sequelize.STRING(200), allowNull: true },
      registration_number: { type: Sequelize.STRING(100), allowNull: true, unique: true },
      hospital_type: {
        type: Sequelize.ENUM('clinic','nursing_home','hospital','diagnostic_center'),
        allowNull: false,
      },
      onboarding_status: {
        type: Sequelize.ENUM(
          'registered','documents_pending','documents_submitted','verification_failed',
          'verified','agreement_pending','agreement_signed','setup_in_progress',
          'live','suspended','deactivated',
        ),
        allowNull: false, defaultValue: 'registered',
      },
      phone_primary:   { type: Sequelize.STRING(20),  allowNull: true },
      email_general:   { type: Sequelize.STRING(200), allowNull: true },
      website:         { type: Sequelize.STRING(500), allowNull: true },
      address_line1:   { type: Sequelize.STRING(300), allowNull: true },
      address_line2:   { type: Sequelize.STRING(300), allowNull: true },
      city:            { type: Sequelize.STRING(100), allowNull: false },
      state:           { type: Sequelize.STRING(100), allowNull: false },
      pincode:         { type: Sequelize.STRING(10),  allowNull: true },
      latitude:        { type: Sequelize.DECIMAL(10,8), allowNull: true },
      longitude:       { type: Sequelize.DECIMAL(11,8), allowNull: true },
      is_verified:       { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      went_live_at:      { type: Sequelize.DATE,    allowNull: true },
      suspended_at:      { type: Sequelize.DATE,    allowNull: true },
      suspension_reason: { type: Sequelize.TEXT,    allowNull: true },
      deleted_at:        { type: Sequelize.DATE,    allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('hospitals', ['city']);
    await queryInterface.addIndex('hospitals', ['onboarding_status']);
  },
  async down(queryInterface) { await queryInterface.dropTable('hospitals'); },
};
