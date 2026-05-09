'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Null out any existing slot_id values that pointed to generated_slots
    // (those rows are now stale — the generated_slots table will be dropped)
    await queryInterface.sequelize.query(
      `UPDATE appointments SET slot_id = NULL WHERE slot_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM opd_slot_sessions WHERE opd_slot_sessions.id = appointments.slot_id)`,
    );

    // Drop the old FK constraint (name may vary — try both common patterns)
    try {
      await queryInterface.removeConstraint('appointments', 'appointments_slot_id_fkey');
    } catch {
      // constraint may already be gone or named differently — continue
    }

    // Add new FK pointing to opd_slot_sessions
    await queryInterface.addConstraint('appointments', {
      fields:     ['slot_id'],
      type:       'foreign key',
      name:       'appointments_slot_id_fkey',
      references: { table: 'opd_slot_sessions', field: 'id' },
      onUpdate:   'CASCADE',
      onDelete:   'SET NULL',
    });
  },

  async down(queryInterface, Sequelize) {
    try {
      await queryInterface.removeConstraint('appointments', 'appointments_slot_id_fkey');
    } catch { /* ignore */ }
  },
};
