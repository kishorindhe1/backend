# Healthcare Appointment Booking System — Phase 1

Production-ready backend for a Healthcare Appointment Booking System.  
Phase 1 covers: **Auth (OTP), JWT, Patient Profile, Progressive Registration.**

---

## Tech Stack

| Layer        | Technology                                      |
|--------------|-------------------------------------------------|
| Runtime      | Node.js 22, TypeScript 5                        |
| Framework    | Express.js                                      |
| ORM          | Sequelize 6 + PostgreSQL 16                     |
| Cache / Queue| Redis 7 (ioredis)                               |
| Auth         | JWT (jsonwebtoken) — access + refresh tokens    |
| Validation   | Zod v4                                          |
| Logging      | Winston + daily-rotate-file                     |
| Container    | Docker + Docker Compose                         |

---

## Project Structure

```
src/
├── config/
│   ├── env.ts            Zod-validated environment variables (fail-fast)
│   ├── database.ts       Sequelize + PostgreSQL connection
│   └── redis.ts          ioredis client + key factory + TTL constants
│
├── modules/
│   ├── auth/
│   │   ├── auth.validation.ts   Zod schemas (RequestOtp, VerifyOtp, RefreshToken)
│   │   ├── auth.service.ts      Business logic — OTP flow, refresh, logout
│   │   ├── token.service.ts     JWT issue, verify, blacklist
│   │   ├── auth.controller.ts   Thin HTTP layer
│   │   └── auth.routes.ts       Route definitions
│   │
│   ├── users/
│   │   └── user.model.ts        Sequelize User model (all roles)
│   │
│   └── patients/
│       ├── patient.model.ts     PatientProfile model + helper functions
│       ├── patient.validation.ts Zod schemas (CompleteProfile, UpdateProfile)
│       ├── patient.service.ts   Profile business logic
│       ├── patient.controller.ts Thin HTTP layer
│       └── patient.routes.ts    Route definitions
│
├── middlewares/
│   ├── requestId.middleware.ts  Attaches UUID to every request (must be first)
│   ├── auth.middleware.ts       JWT verification + role guards
│   ├── profileGuard.middleware.ts Blocks incomplete profiles at booking
│   ├── validate.middleware.ts   Zod validation for body/params/query
│   ├── rateLimit.middleware.ts  Redis-backed rate limiting (global + per-route)
│   └── error.middleware.ts      Global error handler + 404 handler
│
├── utils/
│   ├── logger.ts          Winston with daily rotation + Morgan stream
│   ├── response.ts        Typed API response helpers
│   ├── helpers.ts         OTP generation, mobile utils, pagination
│   └── asyncHandler.ts    Wraps async controllers for Express error forwarding
│
├── types/index.ts         Enums, JWT types, ServiceResult pattern
├── routes/index.ts        Main API router
├── app.ts                 Express app factory
└── server.ts              Entry point — bootstrap + graceful shutdown
```

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo>
cd healthcare-api
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — set DB credentials and generate JWT secrets
```

**Generate JWT secrets:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Run twice — one for JWT_ACCESS_SECRET, one for JWT_REFRESH_SECRET
```

### 3. Start with Docker Compose (recommended)

```bash
# Start postgres + redis + api (with pgAdmin)
docker compose --profile dev up

# Start without pgAdmin
docker compose up
```

The API will:
1. Wait for PostgreSQL and Redis health checks
2. Run migrations automatically
3. Start on `http://localhost:3000`

### 4. Run locally (without Docker)

Requires PostgreSQL and Redis running locally.

```bash
# Run migrations
npm run db:migrate

# Seed development data
npm run db:seed

# Start in development mode
npm run dev
```

---

## API Endpoints — Phase 1

### Health Check
```
GET /api/v1/health
```

### Auth
```
POST /api/v1/auth/request-otp      Public
POST /api/v1/auth/verify-otp       Public
POST /api/v1/auth/refresh-token    Public (uses refresh token)
POST /api/v1/auth/logout           Private
```

### Patient Profile
```
GET  /api/v1/patients/me                     Private
POST /api/v1/patients/me/complete-profile    Private (allowed with incomplete profile)
PUT  /api/v1/patients/me                     Private (requires complete profile)
```

