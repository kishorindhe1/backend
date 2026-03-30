'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Add missing enum value to appointments.status
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_appointments_status" ADD VALUE IF NOT EXISTS 'awaiting_hospital_approval' BEFORE 'pending';`,
    );

    // Add missing hospital_id index
    await queryInterface.addIndex('appointments', ['hospital_id']);

    // Add missing unique index on slot_id (one appointment per slot)
    await queryInterface.addIndex('appointments', ['slot_id'], {
      unique: true,
      where: { slot_id: { [Symbol.for('ne')]: null } }, // partial index — skip NULLs
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('appointments', ['slot_id']);
    await queryInterface.removeIndex('appointments', ['hospital_id']);
    // PostgreSQL does not support DROP VALUE from an enum — no rollback for the enum value
  },
};
