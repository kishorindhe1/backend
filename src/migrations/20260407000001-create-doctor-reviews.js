'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('doctor_reviews', {
      id: {
        type:         Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey:   true,
        allowNull:    false,
      },
      patient_id: {
        type:       Sequelize.UUID,
        allowNull:  false,
        references: { model: 'users', key: 'id' },
        onDelete:   'CASCADE',
      },
      doctor_id: {
        type:       Sequelize.UUID,
        allowNull:  false,
        references: { model: 'doctor_profiles', key: 'id' },
        onDelete:   'CASCADE',
      },
      appointment_id: {
        type:       Sequelize.UUID,
        allowNull:  true,
        references: { model: 'appointments', key: 'id' },
        onDelete:   'SET NULL',
      },
      rating: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      comment: {
        type:      Sequelize.TEXT,
        allowNull: true,
      },
      created_at: {
        type:      Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type:      Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('doctor_reviews', ['doctor_id']);
    await queryInterface.addIndex('doctor_reviews', ['patient_id']);
    await queryInterface.addConstraint('doctor_reviews', {
      fields: ['rating'],
      type: 'check',
      name: 'doctor_reviews_rating_check',
      where: { rating: { [Sequelize.Op.between]: [1, 5] } },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('doctor_reviews');
  },
};
