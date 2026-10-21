/**
 * Centralised, validated configuration.
 *
 * Everything is read from environment variables (optionally loaded from a
 * `.env` file). We fail fast at boot if anything required is missing, rather
 * than discovering it halfway through a live phone call.
 */
import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

function float(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

/**
 * The public base URL (e.g. https://abcd-1234.ngrok-free.app). Twilio signs
 * webhooks against the URL *it* called, which is the public one, not the
 * localhost address our process sees, so we need to know it explicitly.
 */
function publicBaseUrl(): URL {
  const raw = required('PUBLIC_BASE_URL');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_BASE_URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('PUBLIC_BASE_URL must start with https:// (or http:// for local testing)');
  }
  // Normalise: no trailing slash so we can safely append paths.
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export const config = {
  port: int('PORT', 5050),
  host: optional('HOST', '0.0.0.0'),
  logLevel: optional('LOG_LEVEL', 'info'),
  nodeEnv: optional('NODE_ENV', 'development'),

  publicBaseUrl: publicBaseUrl(),

  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    /** Reject webhooks whose X-Twilio-Signature doesn't verify. Keep on in production. */
    validateSignature: bool('TWILIO_VALIDATE_SIGNATURE', true),
  },

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: optional('OPENAI_REALTIME_MODEL', 'gpt-realtime'),
    /** Overridable so the test suite can point at a local mock server. */
    realtimeUrl: optional('OPENAI_REALTIME_URL', 'wss://api.openai.com/v1/realtime'),
    voice: optional('OPENAI_VOICE', 'marin'),
    /** Set to an empty string to disable caller transcription in the logs. */
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() ?? 'gpt-4o-mini-transcribe',
    vadThreshold: float('OPENAI_VAD_THRESHOLD', 0.5),
    vadSilenceMs: int('OPENAI_VAD_SILENCE_MS', 500),
    vadPrefixPaddingMs: int('OPENAI_VAD_PREFIX_PADDING_MS', 300),
    connectTimeoutMs: int('OPENAI_CONNECT_TIMEOUT_MS', 10_000),
  },

  call: {
    /** Name of the person/business the screener answers for, used in the prompt. */
    ownerName: optional('SCREENER_OWNER_NAME', 'the person you are calling'),
    /** Hard cap on call length so a stuck call can't burn tokens forever. */
    maxDurationSeconds: int('MAX_CALL_DURATION_SECONDS', 600),
    /** Spoken to the caller if the AI backend fails mid-call. */
    fallbackMessage: optional(
      'FALLBACK_MESSAGE',
      "Sorry, we're having technical difficulties right now. Please try again later. Goodbye.",
    ),
  },

  /** On SIGTERM, how long to let in-flight calls finish before forcibly ending them. */
  shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 25_000),
} as const;

export type Config = typeof config;
