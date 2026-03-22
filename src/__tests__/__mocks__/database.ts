// Mock Sequelize connection for unit tests
import { Sequelize } from 'sequelize';

export const sequelize = new Sequelize('sqlite::memory:', { logging: false });

export async function connectDatabase(): Promise<void> {
  await sequelize.authenticate();
}

export async function syncDatabase(): Promise<void> {
  await sequelize.sync({ force: true });
}
