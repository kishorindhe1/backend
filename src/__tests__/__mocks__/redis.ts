// In-memory mock for Redis in unit tests
const store = new Map<string, string>();

export const redis = {
  get:    async (k: string) => store.get(k) ?? null,
  set:    async (k: string, v: string) => { store.set(k, v); return 'OK'; },
  setex:  async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; },
  del:    async (...keys: string[]) => { keys.forEach(k => store.delete(k)); return keys.length; },
  exists: async (k: string) => store.has(k) ? 1 : 0,
  ttl:    async (k: string) => store.has(k) ? 300 : -2,
  incr:   async (k: string) => { const n = parseInt(store.get(k) ?? '0', 10) + 1; store.set(k, String(n)); return n; },
  incrby: async (k: string, n: number) => { const v = parseInt(store.get(k) ?? '0', 10) + n; store.set(k, String(v)); return v; },
  expire: async () => 1,
  keys:   async (pattern: string) => [...store.keys()].filter(k => k.includes(pattern.replace('*', ''))),
  ping:   async () => 'PONG',
  quit:   async () => 'OK',
  connect:async () => {},
  on:     () => redis,
};

export const RedisKeys = {
  otpCooldown:  (m: string) => `otp:cooldown:${m}`,
  otpLockout:   (m: string) => `otp:lockout:${m}`,
  otpAttempts:  (m: string) => `otp:attempts:${m}`,
  jwtBlacklist: (j: string) => `blacklist:jti:${j}`,
  refreshToken: (u: string) => `refresh:${u}`,
  slotLock:     (d: string, s: string) => `lock:slot:${d}:${s}`,
  availableSlots:(d: string, date: string) => `slots:available:${d}:${date}`,
  doctorSchedule:(d: string) => `schedule:doctor:${d}`,
  hospitalDoctors:(h: string) => `hospital:doctors:${h}`,
};

export const RedisTTL = {
  OTP_COOLDOWN:  60,
  OTP_LOCKOUT:   1800,
  OTP_ATTEMPTS:  600,
  REFRESH_TOKEN: 604800,
  SLOT_LOCK:     5,
  AVAILABLE_SLOTS: 60,
  DOCTOR_SCHEDULE: 300,
  HOSPITAL_DOCTORS: 600,
};

export async function connectRedis(): Promise<void> {}
