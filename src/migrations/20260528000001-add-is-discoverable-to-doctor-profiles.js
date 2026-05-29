'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('doctor_profiles', 'is_discoverable', {
      type:         Sequelize.BOOLEAN,
      allowNull:    false,
      defaultValue: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('doctor_profiles', 'is_discoverable');
  },
};