---

## Testing the OTP Flow

In `development` mode, OTPs are logged to the console instead of being sent via SMS:

```
📱  OTP for 98****3210: 482910
```

### Step 1 — Request OTP
```bash
curl -X POST http://localhost:3000/api/v1/auth/request-otp \
  -H "Content-Type: application/json" \
  -d '{ "mobile": "9876543210" }'
```

### Step 2 — Verify OTP (copy from console log)
```bash
curl -X POST http://localhost:3000/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{ "mobile": "9876543210", "otp": "482910" }'
```

Response includes `profile_status: "incomplete"` for new users.

### Step 3 — Complete Profile
```bash
curl -X POST http://localhost:3000/api/v1/patients/me/complete-profile \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Kishor Patil",
    "date_of_birth": "1992-06-15",
    "gender": "male",
    "email": "kishor@example.com"
  }'
```

Returns new tokens with `profile_status: "complete"`.

### Step 4 — Refresh Token
```bash
curl -X POST http://localhost:3000/api/v1/auth/refresh-token \
  -H "Content-Type: application/json" \
  -d '{ "refresh_token": "<refresh_token>" }'
```

### Step 5 — Logout
```bash
curl -X POST http://localhost:3000/api/v1/auth/logout \
  -H "Authorization: Bearer <access_token>"
```

---

## Key Design Decisions

### Progressive Registration
- Users enter mobile + OTP only on first visit
- `account_status = otp_verified`, `profile_status = incomplete`
- Full browsing allowed immediately
- Profile gate only activates at booking (Phase 2)

### JWT Strategy
- **Access token**: 15 min TTL, stateless
- **Refresh token**: 7 day TTL, stored in Redis for invalidation
- **Logout**: access token `jti` blacklisted in Redis for remaining TTL
- **Token rotation**: every refresh issues new pair, old refresh token invalidated

### OTP Security
- 6-digit cryptographically secure OTP (not `Math.random()`)
- Stored as bcrypt hash — plain OTP never persisted
- 60s cooldown per mobile (Redis)
- 5 max attempts, then 30-min lockout (Redis)
- 10-min expiry

### Error Codes
All errors return a machine-readable `code` field:
```
AUTH_TOKEN_MISSING, AUTH_TOKEN_INVALID, AUTH_TOKEN_EXPIRED
AUTH_OTP_INVALID, AUTH_OTP_EXPIRED, AUTH_OTP_MAX_ATTEMPTS
AUTH_ACCOUNT_SUSPENDED, AUTH_ACCOUNT_LOCKED
PROFILE_INCOMPLETE, PROFILE_NOT_FOUND
VALIDATION_ERROR, RATE_LIMIT_EXCEEDED, INTERNAL_ERROR
```

---

## Database Migrations

```bash
# Run all pending migrations
npm run db:migrate

# Undo last migration
npm run db:migrate:undo

# Seed development data (3 patients + 1 admin)
npm run db:seed
```

---

## Seeded Test Data

| Mobile       | Role        | Profile Status |
|--------------|-------------|----------------|
| 9000000001   | super_admin | —              |
| 9876543210   | patient     | complete       |
| 9876543211   | patient     | complete       |
| 9876543212   | patient     | incomplete     |

---

## Phase 2 Preview

Phase 2 adds:
- Hospital onboarding
- Doctor profiles + NMC verification
- Schedule templates + slot generation
- Appointment booking with race condition protection
- Payment integration (Razorpay, 2% fee split)

---

## Phase 2 — What's New

### New Modules

| Module | Description |
|--------|-------------|
| hospitals | Registration, onboarding status machine, staff management |
| doctors | Profiles, NMC verification, hospital affiliations |
| schedules | Weekly templates, slot generation engine |
| appointments | Booking with 3-layer race condition protection |
| payments | Razorpay order, verify, webhook idempotency, fee split |

### New Endpoints

