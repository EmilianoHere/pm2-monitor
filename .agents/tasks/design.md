# Technical Design — PM2 Process Monitor & Control Panel

## Overview

This document specifies the implementation architecture for the PM2 monitor and control panel described in `requirements.md`. The application is a single Node.js + TypeScript process that connects to the local PM2 daemon through the official `pm2` programmatic API, keeps an in-memory view of every managed process (status, metrics history, error buffer), serves a REST API and a vanilla-JS dashboard over Express, pushes live updates over a `ws` WebSocket, and raises alerts through MS Teams webhooks and SMTP email according to configurable rules. The monitor is itself runnable as a PM2 process via a provided `ecosystem.config.js`.

The design is organized around a central in-memory **state hub** (`MonitorState`) that owns the canonical snapshot of all processes, metrics, and errors. All subsystems read from and write to this hub through narrow interfaces: the PM2 integration layer feeds it, the alert engine evaluates rules against it on a timer, the WebSocket layer broadcasts its diffs, and the API layer serves its reads and issues control commands. This keeps the modules decoupled (no module calls another module's internals directly — they communicate through the hub plus a small typed event emitter) and makes each unit testable in isolation by substituting the hub or the PM2 layer with a fake.

The technology stack is fixed by the requirements and is not reconsidered here: Node 20+, TypeScript strict, Express, `ws`, the `pm2` programmatic API, Nodemailer, `dotenv` plus an optional JSON alert-rules file, `zod` for validation, a small custom logger, and a no-build vanilla HTML/JS/CSS dashboard.

## Technology stack (locked)

| Concern | Choice | Version pin strategy |
| --- | --- | --- |
| Runtime | Node.js 20+ LTS | `engines.node: ">=20"` |
| Language | TypeScript 5.x, `strict: true` | exact pin, e.g. `5.6.3` |
| HTTP | Express 4.x | exact pin |
| WebSocket | `ws` 8.x | exact pin |
| PM2 API | `pm2` 5.x programmatic | exact pin |
| Email | `nodemailer` 6.x | exact pin |
| Teams | Node 20 global `fetch` (no dependency) | n/a |
| Validation | `zod` 3.x | exact pin |
| Env config | `dotenv` 16.x | exact pin |
| Dev runner | `tsx` (watch) | exact pin (devDependency) |
| Logger | custom (`src/core/logger.ts`), no dependency | n/a |

All runtime dependencies are pinned to exact versions (no `^`/`~`) in `package.json` to satisfy NFR5. MS Teams delivery uses the built-in global `fetch` so no HTTP client dependency is added; this is chosen over `axios` to keep the dependency tree small (NFR3) and because Node 20 ships a stable `fetch`.

## On-disk project layout

```
pm2-monitor/
├── package.json                 # pinned deps; scripts: build, start, dev, typecheck, lint
├── tsconfig.json                # strict, target ES2022, module NodeNext, outDir dist
├── ecosystem.config.js          # runs the monitor itself under PM2
├── .env.example                 # every env var documented
├── .gitignore                   # updated: adds explicit `.env` and `logs/` lines (beyond existing *.log)
├── README.md                    # usage, config, API reference, example payloads
├── config/
│   └── alert-rules.example.json # sample alert-rule config
├── public/                      # dashboard, served statically by Express (no bundler)
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── app.js               # bootstrap, routing between overview/detail
│       ├── api.js               # REST client (adds auth header)
│       ├── ws.js                # WebSocket client with auto-reconnect
│       ├── views/overview.js    # process cards grid
│       ├── views/detail.js      # per-process detail + metrics chart
│       └── views/logs.js        # live log viewer with filter/search
└── src/
    ├── index.ts                 # entry point: wires modules, starts server, handles shutdown
    ├── config/
    │   ├── env.ts               # dotenv load + zod-validated env schema -> AppConfig
    │   └── alertRules.ts        # loads + zod-validates the JSON alert-rules file
    ├── core/
    │   ├── logger.ts            # structured JSON logger (levels, child loggers)
    │   ├── events.ts            # typed EventEmitter (MonitorEvents) used across modules
    │   └── state.ts             # MonitorState hub: processes, metrics, errors, maintenance
    ├── pm2/
    │   ├── client.ts            # Pm2Client: connect, reconnect, list/describe/control, launchBus
    │   └── mapper.ts            # maps raw pm2 ProcessDescription -> ProcessSnapshot
    ├── errors/
    │   ├── tracker.ts           # ErrorTracker: ring buffer, counters, windows
    │   └── signature.ts         # stack/message -> dedup signature
    ├── metrics/
    │   └── store.ts             # MetricsStore: per-process ring of {ts,cpu,mem} samples
    ├── alerts/
    │   ├── engine.ts            # AlertEngine: evaluates rules, cooldown, maintenance gate
    │   ├── cooldown.ts          # per-rule/per-process cooldown tracker
    │   ├── digest.ts            # daily digest scheduler + payload builder
    │   └── channels/
    │       ├── types.ts         # AlertChannel interface + AlertPayload
    │       ├── teams.ts         # TeamsChannel: MessageCard POST via fetch
    │       └── email.ts         # EmailChannel: Nodemailer transport
    ├── api/
    │   ├── server.ts            # Express app factory, static mount, routes, error handler
    │   ├── auth.ts              # auth middleware (API key or basic user/pass)
    │   ├── validate.ts          # zod validation helper middleware
    │   ├── schemas.ts           # zod request schemas + path/name sanitizers
    │   └── routes/
    │       ├── processes.ts     # list/detail/control endpoints
    │       ├── logs.ts          # log read/search endpoints
    │       ├── errors.ts        # error list/export endpoints
    │       ├── alerts.ts        # rules read, maintenance mode, test-alert
    │       └── system.ts        # health/status endpoint
    └── ws/
        └── hub.ts               # WsHub: upgrade auth, subscriptions, broadcast, log-tail
```

## Core data model

All types live beside their owning module but the shared snapshot types are defined in `src/core/state.ts` and imported elsewhere.

```ts
type ProcStatus = 'online' | 'stopping' | 'stopped' | 'launching'
  | 'errored' | 'one-launch-status' | 'unknown';

interface ProcessSnapshot {
  pmId: number;              // pm_id
  name: string;
  pid: number | null;
  status: ProcStatus;
  cpu: number;               // percent
  memory: number;            // bytes
  uptimeMs: number | null;   // now - pm_uptime
  restarts: number;          // restart_time
  unstableRestarts: number;  // unstable_restarts
  mode: 'fork' | 'cluster';
  instances: number;
  execPath: string | null;
  lastUpdated: number;       // epoch ms of last refresh
}

interface MetricSample { ts: number; cpu: number; mem: number; }

// A single physical log line returned by readLogsTail and the REST /logs endpoint.
// Levels mirror the live-tail model exactly: out ⇒ info, err ⇒ error (no other level).
interface LogLine {
  stream: 'out' | 'err';
  level: 'info' | 'error';   // derived from stream: out ⇒ info, err ⇒ error
  line: string;              // the raw log text, one physical line
  ts: number;                // embedded/estimated timestamp; falls back to read order
}

interface TrackedError {
  signature: string;         // dedup key
  processName: string;
  firstSeen: number;
  lastSeen: number;
  count: number;             // total occurrences for this signature
  level: 'error' | 'crash' | 'restart';
  intentional?: boolean;     // only meaningful for level 'restart': true = operator-initiated
                             // (token consumed); false/undefined = crash-loop restart.
                             // The restart-window counter counts only intentional === false.
  message: string;           // first line / summary
  sample: string;            // trimmed representative stack/text
}

interface MonitorSnapshot {
  processes: ProcessSnapshot[];
  pm2Connected: boolean;
  maintenance: boolean;
  generatedAt: number;
}
```

`MonitorState` holds: `Map<string, ProcessSnapshot>` keyed by process name, the `MetricsStore`, the `ErrorTracker`, a `pm2Connected` boolean, a `maintenance` boolean with optional expiry, and a reference to the typed `MonitorEvents` emitter. It exposes read methods (`snapshot()`, `getProcess(name)`, `getMetrics(name, sinceMs)`) and mutation methods (`applyPm2List(list)`, `setConnected(bool)`, `setMaintenance(...)`). Mutations emit events (`state:update`, `process:transition`, `pm2:connected`, `pm2:disconnected`) that the WS hub and alert engine subscribe to. The typed `MonitorEvents` emitter also carries `metrics:tick` (payload `ProcessSnapshot[]`, emitted by `Pm2Client` after each successful poll `list()`; see the metrics poll loop) and `error:captured`; `MonitorState` subscribes to `metrics:tick` to push samples into the `MetricsStore`, and `AlertEngine` subscribes to it for sampled-rule evaluation.

## Module boundaries and interfaces

### Config loader (`src/config/env.ts`, `src/config/alertRules.ts`)

`loadConfig(): AppConfig` runs `dotenv.config()`, then parses `process.env` through a zod schema into a typed, frozen `AppConfig`. The schema coerces numeric env vars, applies defaults, and **fails fast**: on a validation error it logs the aggregated zod issues and the process exits with code 1 (a misconfigured server must not start). Secrets (SMTP password, API key, basic-auth password, Teams webhook URL) are read only here and only from env; they are never logged (the logger has a redaction list of these keys).

`AppConfig` fields (full list mirrored in `.env.example`):

| Env var | Type | Default | Required | Notes |
| --- | --- | --- | --- | --- |
| `PORT` | number | `3000` | no | HTTP + WS port |
| `HOST` | string | `127.0.0.1` | no | bind address |
| `AUTH_MODE` | `apikey`\|`basic` | `apikey` | no | selects auth strategy |
| `API_KEY` | string | — | if `apikey` | shared key |
| `BASIC_USER` | string | — | if `basic` | username |
| `BASIC_PASS` | string | — | if `basic` | password |
| `SMTP_HOST` | string | — | if email enabled | — |
| `SMTP_PORT` | number | `587` | no | — |
| `SMTP_SECURE` | boolean | `false` | no | TLS on connect |
| `SMTP_USER` | string | — | if email enabled | — |
| `SMTP_PASS` | string | — | if email enabled | redacted |
| `MAIL_FROM` | string | — | if email enabled | — |
| `MAIL_TO` | string | — | if email enabled | comma list |
| `TEAMS_WEBHOOK_URL` | string(url) | — | if teams enabled | redacted |
| `ALERT_RULES_FILE` | string | `config/alert-rules.json` | no | optional file |
| `METRICS_RETENTION_MIN` | number | `180` | no | ring window |
| `METRICS_SAMPLE_SEC` | number | `5` | no | poll interval |
| `ERROR_BUFFER_SIZE` | number | `500` | no | ring capacity per process |
| `ERROR_LOG_APPEND` | boolean | `false` | no | append to `logs/errors.log` |
| `DEFAULT_COOLDOWN_SEC` | number | `300` | no | per-rule anti-spam default |
| `INTENTIONAL_ACTION_GRACE_MS` | number | `10000` | no | base grace window for intentional-action tokens; `kill_timeout` added on top when known |
| `ALLOWED_SCRIPT_ROOT` | string | — | no | optional prefix that `startNew` script/ecosystem paths must live under (defense in depth; off by default) |
| `DIGEST_ENABLED` | boolean | `false` | no | daily digest toggle |
| `DIGEST_HOUR` | number(0-23) | `8` | no | local hour to send |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` | `info` | no | — |

Email and Teams channels are considered "enabled" when their required vars are present; absent config disables that channel (logged once at startup) rather than erroring, so a Teams-only or email-only deployment is valid. Zod cross-field refinement enforces "if `AUTH_MODE=basic` then `BASIC_USER`+`BASIC_PASS` present", and likewise channel groups.

`loadAlertRules(path): AlertRule[]` reads the optional JSON file. If the path does not exist, it returns `[]` and logs a warning (monitoring continues with no rules). If the file exists but fails zod validation, the loader logs the issues and exits (an operator who wrote a rules file must know it is broken). The file is also re-loadable at runtime via `POST /api/alerts/rules/reload` so operators can edit rules without restarting.

### PM2 integration layer (`src/pm2/client.ts`)

`Pm2Client` is the only module that touches the `pm2` package. Public interface:

```ts
// Control acts on an EXISTING process identified by its pm2 name.
// 'start' here = start an already-registered but stopped process; creating a
// brand-new process is startNew (never control).
type ControlAction = 'start' | 'stop' | 'restart' | 'reload' | 'delete';

interface StartNewOpts {           // mirrors the POST /api/processes body verbatim
  script?: string;                 // absolute, sanitized; XOR ecosystem
  ecosystem?: string;              // absolute, sanitized; XOR script
  name?: string;                   // process-name rule
  instances?: number;              // 1..128
  exec_mode?: 'fork' | 'cluster';
}

interface LogTailOpts {            // see readLogsTail pipeline below
  stream?: 'out' | 'err' | 'all'; // default 'all'
  q?: string;                      // substring, or /regex/
  level?: 'info' | 'error';        // post-slice filter
}

interface Pm2Client {
  start(): void;                        // begin connect + reconnect loop; non-blocking
  stop(): Promise<void>;                // disconnect, close bus
  isConnected(): boolean;
  list(): Promise<ProcessSnapshot[]>;   // pm2.list -> mapped
  describe(name: string): Promise<ProcessSnapshot | null>;
  control(action: ControlAction, name: string): Promise<ControlResult>; // targets existing process BY NAME
  startNew(opts: StartNewOpts): Promise<ControlResult>;                  // creates a new process
  readLogsTail(name: string, lines: number, opts?: LogTailOpts): Promise<LogLine[]>; // reads pm_out/pm_err files
}
```

`control` always targets an **existing** process by its pm2 `name` (the sanitized map key), never by `pm_id`; it resolves the name to the current `pm_id`(s) internally. `control('start', name)` starts an already-registered-but-stopped process, which is distinct from `startNew`, which registers and launches a brand-new one. For cluster apps, `control` acts on all instances of that name (see `ControlResult` note below).

**Connection + reconnection.** On `start()` it calls `pm2.connect`. On success it sets `pm2Connected=true` on the state hub, performs an initial `list()`, and calls `pm2.launchBus`. On failure, or on a later `disconnect`/`error` from the bus, it enters a reconnection loop with exponential backoff (1s, 2s, 4s … capped at 30s, with ±20% jitter) that retries `pm2.connect` indefinitely. Each failed attempt logs at `warn` (first failure) then `debug` (subsequent, to avoid log spam), and the state hub stays `pm2Connected=false`. This loop is what delivers the graceful-degradation requirement (see dedicated section). All `pm2` callback APIs are wrapped in small `promisify`-style helpers so the rest of the method bodies are async/await and errors become rejected promises.

**Bus events — pinned packet contract.** `launchBus` yields a bus on which the client subscribes to **four** channels: `process:event`, `process:exception`, `log:err`, and `log:out`. The exact packet shapes the mapper expects are pinned below. These shapes reflect PM2 5.x `launchBus` behavior; because `pm2` is not installed in the repo at design time, the mapper reads defensively (see "Field-path defense" below) so it tolerates the two historically observed layouts without needing to be rewritten once the installed version is known.

```ts
// Channel: 'process:event' — lifecycle transitions
interface Pm2ProcEventPacket {
  event: 'online' | 'stop' | 'restart' | 'exit' | 'delete' | 'restart overlimit' | 'start';
  process: {
    name: string;
    pm_id: number;
    status: ProcStatus;
    pm_uptime: number;        // epoch ms process came up
    restart_time: number;
    unstable_restarts: number;
  };
  at: number;                 // epoch ms of the event
}

// Channel: 'process:exception' — uncaught exception inside a managed process
interface Pm2ExceptionPacket {
  process: { name: string; pm_id: number };
  data: { message?: string; stack?: string } | string;  // shape varies by pm2 version
  at?: number;
}

// Channels: 'log:err' and 'log:out' — one packet per emitted log chunk
interface Pm2LogPacket {
  process: { name: string; pm_id: number };
  data: string;               // the raw log text (may contain multiple lines)
  at?: number;
}
```

**Field-path defense.** The lifecycle event name has historically appeared either as `packet.event` (flat) or nested as `packet.data.event` depending on pm2 version. The mapper resolves it as `const ev = packet.event ?? packet.data?.event` and the process block as `const proc = packet.process ?? packet.data?.process`, so it works regardless of which layout the installed `pm2` emits. This is the single verification gap called out by the design review (Finding 1) and the defensive read is the chosen mitigation; the installed `pm2` version is confirmed at implementation time and the dead branch, if any, is removed then.

**Event → MonitorEvents translation:**
- `process:event` resolved `ev`:
  - `online` / `start` → snapshot refresh, `process:transition` (to `online`); never an error.
  - `restart` → snapshot refresh, `process:transition`; emits `error:captured` level `restart` **tagged with `intentional`** (see below). A `restart` manifests on the bus as an `exit` packet followed by an `online` packet; the intentional-action token model below both suppresses the `exit` half's crash classification and determines the `intentional` flag on the emitted `restart` error: if the restart's `exit`/`stop` half consumed a `restart` token (operator/dashboard-initiated) the emitted `error:captured` carries `intentional: true`; a crash-loop restart (no token consumed) carries `intentional: false`. The `restart-threshold` alert condition counts **only** `intentional: false` restarts (crash-loop restarts); it does **not** count `restart overlimit`, which is a terminal `errored` crash and is kept disjoint from the restart window (see the `restart overlimit` bullet and MEDIUM-3). Operator maintenance restarts (`intentional: true`) never trip it either (Finding 4).
  - `restart overlimit` → `process:transition` (to `errored`); emits `error:captured` level `crash`. This is the PM2 "errored" terminal state and is what the `errored` alert condition keys on. **It drives the `errored` condition ONLY and does NOT increment the restart-window counter (Finding 3 / MEDIUM-3):** a `restart overlimit` event is classified as a terminal crash (`errored`), never as one more entry in the restart-threshold window, so a single `restart overlimit` maps to exactly one condition and the "at most one condition per lifecycle event" invariant holds. Crash-loop restarts short of overlimit still feed `restart-threshold` via the ordinary `restart` level with `intentional === false`.
  - `exit` → snapshot refresh; emits `error:captured` level `crash` **only if** no matching intentional-action token is consumed (see token model); otherwise it is an expected exit and no error is captured.
  - `stop` → snapshot refresh, `process:transition` (to `stopped`); classified intentional vs unexpected via the token model.
  - `delete` → removes the process from the snapshot map; never an error.
- `process:exception` → emits `error:captured` **level `crash`** (uncaught exceptions are the highest-signal crash evidence and must not be missed; subscribing to this channel in addition to `process:event` is the Finding 1 fix). The `data` field is normalized to a `{ message, stack }` pair by reading `data.stack ?? data.message ?? String(data)`.
- `log:err` → the `data` text is split on newlines; each non-empty line emits `log:line` (level `error`) and feeds the ErrorTracker (level `error`).
- `log:out` → split on newlines; each non-empty line emits `log:line` (level `info`); not treated as an error.

**Metrics poll loop — owned by `Pm2Client`, dispatched via `metrics:tick` (Finding 1 / MEDIUM-1).** `Pm2Client` owns a single `setInterval(METRICS_SAMPLE_SEC)` timer (started once on first successful connect, cleared on `stop()`), and it is the one and only module that drives the metrics path. Each tick:

1. Calls `list()` to get the fresh `ProcessSnapshot[]` (which also refreshes CPU/memory/uptime). A transient `list()` error skips the tick (no event emitted), logs at `debug`, and keeps the last samples (per the error-handling table).
2. On success, applies the list to the hub (`MonitorState.applyPm2List`, same path the initial list uses) and then emits a single `metrics:tick` event carrying that `ProcessSnapshot[]`. There is exactly one `metrics:tick` per successful poll.

Two consumers subscribe to `metrics:tick`, in this order:

- **`MonitorState`** maps each snapshot to a `MetricSample` and calls `MetricsStore.push(name, { ts: snap.lastUpdated, cpu: snap.cpu, mem: snap.memory })` (note the field rename: snapshot `memory` → sample `mem`). Push rules for edge states are explicit: a snapshot whose `status !== 'online'` (stopped/errored/launching/stopping/unknown) is **skipped — no sample is pushed** rather than pushing zeros, so a stopped process cannot have its gap of absent samples read as "0% CPU/0 bytes sustained" and no CPU/mem rule can be satisfied or reset by a dead process. A process that was `delete`d (removed from the snapshot map) has its MetricsStore ring **dropped** on the next tick: `MonitorState` prunes any `MetricsStore` series whose name is no longer in the snapshot map, so deleted-process samples do not leak memory and a later re-created same-named process starts with a fresh series.
- **`AlertEngine`** runs sampled-rule evaluation (`cpu-threshold`, `mem-threshold`) once per tick, reading the just-updated series via `MonitorState.getMetrics` → `MetricsStore.sustainedAbove`. Because `MonitorState` is subscribed first, the samples are already pushed before the engine evaluates, so each tick evaluates against the sample it just produced.

The poll is the source of truth for metric-threshold rules; the bus is the source of truth for crash/restart rules. Uncaught-exception crashes come from `process:exception`, lifecycle crashes/stops from `process:event`.

**Control + sanitization.** `control()` and `startNew()` validate their inputs (see Input validation) and translate to `pm2.restart/stop/start/reload/delete`. `startNew` only accepts a sanitized absolute script path or a sanitized ecosystem-file path (see sanitization rules). `ControlResult` is `{ ok: true, process: ProcessSnapshot } | { ok: false, code: string, message: string }`. If the daemon is disconnected, control calls short-circuit to `{ ok: false, code: 'PM2_UNAVAILABLE' }` without throwing.

**Aggregate semantics (Finding 6).** `ProcessSnapshot` — and therefore `ControlResult.process` — is the per-**name aggregate** across all instances of that process, not a per-instance record: `instances` is the instance count, `cpu`/`memory` are summed/representative across instances as pm2 reports them, and `pmId`/`pid` reflect the primary/first instance. So `control('restart', name)` on a cluster app with N instances returns one aggregate snapshot for the name, not N snapshots.

**Duplicate names across `pm_id`s (NIT, Finding 4-of-round-3).** PM2 permits two separately started fork apps to share a name; the name-keyed `MonitorState` map collapses them into **one aggregate** entry (last-writer-wins per `applyPm2List`, same as the cluster aggregate above). This is an accepted limitation: operators are expected to use unique process names, documented in the README. The mapper logs a one-time `warn` on a detected name collision (same name, differing `pm_id` set across a list) so the operator is told their names clash rather than silently seeing merged metrics.

**Intentional-action token model (owned by `Pm2Client`).** To tell operator-initiated stops/restarts apart from crashes (used by the `unexpected-stop` condition and by the `exit`-crash suppression above), the client maintains a per-process **queue of intentional-action tokens**, not a flat set. This is the concrete fix for Finding 2.

```ts
interface IntentionToken { kind: 'stop' | 'restart' | 'delete'; expiresAt: number; }
// per-process FIFO queue:
private intentions = new Map<string, IntentionToken[]>();
```

- **On a control call**, before invoking pm2, the client pushes **one token per expected lifecycle event**, i.e. one per running instance (read from the current snapshot's `instances`; falls back to `1` if unknown):
  - `stop` → push `instances` × `{ kind:'stop' }`.
  - `delete` → push `instances` × `{ kind:'delete' }` (a delete also produces a terminal `exit`/`stop`).
  - `restart` / `reload` → push `instances` × `{ kind:'restart' }`. A restart emits an `exit` then an `online`; the token is consumed by the `exit`/`stop` half, and the subsequent `online` is always treated as normal, so the restart's `exit` is correctly suppressed. Consuming a `restart` token also marks the resulting `restart` lifecycle event as **`intentional: true`**, so the `error:captured` level `restart` it emits is excluded from the restart-window counter and cannot trip `restart-threshold` (Finding 4). A `restart` event whose `exit` half found **no** token to consume is a crash-loop restart and emits `intentional: false`.
  - `start`/`startNew` → no token (a start produces `online`, never a stop/exit, so nothing needs suppressing).
- `expiresAt = now + GRACE_MS`, where `GRACE_MS = INTENTIONAL_ACTION_GRACE_MS` (new env var, default `10000`) **plus** the process's `kill_timeout` when `describe` exposes it (`GRACE_MS = base + killTimeout`). Deriving from `kill_timeout` prevents the false alert the review described for processes with a long graceful-shutdown window.
- **On a PM2 `exit`/`stop` event** for process `name`: the client first drops expired tokens from that process's queue, then **consumes exactly one** non-expired token (FIFO) if present. Match semantics are explicit: **one token suppresses exactly one lifecycle event** — a cluster app that emits N `exit` packets for one operator stop had N tokens pushed, so each is consumed by one event and none leaks. If no non-expired token remains, the event is **unexpected** (→ `error:captured` crash for `exit`, and eligible for the `unexpected-stop` alert condition).
- The queue is swept on every consume and on a 30s janitor timer so expired tokens never accumulate.

This model replaces the earlier "15s set" entirely; the magic 15s is gone, the grace window is configurable and `kill_timeout`-aware, cluster instance counts are handled, and the restart `exit`/`online` pair is unambiguous.

**Log reading — bounded tail then in-memory filter.** `readLogsTail(name, lines, opts?: LogTailOpts)` (with `opts = { stream, q, level }`) resolves the process's `pm_out_log_path`/`pm_err_log_path` from `describe`, then reads the **trailing `lines` physical lines** of the selected file(s) directly (bounded read from the end of file) and returns `LogLine[]` (the type defined in the Core data model). The pipeline order is fixed and documented:
1. Read the trailing `lines` physical lines (bounded end-of-file read; `lines` clamped to ≤2000).
2. Tag each line with its level by origin: lines from the `err` file are `error`, from the `out` file are `info`. For `stream=all`, merge and sort by the line's embedded/estimated timestamp (falling back to read order).
3. Apply the `level` filter (keep only `info` or only `error`) and then the `q` filter (case-insensitive substring; a `/pattern/` form is treated as a regex) **to that slice in memory**.

Consequence, stated plainly: results are limited to the recent tail window. A `q` search can return fewer than `lines` results, and matches older than the last `lines` physical lines are **not** visible — whole-history search is **out of scope** and is documented as such in the README so operators are not surprised. This resolves the contradiction the review flagged (bounded read cannot do whole-file search): the design commits to bounded-read-then-filter.

This is used for the "read logs" REST endpoint and for the dashboard's initial backfill; the WS live tail is served by the hub off the bus `log:line` events, not by re-reading files. **Unknown vs file-missing (NIT, Finding 5-of-round-3):** the `GET /api/processes/:name/logs` route resolves `:name` against the snapshot map **before** calling `readLogsTail` and returns `404 NOT_FOUND` for an unknown name (consistent with `GET /api/processes/:name`); only when the process exists but its file is missing/unreadable does it return `200 { lines: [] }`. So `readLogsTail` is only ever invoked for a process known to the hub.

`mapper.ts` is a pure function `mapProcess(raw): ProcessSnapshot` — fully unit-testable with recorded `pm2.list` fixtures, no I/O.

### Error tracker (`src/errors/tracker.ts`, `src/errors/signature.ts`)

`ErrorTracker` subscribes to `error:captured` events. For each event it computes a signature (below), looks it up in a per-process `Map<signature, TrackedError>`, and either increments `count`/`lastSeen` or inserts a new entry. A global ring buffer per process (capacity `ERROR_BUFFER_SIZE`, implemented as a fixed-size circular array of `TrackedError` references ordered by `lastSeen`) bounds memory; when full, the oldest entry is evicted. **Per-rule time windows over a single max-sized slot ring (Finding 2 / MEDIUM-2).** The tracker keeps, per process, two 1-second-slot ring buffers of integer counts — one for `error`-level events (feeding `error-spike` and the digest) and one for crash-loop restarts (feeding `restart-threshold`) — and exposes:

```ts
countInWindow(name: string, sinceSec: number): number   // sums the trailing `sinceSec` 1-second slots of the error ring
restartsInWindow(name: string, sinceSec: number): number // same, over the restart ring
```

The ring length is **not** a fixed constant: on load and on every `POST /api/alerts/rules/reload`, the tracker is told the **maximum window any loaded rule requests** — `maxWindowSec = max( each error-spike rule's withinSec, each restart-threshold rule's withinMin*60 )`, defaulting to a small floor (e.g. 60s) when no windowed rule is loaded. Both rings are **sized to that max** (`ceil(maxWindowSec)` one-second slots), recomputed and resized on reload. The engine then asks for each rule's own window: `error-spike` calls `countInWindow(name, rule.withinSec)`, `restart-threshold` calls `restartsInWindow(name, rule.withinMin*60)`. Summing the trailing `sinceSec` slots gives that rule's exact window count regardless of other rules' windows, so coexisting rules with different windows no longer share one ambiguous counter.

**Over-buffer behavior: size-to-max, never clamp-and-undercount.** Because the ring is always sized to the largest requested window, a `countInWindow`/`restartsInWindow` call can never ask for more slots than exist, so there is no silent under-count. As a defensive guard, if a caller ever passes `sinceSec > ringLengthSec` (should not happen after a correct resize), the tracker clamps the read to the ring length and logs a one-time `warn` naming the rule window and the ring size, so the misconfiguration is visible rather than silently truncating. Reload shrinks the ring when the new max is smaller (older slots beyond the new length are discarded) and grows it (new slots start at zero) when larger.

It maintains the restart ring as a **separate counter** that increments only on `error:captured` level `restart` with `intentional === false` (crash-loop restarts); operator-initiated restarts (`intentional === true`) are recorded in the ring buffer for visibility but are **excluded** from the restart counter, so `restart-threshold` catches crash-looping only (Finding 4). Whether `restart overlimit` increments the restart counter is specified under MEDIUM-3 below (it does **not**). If `ERROR_LOG_APPEND` is true, each newly captured raw error is appended as one JSON line to `logs/errors.log` (best-effort; a write failure is logged at `warn` and never throws).

**Signature algorithm (`signature.ts`).** Deterministic, pure:
1. Take the error text (stderr line group or the `err`/`stack` field).
2. If a stack trace is present, extract the first stack frame line matching `/at .+ \(?(.+):\d+:\d+\)?/`; otherwise use the first non-empty line of the message.
3. Normalize: strip absolute path prefixes to basenames, replace line:column numbers with `:*`, replace long hex/uuid/number runs (`/\b[0-9a-f]{8,}\b/`, `/\d{3,}/`) with `#`, collapse whitespace, lowercase.
4. Prepend the process name.
5. Hash the normalized string with Node's `crypto.createHash('sha1')` and take the first 16 hex chars.

This groups "same error, different timestamp/pid/line-column" into one entry while keeping distinct errors separate. The function is exported standalone for unit testing against crafted inputs.

### Metrics store (`src/metrics/store.ts`)

`MetricsStore` keeps, per process name, a ring buffer of `MetricSample`. Capacity is derived from retention and sample interval: `ceil(METRICS_RETENTION_MIN*60 / METRICS_SAMPLE_SEC)`. `push(name, sample)` appends and evicts expired/overflow samples. `getSeries(name, sinceMs)` returns the samples in range.

**Series read goes through the hub (Finding 5).** The stated invariant is "no module calls another module's internals directly — they communicate through the hub." To honor it, `MetricsStore.getSeries` is **internal to the hub**: the only public read of a per-process series is `MonitorState.getMetrics(name, sinceMs)`, which simply delegates to the `MetricsStore.getSeries(name, sinceMs)` it owns. The `/api/processes/:name/metrics` route and the dashboard chart call `MonitorState.getMetrics` **only** and never reach into `MetricsStore`. `getSeries` is not part of any route or cross-module contract; it is an implementation detail of `MetricsStore` reached exclusively via the hub.

**`sustainedAbove(name, metric: 'cpu' | 'mem', threshold, durationSec)` — coverage tolerance (Finding 3).** The `metric` selector is typed `'cpu' | 'mem'` and indexes **`MetricSample`** (whose fields are `cpu`/`mem`), **not** `ProcessSnapshot` (whose memory field is `memory`); the snapshot→sample rename happens once in the `metrics:tick` push (`mem: snap.memory`), so this primitive only ever sees `cpu`/`mem` and a stray `'memory'` would not type-check (NIT, Finding 6-of-round-3). The naive "every expected sample present" rule silently never fires after a fresh start, a reconnect, or any skipped poll tick, which conflicts with AC12. The concrete contract instead is:

1. Let `sampleSec = METRICS_SAMPLE_SEC`, `expected = ceil(durationSec / sampleSec)`, and `required = max(1, expected - 1)` (tolerate losing one sample to a boundary/skip).
2. Collect the samples whose `ts` falls in the trailing `durationSec` window.
3. Return `false` (fail-safe, **documented**) if coverage is insufficient, meaning either fewer than `required` samples are present, OR any adjacent-sample gap exceeds `2 * sampleSec` (a real hole, not just a boundary rounding). Returning `false` under insufficient coverage means a rule can never fire on sparse/garbage data, and a steady-state process accumulates full coverage within one `durationSec` window after start/reconnect, so the rule arms itself promptly rather than being suppressed indefinitely.
4. When coverage is sufficient, return `true` iff **every** collected sample's `metric` exceeds `threshold`.

This is the single primitive the CPU/memory alert rules use, so the sustained + coverage logic lives in one unit-tested place (fed an injected clock and crafted sample arrays, including gap and under-coverage cases) rather than in the engine.

### Alert engine (`src/alerts/engine.ts`, `cooldown.ts`)

`AlertEngine` holds the loaded `AlertRule[]`, the `CooldownTracker`, and the list of enabled `AlertChannel`s. It evaluates in two ways:
- **Event-driven** rules are checked when the relevant `MonitorEvents` fire (`process:transition`, `error:captured`), reading current counters from the ErrorTracker/state:
  - `errored` → on `process:transition` whose `to === 'errored'` (reached via `restart overlimit`), disjoint from `unexpected-stop` per the schema section.
  - `unexpected-stop` → on `process:transition` to `stopped`/`exit` that the `Pm2Client` token model classified as unexpected (no token consumed).
  - `restart-threshold` → on `error:captured` level `restart` with `intentional === false`, calling `ErrorTracker.restartsInWindow(name, rule.withinMin*60)` and firing when it reaches `rule.count` (the restart ring already excludes operator-initiated restarts and `restart overlimit`); dashboard-driven restarts never contribute (Finding 4, MEDIUM-3).
  - `error-spike` → on `error:captured` level `error`, calling `ErrorTracker.countInWindow(name, rule.withinSec)` and firing when it reaches `rule.count`.
- **Sampled** rules (`cpu-threshold`, `mem-threshold`) are checked once per `metrics:tick` event (emitted by `Pm2Client` after each successful poll `list()`; see the metrics poll loop). The engine subscribes to `metrics:tick` **after** `MonitorState` does, so by the time it evaluates, that tick's samples are already pushed; it then reads each targeted process's series via `MonitorState.getMetrics` and applies `MetricsStore.sustainedAbove`. A `cpu-threshold`/`mem-threshold` rule maps `forSec` → `sustainedAbove(..., durationSec=forSec)`. Only processes present in that tick's `ProcessSnapshot[]` are evaluated, so a stopped/deleted process (which pushed no sample) cannot fire a sustained-threshold rule.

When a rule matches, the engine builds an `AlertPayload` and asks the cooldown tracker whether this `(ruleId, processName)` pair is allowed to fire. The cooldown model is: each rule has a `cooldownSec` (falling back to `DEFAULT_COOLDOWN_SEC`); after a fire, further matches for the same `(ruleId, processName)` are suppressed until `cooldownSec` elapses. Suppressed matches increment a `suppressedCount` that is included in the next allowed alert ("+N more since last alert"), so operators see that the condition persisted without being flooded. The cooldown tracker is an in-memory `Map<string, { lastFired: number; suppressed: number }>`.

Before dispatching, the engine checks `MonitorState.maintenance`: if maintenance is active it **does not deliver** to any channel but still records the alert in an in-memory recent-alerts list and logs it, satisfying "suppress delivery without stopping monitoring" (FR9). Dispatch to each targeted channel is done with `Promise.allSettled` so one channel's failure neither throws nor blocks the other (FR6). Each rejected settle is logged at `warn` with the channel name and error; the app never crashes on a delivery failure.

### Alert channels (`src/alerts/channels/*`)

```ts
interface AlertChannel {
  readonly name: 'teams' | 'email';
  readonly enabled: boolean;
  send(payload: AlertPayload): Promise<void>; // rejects on delivery failure
}
// EmailChannel-only extension used by the daily digest (NIT, Finding 8-of-round-3):
// the digest is a multi-process report that does not fit the single-process AlertPayload,
// so it is sent via a raw path rather than through send(AlertPayload).
interface EmailChannel extends AlertChannel {
  readonly name: 'email';
  sendRaw(msg: { subject: string; html: string; text: string }): Promise<void>; // rejects on SMTP failure
}
interface AlertPayload {
  title: string; severity: 'info'|'warning'|'critical';
  processName: string; ruleId: string;
  summary: string; facts: Array<{ k: string; v: string }>;
  timestamp: number; suppressedCount: number;
}
```

`TeamsChannel.send` builds a MessageCard JSON (themeColor by severity, `activityTitle`, `facts` section, process name and timestamp) and POSTs it to `TEAMS_WEBHOOK_URL` with `fetch`, a 10s `AbortController` timeout, and `Content-Type: application/json`. A non-2xx response or network/timeout error rejects (caught by `allSettled`). `EmailChannel.send` uses a Nodemailer transport created once from SMTP config; it sends an HTML + plaintext email to `MAIL_TO`. The transport is `verify()`-ed at startup; a failed verify disables the channel with a logged warning rather than aborting boot. `EmailChannel` additionally exposes `sendRaw({subject, html, text})` (NIT, Finding 8-of-round-3) which the daily digest uses to send its multi-process report through the same transport and `MAIL_TO` recipients; it builds no `AlertPayload` (which is single-process) and rejects on SMTP failure the same way `send` does. `TeamsChannel` has no `sendRaw` because the digest is email-only (FR10).

### HTTP/API layer (`src/api/*`)

`createServer(deps): http.Server` builds an Express app: JSON body parser (size-limited to 64 KB), the auth middleware, the route modules, static mount of `public/` at `/`, and a terminal error handler that maps thrown/`next`-ed errors to a consistent JSON envelope `{ error: { code, message } }` and logs 5xx at `error`, 4xx at `debug`. The returned `http.Server` is shared with the WS hub (WS upgrades on the same port).

**Auth rule (single, unambiguous — Finding 5):** Every `/api/*` endpoint requires auth **except** `GET /api/system/health`. The only unauthenticated surface is the static dashboard shell (`GET /`, `/css/*`, `/js/*`) plus `GET /api/system/health`. All data and control endpoints — **including read-only ones** such as the process list, metrics, logs, and errors — require auth. This matches the REST table below, where `/api/system/status` and every read is marked `Auth: yes`. The split is deliberate: the dashboard shell loads unauthenticated so the browser can render a login prompt, then the browser supplies the API key/credentials on every subsequent data call and on the WS upgrade.

### WebSocket layer (`src/ws/hub.ts`)

`WsHub` attaches a `ws` `WebSocketServer` in `noServer` mode to the shared `http.Server` and handles the `upgrade` event. On upgrade it authenticates (below); unauthenticated upgrades are destroyed with `401`. Each client gets a subscription set. The hub subscribes to the state hub's events and broadcasts to interested clients. It also tracks per-client log-tail subscriptions (a client asks to tail a specific process) and forwards matching `log:line` events only to subscribers of that process, to avoid flooding every client with every process's logs.

**Log level model and filter contract (Findings 6).** Live-tail levels are exactly two: `info` (every line from `log:out` / stdout) and `error` (every line from `log:err` / stderr). The pipeline produces no other level — there is no semantic `debug`/`warn`. The filter contract therefore differs between REST and WS, and that split is intentional and stated:
- **WS live tail is server-filtered only by stream selection.** `log:subscribe` with `streams: ["out"|"err"]` controls which streams are fanned out; beyond that, the hub forwards raw lines unfiltered. Any `q` text search or finer "level" filtering on the live tail is **best-effort client-side** matching in `public/js/views/logs.js` — a substring/regex match on the rendered line plus a toggle between the two real levels (`info`/`error`). A client "level" selector offering anything beyond `info`/`error` would match nothing, so the UI exposes only those two.
- **REST `GET /logs` filters server-side** (`?q`, `?level`) over the tail slice it reads (see `readLogsTail` below).

This keeps the hot live path cheap (no per-line server regex across all subscribers) while still giving `GET /logs` precise server-side filtering for backfill and ad-hoc search.

### Entry point (`src/index.ts`)

Boot order: `loadConfig()` → build logger → `loadAlertRules()` → construct `MonitorState`, `MetricsStore`, `ErrorTracker` → construct channels → construct `AlertEngine` and wire it to events → construct `Pm2Client` and call `start()` (non-blocking; HTTP must come up even if PM2 is down) → `createServer()` and `WsHub` → `server.listen(PORT, HOST)` → start digest scheduler. A `SIGINT`/`SIGTERM` handler performs graceful shutdown: stop accepting connections, close WS, `pm2Client.stop()`, flush the error log, then exit 0. `unhandledRejection`/`uncaughtException` are logged at `error`; uncaught exceptions trigger the same graceful shutdown with exit 1.

## REST API surface

Base path `/api`. All endpoints except `GET /api/system/health` require auth. Response envelope on success is the resource JSON directly; on error it is `{ error: { code, message } }` with the HTTP status below. Content-Type is `application/json`.

| Method | Path | Auth | Destructive | Request | Success response |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/system/health` | no | no | — | `{ status:'ok', pm2Connected:boolean, maintenance:boolean, uptimeMs:number, version:string }` |
| GET | `/api/system/status` | yes | no | — | `MonitorSnapshot` (processes + flags) |
| GET | `/api/processes` | yes | no | — | `ProcessSnapshot[]` |
| GET | `/api/processes/:name` | yes | no | `name` path | `ProcessSnapshot` or 404 |
| GET | `/api/processes/:name/metrics` | yes | no | `?sinceMs` query (default 1h) | `{ name, samples: MetricSample[] }` |
| POST | `/api/processes/:name/start` | yes | **yes** | — | `ControlResult` |
| POST | `/api/processes/:name/stop` | yes | **yes** | — | `ControlResult` |
| POST | `/api/processes/:name/restart` | yes | **yes** | — | `ControlResult` |
| POST | `/api/processes/:name/reload` | yes | **yes** | — | `ControlResult` |
| DELETE | `/api/processes/:name` | yes | **yes** | — | `ControlResult` |
| POST | `/api/processes` | yes | **yes** | `{ script?:string, ecosystem?:string, name?:string, instances?:number, exec_mode?:'fork'\|'cluster' }` | `ControlResult` |
| GET | `/api/processes/:name/logs` | yes | no | `?lines`(≤2000, default 200), `?stream`(`out`\|`err`\|`all`), `?q`(search over the tail slice only), `?level`(`info`\|`error`) | `{ name, lines: LogLine[] }` — **404 if the process name is unknown** (resolved against the snapshot map first, matching `GET /api/processes/:name`); `200 { name, lines: [] }` only when the process exists but its log file is missing/unreadable. Reads trailing `lines`, then filters that slice in memory (see readLogsTail) |
| GET | `/api/errors` | yes | no | `?name`, `?sinceMs`, `?limit`(≤1000) | `TrackedError[]` |
| GET | `/api/errors/export` | yes | no | `?name`, `?format`(`json`\|`csv`) | file download (`Content-Disposition: attachment`) |
| GET | `/api/alerts/rules` | yes | no | — | `AlertRule[]` (secrets never included) |
| POST | `/api/alerts/rules/reload` | yes | no | — | `{ reloaded:true, count:number }` or 400 with validation issues |
| POST | `/api/alerts/test` | yes | no | `{ channel:'teams'\|'email'\|'all' }` | `{ results: Array<{channel,ok,error?}> }` |
| GET | `/api/alerts/recent` | yes | no | `?limit`(≤200) | recent dispatched/suppressed alerts |
| GET | `/api/maintenance` | yes | no | — | `{ active:boolean, until:number\|null, reason:string\|null }` |
| POST | `/api/maintenance` | yes | no | `{ active:boolean, durationMin?:number, reason?:string }` | updated maintenance state |

Status codes: `200` success, `201` for `POST /api/processes` creating a process, `400` validation error (`code: VALIDATION`), `401` missing/invalid auth (`code: UNAUTHORIZED`), `404` unknown process (`code: NOT_FOUND`), `409` when PM2 is unavailable for a control call (`code: PM2_UNAVAILABLE`), `502` when a control command fails inside PM2 (`code: PM2_ERROR`), `500` unexpected. Destructive endpoints are marked above; the **UI** is responsible for the confirmation prompt (FR2/AC9) — the server does not require a confirmation token because confirmation is a UX concern, but it does require auth on every destructive call.

## WebSocket message protocol

Single endpoint: `GET /ws` (same host/port), authenticated at upgrade. Messages are JSON text frames with a discriminated `type` field.

**Auth at upgrade.** Browsers cannot set an `Authorization` header on a WebSocket upgrade, and if a client offers a `Sec-WebSocket-Protocol` the server **must** echo exactly one accepted subprotocol back or compliant browsers abort the handshake. The design therefore pins a single browser-reachable mechanism and the mandatory echo:

- The browser client opens `new WebSocket(url, ["apikey." + KEY])` — the credential rides as the sole offered subprotocol (works for both auth modes; in basic mode the `KEY` is a base64 of `user:pass`, so one code path serves both).
- As a fallback for non-browser clients, a `?token=<KEY>` query param on `/ws` is also accepted and read server-side at upgrade.
- In the `server.on('upgrade')` handler the hub extracts the credential (from the offered subprotocol or `?token=`), validates it with the **same `safeEqual` validator** used by the REST auth middleware (the length-guarded comparator defined in the Authentication section — it never throws, so a wrong-length credential on the upgrade path returns `401` instead of killing the process), and:
  - **on success**, calls `wss.handleUpgrade(req, socket, head, cb)` and, when a subprotocol was offered, passes that exact string back as the accepted protocol so `ws` echoes it in the `101` response (satisfying the spec and keeping browsers connected);
  - **on failure**, writes `HTTP/1.1 401 Unauthorized` to the socket and destroys it **before** completing the handshake — no `WebSocket` is ever constructed for an unauthenticated upgrade.

The browser-unreachable "Authorization header on the upgrade request" option is dropped for the browser path; it survives only as an accepted header for non-browser clients and is documented as such.

**`?token=` query-string must never reach the logs (Finding 9).** The subprotocol form is the recommended default; the `?token=<KEY>` fallback carries the credential in the request URL, which the logger's key-based redaction set (`API_KEY`, `BASIC_PASS`, etc.) would *not* catch because it appears as a URL substring, not a known field. The design closes this two ways, both mandatory: (1) the `server.on('upgrade')` handler for `/ws` **never logs the raw request URL or request line** — any upgrade-path log (success, `401`, or malformed) logs only the fixed path `"/ws"` and a boolean `authed`, never `req.url`; and (2) a shared `redactUrl(url)` helper strips any `token=…` value (replacing it with `token=***`) and is applied wherever a request URL could otherwise be logged (the Express request logger and any error-handler log that includes a URL). So neither the normal request log nor an error path can emit the token. This is noted in the README as well, but the redaction — not just documentation — is the mitigation.

Client → server:

```jsonc
{ "type": "subscribe", "channels": ["state","alerts"] }      // state snapshots, alert feed
{ "type": "log:subscribe", "process": "api", "streams": ["out","err"] }
{ "type": "log:unsubscribe", "process": "api" }
{ "type": "ping" }
```

Server → client:

```jsonc
{ "type": "hello", "snapshot": { /* MonitorSnapshot */ }, "serverTime": 0 }
{ "type": "state", "snapshot": { /* MonitorSnapshot */ } }    // on any state change (throttled to 1/sec max)
{ "type": "process:transition", "name": "api", "from": "online", "to": "errored", "at": 0 }
{ "type": "log", "process": "api", "stream": "err", "line": "...", "level": "error", "ts": 0 }
{ "type": "alert", "payload": { /* AlertPayload */ }, "delivered": true }
{ "type": "pm2", "connected": false }                          // daemon connectivity change
{ "type": "pong" }
{ "type": "error", "code": "BAD_MESSAGE", "message": "..." }
```

On connect the server immediately sends `hello` with the current snapshot. State broadcasts are throttled (coalesced) to at most one per second to avoid saturating clients during restart storms. The client (`public/js/ws.js`) reconnects with backoff on close and re-sends its subscriptions.

## Alert-rule config JSON schema

The optional file (`ALERT_RULES_FILE`, sample at `config/alert-rules.example.json`) is an object with a `rules` array. Validated by zod:

```jsonc
{
  "rules": [
    {
      "id": "api-crash",                 // required, unique, slug
      "enabled": true,                   // default true
      "description": "API crashed or errored",
      "match": {
        "processes": ["*"],              // names or "*" for all; default ["*"]
        "condition": {
          "type": "errored"              // one of the five types below
        }
      },
      "severity": "critical",            // info|warning|critical; default warning
      "channels": { "teams": true, "email": true },  // per-channel toggle
      "cooldownSec": 300                 // optional; falls back to DEFAULT_COOLDOWN_SEC
    }
  ]
}
```

Condition variants (discriminated union on `condition.type`):

```jsonc
{ "type": "errored" }                                             // status transitions to errored / "restart overlimit" ONLY
{ "type": "unexpected-stop" }                                     // reaches stopped/exit with NO intentional-action token ONLY
{ "type": "restart-threshold", "count": 5, "withinMin": 10 }      // restarts exceed count within window
{ "type": "cpu-threshold", "percent": 85, "forSec": 120 }         // sustained CPU
{ "type": "mem-threshold", "bytes": 1073741824, "forSec": 120 }   // sustained memory
{ "type": "error-spike", "count": 20, "withinSec": 60 }           // N errors in M seconds (log-derived)
```

**`errored` vs `unexpected-stop` are disjoint (Finding 4).** FR5 lists "process errored or unexpectedly stopped" as one bullet, but the two conditions are defined here as non-overlapping facets so a single crash never double-fires unless the operator deliberately subscribes to both:
- `errored` fires **only** when `ProcessSnapshot.status` transitions into `errored` — the PM2 errored terminal state, reached via `restart overlimit`. It does **not** fire on a plain stop/exit.
- `unexpected-stop` fires **only** when a process reaches `stopped`/`exit` with **no** matching intentional-action token consumed (a clean-but-unrequested exit that did not reach the errored state). It does **not** fire on `errored`.

A single lifecycle event maps to at most one of these two conditions, so there is no double alert from one event. An operator who wants to be paged for both error-states and clean-unexpected-stops adds both rule entries deliberately; each then has its own cooldown key `(ruleId, processName)`.

**TypeScript type (Finding 7).** The authoritative TS type is derived from the schema, not hand-written: `type AlertRule = z.infer<typeof alertRuleSchema>`, where `alertRuleSchema` validates a single rule and `condition` is a **zod discriminated union on `condition.type`** (`z.discriminatedUnion('type', [...])`) over the five variants above. `loadAlertRules(path): AlertRule[]`, `GET /api/alerts/rules` (`AlertRule[]`), and the `AlertEngine`'s held `AlertRule[]` all refer to this inferred type, so the discriminated-union condition shape is the single source of truth and narrows correctly in the engine's `switch (rule.match.condition.type)`.

Zod rules: `id` matches `/^[a-z0-9][a-z0-9-]{0,63}$/`; numeric thresholds are positive integers; `channels` requires at least one `true`; `processes` entries are either `"*"` or valid process names (same name rule as sanitization). A rule referencing a channel that is not configured (e.g. `email:true` with no SMTP) loads but logs a `warn` and is skipped for that channel at dispatch time. Unknown `condition.type` or extra keys fail validation (`strict` zod objects).

The `unexpected-stop` rule distinguishes operator-initiated stops from crashes by consulting the **intentional-action token queue** owned by `Pm2Client` (specified in full in the PM2 integration layer section). In short: each control `stop`/`delete`/`restart` pushes one token per running instance with a `kill_timeout`-aware, configurable grace window (`INTENTIONAL_ACTION_GRACE_MS`); each PM2 `stop`/`exit` event consumes exactly one non-expired token; an event with no token left to consume is unexpected and eligible to fire this rule. This prevents false alerts when an operator stops/restarts a process (including cluster apps with many instances) from the dashboard.

## Input validation and sanitization

All request bodies, query params, and path params are validated with zod via a `validate(schema)` middleware that parses `{ body, query, params }` and returns `400 { error:{code:'VALIDATION', message} }` with a human-readable issue summary on failure. Nothing reaches a route handler unvalidated (AC18).

**Process-name rule** (path `:name`, `startNew.name`, rule `processes`): must match `/^[A-Za-z0-9._-]{1,100}$/`. This rejects shell metacharacters, path separators, whitespace, and spaces, eliminating argument/command injection through the name (AC19). The name is used only as a pm2 identifier and a map key, never interpolated into a shell.

**Script-path rule** (`startNew.script`): must be an absolute path (`path.isAbsolute`), is `path.normalize`-d, must not contain `..` segments after normalization, must have an allowed extension (`.js`, `.cjs`, `.mjs`, `.ts`, `.py`, `.sh` — configurable allowlist with a sane default), and the file must exist (`fs.existsSync`) at validation time. Optionally constrained to live under a configured `ALLOWED_SCRIPT_ROOT` prefix if that env var is set (defense in depth; off by default to not surprise operators). The path is passed to `pm2.start` as the `script` option object field — never concatenated into a command string — so pm2 spawns it directly without a shell.

**Ecosystem-path rule** (`startNew.ecosystem`): same absolute/normalize/no-`..`/exists checks, extension restricted to `.js`/`.cjs`/`.config.js`/`.json`. Exactly one of `script` or `ecosystem` must be provided (zod refinement); supplying both or neither is a `400`.

**`instances` / `exec_mode` bounds (Finding 10):** the create-process body validates these explicitly in `schemas.ts`:
- `instances: z.number().int().min(1).max(128).optional()` — rejects `0` and negatives; capped at 128 to prevent an operator fat-fingering a fork bomb. pm2's `"max"` string is **not** supported in v1 (decided: keep the input strictly numeric to avoid a mixed string/number type and an ambiguous cluster-size semantics); the README notes operators needing all-cores clustering should use an ecosystem file.
- `exec_mode: z.enum(['fork','cluster']).optional()`.
- Cross-field refinement: `instances > 1` implies `cluster` — a body with `instances > 1` and `exec_mode: 'fork'` is rejected `400` (fork mode cannot run multiple instances meaningfully). When `instances > 1` is given without `exec_mode`, the server defaults `exec_mode` to `cluster`.

**Numeric query clamps:** `lines`, `limit`, `sinceMs`, `durationMin` are coerced to integers and clamped to the documented maxima rather than rejected when over, except negative values which are `400`.

## Graceful degradation when PM2 is unreachable

The HTTP server and dashboard do not depend on PM2 being up. `Pm2Client.start()` is fire-and-forget and never throws into the boot path. While disconnected:
- `MonitorState.pm2Connected` is `false`; `GET /api/system/health` and `GET /api/system/status` report `pm2Connected:false`.
- `GET /api/processes` returns the last known snapshot (which becomes empty after a fresh start with no successful list) with the connectivity flag; the dashboard shows a prominent "PM2 daemon unreachable — reconnecting" banner driven by the WS `pm2` message.
- Control endpoints return `409 PM2_UNAVAILABLE` immediately (no hang).
- The reconnection loop runs in the background with capped backoff + jitter; the first failure logs `warn`, subsequent attempts log `debug`.
- On reconnect, the client re-lists, re-attaches `launchBus`, flips `pm2Connected:true`, and broadcasts the new state; alert rules resume naturally. This path is explicitly exercised by the resilience test (AC7).

## Error handling (per fallible operation)

| Operation | Failure condition | Recoverable? | Caller receives | Logging |
| --- | --- | --- | --- | --- |
| `loadConfig` | missing/invalid env | fatal | n/a (process exits 1) | `error` with zod issues |
| `loadAlertRules` (missing file) | file absent | recoverable | `[]` | `warn` once |
| `loadAlertRules` (invalid file) | zod fails at boot | fatal | exits 1 | `error` with issues |
| `pm2.connect` | daemon down | recoverable | background retry | `warn` then `debug` |
| `pm2` control call | pm2 returns error | recoverable | `ControlResult{ok:false,PM2_ERROR}` → `502` | `warn` |
| control while disconnected | not connected | recoverable | `409 PM2_UNAVAILABLE` | `debug` |
| `launchBus` dropped | bus error/close | recoverable | triggers reconnect loop | `warn` |
| bus packet malformed | unexpected shape (event/process field missing after defensive read) | recoverable | packet skipped, no event emitted | `warn` (rate-limited) |
| `process:exception` received | uncaught exception in managed process | recoverable | `error:captured` level `crash`; feeds alert engine | `debug` (the crash itself is operator-facing via alerts) |
| metrics poll `list()` | transient pm2 error | recoverable | skip tick, keep last samples | `debug` |
| `GET /logs` unknown process | name not in snapshot map | recoverable | `404 NOT_FOUND` (route resolves name first, before calling `readLogsTail`) | `debug` |
| `readLogsTail` | known process, file missing/unreadable | recoverable | `{lines:[]}` + 200, note | `warn` |
| Teams `send` | non-2xx / timeout / network | recoverable | rejects → `allSettled` logs; other channel unaffected | `warn` |
| Email `send` | SMTP error | recoverable | rejects → `allSettled` logs; other channel unaffected | `warn` |
| Email transport verify at boot | bad SMTP creds | recoverable | channel disabled | `warn` |
| error-log append | fs write error | recoverable | ignored | `warn` (rate-limited) |
| request validation | bad input | recoverable | `400 VALIDATION` | `debug` |
| auth | missing/wrong creds | recoverable | `401 UNAUTHORIZED` | `debug` (no cred values) |
| WS upgrade auth | bad creds | recoverable | socket destroyed, HTTP 401 | `debug` |
| unexpected route throw | bug | recoverable | `500` generic envelope | `error` with stack |
| `uncaughtException` | fatal bug | fatal | graceful shutdown, exit 1 | `error` with stack |

Secret values (`SMTP_PASS`, `API_KEY`, `BASIC_PASS`, `TEAMS_WEBHOOK_URL`) are in the logger's redaction set and are replaced with `***` anywhere they would otherwise appear.

## Authentication (`src/api/auth.ts`)

**Constant-time comparison that never throws (Finding 1 — HIGH).** `crypto.timingSafeEqual(a, b)` throws a synchronous `RangeError` when `a.length !== b.length`. Comparing a client-supplied credential of arbitrary length directly against the configured secret would therefore throw on any length mismatch — a `500` on the REST path (leaking that length matters, defeating the constant-time intent) and, far worse, an **uncaught throw inside `server.on('upgrade')`** on the WS path (no Express error handler there), which the entry point treats as an `uncaughtException` → graceful shutdown with exit 1. That makes a single wrong-length WS upgrade a one-request process kill, violating NFR2 and AC15.

The fix is a single length-guarded comparator used by **both** REST and WS auth. It hashes each side to a fixed 32-byte digest so the two buffers are always equal length, then calls `timingSafeEqual`, so it can never throw on malformed, empty, or wrong-length input and always returns a boolean:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';

// Fixed-length-digest comparison: never throws on unequal/empty/malformed input.
// Returns false (→ 401) for any mismatch; constant-time w.r.t. the real secret.
export function safeEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided ?? '').digest();   // 32 bytes
  const b = createHash('sha256').update(expected ?? '').digest();   // 32 bytes
  return timingSafeEqual(a, b);
}
```

`safeEqual` is the **only** credential comparison in the codebase. Any input that is `undefined`, empty, a malformed `Authorization` header, a malformed subprotocol string, or simply the wrong length is coerced to a string, hashed, and compared, yielding `false` and a `401` — never a throw. (The sha256 pre-hash is not a secrecy measure; it is purely the length-normalization that makes `timingSafeEqual` safe to call.)

Two modes selected by `AUTH_MODE`. **API key mode:** the client sends `X-API-Key: <key>` (or `Authorization: Bearer <key>`); the middleware calls `safeEqual(provided, API_KEY)`. **Basic mode:** standard `Authorization: Basic` header; the decoded `user` and `pass` are each checked with `safeEqual` against `BASIC_USER`/`BASIC_PASS` (both must pass, each a `safeEqual` call so neither comparison can throw on length). Both reject with `401` and a `WWW-Authenticate` header (basic mode) on mismatch. The identical `safeEqual` function is reused by the WS upgrade handler (which extracts the credential from the offered `apikey.<KEY>` subprotocol or `?token=` param, per the WebSocket section), so the WS upgrade auth is equally throw-proof. The dashboard stores the key/credentials in `sessionStorage` after a small login prompt and attaches them to every REST call (as the `X-API-Key`/`Authorization` header) and to the WS upgrade (as the subprotocol argument to `new WebSocket`). No sessions, cookies, or CSRF handling are needed because auth is a static credential on every request (matching the single-shared-credential scope).

## Maintenance mode (`MonitorState` + `src/api/routes/alerts.ts`)

Maintenance is a boolean on `MonitorState` with an optional `until` timestamp and `reason`. `POST /api/maintenance { active, durationMin, reason }` sets it; if `durationMin` is given, a timer clears it automatically at expiry (also checked lazily on read, so a restart that drops the timer still expires it correctly if `until` is persisted — but since state is in-memory, a restart simply clears maintenance, which is acceptable and documented). The AlertEngine consults this flag immediately before channel dispatch: when active, it records the alert in the recent-alerts list and the WS `alert` broadcast with `delivered:false`, but calls no channel. Monitoring, metrics, error capture, and the dashboard remain fully live.

## Daily digest (`src/alerts/digest.ts`)

When `DIGEST_ENABLED` is true and the email channel is configured, a scheduler computes the next occurrence of `DIGEST_HOUR` in local time and sets a `setTimeout`; on fire it builds a digest (per-process status table, restart counts, top error signatures, total alerts dispatched/suppressed) and sends it through the EmailChannel (via `sendRaw`, below), then schedules the next day. **Top error signatures metric (NIT, Finding 7-of-round-3).** The tracker retains no exact per-signature 24h occurrence count (the ring buffer holds recent distinct signatures and `TrackedError.count` is all-time), so the digest metric is defined concretely as **"signatures whose `lastSeen` is within the last 24h, ranked by `count` (all-time total) descending, top N"**, and is explicitly labeled in the email as an approximation bounded by `ERROR_BUFFER_SIZE` (signatures evicted from the ring are not counted). This avoids claiming an exact 24h-windowed per-signature count the design does not store. A digest send failure is logged at `warn` and does not stop the schedule. The digest is independent of maintenance mode (a planned-maintenance window should not drop the daily summary), which is a deliberate choice noted here. Teams is not used for the digest (email-only summary per FR10).

## Optional nice-to-haves: decisions (FR11)

Metrics history (CPU/mem chart) and log/error export are **implemented** (metrics via `MonitorState.getMetrics`, which delegates to the hub-internal `MetricsStore.getSeries`, feeding the detail-view Chart.js chart; export via `GET /api/errors/export`). Per-process HTTP health checks (FR11) are **backlogged for v1** because they require per-process endpoint configuration and a dedicated scheduler beyond the current scope; the alert engine's error/crash/restart-threshold/sustained-threshold rules cover process liveness in the interim. The requirements explicitly permit backlogging FR11 items with a stated reason, which this is.

## Dashboard (`public/`)

Served as static files; no bundler (NFR, Out-of-Scope). `index.html` loads ES modules directly (`<script type="module">`). `app.js` reads auth from `sessionStorage` (prompting if absent), opens the WS, and renders two views. **Overview:** a responsive grid of process cards; each card shows name, status (color-coded: green online, red errored, grey stopped, amber launching/stopping), pid, CPU%, memory, uptime, restarts, mode×instances, and action buttons (start/stop/restart/reload/delete). Destructive buttons (stop/restart/delete) open a confirm dialog before issuing the call (AC9/AC14). **Detail view:** full metadata, a CPU/memory history chart (Chart.js via CDN, reading `/metrics`; if the CDN is blocked the view degrades to a numeric table), the per-process error list from `/api/errors`, and the live log viewer. **Log viewer** (`views/logs.js`): subscribes via WS `log:subscribe`, renders a scrolling buffer with client-side text search and level filter, and an initial backfill from `GET /logs`. A top bar shows global connectivity (the PM2-unreachable banner) and a maintenance-mode toggle.

## Testability

- **Pure/unit:** `signature.ts` (crafted stacks → stable signatures), `mapper.ts` (pm2 fixtures → snapshots, including both `packet.event` and `packet.data.event` layouts and a `process:exception` packet), `metrics/store.ts` (`sustainedAbove` including under-coverage → `false`, gap > `2*sampleSec` → `false`, and the steady-state arms-within-one-window case; eviction), `errors/tracker.ts` (dedup counting, ring eviction, window counters), the intentional-action token model (one-token-per-instance consume, FIFO, expiry, restart `exit`/`online` suppression — with an injected clock and a fake snapshot providing `instances`), `cooldown.ts` (fire/suppress/reset timing with injected clock), `config/env.ts` and `config/alertRules.ts` (valid/invalid inputs), the zod `schemas.ts` sanitizers (injection strings rejected; `instances`/`exec_mode` bounds and the `instances>1`⇒`cluster` refinement). The AlertEngine is unit-tested with a fake state hub, a fake clock, and spy channels to assert cooldown, maintenance gating, and `allSettled` isolation (one channel throwing does not block the other).
- **Integration:** the Express app via `supertest` with a fake `Pm2Client` — exercises auth (401), validation (400), control happy/error paths, `409` when disconnected, and the graceful-degradation path (AC7) by constructing the app with a client reporting `pm2Connected:false`. The WS protocol is tested with a `ws` client against the real hub plus the fake state, asserting `hello`, subscription filtering, log fan-out, and upgrade-auth rejection.
- **Harder to test (documented, not blocking):** real PM2 daemon interaction and real SMTP/Teams delivery are exercised manually via `POST /api/alerts/test` and against a scratch PM2 process; the channel modules are structured so the network call is the only un-unit-tested line (the payload builders are pure and tested separately). The test framework is Node's built-in `node:test` + `node:assert` to avoid adding a heavy test dependency (NFR3); if a richer runner is desired it can be added later without changing module boundaries.

## Deliverables mapping

Every requirements deliverable maps to a concrete file in the layout above: `package.json`/`tsconfig.json` (root), backend modules (`src/**`), dashboard (`public/**`), `.env.example` (every var in the config table), `config/alert-rules.example.json` (the schema above), `ecosystem.config.js` (runs `dist/index.js`), `README.md`, and the `.gitignore` update.

**`.gitignore` update.** The existing file (verified) contains `node_modules/`, `dist/`, and `*.log`, but **not** `.env` and **not** a `logs/` directory entry. `*.log` only matches files ending in `.log`; it does not cover the `logs/` directory itself or any future non-`.log` file under it (e.g. a `logs/README` placeholder or any auxiliary file the directory might hold — note no log rotation is specified, so there is no `errors.1`-style file in v1), yet AC20 names `logs` as a directory to cover. The implementation therefore adds **two** explicit lines in addition to the pre-existing patterns — it does not rely on `*.log`:

```gitignore
.env
logs/
```

After this change `.gitignore` covers `node_modules/`, `dist/`, `.env`, and `logs/`, satisfying NFR4/AC20.

## Responses to design review findings

### Round 2 (current `design-review.json`, verdict CHANGES_REQUESTED: 1 HIGH, 4 MEDIUM, 4 NIT)

This revision addresses **every** finding in the current review. All resolutions align with the original requirements; none required a scope change.

- **Finding 1 (HIGH) — `crypto.timingSafeEqual` throws on unequal-length buffers; auth path can crash / trivial DoS. ADDRESSED.** The Authentication section now defines a single length-guarded `safeEqual(provided, expected)` that sha256-hashes both sides to equal-length 32-byte digests before calling `timingSafeEqual`, so it can never throw on empty/malformed/wrong-length input and always returns `false` (→ `401`). It is declared the **only** credential comparison in the codebase and is reused verbatim by both the REST auth middleware and the WS `server.on('upgrade')` handler, so a wrong-length credential on the WS path returns `401` instead of triggering the uncaught-exception → exit-1 shutdown. Resolves the NFR2/AC15 violation.

- **Finding 2 (MEDIUM) — `LogLine` referenced but never defined. ADDRESSED.** `interface LogLine { stream:'out'|'err'; level:'info'|'error'; line:string; ts:number }` is now in the Core data model, with the stated derivation (`out ⇒ info`, `err ⇒ error`) matching the live-tail level model. `readLogsTail` returns `LogLine[]` and the `GET /api/processes/:name/logs` response uses it.

- **Finding 3 (MEDIUM) — `Pm2Client.control`/`startNew` types undefined. ADDRESSED.** Pinned `type ControlAction = 'start'|'stop'|'restart'|'reload'|'delete'`, `interface StartNewOpts` (mirroring the POST body: `script?`/`ecosystem?`/`name?`/`instances?`/`exec_mode?`), and `interface LogTailOpts`. `control(action: ControlAction, name: string)` is stated to target an existing process **by name**, and `control('start', name)` (start a stopped process) is explicitly distinguished from `startNew` (create a new one).

- **Finding 4 (MEDIUM) — operator restarts vs `restart-threshold` undefined. ADDRESSED.** A restart whose `exit`/`stop` half consumes a `restart` token is flagged `intentional: true` on the emitted `error:captured` level `restart`; the ErrorTracker's dedicated restart-window counter increments **only** on `intentional === false` restarts (crash loops) and `restart overlimit`, and `restart-threshold` consults that counter. Dashboard/operator restarts are recorded for visibility but never contribute to the threshold. `TrackedError` gained an `intentional?` field to carry this. *(Superseded in part by Round-3 MEDIUM-3: `restart overlimit` no longer increments the restart-window counter — it drives `errored` only. See the Round-3 resolutions section.)*

- **Finding 5 (MEDIUM) — `getMetrics` vs `getSeries`; `/metrics` source unspecified. ADDRESSED.** The hub boundary is kept: `MonitorState.getMetrics(name, sinceMs)` is the only public series read and delegates internally to the hub-owned `MetricsStore.getSeries`. The `/metrics` route and the chart call `getMetrics` only; `getSeries` is marked an implementation detail internal to `MetricsStore`, reached exclusively via the hub, so the "no module calls another's internals" invariant holds. The FR11 text was updated to match.

- **Finding 6 (NIT) — `ControlResult.process` vs N cluster instances. ADDRESSED.** Added a note that `ProcessSnapshot` (and thus `ControlResult.process`) is the per-**name aggregate** across instances with `instances` as the count — not a per-instance record — so a cluster control returns one aggregate snapshot.

- **Finding 7 (NIT) — `AlertRule` TS type only given as JSON schema. ADDRESSED.** Stated `type AlertRule = z.infer<typeof alertRuleSchema>` with `condition` as a zod `discriminatedUnion('type', …)`, making the five schema variants the authoritative TS shape that narrows in the engine's `switch`.

- **Finding 8 (NIT) — `errors.1` example implies non-existent rotation. ADDRESSED.** The `.gitignore` rationale no longer cites a rotated `errors.1`; it now justifies `logs/` by the directory itself and "any future non-`.log` file under it," and explicitly notes no log rotation is specified in v1.

- **Finding 9 (NIT) — `?token=` WS fallback log-observable, no redaction. ADDRESSED.** The WS section now mandates two concrete mitigations (not just documentation): the `/ws` upgrade handler never logs the raw request URL/line (only the fixed `"/ws"` path plus an `authed` boolean), and a shared `redactUrl()` helper strips `token=…` → `token=***` wherever any request URL could be logged.

### Round 1 (prior review, resolved in the previous revision — kept for history)

This revision addressed every HIGH and MEDIUM finding and both NITs from the first-round review. Each is resolved against the original requirements (none required a scope change).

- **Finding 1 (HIGH) — PM2 bus event names/shapes not pinned. ADDRESSED.** The PM2 integration section now pins the exact packet interfaces for `process:event`, `process:exception`, `log:err`, and `log:out`, and subscribes to **four** channels (adding `process:exception` → `error:captured` level `crash`, which closes the "crashes may be missed" gap in FR4). The event-name field path ambiguity is resolved by a documented defensive read (`packet.event ?? packet.data?.event`), with the installed-version confirmation deferred to implementation time and the dead branch removed then.

- **Finding 2 (HIGH) — racy 15s intentional-actions set. ADDRESSED.** Replaced entirely with a per-process FIFO **token queue** owned by `Pm2Client`: one token pushed per expected lifecycle event (one per instance for cluster apps), each consumed by exactly one matching `exit`/`stop` event, with a configurable `INTENTIONAL_ACTION_GRACE_MS` grace window that adds the process `kill_timeout` when known. The restart `exit`/`online` pair and cluster multi-exit cases are now explicitly specified.

- **Finding 3 (MEDIUM) — `sustainedAbove` fully-covered suppression. ADDRESSED.** `sustainedAbove` now defines a coverage tolerance: require `max(1, ceil(durationSec/sampleSec)-1)` samples with no gap > `2*sampleSec`, return `false` (fail-safe, documented) under insufficient coverage, and arm within one window at steady state. Resolves the AC12 conflict.

- **Finding 4 (MEDIUM) — `errored`/`unexpected-stop` overlap. ADDRESSED.** The two conditions are now defined as disjoint (`errored` = transition to errored/`restart overlimit` only; `unexpected-stop` = stopped/exit with no token only), inline schema comments updated, and the "add both deliberately" note added.

- **Finding 5 (MEDIUM) — garbled reads-auth sentence. ADDRESSED.** Replaced with a single unambiguous rule: every `/api/*` endpoint requires auth except `GET /api/system/health`; the only unauthenticated surface is the static shell plus that health endpoint.

- **Finding 6 (MEDIUM) — live-tail level model / REST-vs-WS filter contract. ADDRESSED.** Live-tail levels are pinned to exactly `info` (stdout) and `error` (stderr); the UI exposes only those two. WS fan-out is server-filtered only by stream selection with `q`/finer filtering client-side; `GET /logs` filters server-side. The split is stated.

- **Finding 7 (MEDIUM) — `?q`/`?lines` interaction undefined. ADDRESSED.** `readLogsTail` pipeline is fixed: read trailing `lines` physical lines (bounded), then apply `level` then `q` in memory to that slice; whole-history search declared out of scope and documented in the README. REST table note updated.

- **Finding 8 (MEDIUM) — `logs/` not in `.gitignore`. ADDRESSED.** Verified the actual file lacks `.env` and a `logs/` entry (`*.log` is insufficient). The design now adds **two explicit lines** (`.env`, `logs/`) rather than relying on `*.log`.

- **Finding 9 (MEDIUM) — WS auth handshake echo / unreachable Authorization header. ADDRESSED.** WS auth now standardizes on `new WebSocket(url, ["apikey.<KEY>"])` with the server echoing the accepted subprotocol via `handleUpgrade`, plus a `?token=` fallback for non-browser clients; invalid upgrades are destroyed with `401` before the handshake. The browser-unreachable Authorization-header path is dropped for browsers.

- **Finding 10 (NIT) — `instances`/`exec_mode` bounds. ADDRESSED.** Added `instances: z.number().int().min(1).max(128).optional()`, `exec_mode: z.enum(['fork','cluster']).optional()`, and the `instances>1`⇒`cluster` refinement; pm2 `"max"` explicitly not supported in v1 (ecosystem file instead).

- **Finding 11 (NIT) — health-check decision not stated. ADDRESSED.** Added an explicit FR11 decisions subsection: metrics history and export implemented; per-process HTTP health checks backlogged for v1 with a stated reason.

## Round-3 resolutions

This revision closes the three open MEDIUM findings from `design-review.json` (verdict CHANGES_REQUESTED: 0 HIGH, 3 MEDIUM, 5 NIT) and applies all five NITs inline. No resolution changed scope; all remain consistent with `requirements.md` and the rest of the mature design. This did not require another review round.

- **MEDIUM-1 (Finding 1) — no module owned the metrics poll → push → sampled-rule loop; cpu/mem rules could never fire. RESOLVED.** `Pm2Client` now owns a single `setInterval(METRICS_SAMPLE_SEC)` timer (started on first connect, cleared on `stop()`). Each successful tick applies the list to the hub and emits one `metrics:tick` event carrying the fresh `ProcessSnapshot[]`. `MonitorState` subscribes to map each snapshot to a `MetricSample` and `MetricsStore.push(name, { ts: snap.lastUpdated, cpu: snap.cpu, mem: snap.memory })`; `AlertEngine` subscribes (ordered after `MonitorState`) to run `cpu-threshold`/`mem-threshold` evaluation that same tick. Edge behavior is specified: non-`online` snapshots are **skipped (no sample pushed)** rather than pushing zeros, and **deleted** process names have their `MetricsStore` series **dropped** on the next tick. See the metrics poll loop in the PM2 integration layer, the `metrics:tick` entry in the state-hub events, and the sampled-rules bullet in the alert engine. (AC12 can now actually fire.)

- **MEDIUM-2 (Finding 2) — per-rule error-spike `withinSec` / restart-threshold `withinMin` windows were not mapped onto the tracker's single sliding window. RESOLVED.** The `ErrorTracker` keeps two 1-second-slot rings per process (errors; crash-loop restarts) and exposes `countInWindow(name, sinceSec)` and `restartsInWindow(name, sinceSec)` that sum the trailing `sinceSec` slots. Ring length is **sized to the max window any loaded rule requests** (`max(error-spike withinSec, restart-threshold withinMin*60)`, with a 60s floor), recomputed and resized on every `POST /api/alerts/rules/reload`. The engine passes each rule's own window (`withinSec`, `withinMin*60`), so rules with differing windows no longer share one ambiguous counter. **Over-buffer behavior is size-to-max** (never silently clamp-and-undercount); a defensive guard clamps and emits a one-time `warn` if a read ever exceeds the ring length. See the per-rule-window subsection in the error tracker.

- **MEDIUM-3 (Finding 3) — a single `restart overlimit` event counted toward both `errored` and `restart-threshold`, breaking the disjointness invariant. RESOLVED via option (a).** `restart overlimit` drives the `errored` condition **only** and does **not** increment the restart-window counter; it is classified as a terminal crash, never as a restart-window entry. The broader "at most one condition per lifecycle event" invariant is therefore preserved (not narrowed). Crash-loop restarts short of overlimit still feed `restart-threshold` via the ordinary `restart` level with `intentional === false`. See the `restart overlimit` and `restart` bullets in the event→MonitorEvents translation and the restart-ring text in the error tracker.

### NITs applied inline (round 3)

- **NIT (duplicate names across `pm_id`s).** Added to Aggregate semantics: duplicate names collapse to one aggregate (last-writer-wins), operators use unique names (README), and the mapper logs a one-time `warn` on a detected collision.
- **NIT (`GET /logs` 404 vs 200).** The route resolves `:name` against the snapshot map first and `404`s for unknown names; `200 { lines: [] }` is reserved for a known process with a missing/unreadable file. REST table, `readLogsTail` prose, and the error-handling table updated.
- **NIT (`sustainedAbove` metric typing).** `metric` is typed `'cpu' | 'mem'` and documented to index `MetricSample` (not `ProcessSnapshot`); the single `memory`→`mem` rename lives in the `metrics:tick` push.
- **NIT (digest top-signatures backing store).** Redefined as "signatures whose `lastSeen` is within 24h, ranked by all-time `count`, top N," labeled an approximation bounded by `ERROR_BUFFER_SIZE`.
- **NIT (EmailChannel digest `sendRaw`).** Added `EmailChannel.sendRaw({subject, html, text})` for the multi-process digest (which does not fit the single-process `AlertPayload`); `TeamsChannel` has none (digest is email-only, FR10).
