'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // PostgreSQL requires ALTER TYPE to add enum values; cannot use inside a transaction
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_hospitals_payment_collection_mode" ADD VALUE IF NOT EXISTS 'cash_only';`,
    );
  },

  async down() {
    // PostgreSQL does not support removing enum values — no-op
  },
};
