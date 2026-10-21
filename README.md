# Voice Screener

An AI call screener for inbound phone calls. A Node.js/TypeScript server bridges
**Twilio Media Streams** and the **OpenAI Realtime API** over WebSockets. The AI
answers, asks who's calling and why, records the result, says goodbye, and hangs up.
It's designed for callers with withheld or anonymous numbers.

```
Caller ──PSTN──▶ Twilio ──POST /incoming-call──▶ server  (returns <Connect><Stream> TwiML)
                 Twilio ◀═══ WS /media-stream ═══▶ server ◀═══ WS ═══▶ OpenAI Realtime
                        μ-law 8kHz base64 both ways, no transcoding
```

## How it works

| Piece | Where | What it does |
|---|---|---|
| `POST /incoming-call` | `src/server.ts` | Checks `X-Twilio-Signature`, returns TwiML `<Connect><Stream url="wss://…/media-stream">` with a short-lived HMAC token and the caller ID as `<Parameter>`s. |
| `WS /media-stream` | `src/server.ts` → `src/callSession.ts` | One `CallSession` per call. Checks the token in Twilio's `start` message, then opens the OpenAI socket. |
| Session config | `callSession.ts#configureSession` | `session.update` with the screener prompt, `audio/pcmu` in and out (G.711 μ-law 8kHz, called `g711_ulaw` in the old beta API), server VAD, and the `finish_screening` tool. |
| Audio in | `forwardCallerAudio` | Twilio `media` → `input_audio_buffer.append`. Audio that arrives before OpenAI is ready is held in a buffer, then sent. |
| Audio out | `playAssistantAudio` | `response.output_audio.delta` → Twilio `media` + a `mark` so we know what's actually been played. |
| Barge-in | `handleBargeIn` | On `input_audio_buffer.speech_started`: send Twilio `clear`, and send `conversation.item.truncate` so the AI's memory only includes what the caller actually heard. |
| Finish | `onResponseDone` / `handleFunctionCall` | Model calls `finish_screening({caller_name, intent, category})` → logged as `SCREENING RESULT` → AI says goodbye → hang up once Twilio confirms the goodbye played. |
| Failures | `fail` | If OpenAI drops, the live call is redirected through Twilio's REST API to a spoken apology, so the caller doesn't sit in silence. |
| Shutdown | `shutdown` in `server.ts` | SIGTERM/SIGINT: new calls are turned away politely, `/health` returns 503, active calls get `SHUTDOWN_GRACE_MS` to finish, then any still running are ended with the fallback message. |

Other safeguards: a cap on call length, a timeout if Twilio stops sending (it sends a frame every 20ms during a call), a timeout if `start` never arrives, and secrets removed from logs.

To change the screener's behaviour, edit `src/prompt.ts`. To save results somewhere instead of logging them, edit `handleFunctionCall` in `src/callSession.ts`. It's marked with a comment.

## Run it locally with ngrok

**Prerequisites:** Node.js 20+, a Twilio account with a voice-capable phone number, an OpenAI API key with Realtime access, and [ngrok](https://ngrok.com/download) (free account; run `ngrok config add-authtoken <token>` once).

1. **Install**
   ```bash
   npm install
   cp .env.example .env
   ```

2. **Start ngrok** in a separate terminal, pointing at the server port:
   ```bash
   ngrok http 5050
   ```
   Copy the `Forwarding` HTTPS URL, e.g. `https://a1b2-203-0-113-7.ngrok-free.app`.

3. **Fill in `.env`**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OPENAI_API_KEY`, and
   `PUBLIC_BASE_URL=https://a1b2-203-0-113-7.ngrok-free.app` (the ngrok URL, no trailing slash).

4. **Start the server**
   ```bash
   npm run dev
   ```
   It logs the exact `webhookUrl` to paste into Twilio.

5. **Configure Twilio.** In the Console, go to **Phone Numbers → Manage → Active numbers →** click your number → **Voice Configuration**:
   - **A call comes in:** `Webhook`
   - **URL:** `https://a1b2-203-0-113-7.ngrok-free.app/incoming-call`
   - **HTTP:** `HTTP POST`
   - **Save configuration**

   You don't enter the `wss://…/media-stream` URL anywhere. The server puts it in the TwiML it returns.

6. **Call your Twilio number.** To test the anonymous path, dial with caller ID hidden (`*67` in North America, `#31#` in much of Europe). Watch the terminal for transcripts and the `SCREENING RESULT` line.

> On the free ngrok plan, the URL changes every time ngrok restarts. When that happens, update both `PUBLIC_BASE_URL` and the Twilio webhook, or signature checks will fail with 403. A reserved/static ngrok domain avoids this.

### Troubleshooting

- **The call says "an application error has occurred"**: Twilio couldn't reach the webhook, or got an error back. Check the ngrok inspector at `http://127.0.0.1:4040` and the Twilio **Monitor → Logs → Errors** page.
- **403 "Invalid Twilio signature"**: `PUBLIC_BASE_URL` doesn't exactly match the URL in the Twilio console, or `TWILIO_AUTH_TOKEN` is wrong. For a quick local test only, you can set `TWILIO_VALIDATE_SIGNATURE=false`.
- **The call connects, then you hear the apology**: OpenAI refused the connection. Look for `OpenAI rejected the WebSocket handshake` and its `status` in the logs (401 = bad key or no Realtime access, 429 = rate or quota limit).
- **The AI cuts itself off on a noisy line**: raise `OPENAI_VAD_THRESHOLD`, e.g. to `0.7`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run with auto-reload (tsx) |
| `npm run build` && `npm start` | Compile to `dist/` and run in production |
| `npm run typecheck` | Type-check only |
| `npm test` | End-to-end test against a mock OpenAI server and a simulated Twilio stream (no credentials needed) |

## Production notes

- Run behind TLS (any reverse proxy or PaaS). Set `NODE_ENV=production` for JSON logs, and set `PUBLIC_BASE_URL` to your real domain.
- WebSocket sessions are stateful and tied to one process. If you run several instances, the load balancer must support WebSockets and long-lived connections. Set its idle timeout above `MAX_CALL_DURATION_SECONDS`.
- Point your orchestrator's readiness probe at `/health`, and give it a termination grace period longer than `SHUTDOWN_GRACE_MS`.
- Many places require you to tell callers they're talking to an AI and/or being recorded. The default prompt identifies itself as an automated assistant. Check your local rules.