#### Hospitals
```
GET  /api/v1/hospitals               Public — list live hospitals
GET  /api/v1/hospitals/:id           Public — hospital detail
POST /api/v1/hospitals               Super admin — register hospital
PATCH /api/v1/hospitals/:id/onboarding-status   Super admin
POST /api/v1/hospitals/:id/receptionists        Hospital admin
```

#### Doctors
```
GET   /api/v1/doctors                Public — search doctors
GET   /api/v1/doctors/:id            Public — doctor profile
POST  /api/v1/doctors                Hospital admin — register doctor
POST  /api/v1/doctors/schedules      Hospital admin — create schedule
PATCH /api/v1/doctors/:id/verify     Super admin — approve/reject
```

#### Schedules & Slots
```
GET  /api/v1/schedules/:doctorId/:hospitalId/slots?date=YYYY-MM-DD
POST /api/v1/schedules/generate      Admin — trigger slot generation
```

#### Appointments
```
POST   /api/v1/appointments          Patient — book (requires complete profile)
GET    /api/v1/appointments/my       Patient — own history
GET    /api/v1/appointments/:id      Patient — single appointment
DELETE /api/v1/appointments/:id      Patient — cancel
```

#### Payments
```
POST /api/v1/payments/initiate            Patient — create Razorpay order
POST /api/v1/payments/verify             Patient — confirm after checkout
POST /api/v1/payments/webhook/razorpay   Razorpay — event delivery
```

### Full Test Flow (Phase 2)

```bash
# 1. Register hospital (as super admin)
curl -X POST http://localhost:3000/api/v1/hospitals \
  -H "Authorization: Bearer <super_admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"admin_mobile":"9111111111","admin_name":"Raj","hospital_name":"Test Hospital","city":"Nashik","state":"Maharashtra","hospital_type":"hospital"}'

# 2. Register doctor (as hospital admin)
curl -X POST http://localhost:3000/api/v1/doctors \
  -H "Authorization: Bearer <hospital_admin_token>" \
  -d '{"mobile":"9222222222","full_name":"Dr. Test","specialization":"orthopedics","qualifications":["MBBS"],"experience_years":5,"consultation_fee":500,"hospital_id":"<hospitalId>"}'

# 3. Create schedule (as hospital admin)
curl -X POST http://localhost:3000/api/v1/doctors/schedules \
  -H "Authorization: Bearer <hospital_admin_token>" \
  -d '{"doctor_id":"<doctorProfileId>","hospital_id":"<hospitalId>","day_of_week":"monday","start_time":"09:00","end_time":"13:00","slot_duration_minutes":20,"max_patients":12,"effective_from":"2025-03-17"}'

# 4. Generate slots (as hospital admin)
curl -X POST http://localhost:3000/api/v1/schedules/generate \
  -H "Authorization: Bearer <hospital_admin_token>" \
  -d '{"doctor_id":"<doctorProfileId>","hospital_id":"<hospitalId>"}'

# 5. Browse slots (public)
curl "http://localhost:3000/api/v1/schedules/<doctorId>/<hospitalId>/slots?date=2025-03-17"

# 6. Book appointment (as patient with complete profile)
curl -X POST http://localhost:3000/api/v1/appointments \
  -H "Authorization: Bearer <patient_token>" \
  -d '{"doctor_id":"<doctorProfileId>","hospital_id":"<hospitalId>","slot_id":"<slotId>"}'

# 7. Initiate payment
curl -X POST http://localhost:3000/api/v1/payments/initiate \
  -H "Authorization: Bearer <patient_token>" \
  -d '{"appointment_id":"<appointmentId>"}'

# 8. Verify payment (after Razorpay checkout)
curl -X POST http://localhost:3000/api/v1/payments/verify \
  -H "Authorization: Bearer <patient_token>" \
  -d '{"razorpay_order_id":"...","razorpay_payment_id":"...","razorpay_signature":"..."}'
```

### Seeded Data (Phase 2)

| Mobile | Role | Notes |
|--------|------|-------|
| 9000000002 | hospital_admin | Nashik Care Hospital admin |
| 9000000003 | receptionist | OPD receptionist |
| 9000000010 | doctor | Dr. Priya Sharma — Orthopedics — ₹800 |
| 9000000011 | doctor | Dr. Amit Mehta — Cardiology — ₹1200 |
| 9000000012 | doctor | Dr. Sunita Patil — General Physician — ₹500 |

