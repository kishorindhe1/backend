'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      `CREATE TYPE "enum_hospitals_appointment_approval" AS ENUM('auto', 'manual');`,
    ).catch(() => { /* type may already exist */ });

    await queryInterface.addColumn('hospitals', 'appointment_approval', {
      type: Sequelize.ENUM('auto', 'manual'),
      allowNull: false,
      defaultValue: 'auto',
      after: 'longitude',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('hospitals', 'appointment_approval');
    await queryInterface.sequelize.query(
      `DROP TYPE IF EXISTS "enum_hospitals_appointment_approval";`,
    );
  },
};
