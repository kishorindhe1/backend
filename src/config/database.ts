import { Sequelize } from 'sequelize';
import { env } from './env';
import { logger } from '../utils/logger';

// ── Primary (read-write) ───────────────────────────────────────────────────────
export const sequelize = new Sequelize({
  dialect:  'postgres',
  host:     env.DB_HOST,
  port:     env.DB_PORT,
  database: env.DB_NAME,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  logging:  (sql) => { if (env.NODE_ENV === 'development') logger.debug(sql); },
  pool: { max: env.DB_POOL_MAX, min: env.DB_POOL_MIN, acquire: 30000, idle: 10000 },
  define:   { underscored: true, timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' },
});

// ── Read replica (optional) ────────────────────────────────────────────────────
// Set DB_READ_HOST in production to route analytics/search queries away from the
// primary, protecting write throughput during heavy read traffic.
// Falls back to the primary if no replica is configured.
export const sequelizeRead: Sequelize = env.DB_READ_HOST
  ? new Sequelize({
      dialect:  'postgres',
      host:     env.DB_READ_HOST,
      port:     env.DB_READ_PORT,
      database: env.DB_NAME,
      username: env.DB_USER,
      password: env.DB_PASSWORD,
      logging:  false,
      pool:     { max: env.DB_POOL_MAX, min: env.DB_POOL_MIN, acquire: 30000, idle: 10000 },
      define:   { underscored: true, timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' },
    })
  : sequelize; // no replica configured — same instance

export async function connectDatabase(): Promise<void> {
  try {
    await sequelize.authenticate();
    logger.info('PostgreSQL (primary) connected');

    if (env.DB_READ_HOST && sequelizeRead !== sequelize) {
      await sequelizeRead.authenticate();
      logger.info('PostgreSQL (read replica) connected', { host: env.DB_READ_HOST });
    }
  } catch (err) {
    logger.error('PostgreSQL connection failed', { error: err });
    throw err;
  }
}

export async function syncDatabase(): Promise<void> {
  if (env.NODE_ENV === 'development') {
    await sequelize.sync({ alter: false });
    logger.info('Database synced');
  }
}
