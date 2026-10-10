# Technical Design — Multi-Instance (Hub-and-Spoke) Mode for pm2-monitor

## Overview

This design adds a hub-and-spoke capability to pm2-monitor via a single `MODE` config value (`standalone | agent | server`, default `standalone`). It is additive: standalone is the existing single-process monitor and must not change. The work introduces one shared protocol module, an agent runtime (outbound `wss://` client that reuses the existing `src/pm2` layer), and a server runtime (inbound agent WebSocket endpoint, per-agent registry, alias store, command router, log relay) plus a unified REST/dashboard surface spanning all agents.

The guiding principle is **reuse, not reinvention**: the agent is a thin bridge between the existing `Pm2Client`/`MonitorEvents` and the wire; the server reconstructs a per-agent `MonitorState`-shaped view from wire frames and feeds the `AlertEngine`. The engine is reused but made **agent-aware** by a small, explicit set of changes (composite process keys, an injected agent resolver, and an extended rule-target matcher) that leave standalone behavior provably identical — see §6, which replaces the earlier "engine unchanged" claim with the exact changes and their standalone no-op guarantees. Every wire message is a zod-validated discriminated union. Credentials go through the existing throw-safe `safeEqual`. Control commands are validated with the existing `src/api/schemas.ts` on both ends. Secrets are redacted through the existing `src/core/logger.ts`.

The stack is locked by the existing codebase and unchanged: **Node 20+, TypeScript strict, ESM (NodeNext, `.js` relative imports), `express`, `ws` (used for both the server-side `WebSocketServer` and the agent-side `WebSocket` client), `zod`, `dotenv`, `nodemailer`. Tests are `node:test` via `tsx --test`.** No new runtime dependency is added (NFR-5 / Open Question 11 confirmed: the agent client uses the already-present `ws` package).

### Boot wiring at a glance

`src/index.ts#bootstrap()` branches on `config.MODE` after `loadConfig()`:

- `standalone` → the current wiring verbatim (unchanged).
- `agent` → core hub + `Pm2Client` (as today) **minus** the human HTTP/WS server; plus an `AgentRuntime` that dials the server.
- `server` → the human HTTP server + human `WsHub` (reused) **minus** the local `Pm2Client` and local `MonitorState`; plus an `AgentGateway` (inbound agent WS), a `FleetRegistry` (per-agent state), an `AliasStore`, a global `MaintenanceState` holder, a server health router (§5, no `StateDeps`), and the agent-aware `AlertEngine` fed from fleet events with a composite-key state surface and an injected agent resolver (§6). The authenticated `GET /api/system/status` route is not mounted in server mode (no single local snapshot); its fleet equivalent is `GET /api/agents` + `/api/agents/:id`.

The branch is a small dispatch in `bootstrap()` delegating to three functions — `bootstrapStandalone()` (the extracted current body), `bootstrapAgent()`, `bootstrapServer()` — in new files `src/boot/standalone.ts`, `src/boot/agent.ts`, `src/boot/server.ts`. Extracting the current body into `bootstrapStandalone()` is a pure move (no behavior change) so the standalone path and its tests are untouched. **Assumption:** extracting into `src/boot/*` is acceptable; alternatively the three functions can live inside `index.ts`. The split is chosen to keep `index.ts` readable and each mode independently testable.

---

## 1. Configuration model (`src/config/env.ts`)

All new config flows through the existing single zod schema + `superRefine`, preserving `loadConfig() → process.exit(1)` on failure (FR-1, AC-4/5/6). The `.env` is still loaded from the project root exactly as today.

### New variables added to `configSchema`

**How these are added (mechanics — pinned).** Verified `src/config/env.ts`: the exported `configSchema` is `z.object({...}).superRefine(...)`, i.e. a **`ZodEffects`**, not a `ZodObject`. It therefore cannot be appended to with `configSchema.extend(...)` (`.extend` does not exist on `ZodEffects`) and a second chained `.superRefine(...)` must **not** be added (it would change evaluation order and the inferred type). The edits are mechanical and in-place:

- The new variables below are inserted as additional keys **inside the existing `z.object({ ... })` object literal** in `src/config/env.ts`, **before** the trailing `.superRefine`. They sit alongside the current keys (`PORT`, `HOST`, `AUTH_MODE`, …) and reuse the existing `booleanish`/`numeric`/`z.preprocess(blank→undefined)` idioms already defined in that file.
- The new cross-field `MODE` guards (below) are added as additional `ctx.addIssue({ … })` blocks **inside the body of the single existing `superRefine((cfg, ctx) => { … })` callback**, placed **after** the existing auth/email guards. They close over `cfg` with the new fields now present.
- `AppConfig` stays exactly `z.infer<typeof configSchema>` — unchanged. No `.extend()`, no `.merge()`, no second `.superRefine()`, no `ZodObject`/`ZodEffects` reshaping.

```
MODE                 z.enum(['standalone','agent','server']).default('standalone')

# agent-only
SERVER_URL           z.string().url().optional()      # must be ws:// or wss:// (refined)
AGENT_TOKEN          z.string().min(1).optional()     # the credential this agent presents
AGENT_NAME           preprocess-blank→undefined, z.string().min(1).optional()  # alias hint, visual only
AGENT_ID_FILE        z.string().min(1).default('config/agent-id')   # persisted ID suffix path
AGENT_WS_PATH        z.string().startswith('/').default('/agent')   # outbound WS path appended to SERVER_URL (must match the server's AGENT_WS_PATH)
TLS_INSECURE         booleanish.default(false)         # skip server cert verification (agent side)
# (agent mode also reuses the existing all-mode ALLOWED_SCRIPT_ROOT — see note below)

# server-only
AGENT_TOKENS         preprocess-blank→undefined, z.string().min(1).optional()  # comma-separated list
# (AGENT_TOKEN is also accepted on the server as a single-token shorthand)
ALIAS_STORE_FILE     z.string().min(1).default('config/agent-aliases.json')
AGENT_WS_PATH        z.string().startswith('/').default('/agent')   # agent-facing WS path
TLS_CERT_FILE        preprocess-blank→undefined, z.string().min(1).optional()
TLS_KEY_FILE         preprocess-blank→undefined, z.string().min(1).optional()
```

The existing `booleanish`, `numeric`, and the `z.preprocess(blank→undefined)` idiom (already used for `ALLOWED_SCRIPT_ROOT`) are reused for blank-tolerance so an empty optional string behaves as unset — honoring the note that `env.ts` treats blank optional strings carefully. `AGENT_TOKENS` is a raw comma-separated string in env; it is parsed into `string[]` inside the derived auth config (not in the schema transform, to keep the schema a thin validator — consistent with how `MAIL_TO` stays a raw string and is split by the email channel).