All doctors are pre-verified. Schedules are Mon–Fri 9am–1pm (20-min slots).
Run `POST /api/v1/schedules/generate` with each doctor+hospital ID to generate bookable slots.

### Key Design Notes

**2% Fee Split** — uses subtraction not independent rounding:
```
platform_fee  = ROUND(amount × 0.02, 2)
doctor_payout = amount - platform_fee   ← guarantees exact sum
```

**Race condition protection** (3 layers):
1. Redis `SET NX EX 5` — atomic distributed lock per slot
2. `SELECT FOR UPDATE` inside Sequelize transaction — DB row lock
3. `UNIQUE(slot_id)` on appointments table — absolute last resort

**Webhook idempotency** — `webhook_events.event_id UNIQUE` prevents double-processing.
Always returns 200 even on processing failure (Razorpay must not retry a partially-executed handler).

**Raw body for webhooks** — `app.ts` mounts `express.raw()` on the webhook route BEFORE the JSON parser so the HMAC-SHA256 signature verification always has the original buffer.

---

## Phase 3 — What's New

### Structural Changes

| Change | Before | After |
|--------|--------|-------|
| Model location | `src/modules/*/` each folder | `src/models/` flat folder |
| Associations | Scattered inline at bottom of each model | `src/models/index.ts` — single file |
| Server model imports | 11 separate import lines | `import './models/index'` — one line |
| Error handling | Raw `fail()` with manual status codes | `ErrorFactory.notFound()`, `.conflict()` etc. using `http-status-codes` |

### `src/models/index.ts` — Central Association Hub

```
src/models/
  index.ts                    ← ALL exports + ALL associations
  user.model.ts
  patient.model.ts
  hospital.model.ts
  hospital-staff.model.ts
  doctor.model.ts
  doctor-affiliation.model.ts
  schedule.model.ts
  slot.model.ts
  appointment.model.ts
  payment.model.ts
  consultation-queue.model.ts    ← Phase 3
  doctor-delay-event.model.ts    ← Phase 3
  notification-log.model.ts      ← Phase 3
  notification-preference.model.ts ← Phase 3
  opd-session.model.ts           ← Phase 3
  opd-token.model.ts             ← Phase 3
```

### `ErrorFactory` Usage

```typescript
// Before (Phase 1/2)
return fail('DOCTOR_NOT_FOUND', 'Doctor not found.', 404);

// After (Phase 3)
throw ErrorFactory.notFound('DOCTOR_NOT_FOUND', 'Doctor not found.');

// All methods
ErrorFactory.badRequest(code, message, extra?)     // 400
ErrorFactory.unauthorized(code, message)            // 401
ErrorFactory.forbidden(code, message, extra?)       // 403
ErrorFactory.notFound(code, message)                // 404
ErrorFactory.conflict(code, message, extra?)        // 409
ErrorFactory.unprocessable(code, message, extra?)   // 422
ErrorFactory.locked(code, message, extra?)          // 423
ErrorFactory.tooManyRequests(code, message, extra?) // 429
ErrorFactory.internal(message?)                     // 500 — never exposed
ErrorFactory.serviceUnavailable(code, message)      // 503
```

### New Phase 3 Modules

#### Queue (`/api/v1/queue`)
Real-time consultation queue tracking. Estimates use:
- Rolling average consultation duration per doctor
- Historical no-show rate (default 25%)
- Break buffer: 5 min per 60 patients

#### Receptionist (`/api/v1/receptionist`)
Full front-desk workflow:
- Doctor attendance (check-in, delay, absent)
- Patient queue management (arrived, call-next, start, skip)
- Walk-in booking (creates user + appointment + queue entry)

#### Notifications (`/api/v1/notifications`)
BullMQ-backed async delivery:
- Priority queues (critical bypasses quiet hours)
- Per-user preferences (SMS/Push/Email, quiet hours)
- Delivery logging with provider acknowledgement tracking

