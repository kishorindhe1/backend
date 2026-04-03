'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'hospitals' AND column_name = 'payment_collection_mode'
        ) THEN
          CREATE TYPE "enum_hospitals_payment_collection_mode" AS ENUM ('online_only', 'patient_choice');
          ALTER TABLE hospitals
            ADD COLUMN payment_collection_mode "enum_hospitals_payment_collection_mode"
            NOT NULL DEFAULT 'online_only';
        END IF;
      END $$;
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('hospitals', 'payment_collection_mode');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_hospitals_payment_collection_mode";'
    );
  },
};
