'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('opd_slot_sessions', 'session_id', {
      type:       Sequelize.UUID,
      allowNull:  true,
      defaultValue: null,
      references: { model: 'opd_sessions', key: 'id' },
      onUpdate:   'CASCADE',
      onDelete:   'SET NULL',
    });

    await queryInterface.addIndex('opd_slot_sessions', ['session_id'], {
      name: 'opd_slot_sessions_session_id_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('opd_slot_sessions', 'opd_slot_sessions_session_id_idx');
    await queryInterface.removeColumn('opd_slot_sessions', 'session_id');
  },
};
