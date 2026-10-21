/**
 * CallSession: the bridge for ONE phone call.
 *
 *   Caller ──PSTN──▶ Twilio ──WS (μ-law 8kHz, base64)──▶ CallSession ──WS──▶ OpenAI Realtime
 *          ◀──────────────── ◀──────── media / clear / mark ◀────────────── audio deltas
 *
 * Responsibilities:
 *  - Authenticate the Twilio stream (token from the `start` message).
 *  - Open and configure the OpenAI Realtime WebSocket for this call.
 *  - Shuttle audio in both directions with zero transcoding: both sides speak
 *    G.711 μ-law at 8kHz ("audio/pcmu" in the Realtime API), so we just pass
 *    base64 payloads straight through.
 *  - Barge-in: when the caller starts talking, flush Twilio's playback buffer
 *    and tell OpenAI how much of its reply the caller actually heard.
 *  - Handle the finish_screening tool call and hang up after the goodbye.
 *  - Tear everything down exactly once, whichever side disconnects first.
 */
import WebSocket from 'ws';
import type { Twilio } from 'twilio';
import { config } from './config.js';
import type { Logger } from './logger.js';
import { FINISH_SCREENING_TOOL, GREETING_TRIGGER, buildInstructions, isWithheldCallerId } from './prompt.js';
import { verifyStreamToken } from './streamAuth.js';

// ---------------------------------------------------------------------------
// Twilio Media Streams message shapes (only the fields we use).
// https://www.twilio.com/docs/voice/media-streams/websocket-messages
// ---------------------------------------------------------------------------
type TwilioInbound =
  | { event: 'connected'; protocol: string; version: string }
  | {
      event: 'start';
      streamSid: string;
      start: {
        streamSid: string;
        callSid: string;
        accountSid: string;
        tracks: string[];
        mediaFormat: { encoding: string; sampleRate: number; channels: number };
        customParameters?: Record<string, string>;
      };
    }
  | {
      event: 'media';
      streamSid: string;
      media: { track?: string; chunk: string; timestamp: string; payload: string };
    }
  | { event: 'mark'; streamSid: string; mark: { name: string } }
  | { event: 'dtmf'; streamSid: string; dtmf: { digit: string } }
  | { event: 'stop'; streamSid: string; stop?: { callSid: string } };

/** Loose shape of OpenAI Realtime server events; we narrow by `type`. */
interface OpenAIEvent {
  type: string;
  [key: string]: unknown;
}

export interface ScreeningResult {
  caller_name: string;
  intent: string;
  category: string;
  callback_requested?: boolean;
}

export interface CallSessionDeps {
  twilioClient: Twilio;
  log: Logger;
  /** Called exactly once when the session has fully ended. */
  onEnd: (session: CallSession) => void;
}

/** If Twilio never sends `start`, drop the socket. */
const START_TIMEOUT_MS = 5_000;
/** Twilio sends a media frame every 20ms while the call is up; silence this long means it's dead. */
const TWILIO_IDLE_TIMEOUT_MS = 15_000;
/** Audio received before OpenAI is ready is buffered, up to this many 20ms frames (~3s). */
const MAX_PENDING_FRAMES = 150;
/** After the goodbye starts, hang up after this long even if Twilio never echoes our mark. */
const HANGUP_SAFETY_MS = 20_000;

let sessionCounter = 0;

export class CallSession {
  readonly id = ++sessionCounter;
  readonly startedAt = Date.now();

  private log: Logger;
  private openaiWs: WebSocket | null = null;

  // --- Stream identity -----------------------------------------------------
  /** Twilio's stream ID; every message we send back to Twilio must carry it. */
  private streamSid: string | null = null;
  private callSid: string | null = null;

  // --- Readiness / buffering ----------------------------------------------
  /** True once OpenAI has acknowledged our session.update (audio format is set). */
  private openaiReady = false;
  private pendingAudio: string[] = [];

  // --- Playback tracking for barge-in --------------------------------------
  /** Latest `media.timestamp` from Twilio: ms of call audio since the stream started. */
  private latestMediaTimestamp = 0;
  /** Twilio timestamp when the current assistant response's first audio was sent. */
  private responseStartTimestamp: number | null = null;
  /** The assistant item currently being played (needed for conversation.item.truncate). */
  private lastAssistantItem: string | null = null;
  /**
   * Marks we've sent to Twilio that haven't been echoed back yet. Twilio echoes a
   * mark once all audio queued before it has played, so a non-empty set means
   * the caller is still hearing AI audio.
   */
  private pendingMarks = new Set<string>();
  private markCounter = 0;

