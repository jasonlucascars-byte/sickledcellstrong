// Web Push sender, written against Web Crypto only (no npm packages), so it
// runs unchanged in the Supabase Edge runtime (Deno) and in Node for tests.
//
// Two standards do all the work:
//   RFC 8291 — encrypt the message for one browser (aes128gcm). Only that
//              browser holds the private key that can read it; Apple, Google
//              and Mozilla relay bytes they cannot decrypt.
//   RFC 8292 — VAPID: a signed token proving the push came from us, so a
//              stranger who learns a subscription URL can't push to it.
//
// tests/push-reminders.test.mjs decrypts what this produces with the
// independent `http_ece` library and verifies the VAPID signature.

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // browser's public key, base64url, 65-byte uncompressed P-256
  auth: string;   // browser's 16-byte auth secret, base64url
}

export interface Vapid {
  publicKey: string;  // base64url, 65-byte uncompressed P-256
  privateKey: string; // base64url, 32-byte private scalar
  subject: string;    // mailto: or https: contact for push-service operators
}

const enc = new TextEncoder();

// Uint8Array<ArrayBuffer> (not the default ArrayBufferLike) is what Web
// Crypto and fetch accept under TypeScript 5.7+.
type Bytes = Uint8Array<ArrayBuffer>;

export function b64urlToBytes(s: string): Bytes {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64url(b: Uint8Array): string {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

// RFC 8291 §3–4: one record, no padding. `salt` and `serverKeys` are
// parameters only so tests can pin them; callers leave them out.
export async function encryptPayload(
  sub: PushSubscriptionKeys,
  payload: Bytes,
  salt: Bytes = crypto.getRandomValues(new Uint8Array(16)),
  serverKeys?: CryptoKeyPair,
): Promise<Bytes> {
  const uaPublic = b64urlToBytes(sub.p256dh);
  const authSecret = b64urlToBytes(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');

  const as = serverKeys ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintext = concat(payload, new Uint8Array([2])); // 0x02 = last record
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plaintext));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

// RFC 8292 §2: ES256 JWT. Web Crypto's ECDSA output is already the raw r||s
// form JWS wants.
export async function vapidAuthorization(endpoint: string, vapid: Vapid, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const pub = b64urlToBytes(vapid.publicKey);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)),
    d: vapid.privateKey, ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (o: unknown) => bytesToB64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: nowSec + 12 * 3600,
    sub: vapid.subject,
  })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${bytesToB64url(sig)}, k=${vapid.publicKey}`;
}

export interface SendResult { status: number; gone: boolean; ok: boolean; }

// `gone` means the browser unsubscribed or the app was removed: the caller
// should delete the subscription rather than keep pushing into the void.
export async function sendPush(
  sub: PushSubscriptionKeys, message: unknown, vapid: Vapid,
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(message)));
  const headers: Record<string, string> = {
    'Authorization': await vapidAuthorization(sub.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'TTL': String(opts.ttl ?? 900),
    'Urgency': opts.urgency ?? 'high',
  };
  // A topic lets the push service replace an undelivered older reminder
  // with the newer one instead of stacking both on a phone that was off.
  if (opts.topic) headers['Topic'] = opts.topic;
  const res = await fetchImpl(sub.endpoint, { method: 'POST', headers, body });
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
}
