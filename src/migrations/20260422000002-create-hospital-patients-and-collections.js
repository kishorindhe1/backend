'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('hospital_patients', {
      id:             { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      hospital_id:    { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals', key: 'id' }, onDelete: 'RESTRICT' },
      patient_id:     { type: Sequelize.UUID, allowNull: false, references: { model: 'users',     key: 'id' }, onDelete: 'RESTRICT' },
      first_visit_at: { type: Sequelize.DATEONLY, allowNull: false },
      last_visit_at:  { type: Sequelize.DATEONLY, allowNull: false },
      total_visits:   { type: Sequelize.INTEGER,  allowNull: false, defaultValue: 1 },
      notes:          { type: Sequelize.TEXT,      allowNull: true },
      created_at:     { type: Sequelize.DATE,      allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at:     { type: Sequelize.DATE,      allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.addConstraint('hospital_patients', {
      fields: ['hospital_id', 'patient_id'],
      type: 'unique',
      name: 'hospital_patients_unique',
    });

    await queryInterface.addIndex('hospital_patients', ['hospital_id'], { name: 'idx_hospital_patients_hospital' });
    await queryInterface.addIndex('hospital_patients', ['patient_id'],  { name: 'idx_hospital_patients_patient' });

    await queryInterface.createTable('hospital_collections', {
      id:             { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
      hospital_id:    { type: Sequelize.UUID, allowNull: false, references: { model: 'hospitals',     key: 'id' }, onDelete: 'RESTRICT' },
      patient_id:     { type: Sequelize.UUID, allowNull: true,  references: { model: 'users',         key: 'id' }, onDelete: 'SET NULL' },
      appointment_id: { type: Sequelize.UUID, allowNull: true,  references: { model: 'appointments',  key: 'id' }, onDelete: 'SET NULL' },
      opd_token_id:   { type: Sequelize.UUID, allowNull: true,  references: { model: 'opd_tokens',    key: 'id' }, onDelete: 'SET NULL' },
      amount:         { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      mode:           { type: Sequelize.STRING(20),     allowNull: false },
      collected_by:   { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      collected_at:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      notes:          { type: Sequelize.STRING(200), allowNull: true },
      created_at:     { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.addIndex('hospital_collections', ['hospital_id'],  { name: 'idx_hospital_collections_hospital' });
    await queryInterface.addIndex('hospital_collections', ['patient_id'],   { name: 'idx_hospital_collections_patient' });
    await queryInterface.addIndex('hospital_collections', ['collected_at'], { name: 'idx_hospital_collections_date' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('hospital_collections');
    await queryInterface.dropTable('hospital_patients');
  },
};
