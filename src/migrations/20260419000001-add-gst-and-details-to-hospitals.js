'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'hospitals' AND column_name = 'gst_number'
        ) THEN
          ALTER TABLE hospitals
            ADD COLUMN gst_number VARCHAR(20) DEFAULT NULL,
            ADD COLUMN phone_secondary VARCHAR(20) DEFAULT NULL,
            ADD COLUMN established_year INTEGER DEFAULT NULL,
            ADD COLUMN bed_count INTEGER DEFAULT NULL;
        END IF;
      END $$;
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('hospitals', 'gst_number');
    await queryInterface.removeColumn('hospitals', 'phone_secondary');
    await queryInterface.removeColumn('hospitals', 'established_year');
    await queryInterface.removeColumn('hospitals', 'bed_count');
  },
};
