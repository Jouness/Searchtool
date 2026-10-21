/**
 * End-to-end test of the bridge: runs the real server as a child process,
 * pretends to be Twilio on one side and points it at a mock OpenAI Realtime
 * server on the other. No network access or real credentials needed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import WebSocket, { WebSocketServer } from 'ws';

const AUTH_TOKEN = 'test-auth-token';
const PORT = 5099;
const BASE = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

/** Collects JSON messages from a socket and lets tests await the next one matching a predicate. */
class Inbox {
  private messages: Json[] = [];
  private waiters: Array<{ pred: (m: Json) => boolean; resolve: (m: Json) => void }> = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Json;
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(msg);
      else this.messages.push(msg);
    });
  }

  next(pred: (m: Json) => boolean, timeoutMs = 3000): Promise<Json> {
    const idx = this.messages.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.messages.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  all(pred: (m: Json) => boolean): Json[] {
    return this.messages.filter(pred);
  }
}

let mockOpenAI: WebSocketServer;
let openaiConnections: Array<{ ws: WebSocket; inbox: Inbox; headers: Json }> = [];
let server: ChildProcess;

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server did not start');
}

async function postIncomingCall(params: Record<string, string>, signature?: string): Promise<Response> {
  const url = `${BASE}/incoming-call`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature ?? twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
    },
    body: new URLSearchParams(params),
  });
}

function nextOpenAIConnection(): Promise<{ ws: WebSocket; inbox: Inbox; headers: Json }> {
  const start = openaiConnections.length;
  return new Promise((resolve) => {
    const check = setInterval(() => {
      const conn = openaiConnections[start];
      if (conn) {
        clearInterval(check);
        resolve(conn);
      }
    }, 10);
  });
}

async function startTwilioStream(callSid: string, from: string) {
  const res = await postIncomingCall({ CallSid: callSid, From: from, To: '+15550001111' });
  const xml = await res.text();
  const token = /name="token" value="([^"]+)"/.exec(xml)?.[1];
  assert.ok(token, 'TwiML should carry a stream token');

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/media-stream`);
  const inbox = new Inbox(ws);
  await once(ws, 'open');
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  return { ws, inbox, token };
}

function sendStart(ws: WebSocket, callSid: string, token: string, from: string) {
  ws.send(
    JSON.stringify({
      event: 'start',
      streamSid: 'MZ123',
      start: {
        streamSid: 'MZ123',
        callSid,
        accountSid: 'ACtest',
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters: { token, from },
      },
    }),
  );
}

function sendMedia(ws: WebSocket, timestamp: number, payload = 'AAAA') {
  ws.send(
    JSON.stringify({
      event: 'media',
      streamSid: 'MZ123',
      media: { track: 'inbound', chunk: '1', timestamp: String(timestamp), payload },
    }),
  );
}

before(async () => {
  mockOpenAI = new WebSocketServer({ port: 0 });
  mockOpenAI.on('connection', (ws, req) => {
    openaiConnections.push({ ws, inbox: new Inbox(ws), headers: req.headers as Json });
  });
  await once(mockOpenAI, 'listening');
  const mockPort = (mockOpenAI.address() as AddressInfo).port;

  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
      PUBLIC_BASE_URL: BASE,
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REALTIME_URL: `ws://127.0.0.1:${mockPort}/v1/realtime`,
      SHUTDOWN_GRACE_MS: '500',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForHealth();
});

after(async () => {
  server.kill('SIGTERM');
  await once(server, 'exit');
  mockOpenAI.close();
});

