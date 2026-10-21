/**
 * Entry point: HTTP routes, WebSocket upgrade routing, and graceful shutdown.
 *
 *  POST /incoming-call  Twilio voice webhook. Returns TwiML that connects the
 *                       call to our /media-stream WebSocket.
 *  WS   /media-stream   Twilio Media Stream. Each connection gets a CallSession
 *                       that bridges it to the OpenAI Realtime API.
 *  GET  /health         Liveness/readiness probe (503 while shutting down).
 */
import http from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { CallSession } from './callSession.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { createStreamToken } from './streamAuth.js';

const MEDIA_STREAM_PATH = '/media-stream';
/** e.g. "https://abcd.ngrok-free.app" (never a trailing slash). */
const publicBase = config.publicBaseUrl.toString().replace(/\/+$/, '');

const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

/** Every live call, so we can report on and drain them at shutdown. */
const activeSessions = new Set<CallSession>();
let shuttingDown = false;

/** wss://<public host>/media-stream — the URL Twilio opens the stream to. */
const mediaStreamUrl = (() => {
  const url = new URL(config.publicBaseUrl.toString());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${MEDIA_STREAM_PATH}`;
  return url.toString();
})();

// ===========================================================================
// HTTP
// ===========================================================================

const app = express();
app.disable('x-powered-by');
// Twilio sends webhooks as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

/**
 * Verify X-Twilio-Signature so only Twilio can trigger calls into the AI.
 * The signature covers the exact public URL Twilio requested plus the POST
 * params, so we rebuild the URL from PUBLIC_BASE_URL (behind ngrok or a load
 * balancer, req.protocol/host would be the internal ones and never match).
 */
function validateTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  if (!config.twilio.validateSignature) return next();

  const signature = req.header('X-Twilio-Signature');
  const url = `${publicBase}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;

  if (!signature || !twilio.validateRequest(config.twilio.authToken, signature, url, params)) {
    logger.warn({ url, hasSignature: Boolean(signature) }, 'Rejected webhook with invalid Twilio signature');
    res.status(403).type('text/plain').send('Invalid Twilio signature');
    return;
  }
  next();
}

app.get('/health', (_req, res) => {
  res.status(shuttingDown ? 503 : 200).json({
    status: shuttingDown ? 'shutting_down' : 'ok',
    activeCalls: activeSessions.size,
  });
});

/**
 * The voice webhook. Paste https://<your-host>/incoming-call into the Twilio
 * console under "A call comes in". We answer with:
 *
 *   <Response>
 *     <Connect>
 *       <Stream url="wss://<your-host>/media-stream">
 *         <Parameter name="token" value="..."/>   (authenticates the WebSocket)
 *         <Parameter name="from"  value="..."/>   (caller ID, may be "anonymous")
 *       </Stream>
 *     </Connect>
 *   </Response>
 *
 * <Connect><Stream> is a *bidirectional* stream: Twilio sends caller audio to
 * us and plays whatever audio we send back. The call stays inside <Connect>
 * until the WebSocket closes; nothing follows it, so the call then ends.
 */
app.post('/incoming-call', validateTwilioSignature, (req, res) => {
  const body = (req.body ?? {}) as Record<string, string | undefined>;
  const callSid = body.CallSid ?? '';
  const from = body.From ?? '';
  const twiml = new twilio.twiml.VoiceResponse();

  if (shuttingDown || !callSid) {
    // Don't start a call we'd have to cut off mid-conversation.
    twiml.say(config.call.fallbackMessage);
    twiml.hangup();
    logger.warn({ callSid, shuttingDown }, 'Declining incoming call');
  } else {
    const stream = twiml.connect().stream({ url: mediaStreamUrl });
    stream.parameter({ name: 'token', value: createStreamToken(config.twilio.authToken, callSid) });
    stream.parameter({ name: 'from', value: from });
    logger.info({ callSid, from, to: body.To }, 'Incoming call; connecting media stream');
  }

  res.type('text/xml').send(twiml.toString());
});

app.use((_req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

// Last-resort error handler: never leak stack traces, but always answer Twilio.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, path: req.path }, 'Unhandled HTTP error');
  if (res.headersSent) return;
  if (req.path === '/incoming-call') {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(config.call.fallbackMessage);
    twiml.hangup();
    res.status(200).type('text/xml').send(twiml.toString());
    return;
  }
  res.status(500).type('text/plain').send('Internal server error');
});

// ===========================================================================
// WebSocket
// ===========================================================================

const server = http.createServer(app);

// noServer: we route upgrades ourselves so only /media-stream accepts WebSockets.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname !== MEDIA_STREAM_PATH || shuttingDown) {
    const status = shuttingDown ? '503 Service Unavailable' : '404 Not Found';
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  // Authentication happens inside CallSession, using the token Twilio echoes
  // back in the stream's `start` message.
  const session = new CallSession(ws, {
    twilioClient,
    log: logger.child({ remote: req.socket.remoteAddress }),
    onEnd: (s) => activeSessions.delete(s),
  });
  if (!session.isEnded) activeSessions.add(session);
});

// ===========================================================================
// Startup & graceful shutdown
// ===========================================================================

server.listen(config.port, config.host, () => {
  logger.info(
    {
      port: config.port,
      webhookUrl: `${publicBase}/incoming-call`,
      mediaStreamUrl,
      model: config.openai.model,
      signatureValidation: config.twilio.validateSignature,
    },
    'Voice screener listening',
  );
  if (!config.twilio.validateSignature) {
    logger.warn('TWILIO_VALIDATE_SIGNATURE is off: anyone can hit /incoming-call. Do not run like this in production.');
  }
});

server.on('error', (err) => {
  logger.fatal({ err }, 'HTTP server error');
  process.exit(1);
});

/**
 * On SIGTERM/SIGINT:
 *  1. Stop accepting new calls (webhook declines politely, upgrades get 503,
 *     /health goes 503 so a load balancer drains us).
 *  2. Give in-flight calls up to SHUTDOWN_GRACE_MS to finish naturally.
 *  3. Redirect any remaining calls to the fallback message and close sockets.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.warn({ signal }, 'Second shutdown signal; exiting immediately');
    process.exit(1);
  }
  shuttingDown = true;
  logger.info({ signal, activeCalls: activeSessions.size }, 'Shutting down');

  // Stop accepting new HTTP connections; existing ones finish.
  server.close();

  const deadline = Date.now() + config.shutdownGraceMs;
  while (activeSessions.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (activeSessions.size > 0) {
    logger.warn({ remaining: activeSessions.size }, 'Grace period over; ending remaining calls');
    await Promise.allSettled([...activeSessions].map((s) => s.fail('server-shutdown')));
  }

  wss.close();
  server.closeAllConnections();
  logger.info('Shutdown complete');
  // Give pino's transport a moment to flush.
  setTimeout(() => process.exit(0), 100).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  // State may be corrupt; log and exit so the process manager restarts us.
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
