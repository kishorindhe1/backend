'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('banners', {
      id: {
        type:         Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey:   true,
        allowNull:    false,
      },
      title: {
        type:      Sequelize.STRING(120),
        allowNull: true,
      },
      subtitle: {
        type:      Sequelize.STRING(200),
        allowNull: true,
      },
      image_url: {
        type:      Sequelize.STRING(500),
        allowNull: false,
      },
      link_type: {
        type:         Sequelize.ENUM('none', 'external', 'search', 'hospital', 'doctor'),
        allowNull:    false,
        defaultValue: 'none',
      },
      link_value: {
        type:      Sequelize.STRING(500),
        allowNull: true,
      },
      cta_label: {
        type:      Sequelize.STRING(60),
        allowNull: true,
      },
      is_active: {
        type:         Sequelize.BOOLEAN,
        allowNull:    false,
        defaultValue: false,
      },
      display_order: {
        type:         Sequelize.INTEGER,
        allowNull:    false,
        defaultValue: 0,
      },
      starts_at: {
        type:      Sequelize.DATE,
        allowNull: true,
      },
      ends_at: {
        type:      Sequelize.DATE,
        allowNull: true,
      },
      created_by: {
        type:       Sequelize.UUID,
        allowNull:  true,
        references: { model: 'users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('banners', ['is_active', 'display_order'], {
      name: 'banners_active_order_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('banners');
  },
};
