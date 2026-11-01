import crypto from 'node:crypto';

// No 0/O, 1/I/L or U, so an id read out over the phone or typed from a screenshot can't be misread.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

// e.g. BK-7K3M-9QX2: about 6.5e11 combinations, short enough to read out and type.
export function newBookingId(): string {
  const pick = () => ALPHABET[crypto.randomInt(ALPHABET.length)]!;
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `BK-${part()}-${part()}`;
}

// People type ids in any case with stray spaces, and sometimes drop the dashes.
export function normalizeBookingId(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return /^BK[A-Z0-9]{8}$/.test(s) ? `BK-${s.slice(2, 6)}-${s.slice(6)}` : raw.trim();
}
