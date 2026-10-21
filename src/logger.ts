/**
 * Structured JSON logging via pino. In development we pretty-print for humans;
 * in production we emit one JSON object per line for your log pipeline.
 */
import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'voice-screener' },
  // Never let secrets leak into logs, even by accident. HTTP client errors
  // (e.g. from the Twilio SDK) carry the request config, including auth headers.
  redact: {
    paths: ['req.headers.authorization', 'err.config', 'err.request', 'err.response', '*.authToken', '*.apiKey', 'token'],
    remove: true,
  },
  ...(config.nodeEnv !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
  }),
});

export type Logger = typeof logger;
