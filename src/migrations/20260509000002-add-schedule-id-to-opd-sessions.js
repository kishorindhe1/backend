'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('opd_sessions', 'schedule_id', {
      type:       Sequelize.UUID,
      allowNull:  true,
      defaultValue: null,
      references: { model: 'schedules', key: 'id' },
      onUpdate:   'CASCADE',
      onDelete:   'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('opd_sessions', 'schedule_id');
  },
};
