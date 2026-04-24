'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('hospitals', 'logo_url', {
      type:      Sequelize.STRING(500),
      allowNull: true,
      after:     'longitude',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('hospitals', 'logo_url');
  },
};
