import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES   = 12; // 96-bit IV — GCM standard
const TAG_BYTES  = 16;
const ENCODING   = 'base64';

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY env var is not set');
  // Accept raw 32-byte hex (64 chars) or derive from arbitrary string
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex');
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts plaintext with AES-256-GCM.
 * Returns a single base64 string: iv:ciphertext:authTag
 */
export function encrypt(plaintext: string): string {
  const key        = getKey();
  const iv         = crypto.randomBytes(IV_BYTES);
  const cipher     = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  return [
    iv.toString(ENCODING),
    encrypted.toString(ENCODING),
    authTag.toString(ENCODING),
  ].join(':');
}

/**
 * Decrypts a value produced by encrypt().
 * Returns null if the value is null/undefined (pass-through for optional fields).
 */
export function decrypt(ciphertext: string | null | undefined): string | null {
  if (ciphertext == null) return null;
  const [ivB64, dataB64, tagB64] = ciphertext.split(':');
  if (!ivB64 || !dataB64 || !tagB64) throw new Error('Malformed ciphertext — expected iv:data:tag');
  const key      = getKey();
  const iv       = Buffer.from(ivB64, ENCODING);
  const data     = Buffer.from(dataB64, ENCODING);
  const authTag  = Buffer.from(tagB64, ENCODING).slice(0, TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(data) + decipher.final('utf8');
}

/**
 * Encrypt only if value is a non-empty string; otherwise return as-is.
 */
export function encryptField(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  return encrypt(value);
}

/**
 * Decrypt only if value looks encrypted (contains ':'). Allows fields to
 * coexist as plaintext (legacy rows) and ciphertext (new rows) during migration.
 */
export function decryptField(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  if (value.split(':').length !== 3) return value; // legacy plaintext
  return decrypt(value);
}
