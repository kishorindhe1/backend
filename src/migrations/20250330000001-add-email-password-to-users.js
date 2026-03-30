'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'email', {
      type: Sequelize.STRING(255),
      allowNull: true,
      unique: true,
      after: 'mobile',
    });
    await queryInterface.addColumn('users', 'password_hash', {
      type: Sequelize.STRING(255),
      allowNull: true,
      after: 'email',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'password_hash');
    await queryInterface.removeColumn('users', 'email');
  },
};
