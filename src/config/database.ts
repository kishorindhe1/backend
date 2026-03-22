import { Sequelize } from 'sequelize';
import { env } from './env';
import { logger } from '../utils/logger';

export const sequelize = new Sequelize({
  dialect: 'postgres',
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  logging: (sql) => {
    if (env.NODE_ENV === 'development') {
      logger.debug(sql);
    }
  },
  pool: {
    max: env.DB_POOL_MAX,
    min: env.DB_POOL_MIN,
    acquire: 30000,
    idle: 10000,
  },
  define: {
    underscored: true,       // snake_case column names
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
});

export async function connectDatabase(): Promise<void> {
  try {
    await sequelize.authenticate();
    logger.info('✅  PostgreSQL connected');
  } catch (err) {
    logger.error('❌  PostgreSQL connection failed', { error: err });
    throw err;
  }
}

export async function syncDatabase(): Promise<void> {
  if (env.NODE_ENV === 'development') {
    await sequelize.sync({ alter: false });
    logger.info('✅  Database synced');
  }
}
