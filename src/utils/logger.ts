import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const isDev = process.env.NODE_ENV === 'development';

// ── Custom console format (human-readable in dev) ────────────────────────────
const devFormat = printf(({ level, message, timestamp: ts, requestId, ...meta }) => {
  const rid = requestId ? ` [${requestId}]` : '';
  const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
  return `${ts}${rid} [${level}]: ${message}${metaStr}`;
});

// ── Transport: daily rotated file ────────────────────────────────────────────
const fileTransport = new DailyRotateFile({
  dirname: path.join(process.cwd(), 'logs'),
  filename: 'app-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  format: combine(timestamp(), errors({ stack: true }), json()),
  level: 'info',
});

const errorFileTransport = new DailyRotateFile({
  dirname: path.join(process.cwd(), 'logs'),
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '30d',
  format: combine(timestamp(), errors({ stack: true }), json()),
  level: 'error',
});

// ── Logger instance ──────────────────────────────────────────────────────────
export const logger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  defaultMeta: { service: 'healthcare-api' },
  transports: [
    new winston.transports.Console({
      format: isDev
        ? combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), devFormat)
        : combine(timestamp(), errors({ stack: true }), json()),
    }),
    fileTransport,
    errorFileTransport,
  ],
  // Don't exit on handled exceptions
  exitOnError: false,
});

// ── Child logger factory (attaches requestId to every log in a request) ──────
export const createRequestLogger = (requestId: string) =>
  logger.child({ requestId });

// ── Morgan stream (pipes HTTP logs into Winston) ─────────────────────────────
export const morganStream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};
