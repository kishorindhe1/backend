'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('schedules', 'opd_booking_mode', {
      type: Sequelize.ENUM('slot_based', 'token_based'),
      allowNull: false,
      defaultValue: 'slot_based',
    });

    await queryInterface.addColumn('schedules', 'sessions_config', {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('schedules', 'sessions_config');
    await queryInterface.removeColumn('schedules', 'opd_booking_mode');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_schedules_opd_booking_mode";');
  },
};