**`ALLOWED_SCRIPT_ROOT` is reused in agent mode, not re-declared (finding #4).** `ALLOWED_SCRIPT_ROOT` already exists in `configSchema` and is optional in all modes (verified `src/config/env.ts`), so no new agent variable is needed. Agent mode threads `config.ALLOWED_SCRIPT_ROOT` into `buildSchemas({ allowedScriptRoot: config.ALLOWED_SCRIPT_ROOT })` exactly as standalone's `index.ts` does, so the agent's `RequestSchemas` confine remote `start-new` to the configured directory **on the agent host** (where PM2 actually launches the script). See §3 "Inbound command execution" for the wiring.

### Cross-field `superRefine` guards (added as `ctx.addIssue` blocks inside the existing single `superRefine` callback, after the auth/email guards)

As pinned above, these are **not** a new chained `.superRefine` — they are appended to the body of the one existing `superRefine((cfg, ctx) => { … })` in `src/config/env.ts`, after the current auth and email `ctx.addIssue` blocks, so evaluation order and the inferred `AppConfig` type are unchanged.

- `MODE==='agent'` requires `SERVER_URL`; else add issue on `SERVER_URL` (AC-5).
- `MODE==='agent'` requires `AGENT_TOKEN`; else add issue on `AGENT_TOKEN`.
- `SERVER_URL`, when present, must start with `ws://` or `wss://`; else issue. (A `ws://` URL is permitted but is paired with a startup warning in agent boot, since NFR-3 wants TLS by default.)
- `MODE==='server'` requires at least one of `AGENT_TOKENS`/`AGENT_TOKEN`; else issue on `AGENT_TOKENS` (AC-5).
- `MODE==='server'`: if exactly one of `TLS_CERT_FILE`/`TLS_KEY_FILE` is set, add issues on both (native TLS needs the pair; neither set = reverse-proxy termination, which is valid — AC-56).
- `MODE==='server'` and `AGENT_WS_PATH==='/ws'` → add an issue on `AGENT_WS_PATH` ("AGENT_WS_PATH must not collide with the human /ws path"), failing fast at boot (second-pass finding #7). Coexistence of the human `/ws` (`WsHub`) and the agent `AGENT_WS_PATH` (`AgentGateway`) relies on each upgrade handler inspecting `pathname` and handling only its own; if both claim `/ws`, both upgrade handlers fire on the same event with undefined ordering and a likely double-handle/double-destroy. The `startsWith('/')` check alone does not catch this, so the equal-path case is rejected explicitly, consistent with the other cross-field guards.
- `standalone`: no new var is required and none of the above fire (AC-1/2, NFR-1). Existing vars keep their current refinements unchanged.

**Backward compatibility:** every existing variable keeps its name, default, and refinement. A current `.env` with no `MODE` parses to `MODE='standalone'` and is byte-for-byte equivalent in behavior. The existing `env.test.ts` cases stay green because `standalone` adds no required fields. **Assumption (Open Q1):** these exact variable names; the review may rename, but the shape (one `MODE` + mode-scoped vars + cross-field guards) is fixed.

### Derived config helpers (in the boot layer, mirroring `buildAuthConfig`/`buildSmtpConfig`)

```ts
// src/boot/server.ts
function buildAgentAuthConfig(cfg: AppConfig): { tokens: string[] }
  // split AGENT_TOKENS on ',', trim, drop empties; append AGENT_TOKEN if set; dedupe.
  // Guaranteed non-empty by the superRefine above.

// src/boot/agent.ts
function buildAgentDialConfig(cfg: AppConfig): {
  url: string; token: string; nameHint?: string; idFile: string; insecure: boolean;
}
```

---

## 2. Shared protocol module (`src/protocol/`)

A single-sourced wire contract imported by **both** agent and server. Chosen location `src/protocol/` (not `src/cluster/`) because the module is purely the message contract + codec; runtime lives under `src/agent/` and `src/server/`.

Files:

- `src/protocol/version.ts` — `export const PROTOCOL_VERSION = 1;`
- `src/protocol/messages.ts` — zod schemas + inferred TS types for every frame (the discriminated union).
- `src/protocol/codec.ts` — `encode(msg) → string` and `decode(raw) → Result` with validation.
- `src/protocol/correlation.ts` — correlation-id generation + a `PendingRequests` map helper (shared by both ends for request/response).

### Message envelope and union

Every frame is a JSON object with a string `type` discriminator (AC-41). The union is defined with `z.discriminatedUnion('type', [...])`. Wire payloads **reuse the existing internal shapes** by validating against zod mirrors of `ProcessSnapshot`, `MetricSample`, `LogLine`, `TrackedError`, and the transition shape (AC-46). These mirror schemas live in `src/protocol/shapes.ts` and are asserted to match `src/core/types.ts` by a compile-time `satisfies`/type-equality test (see Testing). They are *schemas*, not new types — the inferred type is assignable to the existing interface.

Direction legend: **A→S** agent→server, **S→A** server→agent.

| `type` | dir | key fields |
|---|---|---|
| `register` | A→S | `protocolVersion:number`, `agentId: agentIdSchema` (safe charset, 1–100), `token: z.string().min(1)`, `meta:{ hostname, platform, pm2Version?, monitorVersion, nameHint? }` |
| `register:ack` | S→A | `ok:true`, `serverTime:number`, `heartbeatSec:number` |
| `register:nack` | S→A | `ok:false`, `code:'AUTH_FAILED'|'VERSION_MISMATCH'`, `message:string` |
| `heartbeat` | A→S | `ts:number` |
| `heartbeat:ack` | S→A | `ts:number` |
| `snapshot` | A→S | `processes:ProcessSnapshot[]`, `pm2Connected:boolean`, `generatedAt:number` |
| `update:transition` | A→S | `name, from, to, at` (transition shape) |
| `update:metrics` | A→S | `samples: Array<{ name:string } & MetricSample>` (one tick, online procs) |
| `update:error` | A→S | `error: TrackedError` |
| `update:pm2` | A→S | `connected:boolean` |
| `control:request` | S→A | `cid:string`, `action:'start'|'stop'|'restart'|'reload'|'delete'`, `name:string` |
| `control:createRequest` | S→A | `cid:string`, `opts: StartNewOpts` |
| `control:response` | A→S | `cid:string`, `result: ControlResult` |
| `log:subscribe` | S→A | `process:string`, `streams:('out'|'err')[]` |
| `log:unsubscribe` | S→A | `process:string` |
| `log:line` | A→S | `process:string` + `LogLine` fields (`stream, level, line, ts`) |
| `error:frame` | both | `code:'BAD_MESSAGE'`, `message:string` (mirrors `src/ws/hub.ts` BAD_MESSAGE pattern) |

Notes:
- **`register` field minimums (second-pass finding #6).** `register.agentId` is validated with `agentIdSchema` (the same safe charset as `processNameSchema`, 1–100 chars) and `register.token` is `z.string().min(1)` **in the protocol schema itself**, so a blank, whitespace-only, or charset-malformed handshake is rejected at `decode` with `BAD_MESSAGE` **before auth even runs** and before any registry `Map` is keyed. This makes the (correct) `safeEqual('', nonEmptyConfiguredToken) === false` property a defense-in-depth second line rather than the sole guard against an empty token, and prevents a malformed `agentId` from keying the registry. The gateway test asserts a blank/garbage `agentId` and an empty `token` are rejected at decode (§9).
- `register` carries `protocolVersion` (AC-47). The server compares to its own `PROTOCOL_VERSION`: **v1 policy = reject on mismatch with `register:nack` code `VERSION_MISMATCH`** (Open Q8 resolved to strict rejection; cross-version compatibility is explicitly out of scope and a mismatched peer cannot be trusted to parse frames). This is logged at `warn` on the server.
- Resync strategy (AC-13/16, Open Q3 confirmed): the agent sends a fresh `snapshot` on every (re)connect **before** any `update:*`. No delta replay. The server replaces that agent's process map wholesale on each `snapshot`.
- Metrics are batched per tick into one `update:metrics` frame (not per-process) to bound frame count.

### Codec

```ts
export type DecodeResult =
  | { ok: true; msg: ProtocolMessage }
  | { ok: false; code: 'BAD_MESSAGE'; message: string };

export function encode(msg: ProtocolMessage): string;      // JSON.stringify of a typed msg
export function decode(raw: string): DecodeResult;          // JSON.parse guarded + schema.safeParse
```

`decode` never throws (AC-42): a JSON parse failure or a `safeParse` failure returns `{ ok:false, code:'BAD_MESSAGE', message }`. The caller (agent or server) responds with an `error:frame` and, on the server side, does **not** register/act. This mirrors the existing `handleMessage` in `src/ws/hub.ts` exactly.

### Correlation

`src/protocol/correlation.ts`:

```ts
export function newCid(now: () => number, rand: () => number): string; // e.g. `${now}-${base36 rand}`
export class PendingRequests<T> {
  constructor(opts: { timeoutMs: number; setTimer; clearTimer; now });
  create(cid: string): Promise<T>;          // registers a waiter + arms timeout
  settle(cid: string, value: T): boolean;    // resolves if pending+unsettled; false otherwise
  rejectAll(reason: T): void;                 // on disconnect, settle every pending with a failure value
}
```

Rules (AC-43/44/45): a response with an unknown/duplicate/already-settled `cid` is ignored (`settle` returns false and resolves nothing). A request with no matching response within `timeoutMs` resolves the waiter with a defined timeout value (`{ ok:false, code:'AGENT_TIMEOUT', message }` as a `ControlResult`). **Timeout default = 15s, configurable later but hard-coded in v1** (Open Q9: 15s chosen as a middle of the 10–30s band; not exposed as env in v1 to keep the config surface tight — noted as a revisitable decision). `T` is instantiated as `ControlResult` for control routing.

---

## 3. Agent runtime (`src/agent/`)

The agent reuses the full standalone core: `MonitorEvents`, `MonitorState`, `MetricsStore`, `ErrorTracker`, and `Pm2Client` are constructed exactly as in standalone (so local monitoring/control is identical) — including the **deferred, background PM2 wiring** detailed below. The only additions are an outbound WS client and an event→wire bridge. The agent runs **no** HTTP server and opens **no** listening port (AC-7).

### Boot ordering: dial first, wire PM2 in the background (FR-2, AC-14 — pinned)

Verified `src/pm2/client.ts#createPm2Adapter`: it calls `neutralizeInheritedIpc(logger)` and gates `connect` on a `pingDaemon` so it **never launches** a daemon — it attaches only to an *already-running local* PM2. Verified `src/index.ts`: standalone builds the real adapter in a **background task after `server.listen`**, with `deps.pm2` pointing at a stable facade (`Pm2Deps`) that short-circuits every control call to `PM2_UNAVAILABLE` and every log read to `[]` until the real `Pm2Client` is assigned. That ordering is what keeps standalone boot from hanging on an absent/slow daemon.

The agent has **no** `server.listen` to anchor that deferral on, so `bootstrapAgent()` reproduces the pattern against the WS dial instead:

- **The `AgentConnection` dial loop is started first (or concurrently), never after a PM2 connect.** `bootstrapAgent()` constructs the core hub + the `pm2` facade (same shape as `index.ts`: a mutable `pm2Client` reference behind a `Pm2Deps`-style object returning `PM2_UNAVAILABLE`/`[]` until wired) + the `AgentRuntime`, then starts the outbound dial immediately. The real `createPm2Adapter(logger)` / `new Pm2Client(...)` / `Pm2Client.start()` are built in a **background task** exactly as `index.ts` does today (`void (async () => { … })()`), with the same `try/catch` that logs "pm2 wiring failed; continuing" and does not crash.
- **The server dial is therefore never blocked by a hung or absent local PM2 daemon.** A slow or missing local daemon only delays the background PM2 task; the agent registers, heartbeats, and reconnects regardless of local PM2 state. This is what makes **AC-14 (the agent keeps the server connection even when local PM2 is down)** hold: the connection lifecycle is fully independent of PM2 attachment.
- **A `control:request` arriving before PM2 attaches is answered, not hung.** Because inbound control/create frames are dispatched through the same `pm2` facade (`AgentRuntime` holds the facade, not a raw `Pm2Client`), a command that lands while PM2 is still unwired runs the facade's short-circuit and returns a correlated `control:response { cid, result: { ok:false, code:'PM2_UNAVAILABLE', message } }` — the identical contract `Pm2Client` uses while disconnected. Once the background task assigns the real client, the facade delegates to it and control works normally. The agent also emits `update:pm2 { connected:false }` until `pm2:connected` fires, so the operator sees the agent online with local PM2 down (AC-14).

The agent's local PM2 lifecycle (connect/backoff/`pm2:connected`/`pm2:disconnected`) is thus the **same** `Pm2Client` behavior as standalone, merely wired off the dial path instead of off a `listen` callback.

Files:

- `src/agent/identity.ts` — stable agent-ID generation + disk persistence.
- `src/agent/connection.ts` — the outbound `ws` client with reconnect/backoff/jitter and heartbeat.
- `src/agent/runtime.ts` — `AgentRuntime` orchestrator: wires `MonitorEvents` → wire frames, dispatches inbound control/log frames to `Pm2Client`, and owns a `LogForwarder`.
- `src/agent/logForwarder.ts` — per-process log subscription bridge to `MonitorEvents` `log:line`.

### Identity (FR-4, AC-8/9)

```ts
// src/agent/identity.ts
export function resolveAgentId(opts: {
  idFile: string; hostname: string; logger: Logger;
  readFile?; writeFile?; randomSuffix?;
}): string;
```

Algorithm: read `AGENT_ID_FILE`. If it holds a non-empty suffix, `id = `${sanitize(hostname)}-${suffix}``. If missing/unreadable/empty, generate a new suffix (`crypto.randomBytes(4).toString('hex')`), write it to the file (best-effort; `mkdir -p` the dir first), log `info` "generated agent id suffix" (AC-9), and use it. The hostname is sanitized to the `processNameSchema`-safe charset so the ID is wire- and log-safe. The ID is stable per machine across restarts (AC-8) because only the random suffix is persisted and the hostname is stable. The suffix file is the agent's only persisted datum (NFR-6). `readFile`/`writeFile`/`randomSuffix` are injectable for tests.

**Edge case:** if the file dir is unwritable, the agent still derives and uses an in-memory ID for this run and logs a `warn` (it will regenerate next boot — degraded but non-fatal). This is an explicit tolerance, not a crash.

### Connection + reconnect (FR-2, AC-10/11/12/13)

`AgentConnection` wraps a `ws` `WebSocket`:

- Dials `SERVER_URL` with `new WebSocket(url, { rejectUnauthorized: !insecure })`. When `TLS_INSECURE` is on, `rejectUnauthorized:false` is passed **and** a clearly-marked `warn` "INSECURE: TLS certificate verification disabled" is logged at startup and on each (re)connect (AC-55). When off (default), the server cert is verified (AC-54).
- On `open`: send `register`. **The backoff attempt counter is NOT reset on socket `open`.** On `register:ack`: mark connected, send initial `snapshot`, start the heartbeat timer (`heartbeatSec` from the ack), and **only now reset `backoffAttempt` to 0** (resolves review finding #10). On `register:nack`: log `warn` with the code, then call `onLinkDead()` (the single idempotent teardown — see below), which closes and **still** schedules one reconnect at the current (un-reset) backoff delay (an auth/version problem may be fixed server-side; the agent never crashes — NFR-2).
- **Hot-loop protection (finding #10):** because `backoffAttempt` resets only on a successful `register:ack` and **not** on socket `open`, an agent whose token is wrong gets its socket opened, sends `register`, receives `register:nack AUTH_FAILED`, closes, and reconnects at the *next* backoff step — climbing to and holding at the 30s cap rather than hot-looping every ~1s. This is the one place the agent's reset point intentionally **differs from `Pm2Client`**, which resets on connect success; the shared `backoffDelay` helper is reused but the reset trigger is the application-level `register:ack`, documented inline. (Contrast: `Pm2Client`'s "connect success" is itself the application-level readiness event, so the two are semantically aligned — reset on *useful* connection, not on raw socket open.)
- **Unbounded retries (finding #10, AC-11/NFR-2):** there is **no** cap on total attempts and the agent **never gives up**. So when an operator adds this agent's token to the server's `AGENT_TOKENS` later (AC-50 rotation), the agent's next capped (≤30s) retry succeeds and it registers — no restart required.
- Reconnect/backoff **reuses the exact algorithm and constants from `src/pm2/client.ts`**: base 1s, cap 30s, `±20%` jitter, `backoffDelay(attempt)` as a shared helper. (Open Q4 confirmed; verified `src/pm2/client.ts`: `BACKOFF_BASE_MS=1000`, `BACKOFF_CAP_MS=30_000`, `±20%` jitter via `Math.random()`.) To avoid duplication, `backoffDelay` is extracted to `src/core/backoff.ts` and imported by both `Pm2Client` and `AgentConnection`. **The extracted signature injects the RNG so jitter bounds are deterministically testable (second-pass finding #5):** `backoffDelay(attempt: number, rand: () => number = Math.random): number`. `Pm2Client` and `AgentConnection` call it with the default `rand`, so their runtime behavior is unchanged (the "pure refactor" claim holds), while the unit test injects `rand` returning `0` / `1` / `0.5` to assert the delay lands exactly at `base*0.8` / `base*1.2` / `base`, plus the 30s cap and non-negativity. (The current `src/pm2/client.ts#backoffDelay` calls the global `Math.random()` directly and offers no seam; the extraction adds the parameter precisely to make the jitter-bounds test deterministic rather than statistical.)
- **Heartbeat and single-path liveness (resolves review finding #12).** `heartbeatSec` has a concrete default of **15s** (server-chosen, sent to the agent in `register:ack`). Two independent liveness mechanisms exist: (a) the app-level `heartbeat`/`heartbeat:ack` round-trip, and (b) the transport-level `ws` ping/pong backstop. **Both route through a single idempotent `onLinkDead()` method** so a double trigger closes the socket exactly once: `onLinkDead()` checks an `alreadyDead` guard, returns immediately if set, otherwise sets it, closes the socket, and schedules the reconnect. The dead-link threshold is `2×heartbeatSec` (30s at the default): if neither a `heartbeat:ack` nor a transport pong is observed within that window, whichever timer fires first calls `onLinkDead()`; the second is a no-op. On socket close/reconnect the `alreadyDead` guard is reset for the next connection. This removes any double-close ambiguity between the two mechanisms.
- **All teardown paths funnel through `onLinkDead()` (finding #6).** Beyond the two liveness timers, the agent has additional close triggers: a `register:nack` close, and the server's 5s handshake-timeout close (observed on the agent as a transport close). **Every** socket-teardown path — `register:nack`, handshake-timeout/transport close, and the heartbeat/pong dead-link — calls the single idempotent `onLinkDead()`, which closes the socket once and schedules **exactly one** reconnect. `register:nack` additionally logs the nack `code` (`AUTH_FAILED`/`VERSION_MISMATCH`) at `warn` **before** calling `onLinkDead()`. Because the `alreadyDead` guard covers every trigger (not only the two liveness timers), a single event that trips both an application-level close and a transport close — e.g. a `register:nack` whose socket also fires `close` — still schedules only one reconnect. (The reconnect scheduled by `onLinkDead` uses the current, un-reset backoff delay, so the `register:nack` hot-loop protection of the previous bullet is preserved.)
- All timers are injectable (`setTimer`/`clearTimer`/`now`) following the `Pm2Client`/`WsHub` test pattern.
- The agent keeps monitoring/controlling local PM2 while disconnected (AC-13): the `Pm2Client` loop is independent of the connection; frames emitted while disconnected are simply dropped (not buffered), and the next reconnect sends a fresh snapshot.

### Event → wire bridge (`AgentRuntime`, FR-2, AC-14/15)

`AgentRuntime` subscribes to `MonitorEvents` and forwards (only while connected):

| MonitorEvent | wire frame |
|---|---|
| `state:update` | `snapshot` on (re)connect **and** a throttled resend whenever the process **set** changes (add/delete) — see note |
| `process:transition` | `update:transition` |
| `metrics:tick` | `update:metrics` (see pinned derivation below) |
| `error:captured` | `update:error` |
| `pm2:connected` / `pm2:disconnected` | `update:pm2 { connected }` (reuses existing semantics, AC-14) |

The bridge mirrors how `WsHub` listens to the same events, so the data shapes are identical to what the standalone dashboard already consumes — the server simply relays them to human clients unchanged.

**`update:metrics` derivation and `ts` source (second-pass finding #2, pinned).** `metrics:tick` carries `ProcessSnapshot[]` (verified `src/core/events.ts`), not `MetricSample[]`. The agent maps **each online** `ProcessSnapshot` in the tick list to exactly `{ name: snap.name, ts: snap.lastUpdated, cpu: snap.cpu, mem: snap.memory }` — identical to what `MonitorState.onMetricsTick` does when it builds a `MetricSample` (verified `src/core/state.ts`). The critical pin: **`ts` is `snap.lastUpdated`** (the agent's own sample wall-clock time), carried **verbatim** on the wire. The server pushes it **unchanged** into the per-agent `MetricsStore` and **never re-stamps it with send-time or receive-time**, so `MetricsStore.sustainedAbove(name, metric, threshold, durationSec)` — a time-window primitive — is computed in the agent's time base and matches standalone semantics exactly. Agent↔server clock skew is **accepted for v1** (state is in-memory and loss-tolerant per NFR-6); it is not corrected or normalized. Offline processes are omitted from the batch (online-only, as in standalone).

**Snapshot resend on process-set change (ties into the server prune, finding #1).** `update:transition` carries a status change for an existing process; it does **not** by itself tell the server a process was **added or deleted**. So the authoritative process set must be re-asserted whenever it changes, not only on reconnect. The agent therefore resends a `snapshot` on `state:update` **whenever the set of process names differs from the last sent snapshot** (a `start-new` or `delete` changes the name set), throttled to ≤1/sec and coalesced exactly like `WsHub`'s state throttling so a burst of churn sends at most one snapshot per second. Pure status/metric changes (no name-set delta) do **not** trigger a resend — they flow as `update:transition`/`update:metrics` deltas. This keeps the server's per-agent `processes` map and `MetricsStore` prune (§4) correct in steady state: a deleted process disappears from the next snapshot within ≤1s and its metric series is dropped by the snapshot prune, without waiting for a reconnect.

### Inbound command execution (FR-2, AC-17/18/19)

On `control:request` / `control:createRequest`, the agent **re-validates on the wire before touching PM2** (AC-17, defense in depth, NFR-3). The frame is already schema-validated by `decode`; the agent then re-runs the **same** `src/api/schemas.ts` validators the REST layer uses. The agent builds its own `RequestSchemas` at boot via `buildSchemas({ allowedScriptRoot: config.ALLOWED_SCRIPT_ROOT })` — the identical call `index.ts` makes in standalone, reusing the existing all-mode `ALLOWED_SCRIPT_ROOT` variable (finding #4). Script/ecosystem paths are therefore validated against the **agent's** filesystem and policy, so an operator can confine remote `start-new` to a directory **per agent host** exactly as standalone does — correct, since the agent is where PM2 runs.

**`control:request` (name-only actions `start`/`stop`/`restart`/`reload`/`delete`):** `processNameSchema.safeParse(name)`. On failure → `VALIDATION`; on success → `Pm2Client.control(action, name)`.

**`control:createRequest` (start-new) — the `{ body }` wrapper is mandatory (resolves review finding #6):** verified in `src/api/schemas.ts`, `createProcess` is `z.object({ body: z.object({...}).strict().superRefine(...).transform(...) })`. It validates a **`{ body: {...} }` envelope** (not a bare opts object), is `.strict()` (unknown keys rejected), its `superRefine` enforces the XOR of `script`/`ecosystem` and rejects `fork`+`instances>1`, and its `transform` **injects `exec_mode:'cluster'` when `instances>1` and no `exec_mode` was given**. The wire `control:createRequest.opts` carries a `StartNewOpts` (`{ script?, ecosystem?, name?, instances?, exec_mode? }`), which is key-compatible with the `createProcess` body but does **not** carry the transform. Therefore:

- The agent validates with `createProcess.safeParse({ body: opts })` — wrapping the wire `opts` as `{ body: opts }`.
- On failure → `control:response { cid, result: { ok:false, code:'VALIDATION', message } }`, PM2 **never** called (AC-18).
- On success → the agent passes `parsed.data.body` (the **post-transform** object, i.e. with `exec_mode:'cluster'` already injected) to `Pm2Client.startNew`, reconstructing the `StartNewOpts` from the transformed body exactly as `src/api/routes/processes.ts` does today (spread only the defined fields). The agent must consume the transformed body, not the raw frame, so cluster default-injection is applied identically to standalone.
- **Path existence:** `scriptPathSchema`/`ecosystemPathSchema` call `existsSync` on the **agent's** disk; a `start-new` whose `script`/`ecosystem` does not exist on the agent is rejected wire-side with a correlated `VALIDATION` error (AC-18).

**Server-side symmetry (both-ends validation, AC-52):** the server performs the **same** `createProcess.safeParse({ body: opts })` wrapping before routing, so both ends agree on the transformed shape and a request the agent would reject never leaves the server. The server validates against its own `RequestSchemas`, but because path existence can only be truly checked on the agent, the server's check is the structural/XOR/transform gate and the agent's is the authoritative filesystem gate (defense in depth; the agent is the final arbiter).

**On every success path:** `control:response { cid, result }` carries the real `ControlResult` (AC-19). The `{ ok:true, process }` / `{ ok:false, code, message }` shape is wire-identical to the REST contract, so the server relays it to the operator unchanged.

### Log forwarding (FR-2, AC-20/21)

`LogForwarder` holds the set of `(process, streams)` the server has subscribed to. The agent is *already* receiving every `log:line` from `MonitorEvents` (emitted by `Pm2Client`'s bus handler). On `log:subscribe`, the forwarder adds the process+streams to its filter; matching `log:line` events are sent as `log:line` frames (AC-20). On `log:unsubscribe` (or disconnect), it drops the filter and stops forwarding (AC-21). This mirrors `WsHub.fanOutLog` filtering exactly — it does not re-tail files; it filters the live event stream the standalone hub already uses.

---

## 4. Server runtime (`src/server/`)

The server reuses the human-facing `createServer` (Express) and `WsHub` **unchanged** for operators, and adds an agent-facing gateway with its own path, auth space, registry, alias store, command router, and log relay. Naming is deliberately separated from `src/api`/`src/ws` (human-facing) — the agent-facing code lives under `src/server/`.

Files:

- `src/server/agentAuth.ts` — agent-token validation via `safeEqual`.
- `src/server/gateway.ts` — `AgentGateway`: the inbound agent `WebSocketServer` (noServer mode) sharing the HTTP server, on path `AGENT_WS_PATH` (default `/agent`).
- `src/server/registry.ts` — `FleetRegistry`: per-agent in-memory state + connection status + command routing + log relay fan-out.
- `src/server/aliasStore.ts` — disk-JSON alias persistence.
- `src/server/fleetEvents.ts` — adapts fleet frames into a `MonitorEvents`-compatible stream for the `AlertEngine`.

### Agent-facing WS endpoint (FR-3, AC-7/22/23, Open Q2)

The agent WS shares the **same HTTP server and port** as the human API, distinguished by pathname: human `/ws` (existing `WsHub`) vs agent `/agent` (new `AgentGateway`). Both attach as `ws` `WebSocketServer({ noServer:true })` and both listen on the shared `server.on('upgrade')`. The existing `WsHub.handleUpgrade` already *returns without destroying* when the path is not `/ws` (its comment explicitly reserves this for "a future second WS path"), so the gateway's upgrade handler coexists cleanly: each inspects `pathname` and handles only its own. (Open Q2 resolved to **same port, distinct path** — simplest for operators and reverse proxies; a separate port is unnecessary.) The equal-path pathology (`AGENT_WS_PATH=/ws`) that would make both handlers claim `/ws` is **rejected at config validation** by the superRefine guard in §1 (finding #7), so this coexistence contract cannot be violated at runtime.

Agent upgrade auth differs from human auth: the agent token is read from the `register` frame **after** the socket opens (not from the upgrade headers), because the token is part of the protocol handshake and keeps the agent client simple. The gateway therefore accepts the `/agent` upgrade unconditionally (no secrets in the URL), then requires a valid `register` within a bounded handshake window. On `register`:

- Validate `protocolVersion` → `register:nack VERSION_MISMATCH` on mismatch.
- Validate the token against the configured token set using `safeEqual` (`src/server/agentAuth.ts`): `tokens.some(t => safeEqual(provided, t))` (AC-50 rotation: any valid token matches). A missing/malformed/invalid token → `register:nack AUTH_FAILED`, then close; the agent is **not** registered (AC-23). `safeEqual` is the existing throw-safe comparator and never throws on length mismatch/empty (AC-49).
- On success → register in `FleetRegistry` keyed by `agentId`, send `register:ack`, mark online (AC-22/24).

The gateway upgrade/handshake path **never logs the token or the agent URL**; it logs `{ path:'/agent', agentId, authed }` only, mirroring the `WsHub` rule.

#### Pre-auth hardening (resolves review finding #9, NFR-3 default-secure)

Accepting the `/agent` upgrade before auth means an un-registered socket exists during the handshake window; this is the server's only pre-auth surface and is bounded explicitly:

- **Only `register` is accepted before auth.** While a socket is in the un-registered state, the gateway accepts exactly one frame type: `register`. Any other frame type (or a `decode` `BAD_MESSAGE`) → send `error:frame { code:'BAD_MESSAGE' }` and **immediately close** the socket. No state is created, no `FleetRegistry` entry is touched. This prevents an unauthenticated peer from exercising snapshot/log/control handling.
- **Hard handshake timeout = 5s, no extension.** On upgrade the gateway arms a 5s timer. If no valid `register:ack`-worthy `register` is received before it fires, the gateway **closes the socket** (not merely marks it) and clears any per-socket state. The timer is non-extendable: receiving a malformed frame does not reset it. On a successful `register` the timer is cleared.
- **Concurrent un-registered socket cap.** The gateway maintains a counter of currently un-registered `/agent` sockets with a hard cap (**default 50**, named constant `MAX_PENDING_AGENT_SOCKETS`). When the cap is reached, a new `/agent` upgrade is **refused at the HTTP upgrade** (the gateway writes `HTTP/1.1 503` and destroys the socket before constructing a WebSocket, mirroring the `WsHub` 401-and-destroy pattern) rather than queued. Registered agents are not counted against the cap, so the cap never blocks legitimate connected agents and only throttles a flood of half-open handshakes. The cap is a defense-in-depth backstop; operators running behind a reverse proxy are additionally expected to rate-limit `/agent` upgrades at the proxy (documented in README), but the server does not rely on the proxy for correctness.
- **No pre-auth timers beyond the single 5s handshake timer.** Heartbeat/ping-pong timers start only after `register:ack`, so an un-registered socket holds at most one timer plus the socket itself — bounding per-socket resource use.

### FleetRegistry (FR-3, AC-24/25/29)

Keyed by stable `agentId`. Per agent it holds a bounded live view:

```ts
interface AgentEntry {
  id: string;
  meta: AgentMeta;                 // hostname, platform, versions, nameHint
  online: boolean;
  lastSeen: number;
  socket: WebSocket | null;
  processes: Map<string, ProcessSnapshot>;   // from snapshot + transitions
  metrics: MetricsStore;                      // one bounded store per agent
  errors: ErrorTracker;                        // one bounded tracker per agent
  pm2Connected: boolean;
  pending: PendingRequests<ControlResult>;    // control correlation for this agent
  logSubscribers: Map<string, Set<HumanLogClient>>; // process -> human WS clients
}
```

Per-agent `MetricsStore`/`ErrorTracker` reuse the existing classes with the existing `METRICS_RETENTION_MIN`/`METRICS_SAMPLE_SEC`/`ERROR_BUFFER_SIZE` semantics applied **per agent** (NFR-4, Open Q10 confirmed: per-agent bounds using existing semantics; a global cap across agents is explicitly deferred). Each agent's state is fully isolated — a map keyed by id, with per-entry structures — so one agent's data, errors, or disconnect never affects another (AC-29).

Frame handling updates the entry:
- `snapshot` → replace `processes` map wholesale, set `pm2Connected`, mark online, **then prune departed metric series** (see below).
- `update:transition` → update the process status, re-emit on the fleet event stream (for alerts + human WS).
- `update:metrics` → push each sample into the agent's `MetricsStore` (**push only; no pruning here** — pruning happens on `snapshot`, below).
- `update:error` → feed the agent's `ErrorTracker` and re-emit for alerts.
- `update:pm2` → set `pm2Connected`.
- `control:response` → `entry.pending.settle(cid, result)` (ignores unknown/duplicate — AC-44).
- `log:line` → fan out to that process's subscribed human clients (relay).

**Departed-process metric prune on `snapshot` (second-pass finding #1, NFR-4).** Standalone's `MonitorState.onMetricsTick` does two things each tick: push a sample for every online process **and** prune series for names no longer present (`for (const name of this.metrics.names()) if (!liveNames.has(name)) this.metrics.drop(name)` — verified `src/core/state.ts`). On the server, `update:metrics` only pushes, so the prune step must be ported to the **`snapshot` handler**, which is the authoritative "current process set" per AC-16. After replacing the `processes` map wholesale, the registry drops every metric series whose name is not in the new snapshot:

```ts
// FleetRegistry, on `snapshot`:
entry.processes = new Map(snapshot.processes.map((p) => [p.name, p]));
entry.pm2Connected = snapshot.pm2Connected;
entry.online = true;
const snapshotNames = new Set(snapshot.processes.map((p) => p.name));
for (const name of entry.metrics.names()) {
  if (!snapshotNames.has(name)) entry.metrics.drop(name);
}
```

This guarantees a process deleted on an agent does not leave a ghost series lingering in the per-agent `MetricsStore` until retention expiry — so `AlertStateHub.processNames()` / `sustainedAbove` never evaluate a rule against a dead series, and per-agent memory stays bounded by the live process set (NFR-4). `update:metrics` deliberately does **not** prune (it does not carry the full process set); pruning is a `snapshot`-only operation. A fresh `snapshot` arrives on every (re)connect (AC-13/16) **and** on any steady-state process-set change (the agent's throttled resend-on-set-change, §3), so a deleted process's series is dropped within ≤1s of the delete rather than only on the next reconnect — consistent with the resync-by-snapshot strategy of §2.

On disconnect (socket close/error): set `online=false`, `socket=null`, `entry.pending.rejectAll({ ok:false, code:'AGENT_OFFLINE', message })` so no routed command hangs, clear `logSubscribers` for that agent, and emit a single `agent:offline` event. The entry (and its alias) is **retained** so the operator still sees the agent as offline (AC-24) and in-flight routed commands fail fast rather than block (AC-27). The server keeps serving all other agents (NFR-2).

### Command routing (FR-3, AC-26/27)

`FleetRegistry.routeControl(agentId, action, name): Promise<ControlResult>`:
1. Look up the entry. Unknown → resolve `{ ok:false, code:'AGENT_NOT_FOUND' }`. Offline → `{ ok:false, code:'AGENT_OFFLINE' }` (AC-27). Neither blocks.
2. `cid = newCid(...)`. Register `const p = entry.pending.create(cid)`.
3. Send `control:request { cid, action, name }` (or `control:createRequest`).
4. `return p` — resolves on the correlated `control:response` or on the 15s timeout (`AGENT_TIMEOUT`, AC-45) or on disconnect (`AGENT_OFFLINE`).

**HTTP status mapping (resolves review finding #5).** Verified `src/api/routes/processes.ts`: the existing `sendControlResult` is a **binary branch** — `const status = result.code === 'PM2_UNAVAILABLE' ? 409 : 502` — so it has **no** path that turns a `ControlResult` with `code:'VALIDATION'` into 400 (it would become 502), and the fleet codes (`AGENT_OFFLINE`/`AGENT_NOT_FOUND`/`AGENT_TIMEOUT`) do not exist in it. Routed-command failures arrive as `ControlResult` **not-ok values** (resolved from `routeControl`), not as thrown `apiError`s, so the agents routes must map codes themselves.

The design therefore adds a shared, explicit mapper rather than overloading the binary standalone function:

```ts
// src/api/routes/controlStatus.ts
export function statusForControlCode(code: string): number {
  switch (code) {
    case 'PM2_UNAVAILABLE':
    case 'AGENT_OFFLINE':
    case 'AGENT_TIMEOUT':  return 409;
    case 'AGENT_NOT_FOUND': return 404;
    case 'VALIDATION':      return 400;
    case 'PM2_ERROR':
    default:                return 502;
  }
}
```

- The **agents routes** (`src/api/routes/agents.ts`) write success and failure as follows (finding #5): on a **not-ok** `ControlResult` (any route, including create), use `statusForControlCode(result.code)` with the existing `{ error: { code, message } }` envelope — a failed create is **not** special-cased and never returns 201. On an **ok** result: the non-create control endpoints return **200**; the create route (`POST /api/agents/:id/processes`) returns **201 only when `result.ok === true`**, matching standalone's `sendControlResult(res, result, 201)`. In other words, 201 is gated strictly on create-success; every create failure (`VALIDATION`→400, `AGENT_OFFLINE`/`AGENT_TIMEOUT`→409, `AGENT_NOT_FOUND`→404, `PM2_ERROR`→502) flows through `statusForControlCode` identically to the other control endpoints.
- The **standalone `sendControlResult` in `src/api/routes/processes.ts` is left exactly as-is** (binary `PM2_UNAVAILABLE?409:502`) so the standalone route tests stay green and standalone behavior is unchanged (NFR-1). Standalone never produces `VALIDATION`/`AGENT_*` `ControlResult` codes, so the richer table is only needed on the fleet path.
- `AGENT_OFFLINE`/`AGENT_NOT_FOUND`/`AGENT_TIMEOUT` are returned by `routeControl` (see below) as `ControlResult` not-ok values; `VALIDATION` is produced by the agent's wire re-validation (§3). All flow through the same `statusForControlCode` on the agents route.

### AliasStore (FR-5, AC-34–40)

`src/server/aliasStore.ts`, backed by a single JSON file `ALIAS_STORE_FILE` (`{ [agentId]: alias }`). No database (NFR-6).

```ts
class AliasStore {
  constructor(opts: { file: string; logger; readFile?; writeFile?; rename? });
  load(): void;                              // called once at boot (sync)
  get(agentId: string): string | undefined; // reads the in-memory map
  set(agentId: string, alias: string): Promise<void>; // validates, updates map sync, persists async
  all(): Record<string,string>;             // snapshot of the in-memory map
}
```

- **Load (AC-36/39):** read the file; parse JSON; validate with a zod schema `z.record(z.string(), aliasSchema)`. Missing file → start with `{}` and continue (AC-39 first clause). Corrupt/invalid JSON or schema failure → log a `warn` and continue with `{}` (AC-39 second clause, Open Q6 confirmed: warn + continue rather than crash — losing a cosmetic map must never stop the fleet server; the operator can re-set aliases).
- **Set (AC-34/38/40):** validate the alias with `aliasSchema` = `z.string().trim().min(1).max(100).refine(no control chars)`; on failure the route returns `400 VALIDATION` and nothing is persisted (AC-38). **Unknown agent id (AC-40, Open Q5 confirmed): accept and persist** so an alias can be pre-seeded before the agent first connects. The alias never changes routing/keying (AC-35) — routing is always by `agentId`.
- The `aliasSchema` is defined in `src/api/schemas.ts` alongside the other request schemas (so it's part of the single validation surface) and reused by both the store and the PUT route.

**Concurrency and durability (resolves review finding #8).** The in-memory map is the **single source of truth** and is the thing `get`/`all` read:

- `set()` validates, then **synchronously** updates the in-memory map (so a subsequent `get`/`GET /api/agents` on the same tick already sees the new value), then persists asynchronously. The REST `PUT` resolves after the write settles so the caller's 200 means "persisted."
- **Writes are serialized to prevent regression.** A single in-flight write is allowed at a time; concurrent `set()` calls do not each spawn an independent temp-rename. The store keeps a `writing` promise and a `dirty` flag: if a write is in flight when another `set()` lands, it marks `dirty` and the in-flight write, on completion, re-serializes the **current** in-memory map and writes again if `dirty`. This "coalesce + re-flush latest" scheme is **last-writer-wins by in-memory state**, so a slow rename can never clobber a newer value — the file always converges to the latest in-memory map. Each physical write is write-to-temp-then-`rename` (atomic on the same filesystem) so a crash mid-write cannot corrupt the file (a partial temp file is simply ignored by the next load).
- **Error on write failure:** a failed write logs a `warn` (never crashes — NFR-2) and the in-memory map retains the new value; the next successful `set()` or a restart's `load()` reconciles. Because the datum is cosmetic (NFR-6), a transient write failure degrades to "alias not yet durable" rather than a fatal error.

**`all()` vs. the live registry (resolves review finding #8).** `all()` returns every persisted alias, **including pre-seeded entries for agents that have never connected** (AC-40). The unified `GET /api/agents` list is **keyed by the live `FleetRegistry`**, not by the alias map: it iterates the registry's known agents (online or retained-offline) and looks up each one's alias via `AliasStore.get(id)`. Pre-seeded aliases for never-seen agents are therefore **not listed** in `GET /api/agents` (there is no registry entry to attach them to) — they take effect only once that agent first connects and gets a registry entry. This is the chosen reconciliation (list = registry ∩ aliases, aliases joined per entry); it keeps the agent list meaning "agents the server has actually heard from" and avoids phantom rows for aliases typed ahead of time. A pre-seeded alias is still returned by the `PUT …/alias` round-trip and is applied the instant the agent registers.

### Alias display semantics (AC-37)

The unified API returns both `id` and `alias` per agent. The dashboard shows the alias when set, else the real id, with the id always available on hover/detail. `AGENT_NAME` on the agent side is sent as `meta.nameHint`; the server uses it **only** as the initial alias if no alias is stored yet (operator convenience from the user's request: "autogenerate the name from the instance, but let me set an alias"). An operator-set alias always wins over the hint.

---

## 5. Unified REST + dashboard (server mode)

### REST endpoints (FR-6, AC-25/26/28/34)

New agent-scoped routes mounted under `/api/agents` (new file `src/api/routes/agents.ts`), behind the existing human auth middleware (AC-53 — human auth unchanged). They take a `FleetDeps` surface (narrow, injectable like the existing `StateDeps`/`Pm2Deps`) so integration tests inject a fake registry:

```
GET    /api/agents
         → [{ id, alias, online, meta, pm2Connected, processCount, lastSeen }]
GET    /api/agents/:id
         → { id, alias, online, meta, pm2Connected, processes }  (404 AGENT_NOT_FOUND)
GET    /api/agents/:id/processes
         → ProcessSnapshot[]            (per-agent, same shape as /api/processes)
GET    /api/agents/:id/processes/:name/metrics?sinceMs
         → { name, samples }            (from the agent's MetricsStore)
GET    /api/agents/:id/processes/:name/logs?lines&stream&q&level
         → { name, lines }  — see log note below
GET    /api/agents/:id/errors?...        → TrackedError[]  (agent's ErrorTracker)
POST   /api/agents/:id/processes/:name/{start|stop|restart|reload|delete}
         → routeControl(...) → ControlResult mapped to HTTP
POST   /api/agents/:id/processes          → create (startNew) routed to the agent
PUT    /api/agents/:id/alias  { alias }    → AliasStore.set → { id, alias }
```

- `:id` is validated by a new `agentIdSchema` (same safe charset as `processNameSchema`); `:name` reuses `processNameSchema`; control bodies reuse `createProcess`/`nameParam` from `src/api/schemas.ts` (AC-26 — validated with the existing schemas on the server before routing, NFR-3 both-ends validation).
- **Logs over REST (resolves review finding #7).** In v1 the agent forwards logs only as a **live stream** (it does not expose a historical remote file tail over the wire — the AC set does not mandate one, so this is deliberately out of v1 scope to bound work). The design pins the behavior precisely rather than leaving it to the implementer:
  - The relay maintains a **bounded ring buffer of the last 200 lines per `(agentId, process)`** key, populated **only while at least one live WS log subscription is active** for that key. The ring is created on the first subscribe and torn down when the last subscriber unsubscribes (reference-counted, consistent with the WS relay below).
  - `GET /api/agents/:id/processes/:name/logs` returns `{ name, lines }` where `lines` is a snapshot of that ring. **If no live subscription exists for the key, the ring is empty and the endpoint returns `{ name, lines: [] }`** — a well-defined, documented empty result, not an error.
  - This is an **explicit, documented semantic difference** from standalone's `/logs`, which returns a real file tail via `pm2.readLogsTail`. The server-mode agent-scoped `/logs` is "recent live-relayed lines," and the primary log experience in server mode is the **live WS relay** (below). The difference is called out in README so operators are not surprised by an empty REST tail when nothing is actively streaming.
  - **Deferred alternative (not v1):** a `log:tailRequest`/`log:tailResponse` control frame pair that invokes the agent's `readLogsTail` for true historical parity. It is noted as a low-risk follow-up (it reuses the existing correlation machinery and the agent's existing `readLogsTail`) but is explicitly out of v1 scope; the ring approach above is the v1 decision.

### Human WS log relay (FR-3, AC-28)

The human dashboard already subscribes to logs via the existing `WsHub` with `log:subscribe {process}`. In server mode the subscription must name an agent too. Rather than fork the `WsHub` protocol, the human WS message is extended with an optional `agentId`: `log:subscribe { agentId, process, streams }`. In standalone, `agentId` is absent and behavior is identical (NFR-1). In server mode:
- The `WsHub` is constructed with an optional `relay` hook (`FleetLogRelay`). When a human client sends `log:subscribe` with an `agentId`, the hub registers the client with the relay instead of the local log fan-out; the relay sends `log:subscribe` to that agent (AC-28) and, as `log:line` frames arrive, pushes them to the subscribed human clients as the existing `{ type:'log', ... }` frame (so `public/js` renders them unchanged). On client disconnect or `log:unsubscribe`, the relay sends `log:unsubscribe` to the agent (AC-28). Reference-counted per `(agentId,process)` so multiple operators share one upstream subscription and the last unsubscribe tears it down.
- **`agentId` is validated on the hot WS path before any registry lookup or upstream frame (second-pass finding #3, FR-8/NFR-3 both-ends validation).** Verified `src/ws/hub.ts`: the existing `log:subscribe` case validates only that `process` is a string (it relies on the local fan-out being safe). The WS relay is the dashboard's primary live-log channel, so an unvalidated `agentId` would reach a `FleetRegistry` `Map` lookup and an upstream frame — the exact sharp edge the REST side already guards with `agentIdSchema`. The design pins: when a `log:subscribe` carries an `agentId`, the relay hook **first** validates it with the same `agentIdSchema` (safe charset, 1–100 chars, excludes `/` and prototype-pollution keys like `__proto__`). On validation failure the hub returns the existing `{ type:'error', code:'BAD_MESSAGE', message }` frame (reusing `src/ws/hub.ts`'s established pattern) and **touches neither the registry nor an upstream frame**. `process` continues to reuse `processNameSchema` (tightening the current string-only check on the relay path), and `streams` is validated against `('out'|'err')[]`.
- **Standalone path is byte-identical (NFR-1).** When `agentId` is absent (standalone, and the human dashboard before an agent is selected), the message takes the existing local fan-out path with no new validation and no relay — unchanged behavior and unchanged tests. The new `agentId`/`process` validation applies **only** when `agentId` is present (server-mode relay path).

This is the one place the human `WsHub` gains an awareness of agents; it is injected (the hook is `undefined` in standalone), so the standalone `WsHub` code path and its tests are unchanged.

### Dashboard (`public/`, vanilla JS, no bundler) (FR-6, AC-37)

Standalone must look identical to today (NFR-1). The dashboard discovers mode from `GET /api/system/health`, which gains a `mode` field. `agent` mode has no dashboard of its own (it serves no HTTP); the field is only meaningful for `standalone`/`server`.

#### Health route in server mode (resolves review finding #4)

Verified `src/api/routes/system.ts`: `createHealthRouter` reads `deps.state.isConnected()` and `deps.state.getMaintenance().active`, and `ApiDeps.state` is a **required** `MonitorState`-shaped `StateDeps`. Server mode removes the local `Pm2Client` and local `MonitorState`, so `pm2Connected`/`maintenance` have no local source. The design pins both the server-mode health **shape** and how `ApiDeps.state` is satisfied:

- **`mode` is added to health in all modes** (additive, unauthenticated): standalone and server both return `mode` (the dashboard reads it in both). The field is `'standalone' | 'server'` in practice (agent serves no HTTP).
- **Server-mode health shape:**
  ```jsonc
  {
    "status": "ok",
    "mode": "server",
    "maintenance": <globalMaintenance.active>,   // from the server's global MaintenanceState (§6)
    "agents": { "total": <registry size>, "online": <online count> },
    "version": "<monitor version>",
    "uptimeMs": <now - startedAt>
  }
  ```
  `pm2Connected` is **dropped in server mode** (there is no local PM2 daemon); it is replaced by the `agents` summary. The dashboard's health consumer treats `pm2Connected` as optional and keys fleet UI off `mode === 'server'` + `agents`.
- **Standalone health shape is unchanged** except for the additive `mode:'standalone'` field — `status`, `pm2Connected`, `maintenance`, `uptimeMs`, `version` are byte-for-byte as today, so the existing health test only gains an assertion for the new `mode` field (NFR-1).
- **How `ApiDeps.state` is satisfied in server mode:** rather than fake a full `MonitorState`, the design uses a **dedicated server health router** for server mode. `src/api/routes/system.ts` gains `createServerHealthRouter(deps)` that reads the global `MaintenanceState` holder and the `FleetRegistry` summary directly (no `StateDeps`). Server boot mounts this instead of the standalone `createHealthRouter`. The authenticated `GET /api/system/status` route, which also depends on `deps.state.snapshot()`, is **not mounted in server mode** (there is no single local snapshot); the fleet equivalent is `GET /api/agents` + `GET /api/agents/:id`. This keeps `ApiDeps` honest: the server-mode wiring provides only the deps its mounted routes actually need, and does not construct a stub `MonitorState`. (The alternative — a thin maintenance-only object standing in for `state` — was rejected because `StateDeps` also requires `snapshot`/`getProcess`/`getMetrics`/`isConnected`, which have no meaningful server-mode value and would be dead stubs.)

- **standalone:** `app.js` behaves exactly as today — no agent concepts, identical overview/detail. The new agent code paths are gated behind `mode === 'server'`.
- **server:** a new `public/js/views/agents.js` renders a **fleet overview**: a list/grid of agent cards (alias or id, online badge, host/platform, process count, pm2-connected badge). Selecting an agent drills into the **existing** overview/detail views, parameterized by `agentId`: `overview.js`/`detail.js` gain an optional `agentId` that, when set, makes `api.js` hit the `/api/agents/:id/...` endpoints instead of `/api/processes/...`. The per-agent process grid, control buttons, metrics, and log tail are the **same components** — only the base path changes. The alias is editable inline on the agent card (`PUT /api/agents/:id/alias`), showing the real id on hover/detail (AC-37).
- `api.js` gains agent methods (`listAgents`, `getAgent`, `agentProcesses`, `agentControl`, `agentLogs`, `setAlias`, ...) and the existing methods are refactored to accept an optional `agentId` that selects the base path. `ws.js` `logSubscribe` gains an optional `agentId` passed straight through to the frame. These are additive; the standalone call sites pass no `agentId` and are unchanged.

**Assumption (Open Q12):** v1 UX is "fleet overview + drill-down into the existing per-agent views" (full control/metrics/logs parity per agent, reached one agent at a time) rather than a single cross-fleet merged grid. This matches the user's "administer distinct PM2 instances through the server" intent and reuses the existing views with minimal change.

---

## 6. Alert engine + maintenance in server mode

### Where the engine runs (FR-3, AC-30/31)

In server mode the `AlertEngine` runs **on the server** as a **single** instance, evaluating across all agents. It is the **reused** engine, but made **agent-aware** by a small, explicit, tested set of changes. The earlier draft's claim that "the engine is unchanged" was wrong (confirmed by review findings #1–#3 against `src/alerts/engine.ts`): the existing matcher does literal `includes()` matching (`ruleTargets`/`targetNames`) and `handleTick` drops any target not in the `present` set, and `buildPayload` constructs the payload internally from a bare `name` — none of which can route a bare rule name onto a composite `agentId/name` key or attach agent context without editing the engine. This section specifies the exact changes and proves standalone is a no-op under them.

#### Decision: one agent-aware engine with composite keys (chosen) vs. one engine per agent (rejected)

Two viable approaches were considered:

- **(A) One agent-aware engine over composite `${agentId}/${name}` keys (CHOSEN).** A single engine, a single cooldown tracker, and a single maintenance holder, with process identity on the server being the composite key. Rationale: it keeps global cooldown and global maintenance trivially global (one tracker, one holder), matches the existing single-engine lifecycle, and the cross-agent `*` rule is naturally "every composite key." The cost is a bounded, well-contained set of engine edits (below).
- **(B) One engine instance per agent (REJECTED).** Keeps `engine.ts` literally untouched but multiplies engine objects, requires a **shared** cooldown tracker and **shared** maintenance holder injected into every instance to preserve global semantics (AC-32 and per-`(rule,process)` cooldown across the fleet), and makes a cross-agent `*` rule awkward (it must be instantiated per agent, and "N restarts across the fleet" style rules cannot be expressed). The coordination glue to re-globalize cooldown/maintenance across N engines is more code and more surface than the contained edits in (A).

**Chosen: (A).** The "engine unchanged" framing is dropped; the engine is modified as follows and the changes are covered by new tests.

#### Agent-aware engine changes (the actual edits to `src/alerts/engine.ts`)

Process identity on the server is the composite **`${agentId}/${name}`**. The engine's two matcher helpers and its payload builder are made agent-aware; nothing else in the evaluation flow changes.

1. **Composite-key state surface.** The server's per-agent `MetricsStore`/`ErrorTracker` are addressed by `agentId/name` keys. The `AlertStateHub` and `AlertErrorWindows` the engine receives are **server implementations backed by the `FleetRegistry`** that speak composite keys: `processNames()` returns `agentId/name` for every process across all online agents; `getProcess`/`sustainedAbove`/`countInWindow`/`restartsInWindow` parse the composite key (split on the **last** `/`) and dispatch to the owning agent's store. In standalone these same interfaces are the existing `MonitorState`/`ErrorTracker` returning bare names — the engine does not care which, because the key is opaque to it except at the two match points below.
2. **`ruleTargets(rule, key)` — extended matcher.** Replace the current body
   `rule.match.processes.includes('*') || rule.match.processes.includes(name)`
   with a match that treats `key` as possibly-composite: it returns true when `rule.match.processes` includes `'*'`, OR includes the **full** `key` (`agentId/name`), OR includes the **bare name part** of `key` (everything after the last `/`; if there is no `/`, the bare part is the whole key, which is exactly the standalone case). This is the one behavioral extension: a bare rule name now matches that process **on any agent**, and an `agentId/name` rule matches one agent's process.
3. **`targetNames(rule, present)` — composite-aware expansion.** For `*` return `present` (now composite keys) as today. For an explicit list, map each selector: a bare `name` expands to **every present key whose name-part equals `name`** (fleet-wide), and a composite `agentId/name` passes through if present. `handleTick`'s `if (!present.has(name)) continue` guard then works unchanged because the expanded targets are real present keys.
4. **`buildPayload` — injected agent resolver (resolves finding #3).** The engine is constructed with an injected `resolveAgent(key) => { agentId?: string; agentAlias?: string; name: string }`. `buildPayload` calls it to (a) split the composite key into `{ agentId, name }`, (b) look up the alias via the resolver (which closes over the `AliasStore`/registry), and (c) attach **optional** `agentId`/`agentAlias` fields to the payload and prefix the `summary`/`title` with the alias-or-id. `processName` in the payload is set to the **bare name** (so existing channel formatting is unchanged), while the agent attribution rides the new optional fields. **Standalone wiring injects a resolver that returns `{ name: key }` with no `agentId`/`agentAlias`**, so in standalone `buildPayload` produces a payload with `agentId`/`agentAlias` **absent** and `summary`/`title` **unprefixed** — byte-for-byte the current output (NFR-1). The default resolver (when none is injected) is this standalone identity resolver, so the engine's existing constructor callers compile unchanged.

These four edits are the complete, bounded engine change. They are additive at the type level (new optional constructor field, new optional payload fields) and no-ops in standalone.

#### Rule schema: allow agent-scoped targets (resolves finding #2)

Verified `src/config/alertRules.ts`: `match.processes` entries are validated by `processSelector = z.union([z.literal('*'), processNameRule])` where `processNameRule = /^[A-Za-z0-9._-]{1,100}$/`. The `/` in a composite `agentId/name` is **not** in that charset, so a rule file targeting `agent1/web` fails schema validation and the server exits — an operator could not author the agent-scoped rules the engine now supports. The schema is extended with an explicit, validated composite form:

```ts
const processNameRule = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'invalid process name');
const compositeTargetRule = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, 'invalid agentId/process target');
const processSelector = z.union([z.literal('*'), processNameRule, compositeTargetRule]);
```

- `*` → every process on every agent (fleet-wide).
- bare `name` → that process name on **any** agent (fleet-wide by name).
- `agentId/name` → that specific agent's process.

The `agentId` part uses the same safe charset as `processNameSchema`/`agentIdSchema`, so the composite is a strict concatenation of two already-validated identifiers with a single `/` separator — unambiguous because neither part may contain `/`. This is a **widening** of the schema (a superset of what validated before), so every existing rules file still validates and still means the same thing in standalone (a bare name matches the single local process set). The scope decision is explicit: **agent-scoped rule targeting IS in v1** (it is cheap given the matcher change and directly serves "administer distinct instances through the server"). The split-on-last-`/` in the matcher and state surface is unambiguous precisely because `agentId` and `name` individually exclude `/`.

#### Alert payload (AC-31, resolves finding #3)

`AlertPayload` (in `src/alerts/channels/types.ts`) gains two **optional** fields: `agentId?: string` and `agentAlias?: string`. They are populated only via the injected `resolveAgent` in server mode. Because they are optional and the standalone resolver leaves them `undefined`, standalone payloads and the existing channel renderers are unchanged (a renderer that does not read the new fields behaves identically; the Teams/email formatters are extended to show the agent attribution only when `agentId` is present). This is now specified as a real engine change (not "purely additive type field"): the fields are *declared* additively, but *populating* them requires the injected resolver and the `buildPayload` edit above.

### Agent-offline alerting (AC-33, Open Q7)

When an agent disconnects, the server emits a single **`agent offline`** alert through the engine's dispatch path, gated by the existing cooldown (keyed by `agentId` with a synthetic rule id `__agent_offline__`), and **suppresses per-process crash alerts for that agent's orderly disconnect** — i.e., disconnect does not synthesize per-process `errored`/`unexpected-stop` events; the agent's processes simply go stale/offline in the registry. (Open Q7 confirmed.) An agent that *reconnects* and reports a genuinely crashed process still alerts normally via the fresh snapshot/updates.

### Global maintenance (AC-32)

Maintenance is **global** in server mode. The existing `MonitorState.maintenance` semantics are reused by giving the server a single `MaintenanceState` (one `MonitorState`-like holder, or a tiny dedicated holder exposing `getMaintenance`/`setMaintenance`) that the engine's `AlertStateHub.getMaintenance()` reads. While active, the engine suppresses alerts across all agents exactly as today (the engine already consults `getMaintenance().active` before dispatch). The existing `GET/POST /api/maintenance` routes are reused unchanged and now toggle the global state (AC-32). The dashboard maintenance toggle is unchanged.

---

## 7. Security

- **Separate credential space (AC-48/53).** Agent tokens live in `AGENT_TOKENS`/`AGENT_TOKEN` and are validated only by `src/server/agentAuth.ts` on the `/agent` path. Human auth (`API_KEY`/basic) is validated only by `src/api/auth.ts`/`WsHub` on `/api` and `/ws`. The two never cross: a human credential cannot authenticate an agent and vice versa, because they are checked by different code on different paths against different config.
- **Constant-time comparison (AC-49/50).** `agentAuth.validate(provided, tokens)` is `tokens.some(t => safeEqual(provided, t))`, reusing the existing throw-safe `safeEqual` (sha256-normalized `timingSafeEqual`). It never throws on empty/malformed/length-mismatch input and returns `false` → `register:nack`. Multiple valid tokens enable rotation (keep old + new valid during a rollout, then drop the old).
- **Both-ends command validation (AC-17/52, FR-8).** The server validates every control request with `src/api/schemas.ts` (`processNameSchema`, `createProcess`) before routing; the agent re-validates with the **same** schemas before invoking PM2. The agent never trusts the wire. `decode`'s schema validation is the first gate; the domain re-validation is the second.
- **Correlation integrity (AC-43/44).** Every control carries a unique `cid`; responses are matched only to a pending, unsettled `cid`; unknown/duplicate/late acks are ignored (`PendingRequests.settle` returns false). A forged/duplicate ack therefore cannot resolve the wrong command.
- **Logger redaction (AC-51, review finding #11).** `REDACTED_KEYS` in `src/core/logger.ts` is extended with `AGENT_TOKEN`, `AGENT_TOKENS`, and `SERVER_URL` (so a `wss://…?token=` never leaks; `redactUrl` already strips `token=` query values and is applied to any string value that contains `token=`). Agent and gateway log `agentId`/path/`authed` only — never the token, never the raw `SERVER_URL`. The insecure-TLS warning is logged but names no secret. **Redaction depth (second-pass finding #4, corrected):** verified `src/core/logger.ts` — `redactContext` **recurses into nested plain objects to full depth** (it calls itself on every nested plain object with no depth bound), `REDACTED_KEYS` matches by key name at any depth, and `redactValue` redacts any string containing `token=` via `redactUrl` at any depth it visits. So adding the three keys covers them wherever they appear, and any URL string carrying `?token=` is redacted regardless of its key or nesting depth. **No special one-level nesting contract is required** (the earlier draft's "one level" premise and the self-imposed "no secret deeper than one nested level" rule were based on a misreading of `logger.ts` and are dropped — the real behavior is deeper and safer). The **one genuine edge** is that `redactContext` does **not** recurse into arrays (`!Array.isArray(value)`), so a token-bearing object placed inside an array element is **not** key-redacted; the contract is therefore the narrow one that **no log call places a token-bearing object inside an array** (agent/gateway logs use flat object contexts like `{ agentId, path, authed }` and never array-wrap a secret). A regression test asserts both `{ AGENT_TOKEN: '…' }` and `{ dial: { url: 'wss://h/agent?token=secret' } }` redact (see Testing). **Stale docstring (finding #3).** The `logger.ts` module docstring still reads "replaces known secret keys … (shallow + one level nested)", which **contradicts** the real full-depth recursion the design depends on (verified in the source). The §9 redaction-depth test — which asserts redaction at depth ≥2 — is the **source of truth**, not the comment. The implementer must update that docstring line to describe full-depth recursion (and the single array edge) while adding the new keys, so a later reader does not "fix" the test to match the stale doc.
- **TLS (AC-54/55/56).** Agents dial `wss://` and verify the cert by default (`rejectUnauthorized:true`). `TLS_INSECURE=true` sets `rejectUnauthorized:false` and triggers the clearly-marked startup+reconnect warning; it defaults off. The server supports reverse-proxy TLS termination (no cert config; operators point agents at `wss://` through the proxy) **and** native TLS when both `TLS_CERT_FILE`/`TLS_KEY_FILE` are set (the HTTP server is created with `https.createServer` reading those files; `WsHub`/`AgentGateway` attach to it identically since both use `noServer` mode). The superRefine rejects a half-configured pair. mTLS/client-certs are out of scope (v1).

---

## 8. Module-by-module implementation ordering

A planner can decompose this into the following ordered units; each is independently testable and most are additive.

1. **`src/core/backoff.ts`** — extract `backoffDelay(attempt, rand = Math.random)` from `Pm2Client` (pure refactor + test; `Pm2Client` imports it and calls it with the default `rand`; no behavior change). The injected `rand` is the deterministic-jitter test seam (finding #5). Verifies the baseline stays green.
2. **`src/config/env.ts`** — add `MODE` + mode-scoped vars + superRefine guards; derived-config helpers come later with each boot file. Extend `env.test.ts`.
3. **`src/protocol/`** — `version.ts`, `shapes.ts` (zod mirrors of core types + type-equality assertion), `messages.ts` (discriminated union), `codec.ts`, `correlation.ts`. Fully unit-testable with no sockets.
4. **`src/boot/standalone.ts`** — move the current `bootstrap()` body here verbatim; `index.ts` calls it for `MODE==='standalone'`. No behavior change; existing tests cover it.
5. **`src/agent/identity.ts`** — stable ID + persistence (injected fs/rand).
6. **`src/agent/connection.ts`** — outbound `ws` client, register/heartbeat, reconnect/backoff/jitter, insecure-TLS toggle (injected timers/socket factory).
7. **`src/agent/logForwarder.ts`** + **`src/agent/runtime.ts`** — event→wire bridge, inbound command execution (reusing `src/api/schemas.ts`), log forwarding.
8. **`src/boot/agent.ts`** — wire core + the `Pm2Deps` facade + `AgentRuntime`; no HTTP server. **Start the `AgentConnection` dial loop first/concurrently and wire the real `createPm2Adapter`/`Pm2Client.start()` in a background task exactly as `index.ts` does today, so the outbound server dial is never blocked by a hung/absent local PM2 daemon and a `control:request` before PM2 attaches returns a correlated `PM2_UNAVAILABLE` `ControlResult` (§3 "Boot ordering", AC-14).**
9. **`src/server/agentAuth.ts`** — token validation via `safeEqual`.
10. **`src/server/aliasStore.ts`** + `aliasSchema` in `src/api/schemas.ts` — disk JSON persistence, atomic write, corrupt-tolerance.
11. **`src/server/registry.ts`** — `FleetRegistry`: per-agent state, frame handling, command routing (`PendingRequests`), log-relay fan-out with the bounded 200-line-per-`(agentId,process)` ring (§5), offline handling.
12. **`src/server/gateway.ts`** — inbound agent `WebSocketServer` on `/agent`, handshake/auth, **pre-auth hardening** (register-only before auth, 5s non-extendable handshake timeout, `MAX_PENDING_AGENT_SOCKETS` cap — §4), bind frames to the registry.
13. **`src/alerts/engine.ts` (agent-aware edits) + `src/config/alertRules.ts` (schema widening)** — the four bounded engine edits (`ruleTargets`/`targetNames` composite matching, injected `resolveAgent`, `buildPayload` attribution) and the `processSelector` composite form (§6). Add engine tests for composite matching and the standalone-identity resolver no-op; add a rules-schema test for `agentId/name`. **`src/alerts/channels/types.ts`** gains optional `agentId`/`agentAlias` on `AlertPayload`.
14. **`src/server/fleetEvents.ts`** — re-emit fleet events with composite keys; the server `AlertStateHub`/`AlertErrorWindows` implementations over the `FleetRegistry`; the `resolveAgent` closure over the registry + `AliasStore`; agent-offline alert.
15. **`src/api/routes/controlStatus.ts`** — the shared `statusForControlCode` mapper (§4). Standalone `sendControlResult` in `processes.ts` is left unchanged.
16. **`src/api/routes/agents.ts`** + `FleetDeps` — unified REST endpoints using `statusForControlCode`; `{ body }`-wrapped server-side `createProcess` validation before routing (§3).
17. **`src/api/routes/system.ts`** — add `mode` to the standalone health payload; add `createServerHealthRouter` (server-mode shape, no `StateDeps` — §5).
18. **`src/ws/hub.ts`** — add the optional `relay` hook + optional `agentId` on `log:subscribe`, with `agentId` validated by `agentIdSchema` and `process` by `processNameSchema` **only on the relay path** before any registry lookup/upstream frame (finding #3); additive, standalone (no `agentId`) unchanged.
19. **`src/boot/server.ts`** — wire human `createServer` (server health router, no `/status`) + `WsHub`+relay + `AgentGateway` + `FleetRegistry` + `AliasStore` + global `MaintenanceState` + agent-aware `AlertEngine` (fleet-fed, injected resolver).
20. **`index.ts`** — the `MODE` dispatch to the three boot functions.
21. **`public/`** — `health` `mode` field consumption (optional `pm2Connected`); `agents.js` fleet view; parameterize `overview.js`/`detail.js`/`api.js`/`ws.js` by optional `agentId`.
22. **Docs** — `README.md` + `.env.example` (three modes, token setup/rotation, TLS/insecure, alias file, protocol summary, and the server-mode `/logs` live-ring semantics vs. standalone file tail).

Order rationale: protocol before both runtimes; agent and server runtimes are independent after the protocol exists and can proceed in parallel; the human-facing additions (routes, hub hook, dashboard) come after the registry exists; `index.ts` dispatch and docs last.

---

## 9. Testing plan

All tests are `node:test` via `tsx --test`, using injected fakes/timers consistent with `fakePm2Client`, the injected-timer pattern in `Pm2Client`/`WsHub`, and `safeParse`-style assertions. Target: the full existing ~164 tests stay green (AC-3/57/58), plus:

- **`src/core/backoff.test.ts`** — delay sequence (1s,2s,4s… capped 30s); jitter bounds `±20%` asserted **deterministically** by injecting `rand` returning `0`/`1`/`0.5` so the delay is exactly `base*0.8`/`base*1.2`/`base` (finding #5); 30s cap and non-negativity. A separate assertion confirms `Pm2Client` still uses the default `Math.random` (behavior unchanged).
- **`src/config/env.test.ts` (extended)** — `MODE` default = standalone; invalid `MODE` → fail; `agent` without `SERVER_URL`/`AGENT_TOKEN` → fail; `server` without any token → fail; half-set TLS pair → fail; non-`ws(s)://` `SERVER_URL` → fail; **`MODE=server` with `AGENT_WS_PATH=/ws` → fail (finding #7)**; standalone with legacy `.env` → unchanged (AC-1/4/5/6).
- **Protocol round-trip (`src/protocol/codec.test.ts`, `messages.test.ts`)** — encode→decode every frame type; `decode` returns `BAD_MESSAGE` (never throws) for bad JSON, missing `type`, unknown `type`, and schema-invalid payloads (AC-41/42); **a `register` with a blank/whitespace `token` or a blank/garbage/charset-malformed `agentId` is rejected at decode with `BAD_MESSAGE` (finding #6)**; the shape-mirror type-equality assertion compiles (ProcessSnapshot/MetricSample/LogLine/TrackedError/ControlResult, AC-46).
- **Correlation (`src/protocol/correlation.test.ts`)** — matching `cid` resolves; unknown/duplicate/already-settled `cid` ignored (AC-44); timeout resolves `AGENT_TIMEOUT` and never hangs (AC-45); `rejectAll` on disconnect.
- **Agent identity (`src/agent/identity.test.ts`)** — new suffix generated+persisted when file missing; same ID reused when present; regeneration logs info on unreadable file; stable across simulated restarts (AC-8/9).
- **Agent connection (`src/agent/connection.test.ts`)** — reconnect with capped backoff+jitter via injected timers (AC-12); no crash when the server is unreachable at boot and keeps retrying (AC-11); register sent on open; `register:nack AUTH_FAILED` → backoff, no crash; insecure toggle passes `rejectUnauthorized:false` + logs the warning (AC-55). **Backoff reset point (finding #10):** assert `backoffAttempt` is **not** reset on socket `open` and **is** reset only on `register:ack`, so a repeated `AUTH_FAILED` climbs to and holds at the 30s cap rather than hot-looping; assert retries are unbounded (a later-accepted token eventually registers). **`onLinkDead` idempotency (finding #12):** both the app-level heartbeat-ack timeout and the transport pong timeout firing route through a single `onLinkDead()` that closes exactly once (second trigger is a no-op).
- **Agent command execution (`src/agent/runtime.test.ts`)** — valid control → `Pm2Client` called, correlated `control:response` with the `ControlResult` (AC-19); invalid name/opts → rejected wire-side with correlated `VALIDATION`, PM2 **not** called (AC-17/18); both-ends validation reuses `src/api/schemas.ts`. **`createProcess` `{ body }` wrapper (finding #6):** assert the agent validates with `createProcess.safeParse({ body: opts })`, that `instances>1` with no `exec_mode` yields the **transformed** `exec_mode:'cluster'` reaching `startNew`, that a non-existent `script` on the agent's disk → `VALIDATION` (fake `fileExists`), and that unknown keys are rejected by `.strict()`.
- **Agent-token auth (`src/server/agentAuth.test.ts`)** — valid token accepted; invalid/missing/empty/wrong-length rejected **without throwing** (AC-49); list rotation: any entry matches (AC-50); uses `safeEqual`.
- **Alias store (`src/server/aliasStore.test.ts`)** — set/get/persist; reload after restart (AC-36); missing file → empty, continue (AC-39a); corrupt JSON/schema → warn + empty, no crash (AC-39b); invalid alias (too long / control chars / blank) → rejected, not persisted (AC-38); unknown-agent id → accepted + persisted (AC-40); atomic write (temp+rename). **Concurrency (finding #8):** the in-memory map is updated synchronously on `set()` (a `get()` immediately after sees the new value before the write settles); concurrent `set()`s coalesce to a single in-flight write and the file converges to the **latest** in-memory value (no regression) — tested with an injected slow `writeFile`/`rename`; a write failure logs a warn and keeps the in-memory value (no crash). **`all()` vs. registry (finding #8):** a pre-seeded alias for a never-connected id is in `all()` but **not** listed by `GET /api/agents` (asserted in the agents-route test below).
- **Registry + routing (`src/server/registry.test.ts`)** — register keys by stable id (AC-22); online/offline transitions (AC-24); isolation across agents (AC-29); `routeControl` returns the agent's correlated result; offline → `AGENT_OFFLINE`, unknown → `AGENT_NOT_FOUND`, neither blocks (AC-27); disconnect `rejectAll` fails in-flight commands; log fan-out to subscribed human clients only. **Metric prune (finding #1):** after a `snapshot` that omits a previously-present process, that process's `MetricsStore` series is dropped (`entry.metrics.names()` no longer contains it) and `sustainedAbove`/`processNames` no longer see it; `update:metrics` alone does **not** prune; `ts` from the wire sample is pushed verbatim (finding #2) — a sample with `ts = snap.lastUpdated` lands at that time in the store (no re-stamping).
- **Gateway handshake (`src/server/gateway.test.ts`)** — accept on valid register; `AUTH_FAILED`/`VERSION_MISMATCH` nack + no registration; handshake-timeout close; never logs token/url. **Pre-auth hardening (prior-pass finding #9):** a non-`register` frame before auth → `error:frame` + close; the 5s handshake timeout closes the socket and is not reset by a malformed frame; reaching `MAX_PENDING_AGENT_SOCKETS` un-registered sockets refuses the next `/agent` upgrade with 503-and-destroy; registered agents are not counted against the cap. **Blank/garbage identity (finding #6):** a `register` with an empty `token` or a malformed `agentId` is rejected at decode (`BAD_MESSAGE`) and never reaches auth or the registry.
- **Engine agent-awareness (`src/alerts/engine.test.ts`, extended) + rule schema (`src/config/alertRules.test.ts`, extended)** — `ruleTargets`/`targetNames` match `*`, full `agentId/name`, and bare `name` against a composite-keyed `present` set; two agents with a same-named process do **not** share a cooldown or cross-trigger; a bare rule fires on that name across all agents (finding #1). The standalone-identity `resolveAgent` yields payloads with `agentId`/`agentAlias` **absent** and an **unprefixed** `summary`/`title` — asserted byte-identical to current output (NFR-1, finding #3). The rule schema accepts `agentId/name`, still accepts bare names and `*`, and rejects a two-slash/empty-part target (finding #2).
- **Fleet alerts (`src/server/fleetEvents.test.ts`)** — cross-agent evaluation over the composite-key state surface; payload carries `agentId`+`agentAlias` via the injected resolver (AC-31); global maintenance suppresses across all agents (AC-32); single cooldown-gated agent-offline alert, no per-process crash alerts on orderly disconnect (AC-33).
- **Control-status mapping (`src/api/routes/controlStatus.test.ts`)** — `statusForControlCode` returns 409 for `PM2_UNAVAILABLE`/`AGENT_OFFLINE`/`AGENT_TIMEOUT`, 404 for `AGENT_NOT_FOUND`, 400 for `VALIDATION`, 502 for `PM2_ERROR`/default (finding #5); a separate assertion confirms the standalone `sendControlResult` in `processes.ts` is unchanged (still binary 409/502).
- **Server health (`src/api/routes/system.test.ts`, extended)** — standalone health gains `mode:'standalone'` and is otherwise unchanged; `createServerHealthRouter` returns `{ status, mode:'server', maintenance, agents:{total,online}, version, uptimeMs }` with **no** `pm2Connected`, reading the global maintenance holder + a fake registry summary (finding #4).
- **Unified REST (`src/api/routes/agents.test.ts`)** — `GET /api/agents` + per-agent reads/control via a fake `FleetDeps`; the list is keyed by the live registry and a pre-seeded alias for a never-connected id is **not** listed (finding #8); `PUT /api/agents/:id/alias` validation + persistence; routed-control HTTP mapping via `statusForControlCode` (409 offline / 404 unknown / 400 validation / 502 PM2 error); server-side `{ body }`-wrapped `createProcess` validation before routing (finding #6); human auth still enforced (AC-53).
- **Logger redaction (`src/core/logger.test.ts`, extended)** — `{ AGENT_TOKEN: '…' }`, `{ AGENT_TOKENS: '…' }`, and `{ dial: { url: 'wss://h/agent?token=secret' } }` all redact (prior-pass finding #11), matching the existing redaction test style. **Depth (second-pass finding #4):** also assert a deeper nesting `{ a: { b: { AGENT_TOKEN: '…' } } }` redacts (full-depth recursion confirmed), and document the single array edge with a case showing `{ list: [{ AGENT_TOKEN: '…' }] }` is **not** key-redacted — proving the design's "never array-wrap a secret in a log context" contract is the only thing the implementer must honor.
- **Human WS relay validation (`src/ws/hub.test.ts`, extended — finding #3)** — a `log:subscribe` with a valid `agentId` reaches the relay hook and triggers an upstream subscribe; a `log:subscribe` with a **malformed** `agentId` (bad charset, `/`, `__proto__`, non-string) returns `{ type:'error', code:'BAD_MESSAGE' }` and **does not** invoke the relay hook or touch the registry (asserted via a spying fake relay that records zero calls); a `log:subscribe` with **no** `agentId` takes the existing local fan-out path unchanged (NFR-1).
- **Standalone unchanged (regression)** — the existing `server.test.ts`/`hub.test.ts`/`env.test.ts`/`client.test.ts` and all others run untouched; the `WsHub` `relay`-hook addition is covered by a case asserting that with no `agentId` and no relay, behavior is identical (NFR-1, AC-2/3).
- **Integration (`src/server/integration.test.ts`, AC-59)** — an in-process agent↔server over loopback `ws` (real sockets, no TLS): register handshake → snapshot received by the server → a routed control command round-trips (`routeControl` → agent executes against `fakePm2Client` → correlated response → HTTP result) → a log subscribe relays a `log:line` to a human client → unsubscribe stops it. Uses injected `fakePm2Client` on the agent side and the human `WsHub` on the server side.

### End-to-end smoke (from requirements FR-10/AC-57/58)

- `tsc` compiles clean under strict/NodeNext (AC-57).
- `tsx --test` passes all suites (AC-58).
- Manual/scripted smoke: start one server (`MODE=server`, a token, native-TLS off), start one agent (`MODE=agent`, `SERVER_URL=ws://localhost:PORT`, matching token) against a real local PM2 with a demo process; confirm the agent appears online in `GET /api/agents`, a control command round-trips, live logs stream in the dashboard drill-down, an alias set persists across a server restart, and `MODE` unset still serves the identical standalone dashboard.

---

## Unverified assumptions (flagged for the design review)

1. **Boot extraction into `src/boot/*`** (vs. inline functions in `index.ts`). Chosen for testability; behavior-neutral.
2. **Exact new env var names** (Open Q1) — shape is fixed; names are a naming decision.
3. **Same port + distinct path `/agent`** for the agent WS (Open Q2) — relies on the existing `WsHub` upgrade handler already yielding on non-`/ws` paths (verified in `src/ws/hub.ts`).
4. **Composite `agentId/name` process identity** for the fleet alert engine, implemented via a bounded, tested set of agent-aware engine edits (not "engine unchanged") plus a widened rule-target schema — see §6 and the "Responses to the design review" section. The alternative (one engine per agent) is explicitly rejected there. **Resolved** by review findings #1/#2/#3; no longer open.
5. **REST logs return relayed buffered lines (a bounded 200-line live ring per `(agentId,process)`), not a remote historical file tail**, in v1 — the live WS relay is the primary log path and the empty-no-subscription result is defined. A `log:tailRequest` control frame bridging to the agent's `readLogsTail` is a noted, low-risk follow-up. **Resolved** by review finding #7 (ring pinned, scope stated); no longer open.
6. **Dashboard UX = fleet overview + drill-down into the reused per-agent views** (Open Q12), not a single merged cross-fleet grid.
7. **Protocol v1 rejects version mismatch** (Open Q8) rather than warning-and-continuing.
8. **Control-response timeout = 15s, not env-configurable in v1** (Open Q9).
9. **Per-agent resource bounds reuse the existing retention/buffer env semantics** (Open Q10); no global cross-agent cap in v1.
10. **`heartbeatSec`** is server-chosen and sent in `register:ack`; a concrete default (e.g. 15s) is left for implementation and is not an architectural decision.
11. **`AGENT_NAME`/`meta.nameHint` seeds the initial alias only** when none is stored; an operator-set alias always wins — this interprets the user's "autogenerate from instance name, then let me set an alias" requirement.

All other decisions above are determined by the existing patterns (ESM NodeNext `.js` imports, zod schemas, throw-safe `safeEqual`, `src/pm2` as the only pm2 import site, `MonitorState`/`MonitorEvents` core, the Express REST + `ws` hub + vanilla `public/` dashboard) and the numbered acceptance criteria.

---

## Responses to the design review

### Third pass (current) — `design-review.json` verdict CHANGES_REQUESTED, 0 HIGH + 2 MEDIUM + 4 NIT

Both MEDIUMs and all four NITs are resolved in-document (edits folded into the relevant sections, not appended). Each was re-checked against the actual source in the worktree (`src/config/env.ts`, `src/index.ts`, `src/pm2/client.ts`, `src/core/logger.ts`, `src/api/routes/processes.ts`) before being addressed.

| # | Sev | Disposition | Where resolved |
|---|---|---|---|
| 1 | MEDIUM | **Addressed.** Pinned the `ZodEffects` mechanics: new vars go **inside the existing `z.object({…})` literal before `.superRefine`**, and new `MODE` cross-field guards are added as `ctx.addIssue` blocks **inside the body of the single existing `superRefine` callback** after the auth/email guards. `AppConfig` stays `z.infer<typeof configSchema>`. Explicitly forbade `.extend()` and a second chained `.superRefine()`. Standalone requires no new vars and all existing vars keep working. | §1 "New variables added to `configSchema`" (mechanics block) + "Cross-field `superRefine` guards" heading/preamble |
| 2 | MEDIUM | **Addressed.** Pinned `bootstrapAgent()` to start the `AgentConnection` dial loop first/concurrently and wire `createPm2Adapter`/`Pm2Client.start()` in a background task exactly as `index.ts`, behind the same `Pm2Deps` facade (`PM2_UNAVAILABLE`/`[]`) until the real client is assigned — so the dial is never blocked by a hung/absent local PM2 daemon and a `control:request` before PM2 attaches returns a correlated `PM2_UNAVAILABLE` `ControlResult`. Stated the AC-14 guarantee explicitly. | §3 "Boot ordering: dial first, wire PM2 in the background"; §8 item 8 |
| 3 | NIT | **Addressed.** Noted the `logger.ts` docstring ("shallow + one level nested") is stale vs. the full-depth recursion the design relies on; pinned the §9 redaction-depth test as the source of truth and instructed updating the docstring while adding the keys. | §7 "Logger redaction / Redaction depth" |
| 4 | NIT | **Addressed.** Pinned that agent mode reuses the existing all-mode `ALLOWED_SCRIPT_ROOT` and builds its validators via `buildSchemas({ allowedScriptRoot: config.ALLOWED_SCRIPT_ROOT })` (the standalone call), confining remote `start-new` per agent host. No new variable. | §1 "`ALLOWED_SCRIPT_ROOT` is reused in agent mode"; §3 "Inbound command execution" |
| 5 | NIT | **Addressed.** Pinned that the agents create route returns **201 only when `result.ok === true`**; every not-ok create (and all other control results) uses `statusForControlCode(result.code)` with the error envelope; non-create ok returns 200. | §4 "HTTP status mapping" (agents-routes bullet) |
| 6 | NIT | **Addressed.** Pinned that all socket-teardown paths — `register:nack`, handshake-timeout/transport close, heartbeat/pong dead-link — funnel through the single idempotent `onLinkDead()` (one close, exactly one reconnect); `register:nack` logs the nack code before calling it. | §3 "Connection + reconnect" (`register:nack` bullet) + "Heartbeat and single-path liveness" |

**Alignment with requirements.** No scope changed. Finding #1 is a mechanical pinning of how the config schema is edited (no behavior change; standalone still requires zero new vars — NFR-1, AC-1/2/4/5/6). Finding #2 makes AC-14 hold by reusing the existing standalone deferred-PM2 pattern against the dial instead of a `listen` callback (no new behavior; same `Pm2Deps` facade, same `Pm2Client`). The four NITs are precision/correctness tightenings (a doc-staleness note, an existing-variable reuse statement, a status-code gate matching standalone's 201, and consolidating teardown through the existing idempotent `onLinkDead`) that add nothing to v1 scope. No requirement was backlogged or ignored.

### Second pass (prior) — `design-review.json` verdict CHANGES_REQUESTED, 0 HIGH + 3 MEDIUM + 4 NIT

Every finding below was re-verified against the actual source in the worktree before being addressed. All MEDIUMs and all NITs were resolved in-document.

| # | Sev | Disposition | Where resolved |
|---|---|---|---|
| 1 | MEDIUM | **Addressed.** Ported the standalone `onMetricsTick` prune to the server's `snapshot` handler: after replacing the `processes` map, every `MetricsStore` series whose name is not in the new snapshot is dropped (`entry.metrics.drop(name)`), so a deleted process leaves no ghost series for `sustainedAbove`/`processNames`. `update:metrics` only pushes; pruning is snapshot-only. Also pinned a throttled snapshot resend on process-set change so a steady-state `delete` is pruned within ≤1s, not only on reconnect. | §4 "Departed-process metric prune on `snapshot`"; §3 "Snapshot resend on process-set change"; §9 registry test |
| 2 | MEDIUM | **Addressed.** Pinned the agent-side `update:metrics` derivation: each online `ProcessSnapshot` maps to `{ name, ts: snap.lastUpdated, cpu, mem }`, `ts` carried **verbatim** and never re-stamped on send or receive, so `sustainedAbove` runs in the agent's time base identically to standalone. Clock skew explicitly accepted for v1. | §3 "`update:metrics` derivation and `ts` source" |
| 3 | MEDIUM | **Addressed.** The human WS log-relay validates `agentId` with `agentIdSchema` (and `process` with `processNameSchema`) **before** any registry lookup or upstream frame; failure returns `{ type:'error', code:'BAD_MESSAGE' }` touching neither registry nor upstream. The no-`agentId` standalone path is byte-identical. Added a hub-relay validation test. | §5 "Human WS log relay"; §8 item 18; §9 hub-relay test |
| 4 | NIT | **Addressed.** Corrected §7: `redactContext` recurses into nested plain objects to **full depth** and `token=` is redacted in any string at any depth; dropped the incorrect "one level" premise and the unnecessary "no secret deeper than one nested level" contract. Kept the single real edge — arrays are not key-redacted — as the one narrow contract (never array-wrap a secret), with a test. | §7 "Redaction depth"; §9 logger-redaction test |
| 5 | NIT | **Addressed.** Specified the extracted signature `backoffDelay(attempt, rand = Math.random)` so the jitter-bounds test injects `rand` returning 0/1/0.5 to assert `base*0.8`/`base*1.2`/`base` deterministically; `Pm2Client`/`AgentConnection` keep the default `rand` (behavior unchanged). | §3 "Connection + reconnect"; §8 item 1; §9 backoff test |
| 6 | NIT | **Addressed.** `register.agentId` is validated with `agentIdSchema` and `register.token` is `z.string().min(1)` in the protocol schema, so a blank/malformed handshake is rejected at `decode` (`BAD_MESSAGE`) before auth or any registry keying — making the `safeEqual('', …)===false` property defense-in-depth. Added gateway/codec tests for blank/garbage identity. | §2 "`register` field minimums"; §9 codec + gateway tests |
| 7 | NIT | **Addressed.** Added a `superRefine` guard rejecting `MODE==='server' && AGENT_WS_PATH==='/ws'` at config validation (fail-fast at boot), so the human `/ws` vs agent-path coexistence contract cannot be violated at runtime. Added an env test. | §1 cross-field guards; §4 agent-facing WS endpoint; §9 env test |

**Alignment with requirements.** Every second-pass disposition keeps the original requirements intact and changes no scope. Findings #1/#2 make per-agent metric retention and `sustainedAbove` behave exactly as standalone (NFR-4, AC-30), with no new behavior beyond porting the existing prune and pinning the existing `ts` field. Finding #3 extends the existing both-ends-validation posture (FR-8/NFR-3) to the WS relay path and leaves the standalone path byte-identical (NFR-1). The four NITs are precision/correctness fixes (a factual correction about `logger.ts`, a testability seam, two fail-fast schema guards) that tighten the defense-in-depth already specified and add nothing to v1 scope. No requirement was backlogged or ignored.

### First pass (prior) — verdict CHANGES_REQUESTED, 2 HIGH + 8 MEDIUM + 3 NIT (all resolved; retained for traceability)

| # | Sev | Disposition | Where resolved |
|---|---|---|---|
| 1 | HIGH | **Addressed.** Dropped the "engine unchanged" claim; chose approach (a): a single **agent-aware** engine with composite `agentId/name` keys and an extended matcher (`ruleTargets`/`targetNames` split on the last `/`, matching `*` \| full key \| bare name). Documented as an explicit engine change with tests. Rejected approach (b) (one engine per agent) with reasons. | §6 "Agent-aware engine changes"; Overview |
| 2 | HIGH | **Addressed.** Agent-scoped targeting is **in v1**. Widened `processSelector` in `src/config/alertRules.ts` with a validated `agentId/name` composite form; it is a superset so existing rule files are unchanged. | §6 "Rule schema: allow agent-scoped targets" |
| 3 | MEDIUM | **Addressed.** `AlertPayload` gains optional `agentId`/`agentAlias`; the engine takes an injected `resolveAgent(key)` and `buildPayload` splits the composite key + attaches attribution + prefixes summary/title. Standalone injects an identity resolver → fields absent, output byte-identical. | §6 "Agent-aware engine changes" #4 + "Alert payload" |
| 4 | MEDIUM | **Addressed.** Pinned the server-mode health shape (`{status,mode,maintenance,agents:{total,online},version,uptimeMs}`, no `pm2Connected`); added a dedicated `createServerHealthRouter` (no `StateDeps`); `mode` added to standalone health too; `/api/system/status` not mounted in server mode. | §5 "Health route in server mode" |
| 5 | MEDIUM | **Addressed.** Added a shared `statusForControlCode` table (409/404/400/502) used by the agents routes; standalone `sendControlResult` left unchanged. | §4 "Command routing" |
| 6 | MEDIUM | **Addressed.** Agent (and server) validate with `createProcess.safeParse({ body: opts })`, consume the **post-transform** body (cluster default-injection), return `VALIDATION` on failure, and check path existence on the agent's disk. | §3 "Inbound command execution" |
| 7 | MEDIUM | **Addressed.** Pinned a bounded **200-line live ring per `(agentId,process)`**, populated only during an active subscription; REST read with no subscription returns `{ name, lines: [] }`; documented divergence from the standalone file tail; `log:tailRequest` deferred out of v1. | §5 "Logs over REST" |
| 8 | MEDIUM | **Addressed.** In-memory map is the source of truth, updated synchronously on `set()`, with serialized/coalesced writes converging to the latest value (no regression); `GET /api/agents` is keyed by the live registry and does not list pre-seeded aliases for never-connected ids. | §4 "AliasStore — Concurrency and durability / all() vs. the live registry" |
| 9 | MEDIUM | **Addressed.** Before `register` the only accepted frame is `register` (others → `error:frame` + close); hard non-extendable 5s handshake timeout that closes the socket; `MAX_PENDING_AGENT_SOCKETS` (default 50) cap refusing new upgrades with 503-and-destroy; proxy rate-limit noted but not relied on. | §4 "Pre-auth hardening" |
| 10 | MEDIUM | **Addressed.** `backoffAttempt` resets **only on `register:ack`**, not on socket `open`, so an auth-failing agent holds at the 30s cap; retries are unbounded so a later token addition is picked up. | §3 "Connection + reconnect" |
| 11 | NIT | **Addressed** (and further corrected by second-pass finding #4). Agent token keys added to redaction; regression test added. | §7 "Logger redaction"; §9 testing |
| 12 | NIT | **Addressed.** Concrete `heartbeatSec` default = 15s; both app-heartbeat and transport pong timeouts route through a single idempotent `onLinkDead()` (single close). | §3 "Heartbeat and single-path liveness" |
| 13 | NIT | **No change required** (as the review states). The `control:request` vs `control:createRequest` split matches `ControlAction` + `startNew`; kept distinct. | §2 message table |
