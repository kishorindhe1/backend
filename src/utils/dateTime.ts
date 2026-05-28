import { formatInTimeZone } from 'date-fns-tz';

export const IST = 'Asia/Kolkata';

/**
 * Today's date in IST as YYYY-MM-DD.
 * Replaces: new Date().toISOString().split('T')[0]
 * That pattern gives UTC date — at 11:30 PM IST the UTC date is already tomorrow.
 */
export function istDate(): string {
  return formatInTimeZone(new Date(), IST, 'yyyy-MM-dd');
}

/**
 * Current IST datetime as YYYY-MM-DDTHH:MM:SS.
 * Used for comparing slot times stored as local strings (HH:MM).
 * Replaces the localNowDateTime() hack that depended on server TZ.
 */
export function istDateTime(): string {
  return formatInTimeZone(new Date(), IST, "yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * Current IST wall-clock time as HH:MM.
 * Replaces: new Date().toTimeString().slice(0, 5) which is server-TZ-dependent.
 */
export function istTime(): string {
  return formatInTimeZone(new Date(), IST, 'HH:mm');
}

/**
 * Format any Date as YYYY-MM-DD in IST.
 */
export function toIstDate(d: Date): string {
  return formatInTimeZone(d, IST, 'yyyy-MM-dd');
}

/**
 * Format any Date as HH:MM in IST.
 */
export function toIstTime(d: Date): string {
  return formatInTimeZone(d, IST, 'HH:mm');
}