#### OPD Sessions (`/api/v1/opd`)
Token-based high-volume OPD:
- Atomic token issuance (Redis lock prevents duplicates)
- Rolling avg consultation time updated after each patient
- Live session stats for display board

### Phase 3 New Endpoints

```
# Queue
GET  /api/v1/queue/status/:appointmentId         Patient — own position
GET  /api/v1/queue/:doctorId/:hospitalId          Receptionist — full day queue

# Receptionist
POST   /api/v1/receptionist/doctors/:dId/:hId/check-in
POST   /api/v1/receptionist/doctors/:dId/:hId/delay
POST   /api/v1/receptionist/doctors/:dId/:hId/absent
POST   /api/v1/receptionist/doctors/:dId/:hId/call-next
PATCH  /api/v1/receptionist/appointments/:id/arrived
PATCH  /api/v1/receptionist/appointments/:id/start
PATCH  /api/v1/receptionist/appointments/:id/skip
POST   /api/v1/receptionist/walk-in

# Notifications
PUT  /api/v1/notifications/preferences
GET  /api/v1/notifications/history

# OPD
POST   /api/v1/opd                                Create session
PATCH  /api/v1/opd/:sessionId/activate           Activate session
POST   /api/v1/opd/:sessionId/call-next          Call next token
POST   /api/v1/opd/:sessionId/walkin-token       Issue walk-in token
GET    /api/v1/opd/:sessionId/stats              Live statistics
```

### Seeded Test Data (all phases)

| Mobile | Role | Notes |
|--------|------|-------|
| 9000000001 | super_admin | Platform owner |
| 9000000002 | hospital_admin | Nashik Care Hospital |
| 9000000003 | receptionist | OPD desk |
| 9000000010 | doctor | Dr. Priya Sharma — Orthopedics |
| 9000000011 | doctor | Dr. Amit Mehta — Cardiology |
| 9000000012 | doctor | Dr. Sunita Patil — General Physician |
| 9876543210 | patient | Complete profile |
| 9876543211 | patient | Complete profile |
| 9876543212 | patient | Incomplete profile (for testing gate) |

---

## Phase 4 — What's New

### Bug Fixes from Phase 3
| Bug | Fix |
|-----|-----|
| `addToQueue` never called after booking | Wired into `appointment.service.ts` after transaction commits |
| `enqueueNotification` never called | Wired into booking, cancellation, and payment capture |
| Walk-in `slot_id` was zero UUID | Changed to `null`; `slot_id` is now nullable in model + migration |
| 10 duplicate model files in `src/modules/*/` | All deleted — only `src/models/` remains |
| Live counters never incremented | `incrementCounter` wired into booking, payment, and registration |

### New Modules

#### Search (`/api/v1/search`)
- Symptom-to-specialisation mapping (30 symptoms seeded)
- Autocomplete: doctor names + specialisation suggestions
- Smart search: auto-detects symptoms, maps to specialisations
- Distance ranking via Haversine formula (no PostGIS required)
- Wilson score dampens rating by review count
- Results cached 2 min in Redis

#### Admin (`/api/v1/admin`)
- Platform health dashboard from Redis live counters
- Operations alerts (delays, long waits, failed notifications)
- Financial summary: GMV, platform revenue, take rate
- Doctor management with suspend/reactivate
- Reliability score manual recompute

#### Cron Jobs
BullMQ repeatable jobs scheduled at server start:
- **2:30 AM IST** — Generate slots for all active doctors (30 days ahead)
- **2:35 AM IST** — Rebuild full search index
- **2:40 AM IST** — Compute reliability scores for all doctors
- **5:25 AM IST** — Archive Redis daily counters to `daily_platform_stats`
- **Every 5 min** — Refresh slot availability counts in search index

### New Phase 4 Endpoints
```
GET  /api/v1/search/autocomplete?q=...&city=...   Public
GET  /api/v1/search/doctors?q=...&city=...&...    Public
POST /api/v1/search/rebuild                        Admin

GET  /api/v1/admin/dashboard                       Admin
GET  /api/v1/admin/alerts                          Admin
GET  /api/v1/admin/financial?period=today|week|month
GET  /api/v1/admin/doctors?verification_status=... Admin
PATCH /api/v1/admin/doctors/:id/status             Super admin
POST  /api/v1/admin/reliability/recompute          Super admin
```