describe('POST /incoming-call', () => {
  test('rejects requests without a valid Twilio signature', async () => {
    const res = await postIncomingCall({ CallSid: 'CA1', From: 'anonymous' }, 'bogus');
    assert.equal(res.status, 403);
  });

  test('returns <Connect><Stream> TwiML pointing at /media-stream', async () => {
    const res = await postIncomingCall({ CallSid: 'CA1', From: 'anonymous' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /xml/);
    const xml = await res.text();
    assert.match(xml, /<Connect><Stream url="ws:\/\/127\.0\.0\.1:5099\/media-stream">/);
    assert.match(xml, /<Parameter name="from" value="anonymous"\/>/);
  });
});

describe('WS /media-stream', () => {
  test('rejects a stream with a forged token', async () => {
    const { ws } = await startTwilioStream('CA-forged', 'anonymous');
    sendStart(ws, 'CA-forged', '9999999999.forged', 'anonymous');
    const [code] = (await once(ws, 'close')) as [number];
    assert.equal(code, 1008);
  });

  test('bridges audio, handles barge-in, and hangs up after screening', async () => {
    const callSid = 'CA-happy';
    const { ws: twilioWs, inbox: twilio, token } = await startTwilioStream(callSid, 'anonymous');
    const openaiPromise = nextOpenAIConnection();
    sendStart(twilioWs, callSid, token, 'anonymous');

    // Audio that arrives before OpenAI is ready must be buffered, not lost.
    sendMedia(twilioWs, 20, 'early');

    const openai = await openaiPromise;
    assert.equal(openai.headers.authorization, 'Bearer sk-test');

    // 1. Session is configured for μ-law in both directions with our tool.
    const update = await openai.inbox.next((m) => m.type === 'session.update');
    assert.equal(update.session.audio.input.format.type, 'audio/pcmu');
    assert.equal(update.session.audio.output.format.type, 'audio/pcmu');
    assert.equal(update.session.tools[0].name, 'finish_screening');
    assert.match(update.session.instructions, /withheld their number/);

    openai.ws.send(JSON.stringify({ type: 'session.updated', session: {} }));

    // 2. Buffered audio is flushed, then the AI is prompted to greet.
    const early = await openai.inbox.next((m) => m.type === 'input_audio_buffer.append');
    assert.equal(early.audio, 'early');
    await openai.inbox.next((m) => m.type === 'conversation.item.create');
    await openai.inbox.next((m) => m.type === 'response.create');

    // 3. Live caller audio is forwarded as-is.
    sendMedia(twilioWs, 40, 'live');
    const live = await openai.inbox.next((m) => m.type === 'input_audio_buffer.append');
    assert.equal(live.audio, 'live');

    // 4. AI audio is wrapped as a Twilio media message, followed by a mark.
    openai.ws.send(JSON.stringify({ type: 'response.output_audio.delta', item_id: 'item_1', delta: 'aGVsbG8=' }));
    const media = await twilio.next((m) => m.event === 'media');
    assert.deepEqual(media, { event: 'media', streamSid: 'MZ123', media: { payload: 'aGVsbG8=' } });
    await twilio.next((m) => m.event === 'mark');

    // 5. Barge-in: caller speaks 300ms later while audio is still "playing".
    sendMedia(twilioWs, 340);
    await openai.inbox.next((m) => m.type === 'input_audio_buffer.append');
    openai.ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    const clear = await twilio.next((m) => m.event === 'clear');
    assert.equal(clear.streamSid, 'MZ123');
    const truncate = await openai.inbox.next((m) => m.type === 'conversation.item.truncate');
    assert.equal(truncate.item_id, 'item_1');
    assert.equal(truncate.audio_end_ms, 300);

    // 6. Model finishes screening via the tool.
    openai.ws.send(
      JSON.stringify({
        type: 'response.done',
        response: {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'finish_screening',
              call_id: 'call_1',
              arguments: JSON.stringify({ caller_name: 'Jane Doe', intent: 'Dentist appointment', category: 'personal' }),
            },
          ],
        },
      }),
    );
    const output = await openai.inbox.next((m) => m.type === 'conversation.item.create');
    assert.equal(output.item.type, 'function_call_output');
    assert.equal(output.item.call_id, 'call_1');
    await openai.inbox.next((m) => m.type === 'response.create');

    // 7. Goodbye plays, then the server hangs up once Twilio confirms playback.
    openai.ws.send(JSON.stringify({ type: 'response.output_audio.delta', item_id: 'item_2', delta: 'Ynll' }));
    openai.ws.send(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [] } }));
    const hangupMark = await twilio.next((m) => m.event === 'mark' && m.mark.name.startsWith('hangup'));

    const closed = once(twilioWs, 'close');
    const openaiClosed = once(openai.ws, 'close');
    twilioWs.send(JSON.stringify({ event: 'mark', streamSid: 'MZ123', mark: hangupMark.mark }));
    const [code] = (await closed) as [number];
    assert.equal(code, 1000);
    await openaiClosed;
  });

  test('caller hanging up closes the OpenAI socket', async () => {
    const callSid = 'CA-hangup';
    const { ws: twilioWs, token } = await startTwilioStream(callSid, '+15551234567');
    const openaiPromise = nextOpenAIConnection();
    sendStart(twilioWs, callSid, token, '+15551234567');
    const openai = await openaiPromise;
    await openai.inbox.next((m) => m.type === 'session.update');

    const openaiClosed = once(openai.ws, 'close');
    twilioWs.send(JSON.stringify({ event: 'stop', streamSid: 'MZ123', stop: { callSid } }));
    await openaiClosed;
  });
});
