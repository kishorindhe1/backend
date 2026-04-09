import express, { Application } from 'express';
import cors    from 'cors';
import helmet  from 'helmet';
import morgan  from 'morgan';
import path    from 'path';
import { requestIdMiddleware }  from './middlewares/requestId.middleware';
import { globalRateLimiter }    from './middlewares/rateLimit.middleware';
import { errorMiddleware, notFoundMiddleware } from './middlewares/error.middleware';
import { morganStream }         from './utils/logger';
import { setupSwagger } from './config/swagger';
import { env }                  from './config/env';
import router                   from './routes/index';

export function createApp(): Application {
  const app = express();

  // ── 0. Trust proxy — required for correct IP detection behind nginx/ALB ──
  app.set('trust proxy', 1);

  // ── 1. Request ID — must be FIRST ─────────────────────────────────────────
  app.use(requestIdMiddleware);

  // ── 2. HTTP request logging ───────────────────────────────────────────────
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: morganStream }));

  // ── 3. Security headers ───────────────────────────────────────────────────
  app.use(helmet());

  // ── 4. CORS ───────────────────────────────────────────────────────────────
  app.use(cors({
    origin: env.NODE_ENV === 'production' ? ['https://yourdomain.com'] : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'RateLimit-Limit', 'RateLimit-Remaining'],
  }));

  // ── 5. Global rate limiter ────────────────────────────────────────────────
  app.use(globalRateLimiter);

  // ── 6. Raw body for Razorpay webhook (BEFORE JSON parser) ─────────────────
  // Webhook route needs raw buffer for HMAC-SHA256 signature verification.
  // If JSON parser runs first, rawBody is lost and signature check always fails.
  app.use('/api/v1/payments/webhook/razorpay',
    express.raw({ type: 'application/json' }),
  );

  // ── 7. JSON body parser for all other routes ──────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ── 8. Swagger docs (dev/staging only)
  setupSwagger(app);

  // ── 8. Static files — uploaded health records ────────────────────────────
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  // ── 8. API routes ─────────────────────────────────────────────────────────
  app.use('/api/v1', router);

  // ── 9. 404 handler ────────────────────────────────────────────────────────
  app.use(notFoundMiddleware);

  // ── 10. Global error handler — MUST be last ───────────────────────────────
  app.use(errorMiddleware);

  return app;
}
