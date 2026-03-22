require('dotenv').config();

module.exports = {
  development: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 5432,
    dialect:  'postgres',
    migrationStorageTableName: 'sequelize_migrations',
    seederStorageTableName:    'sequelize_seeders',
    seederStorage:             'sequelize',
  },
  test: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'healthcare_test',
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 5432,
    dialect:  'postgres',
    logging:  false,
  },
  production: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT     || 5432,
    dialect:  'postgres',
    dialectOptions: {
      ssl: {
        require:            true,
        rejectUnauthorized: false,
      },
    },
    migrationStorageTableName: 'sequelize_migrations',
    seederStorageTableName:    'sequelize_seeders',
    seederStorage:             'sequelize',
    logging: false,
  },
};
