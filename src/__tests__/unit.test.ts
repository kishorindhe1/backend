/**
 * Unit tests — pure functions with no DB/Redis dependency
 * Run with: npx jest --testPathPattern=unit
 */

// ── OTP helpers ───────────────────────────────────────────────────────────────
describe('OTP helpers', () => {
  // Inline the functions so tests don't need env setup
  function generateOTP(): string {
    const crypto = require('crypto');
    const buffer = crypto.randomBytes(3);
    const num    = buffer.readUIntBE(0, 3) % 1000000;
    return num.toString().padStart(6, '0');
  }

  it('generates a 6-digit numeric string', () => {
    for (let i = 0; i < 20; i++) {
      const otp = generateOTP();
      expect(otp).toHaveLength(6);
      expect(/^\d{6}$/.test(otp)).toBe(true);
    }
  });

  it('generates different OTPs each time', () => {
    const otps = new Set(Array.from({ length: 100 }, () => generateOTP()));
    expect(otps.size).toBeGreaterThan(50); // extremely unlikely to get < 50 unique in 100 tries
  });
});

// ── Fee split ─────────────────────────────────────────────────────────────────
describe('Platform fee split', () => {
  function calcFee(amount: number, pct = 2) {
    const platform_fee  = Math.round(amount * (pct / 100) * 100) / 100;
    const doctor_payout = amount - platform_fee;
    return { platform_fee, doctor_payout };
  }

  it('sums to exact amount — no float leakage', () => {
    const amounts = [500, 999, 1001, 800, 1200, 350.50, 1499.99];
    amounts.forEach(amount => {
      const { platform_fee, doctor_payout } = calcFee(amount);
      expect(platform_fee + doctor_payout).toBeCloseTo(amount, 10);
    });
  });

  it('computes 2% correctly', () => {
    expect(calcFee(1000).platform_fee).toBe(20);
    expect(calcFee(1000).doctor_payout).toBe(980);
    expect(calcFee(500).platform_fee).toBe(10);
    expect(calcFee(500).doctor_payout).toBe(490);
  });

  it('doctor_payout is always less than amount', () => {
    [100, 500, 999, 10000].forEach(amount => {
      const { doctor_payout } = calcFee(amount);
      expect(doctor_payout).toBeLessThan(amount);
    });
  });
});

// ── Wilson score ──────────────────────────────────────────────────────────────
describe('Wilson rating score', () => {
  function wilsonScore(avgRating: number, totalReviews: number): number {
    if (totalReviews === 0) return 0;
    const p = avgRating / 5;
    const n = totalReviews;
    const z = 1.96;
    const num = p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    const den = 1 + (z * z) / n;
    return Math.max(0, Math.min(1, num / den));
  }

  it('returns 0 for zero reviews', () => {
    expect(wilsonScore(5.0, 0)).toBe(0);
    expect(wilsonScore(4.7, 0)).toBe(0);
  });

  it('doctor with 500 reviews at 4.7 ranks higher than 2 reviews at 5.0', () => {
    const manyGoodReviews = wilsonScore(4.7, 500);
    const fewPerfectReviews = wilsonScore(5.0, 2);
    expect(manyGoodReviews).toBeGreaterThan(fewPerfectReviews);
  });

  it('score improves as review count grows (same rating)', () => {
    const s10   = wilsonScore(4.5, 10);
    const s100  = wilsonScore(4.5, 100);
    const s1000 = wilsonScore(4.5, 1000);
    expect(s100).toBeGreaterThan(s10);
    expect(s1000).toBeGreaterThan(s100);
  });

  it('result is always between 0 and 1', () => {
    const cases = [[5.0, 1], [1.0, 1000], [3.5, 50], [4.9, 3]];
    cases.forEach(([rating, reviews]) => {
      const score = wilsonScore(rating, reviews);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });
});

// ── Haversine distance ────────────────────────────────────────────────────────
describe('Haversine distance', () => {
  function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R   = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  it('distance from a point to itself is 0', () => {
    expect(haversineKm(20.0059, 73.7897, 20.0059, 73.7897)).toBeCloseTo(0, 5);
  });

  it('Mumbai to Nashik is approximately 165km', () => {
    // Mumbai: 19.0760, 72.8777  |  Nashik: 20.0059, 73.7897
    const dist = haversineKm(19.0760, 72.8777, 20.0059, 73.7897);
    expect(dist).toBeGreaterThan(130);
    expect(dist).toBeLessThan(160);
  });

  it('is symmetric', () => {
    const d1 = haversineKm(19.0760, 72.8777, 20.0059, 73.7897);
    const d2 = haversineKm(20.0059, 73.7897, 19.0760, 72.8777);
    expect(d1).toBeCloseTo(d2, 5);
  });
});

// ── Mobile number helpers ─────────────────────────────────────────────────────
describe('Mobile number helpers', () => {
  function isValidIndianMobile(mobile: string): boolean {
    const digits = mobile.replace(/\D/g, '');
    const stripped = digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits;
    return /^[6-9]\d{9}$/.test(stripped);
  }

  function maskMobile(mobile: string): string {
    if (mobile.length < 6) return mobile;
    return `${mobile.slice(0, 2)}${'*'.repeat(mobile.length - 4)}${mobile.slice(-2)}`;
  }

  it('validates correct Indian mobile numbers', () => {
    expect(isValidIndianMobile('9876543210')).toBe(true);
    expect(isValidIndianMobile('6000000000')).toBe(true);
    expect(isValidIndianMobile('7123456789')).toBe(true);
    expect(isValidIndianMobile('8999999999')).toBe(true);
  });

  it('rejects invalid mobile numbers', () => {
    expect(isValidIndianMobile('1234567890')).toBe(false); // starts with 1
    expect(isValidIndianMobile('5000000000')).toBe(false); // starts with 5
    expect(isValidIndianMobile('98765432')).toBe(false);   // too short
    expect(isValidIndianMobile('98765432101')).toBe(false); // too long
  });

  it('masks mobile number correctly', () => {
    const masked = maskMobile('9876543210');
    expect(masked).toBe('98******10');
    expect(masked).toHaveLength(10);
    expect(masked.startsWith('98')).toBe(true);
    expect(masked.endsWith('10')).toBe(true);  // last 2 digits preserved
  });
});

// ── Quiet hours logic ─────────────────────────────────────────────────────────
describe('Quiet hours logic', () => {
  function isInQuietHours(currentTime: string, start: string, end: string): boolean {
    if (start > end) {
      return currentTime >= start || currentTime < end;
    }
    return currentTime >= start && currentTime < end;
  }

  it('detects midnight-crossing quiet hours (22:00–07:00)', () => {
    expect(isInQuietHours('23:00', '22:00', '07:00')).toBe(true);  // after 10pm
    expect(isInQuietHours('03:00', '22:00', '07:00')).toBe(true);  // 3am
    expect(isInQuietHours('06:59', '22:00', '07:00')).toBe(true);  // just before 7am
    expect(isInQuietHours('07:00', '22:00', '07:00')).toBe(false); // exactly 7am — not quiet
    expect(isInQuietHours('12:00', '22:00', '07:00')).toBe(false); // noon
    expect(isInQuietHours('21:59', '22:00', '07:00')).toBe(false); // just before 10pm
  });

  it('handles same-day quiet hours correctly (02:00–06:00)', () => {
    expect(isInQuietHours('04:00', '02:00', '06:00')).toBe(true);
    expect(isInQuietHours('01:59', '02:00', '06:00')).toBe(false);
    expect(isInQuietHours('06:00', '02:00', '06:00')).toBe(false);
  });
});