  // --- End-of-call ---------------------------------------------------------
  /** Set after finish_screening: hang up once the following response (the goodbye) has played. */
  private hangupAfterNextResponse = false;
  /** The mark whose echo means "goodbye finished playing". */
  private hangupMark: string | null = null;
  private hangupSafetyTimer: NodeJS.Timeout | null = null;
  private screening: ScreeningResult | null = null;
  private ended = false;
  private endReason = '';
  /** Set while fail() is redirecting the call, so the resulting stream close keeps the real reason. */
  private failReason: string | null = null;

  private timers = new Set<NodeJS.Timeout>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly twilioWs: WebSocket,
    private readonly deps: CallSessionDeps,
  ) {
    this.log = deps.log.child({ session: this.id });
    this.log.info('Twilio media stream connected');

    twilioWs.on('message', (data) => this.onTwilioMessage(data));
    twilioWs.on('close', (code, reason) => {
      this.log.info({ code, reason: reason.toString() }, 'Twilio socket closed');
      this.end('twilio-socket-closed');
    });
    twilioWs.on('error', (err) => {
      this.log.error({ err }, 'Twilio socket error');
      this.end('twilio-socket-error');
    });

    this.setTimer(() => {
      if (!this.streamSid) {
        this.log.warn('No start message received from Twilio in time');
        this.end('start-timeout', 1008);
      }
    }, START_TIMEOUT_MS);
    this.resetIdleTimer();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  // =========================================================================
  // Twilio → server
  // =========================================================================

  private onTwilioMessage(data: WebSocket.RawData): void {
    this.resetIdleTimer();

    let msg: TwilioInbound;
    try {
      msg = JSON.parse(data.toString()) as TwilioInbound;
    } catch {
      this.log.warn('Ignoring non-JSON message from Twilio');
      return;
    }

    switch (msg.event) {
      case 'connected':
        this.log.debug({ protocol: msg.protocol, version: msg.version }, 'Twilio protocol handshake');
        break;

      case 'start':
        this.onTwilioStart(msg);
        break;

      case 'media':
        // Ignore anything until the stream is authenticated.
        if (!this.streamSid) return;
        this.latestMediaTimestamp = Number(msg.media.timestamp) || this.latestMediaTimestamp;
        // With <Connect><Stream> only the caller's audio ("inbound") is sent, but be defensive.
        if (msg.media.track && msg.media.track !== 'inbound') return;
        this.forwardCallerAudio(msg.media.payload);
        break;

      case 'mark':
        this.pendingMarks.delete(msg.mark.name);
        if (msg.mark.name === this.hangupMark) {
          this.log.info('Goodbye finished playing; hanging up');
          this.end('screening-complete');
        }
        break;

      case 'dtmf':
        this.log.info({ digit: msg.dtmf.digit }, 'Caller pressed a key');
        break;

      case 'stop':
        this.log.info('Twilio sent stop (caller hung up or call ended)');
        this.end('twilio-stop');
        break;

      default:
        this.log.debug({ event: (msg as { event?: string }).event }, 'Unhandled Twilio event');
    }
  }

  private onTwilioStart(msg: Extract<TwilioInbound, { event: 'start' }>): void {
    if (this.streamSid) {
      this.log.warn('Duplicate start message ignored');
      return;
    }

    const { callSid, streamSid, customParameters = {}, mediaFormat } = msg.start;

    if (!verifyStreamToken(config.twilio.authToken, callSid, customParameters.token)) {
      this.log.warn({ callSid }, 'Rejected media stream: invalid or expired token');
      this.end('invalid-stream-token', 1008);
      return;
    }

    this.streamSid = streamSid;
    this.callSid = callSid;
    this.log = this.log.child({ callSid, streamSid });

    const callerIdWithheld = isWithheldCallerId(customParameters.from);
    this.log.info({ mediaFormat, callerIdWithheld, from: customParameters.from }, 'Media stream started');

    if (mediaFormat && (mediaFormat.encoding !== 'audio/x-mulaw' || mediaFormat.sampleRate !== 8000)) {
      // Shouldn't happen with Twilio Voice, but if it did, audio would be garbage.
      this.log.warn({ mediaFormat }, 'Unexpected Twilio media format; expected audio/x-mulaw @ 8000Hz');
    }

    this.setTimer(() => {
      this.log.warn({ maxSeconds: config.call.maxDurationSeconds }, 'Max call duration reached');
      this.end('max-duration');
    }, config.call.maxDurationSeconds * 1000);

    this.connectOpenAI(callerIdWithheld);
  }

  /** Forward one 20ms μ-law frame to OpenAI, or buffer it if OpenAI isn't ready yet. */
  private forwardCallerAudio(payload: string): void {
    if (this.openaiReady) {
      this.sendToOpenAI({ type: 'input_audio_buffer.append', audio: payload });
      return;
    }
    this.pendingAudio.push(payload);
    if (this.pendingAudio.length > MAX_PENDING_FRAMES) this.pendingAudio.shift();
  }

  // =========================================================================
  // OpenAI connection
  // =========================================================================

  private connectOpenAI(callerIdWithheld: boolean): void {
    const url = new URL(config.openai.realtimeUrl);
    url.searchParams.set('model', config.openai.model);

    this.log.debug({ url: url.toString() }, 'Connecting to OpenAI Realtime');
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
      handshakeTimeout: config.openai.connectTimeoutMs,
    });
    this.openaiWs = ws;

    ws.on('open', () => {
      this.log.info('Connected to OpenAI Realtime');
      this.configureSession(callerIdWithheld);
    });

    ws.on('message', (data) => this.onOpenAIMessage(data));

    // Non-101 handshake responses (401 bad key, 429 rate limit, ...).
    ws.on('unexpected-response', (_req, res) => {
      this.log.error({ status: res.statusCode }, 'OpenAI rejected the WebSocket handshake');
      ws.terminate();
    });

    ws.on('error', (err) => {
      // A 'close' event always follows, which is where we react.
      this.log.error({ err }, 'OpenAI socket error');
    });

    ws.on('close', (code, reason) => {
      this.log.info({ code, reason: reason.toString() }, 'OpenAI socket closed');
      if (!this.ended) void this.fail('openai-disconnected');
    });
  }

  /**
   * Configure the Realtime session. `audio/pcmu` is G.711 μ-law at 8kHz — the
   * GA name for what the beta API called `g711_ulaw` — which is exactly what
   * Twilio sends and expects, so no resampling or transcoding is needed.
   */
  private configureSession(callerIdWithheld: boolean): void {
    const transcription = config.openai.transcriptionModel
      ? { transcription: { model: config.openai.transcriptionModel } }
      : {};

    this.sendToOpenAI({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: config.openai.model,
        output_modalities: ['audio'],
        instructions: buildInstructions({ callerIdWithheld }),
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            ...transcription,
            turn_detection: {
              type: 'server_vad',
              threshold: config.openai.vadThreshold,
              prefix_padding_ms: config.openai.vadPrefixPaddingMs,
              silence_duration_ms: config.openai.vadSilenceMs,
              create_response: true,
              // Server cancels its in-progress response when the caller starts talking.
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: config.openai.voice,
          },
        },
        tools: [FINISH_SCREENING_TOOL],
        tool_choice: 'auto',
      },
    });
  }

  // =========================================================================
  // OpenAI → server
  // =========================================================================

  private onOpenAIMessage(data: WebSocket.RawData): void {
    let event: OpenAIEvent;
    try {
      event = JSON.parse(data.toString()) as OpenAIEvent;
    } catch {
      this.log.warn('Ignoring non-JSON message from OpenAI');
      return;
    }

    switch (event.type) {
      case 'session.created':
        this.log.debug('OpenAI session created');
        break;

      case 'session.updated':
        if (!this.openaiReady) this.onSessionReady();
        break;

      // GA event name, plus the beta name for compatibility with older models/endpoints.
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.playAssistantAudio(event.delta as string, event.item_id as string | undefined);
        break;

      case 'input_audio_buffer.speech_started':
        this.handleBargeIn();
        break;

      case 'response.done':
        this.onResponseDone(event.response as ResponseDonePayload | undefined);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.log.info({ caller: event.transcript }, 'Caller said');
        break;

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.log.info({ assistant: event.transcript }, 'Assistant said');
        break;

      case 'error':
        // Most Realtime errors are per-request (e.g. truncating an item that already
        // finished) and the session carries on, so log rather than hang up.
        this.log.error({ error: event.error }, 'OpenAI error event');
        break;

      default:
        this.log.trace({ type: event.type }, 'OpenAI event');
    }
  }

  /** OpenAI now knows we speak μ-law: flush buffered audio and have the AI greet the caller. */
  private onSessionReady(): void {
    this.openaiReady = true;
    this.log.info({ bufferedFrames: this.pendingAudio.length }, 'OpenAI session configured');

    for (const payload of this.pendingAudio) {
      this.sendToOpenAI({ type: 'input_audio_buffer.append', audio: payload });
    }
    this.pendingAudio = [];

    this.sendToOpenAI({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: GREETING_TRIGGER }] },
    });
    this.sendToOpenAI({ type: 'response.create' });
  }

  /** Wrap an OpenAI audio chunk in a Twilio `media` message and queue it for playback. */
  private playAssistantAudio(delta: string, itemId: string | undefined): void {
    if (!delta || !this.streamSid) return;

    this.sendToTwilio({ event: 'media', streamSid: this.streamSid, media: { payload: delta } });

    // First chunk of a new response: remember where in the call's timeline it started.
    if (this.responseStartTimestamp === null) {
      this.responseStartTimestamp = this.latestMediaTimestamp;
    }
    if (itemId) this.lastAssistantItem = itemId;

    // A mark after each chunk lets us know whether audio is still playing.
    this.sendMark();
  }

  /**
   * Barge-in. The caller started speaking, so:
   *  1. Tell OpenAI how many ms of the current reply were actually played, so its
   *     memory of the conversation matches what the caller heard.
   *  2. Send `clear` so Twilio drops any AI audio it has buffered but not played.
   */
  private handleBargeIn(): void {
    if (!this.streamSid) return;

    const stillPlaying = this.pendingMarks.size > 0;
    if (stillPlaying && this.lastAssistantItem && this.responseStartTimestamp !== null) {
      const audioEndMs = Math.max(0, this.latestMediaTimestamp - this.responseStartTimestamp);
      this.log.debug({ itemId: this.lastAssistantItem, audioEndMs }, 'Caller interrupted; truncating');
      this.sendToOpenAI({
        type: 'conversation.item.truncate',
        item_id: this.lastAssistantItem,
        content_index: 0,
        audio_end_ms: audioEndMs,
      });
    }

    this.sendToTwilio({ event: 'clear', streamSid: this.streamSid });

    // Twilio echoes outstanding marks after a clear; forgetting them here means
    // those late echoes are ignored, including a pending hangup mark. If the
    // caller talks over the goodbye, let the AI answer them, then hang up after
    // that reply instead.
    this.pendingMarks.clear();
    if (this.hangupMark) {
      this.hangupMark = null;
      this.hangupAfterNextResponse = true;
      this.clearTimer(this.hangupSafetyTimer);
      this.hangupSafetyTimer = null;
    }
    this.lastAssistantItem = null;
    this.responseStartTimestamp = null;
  }

  private onResponseDone(response: ResponseDonePayload | undefined): void {
    // Next audio delta belongs to a new response.
    this.responseStartTimestamp = null;

    if (response?.status === 'failed') {
      this.log.error({ details: response.status_details }, 'OpenAI response failed');
    }

    const calls = (response?.output ?? []).filter((item) => item.type === 'function_call');
    if (calls.length > 0) {
      for (const call of calls) this.handleFunctionCall(call as FunctionCallItem);
      // Let the model speak again now that it has the tool result(s).
      this.sendToOpenAI({ type: 'response.create' });
      return;
    }

    if (this.hangupAfterNextResponse && response?.status !== 'cancelled') {
      // That was the goodbye. Hang up once Twilio confirms it has finished playing.
      this.hangupAfterNextResponse = false;
      this.hangupMark = this.sendMark('hangup');
      this.hangupSafetyTimer = this.setTimer(() => this.end('screening-complete-timeout'), HANGUP_SAFETY_MS);
    }
  }

  private handleFunctionCall(call: FunctionCallItem): void {
    let output: Record<string, unknown>;

    if (call.name === FINISH_SCREENING_TOOL.name) {
      try {
        this.screening = JSON.parse(call.arguments ?? '{}') as ScreeningResult;
        // This is the "business output" of the call. Swap the log line for a
        // database write, email, Slack message, etc.
        this.log.info({ screening: this.screening, callSid: this.callSid }, 'SCREENING RESULT');
        output = { ok: true };
        this.hangupAfterNextResponse = true;
      } catch (err) {
        this.log.warn({ err, arguments: call.arguments }, 'finish_screening called with invalid JSON');
        output = { ok: false, error: 'Arguments were not valid JSON. Please call the tool again.' };
      }
    } else {
      this.log.warn({ name: call.name }, 'Model called an unknown tool');
      output = { ok: false, error: `Unknown tool: ${call.name}` };
    }

    this.sendToOpenAI({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) },
    });
  }

  // =========================================================================
  // Sending helpers
  // =========================================================================

  private sendToOpenAI(event: Record<string, unknown>): void {
    if (this.openaiWs?.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify(event));
    }
  }

  private sendToTwilio(message: Record<string, unknown>): void {
    if (this.twilioWs.readyState === WebSocket.OPEN) {
      this.twilioWs.send(JSON.stringify(message));
    }
  }

  /** Send a uniquely named mark and track it until Twilio echoes it. */
  private sendMark(prefix = 'audio'): string | null {
    if (!this.streamSid) return null;
    const name = `${prefix}-${++this.markCounter}`;
    this.pendingMarks.add(name);
    this.sendToTwilio({ event: 'mark', streamSid: this.streamSid, mark: { name } });
    return name;
  }

  // =========================================================================
  // Failure / teardown
  // =========================================================================

  /**
   * The AI side broke mid-call (or we're shutting down). Rather than dropping
   * the caller into dead air, redirect the live call via Twilio's REST API to a
   * spoken apology. This must happen BEFORE we close the stream: closing it
   * first would end <Connect> and, with no TwiML after it, hang up the call.
   * Updating the call's TwiML makes Twilio close this media stream itself.
   */
  async fail(reason: string): Promise<void> {
    if (this.ended || this.failReason) return;
    this.failReason = reason;
    this.log.error({ reason }, 'Call failed; playing fallback message');

    // Stop talking to OpenAI immediately; the caller hears silence for the
    // few hundred ms the redirect takes.
    if (this.openaiWs && this.openaiWs.readyState !== WebSocket.CLOSED) this.openaiWs.terminate();

    if (this.callSid) {
      try {
        await withTimeout(
          this.deps.twilioClient.calls(this.callSid).update({
            twiml: `<Response><Say>${escapeXml(config.call.fallbackMessage)}</Say><Hangup/></Response>`,
          }),
          5_000,
        );
      } catch (err) {
        // Usually the caller already hung up (Twilio error 21220). Log only safe
        // fields: the raw HTTP error object includes the Basic auth header.
        const e = err as { code?: unknown; status?: unknown; message?: unknown };
        this.log.warn({ code: e.code, status: e.status, message: e.message }, 'Could not redirect call to fallback message');
      }
    }

    this.end(reason);
  }

  /** Idempotent teardown: close both sockets, clear timers, notify the server. */
  end(reason: string, twilioCloseCode = 1000): void {
    if (this.ended) return;
    this.ended = true;
    reason = this.failReason ?? reason;
    this.endReason = reason;

    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);

    if (this.openaiWs) {
      const ws = this.openaiWs;
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'call ended');
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    }

    // Closing the stream from our side ends <Connect>; with no TwiML after it, Twilio hangs up.
    if (this.twilioWs.readyState === WebSocket.OPEN) {
      this.twilioWs.close(twilioCloseCode, reason.slice(0, 120));
    }

    this.log.info(
      {
        reason,
        durationSec: Math.round((Date.now() - this.startedAt) / 1000),
        screening: this.screening,
      },
      'Call session ended',
    );
    this.deps.onEnd(this);
  }

  get summary(): { reason: string; screening: ScreeningResult | null } {
    return { reason: this.endReason, screening: this.screening };
  }

  private setTimer(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private clearTimer(timer: NodeJS.Timeout | null): void {
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  private resetIdleTimer(): void {
    if (this.ended) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.log.warn('No messages from Twilio; assuming the stream is dead');
      this.end('twilio-idle-timeout');
    }, TWILIO_IDLE_TIMEOUT_MS);
  }
}

interface FunctionCallItem {
  type: 'function_call';
  name: string;
  call_id: string;
  arguments?: string;
}

interface ResponseDonePayload {
  status?: string;
  status_details?: unknown;
  output?: Array<{ type: string } & Partial<FunctionCallItem>>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
