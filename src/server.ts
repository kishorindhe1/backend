import { createApp }       from './app';
import { connectDatabase } from './config/database';
import { connectRedis }    from './config/redis';
import { env }             from './config/env';
import { logger }          from './utils/logger';

// Single import — registers ALL models + ALL associations in dependency order
import './models/index';

async function bootstrap(): Promise<void> {
  try {
    logger.info(`🏥  Healthcare API starting — ${env.NODE_ENV} mode`);
    await connectDatabase();
    await connectRedis();

    // Start async workers (after Redis is ready)
    const { startNotificationWorker } = await import('./modules/notifications/notification.service');
    const { startCronWorker, scheduleCronJobs } = await import('./modules/cron/cron.worker');

    startNotificationWorker();
    startCronWorker();
    await scheduleCronJobs();

    const app    = createApp();
    const server = app.listen(env.PORT, () => {
      logger.info(`🚀  Server running on http://localhost:${env.PORT}`);
      logger.info(`📋  Health: http://localhost:${env.PORT}/api/v1/health`);
      logger.info(`🔍  Search: http://localhost:${env.PORT}/api/v1/search/doctors`);
    });

    const shutdown = async (signal: string): Promise<void> => {
      logger.info(`${signal} received — shutting down gracefully`);
      server.close(async () => {
        const { sequelize } = await import('./config/database');
        const { redis }     = await import('./config/redis');
        await sequelize.close();
        await redis.quit();
        logger.info('Graceful shutdown complete');
        process.exit(0);
      });
      setTimeout(() => { logger.error('Forced shutdown after timeout'); process.exit(1); }, 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('unhandledRejection', (r) => logger.error('Unhandled rejection', { reason: r }));
    process.on('uncaughtException',  (e) => { logger.error('Uncaught exception', { error: e }); process.exit(1); });

  } catch (err) {
    logger.error('Failed to start server', { error: err });
    process.exit(1);
  }
}

bootstrap();
