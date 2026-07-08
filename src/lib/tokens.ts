/**
 * Public pay-link token: 20 chars of lowercase Crockford base32 (no i/l/o/u),
 * 100 bits of entropy. Lowercase with no symbols so links survive plain-text
 * email wrapping and can be read aloud. Older invoices keep their long
 * base64url tokens — lookups don't care about the alphabet.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newPublicToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}
