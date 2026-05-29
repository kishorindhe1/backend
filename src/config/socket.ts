import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from './env';
import { logger } from '../utils/logger';
import type { JwtAccessPayload } from '../types';

let io: SocketServer | null = null;

// ── Room naming helpers ───────────────────────────────────────────────────────
export const OpdRooms = {
  session:  (sessionId:  string) => `opd:session:${sessionId}`,
  hospital: (hospitalId: string) => `opd:hospital:${hospitalId}`,
  patient:  (patientId:  string) => `patient:${patientId}`,
};

// ── Event names — single source of truth shared with frontend ─────────────────
export const OpdEvents = {
  // server → client
  TOKEN_CALLED:       'opd:token_called',
  TOKEN_STATUS:       'opd:token_status',
  QUEUE_UPDATED:      'opd:queue_updated',
  SESSION_STARTED:    'opd:session_started',
  SESSION_ENDED:      'opd:session_ended',
  DOCTOR_DELAY:       'opd:doctor_delay',
  // slot lifecycle — emitted to hospital room
  SLOT_BOOKED:        'slot:booked',
  SLOT_CANCELLED:     'slot:cancelled',
  // client → server
  JOIN_SESSION:       'opd:join_session',
  JOIN_HOSPITAL:      'opd:join_hospital',
} as const;

export function initSocket(httpServer: HttpServer): SocketServer {
  const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);

  io = new SocketServer(httpServer, {
    cors: {
      origin: env.NODE_ENV === 'production' ? allowedOrigins : '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25_000,
    pingTimeout:  60_000,
  });

  // ── JWT auth middleware ───────────────────────────────────────────────────
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined
      ?? (socket.handshake.headers.authorization ?? '').replace('Bearer ', '');
    if (!token) { next(new Error('Authentication required')); return; }
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtAccessPayload;
      (socket as any).user = payload;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user: JwtAccessPayload = (socket as any).user;
    logger.debug('Socket connected', { socketId: socket.id, userId: user.sub, role: user.role });

    // Auto-join personal room for patient notifications
    socket.join(OpdRooms.patient(user.sub));

    socket.on(OpdEvents.JOIN_SESSION, (sessionId: string) => {
      socket.join(OpdRooms.session(sessionId));
      logger.debug('Socket joined session room', { socketId: socket.id, sessionId });
    });

    socket.on(OpdEvents.JOIN_HOSPITAL, (hospitalId: string) => {
      if (['receptionist', 'hospital_admin', 'super_admin', 'doctor'].includes(user.role)) {
        socket.join(OpdRooms.hospital(hospitalId));
        logger.debug('Socket joined hospital room', { socketId: socket.id, hospitalId });
      }
    });

    socket.on('disconnect', (reason) => {
      logger.debug('Socket disconnected', { socketId: socket.id, reason });
    });
  });

  logger.info('Socket.IO initialised');
  return io;
}

/** Emit to a room. No-op if socket server not yet initialised. */
export function emit(room: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(room).emit(event, data);
}

export function getIO(): SocketServer | null { return io; }
