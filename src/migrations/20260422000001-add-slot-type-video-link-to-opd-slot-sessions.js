'use strict';

/** Add slot_type and video_link columns to opd_slot_sessions.
 *  These were declared in the model but never included in the initial migration.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('opd_slot_sessions', 'slot_type', {
      type: Sequelize.ENUM('in_person', 'teleconsult', 'hybrid'),
      allowNull: false,
      defaultValue: 'in_person',
    });
    await queryInterface.addColumn('opd_slot_sessions', 'video_link', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('opd_slot_sessions', 'video_link');
    await queryInterface.removeColumn('opd_slot_sessions', 'slot_type');
    await queryInterface.sequelize.query(
      "DROP TYPE IF EXISTS enum_opd_slot_sessions_slot_type",
    );
  },
};