### Running Migrations and Seeds (all phases)
```bash
npm run db:migrate       # runs all 6 migrations in order
npm run db:seed          # Phase 1 admin + patients
                         # Phase 2 hospital, doctors, schedules
                         # Phase 4 symptom map + search index seed
```

---

## Phase 5 — What's New

### Test Suite
29 tests passing across 2 suites:

**Unit tests** (`src/__tests__/unit.test.ts`) — 17 tests, no DB/Redis:
- OTP generation (6-digit, unique, numeric)
- Platform fee split (2% math, no float leakage)
- Wilson score (low review count penalty, monotonically increasing)
- Haversine distance (Mumbai–Nashik ~141km, symmetric, zero self-distance)
- Mobile validation (Indian 10-digit, starts 6–9)
- Quiet hours (midnight-crossing window, same-day window)

**Integration tests** (`src/__tests__/integration.test.ts`) — 12 tests without DB, 14 with DB:
- Health check response shape
- Validation middleware (bad input, missing field, request ID header, 404)
- Auth (invalid token, missing header)
- Profile gate (booking without auth)
- Search (autocomplete validation, doctor search, query_interpretation field)
- Rate limiting (header presence)
- **With DB only**: OTP flow, lock-out logic, webhook idempotency, booking race condition

```bash
# Run unit tests only (no DB required)
npm test

# Run with DB + Redis
RUN_INTEGRATION=1 npm test

# Coverage report
npm run test:coverage
```

### Swagger / OpenAPI 3.0
Mounted at `/api/docs` in development mode.
Raw spec at `/api/docs.json` — import into Postman, Insomnia, or Stoplight.

```bash
# Enable in production
SWAGGER_ENABLED=true npm start
```

### Real SMS Provider
`src/utils/smsProvider.ts` implements:
- **MSG91** primary (3s timeout)
- **Twilio** fallback (4s timeout)
- **Redis circuit breaker** — opens after 3 failures, resets after 10 minutes
- **Console logging** in development (no credentials needed)

### Bug Fixes
| Bug | Fix |
|-----|-----|
| `payment.service` notification had wrong `userId` (passed `appointment_id`) | Fixed — now fetches `patient_id` from `Appointment` before enqueuing |
| `receptionist.service` never sent delay/absent notifications | Wired — iterates waiting patients and enqueues per-patient notifications |
| Rate limiter threw `MaxRetriesPerRequestError` in tests | Fixed — uses memory store when `NODE_ENV=test` |
| `ts-jest` stricter type-check broke all controllers | Fixed — `types/index.ts` rebuilt with proper `readonly` discriminants + `handleResult` helper |
| Search service threw when Redis unavailable | Fixed — all cache reads/writes wrapped in `try/catch` |

### `handleResult` — Type-Safe Controller Pattern
All controllers now use this instead of manual `if (!result.success)` checks:

```typescript
// Before (broken — ts-jest couldn't narrow the union)
if (!result.success) { sendError(res, result.statusCode, ...); return; }
sendSuccess(res, result.data);

// After (works — handleResult narrows via result.success === false)
handleResult(res, result, (data) => sendSuccess(res, data));
```

### Summary — All Phases
| Phase | Key Deliverables |
|-------|-----------------|
| 1 | OTP auth, patient profile, JWT, rate limiting |
| 2 | Hospitals, doctors, schedules, slot generation, booking (3-layer lock), Razorpay |
| 3 | Queue estimation, receptionist ops, BullMQ notifications, OPD token sessions |
| 4 | Search (Wilson score, symptom mapping, Haversine), Admin dashboard, Cron jobs |
| 5 | Tests (29 passing), Swagger, real SMS provider, bug fixes, `handleResult` |

### File Counts (Final)
- Source files:  79 TypeScript files
- Compiled:      89 JavaScript files
- Migrations:    6 (phases 1–4)
- Seeders:       5
- Test files:    2 (43 total tests)
- Postman:       74 requests across 16 folders
# backend
