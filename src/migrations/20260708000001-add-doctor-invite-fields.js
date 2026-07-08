'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('doctor_profiles', 'invite_status', {
      type: Sequelize.ENUM('pending_invite', 'accepted', 'expired', 'revoked'),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('doctor_profiles', 'invite_token_hash', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn('doctor_profiles', 'invite_expires_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('doctor_profiles', 'invite_accepted_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('doctor_profiles', 'invite_sent_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addIndex('doctor_profiles', ['invite_status']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('doctor_profiles', ['invite_status']).catch(() => {});
    await queryInterface.removeColumn('doctor_profiles', 'invite_sent_at');
    await queryInterface.removeColumn('doctor_profiles', 'invite_accepted_at');
    await queryInterface.removeColumn('doctor_profiles', 'invite_expires_at');
    await queryInterface.removeColumn('doctor_profiles', 'invite_token_hash');
    await queryInterface.removeColumn('doctor_profiles', 'invite_status');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_doctor_profiles_invite_status";');
  },
};
