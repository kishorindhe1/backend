'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('opd_session_breaks', {
      id: {
        type:         Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey:   true,
        allowNull:    false,
      },
      session_id: {
        type:       Sequelize.UUID,
        allowNull:  false,
        references: { model: 'opd_sessions', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      start_time: { type: Sequelize.STRING(5), allowNull: false },
      end_time:   { type: Sequelize.STRING(5), allowNull: false },
      reason:     { type: Sequelize.STRING(100), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('opd_session_breaks', ['session_id'], {
      name: 'opd_session_breaks_session_id_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('opd_session_breaks');
  },
};
