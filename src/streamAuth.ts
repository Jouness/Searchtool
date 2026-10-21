/**
 * One-time-ish tokens that authenticate the Media Stream WebSocket.
 *
 * The /incoming-call webhook is protected by Twilio's request signature, but
 * the /media-stream WebSocket is a public URL that anyone could connect to and
 * use to burn your OpenAI credits. To close that hole, the webhook mints a
 * short-lived HMAC token bound to the CallSid and hands it to Twilio as a
 * <Stream><Parameter>. Twilio echoes it back to us in the stream's `start`
 * message, where we verify it before ever opening an OpenAI connection.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_SECONDS = 120;

function sign(secret: string, callSid: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(`${callSid}.${expiresAt}`).digest('base64url');
}

export function createStreamToken(secret: string, callSid: string, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + TOKEN_TTL_SECONDS;
  return `${expiresAt}.${sign(secret, callSid, expiresAt)}`;
}

export function verifyStreamToken(
  secret: string,
  callSid: string,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token || !callSid) return false;
  const [expRaw, signature] = token.split('.');
  const expiresAt = Number(expRaw);
  if (!signature || !Number.isInteger(expiresAt)) return false;
  if (expiresAt < Math.floor(now / 1000)) return false;

  const expected = Buffer.from(sign(secret, callSid, expiresAt));
  const actual = Buffer.from(signature);
  // Constant-time comparison so the signature can't be guessed byte by byte.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
