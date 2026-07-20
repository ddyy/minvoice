/**
 * Envelope encryption for dashboard-entered credentials stored in D1.
 * Boxed values are `enc:v1:` + base64(iv || AES-256-GCM ciphertext); the AES
 * key is SHA-256 of the SETTINGS_MASTER_KEY secret, so any high-entropy string
 * works as the master key (`npm run deploy` generates one). Untagged values
 * pass through unchanged — legacy plaintext rows and deployments without a
 * master key keep working, and re-encrypt lazily once the key exists.
 */

import { secretConfigured } from './config';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;

export const MASTER_KEY_MIN_LENGTH = 32;

/**
 * A usable master key: not a known placeholder and long enough to carry real
 * entropy. Anything else is treated as absent on EVERY path — encrypting with
 * `change-me` would be worse than plaintext (publicly known key, warning gone).
 */
export function validMasterKey(v: string | undefined): string | undefined {
  const t = (v ?? '').trim();
  return t.length >= MASTER_KEY_MIN_LENGTH && secretConfigured(t) ? t : undefined;
}

export function isBoxed(v: string): boolean {
  return v.startsWith(PREFIX);
}

async function aesKey(masterKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(masterKey));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function box(masterKey: string, plaintext: string): Promise<string> {
  if (!validMasterKey(masterKey)) throw new Error('box() requires a valid SETTINGS_MASTER_KEY — callers must gate on validMasterKey()');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(masterKey), new TextEncoder().encode(plaintext))
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv);
  packed.set(ct, iv.length);
  return PREFIX + btoa(String.fromCharCode(...packed));
}

/**
 * Open a stored value. Plaintext passes through as-is; a boxed value returns
 * undefined when the master key is absent or wrong — callers treat that as
 * "not configured" and configWarnings surfaces the key problem.
 */
export async function unbox(masterKey: string | undefined, stored: string): Promise<string | undefined> {
  if (!isBoxed(stored)) return stored;
  const key = validMasterKey(masterKey);
  if (!key) return undefined;
  try {
    const packed = Uint8Array.from(atob(stored.slice(PREFIX.length)), (c) => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: packed.slice(0, IV_BYTES) },
      await aesKey(key),
      packed.slice(IV_BYTES)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return undefined;
  }
}

/** Encrypt when a VALID master key is configured; store plaintext otherwise (legacy path). */
export async function sealIfKeyed(masterKey: string | undefined, value: string): Promise<string> {
  const key = validMasterKey(masterKey);
  return key && value ? box(key, value) : value;
}
