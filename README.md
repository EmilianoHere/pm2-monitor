# pm2-monitor

A single Node.js + TypeScript service that monitors and controls your local
[PM2](https://pm2.keymetrics.io/) processes, raises alerts to **Microsoft Teams**
and **email**, captures and deduplicates errors, and serves a live vanilla-JS
dashboard. It talks to the PM2 daemon through the official programmatic API,
keeps an in-memory view of every managed process (status, metrics history, error
buffer), exposes a REST API and a WebSocket for live updates, and can run itself
under PM2.

## What it does

- **Monitor** every PM2 process: status, PID, CPU%, memory, uptime, restarts,
  mode × instances — refreshed on a poll loop and pushed live over WebSocket.
- **Control** processes from the dashboard or REST: start, stop, restart,
  reload, delete, and create a brand-new process.
- **Metrics history**: per-process CPU/memory time series with a dashboard chart.
- **Error capture & recall**: crashes, uncaught exceptions, and stderr lines are
  captured, deduplicated into signatures, counted, and kept in a ring buffer;
  browse them in the dashboard or export them as JSON/CSV.
- **Alerts** to MS Teams webhooks and SMTP email, driven by configurable rules
  (errored, unexpected stop, crash-loop restarts, sustained CPU/memory, error
  spikes), each with per-channel toggles and anti-spam cooldowns.
- **Maintenance mode** to suppress alert *delivery* without stopping monitoring.
- **Daily digest** email summarizing status, restarts, and top error signatures.
- **Graceful degradation**: the HTTP server and dashboard stay up and reconnect
  in the background when the PM2 daemon is unreachable.

## Requirements

- Node.js 20+ (uses the built-in global `fetch` for Teams delivery).
- PM2 installed on the host for live process data (the service runs fine without
  it and reconnects when it comes back).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
cp .env.example .env # then edit .env with your settings
```

## Configuration

All configuration is read from the environment (via `.env`). Secrets are read
only from env and are never logged. Every variable is documented in
[`.env.example`](./.env.example); the table below is the authoritative reference.

| Variable | Type | Default | Required | Notes |
| --- | --- | --- | --- | --- |
| `PORT` | number | `3000` | no | HTTP + WebSocket port |
| `HOST` | string | `127.0.0.1` | no | Bind address |
| `AUTH_MODE` | `apikey` \| `basic` | `apikey` | no | Auth strategy |
| `API_KEY` | string | — | if `apikey` | Shared key |
| `BASIC_USER` | string | — | if `basic` | Basic-auth username |
| `BASIC_PASS` | string | — | if `basic` | Basic-auth password |
| `SMTP_HOST` | string | — | if email enabled | SMTP server host |
| `SMTP_PORT` | number | `587` | no | SMTP port |
| `SMTP_SECURE` | boolean | `false` | no | TLS on connect |
| `SMTP_USER` | string | — | if email enabled | SMTP username |
| `SMTP_PASS` | string | — | if email enabled | SMTP password (redacted) |
| `MAIL_FROM` | string | — | if email enabled | From address |
| `MAIL_TO` | string | — | if email enabled | Comma-separated recipients |
| `TEAMS_WEBHOOK_URL` | url | — | if teams enabled | Incoming webhook (redacted) |
| `ALERT_RULES_FILE` | string | `config/alert-rules.json` | no | Optional rules file |
| `METRICS_RETENTION_MIN` | number | `180` | no | Metric ring window (minutes) |
| `METRICS_SAMPLE_SEC` | number | `5` | no | Poll interval (seconds) |
| `ERROR_BUFFER_SIZE` | number | `500` | no | Error ring capacity per process |
| `ERROR_LOG_APPEND` | boolean | `false` | no | Append captured errors to `logs/errors.log` |
| `DEFAULT_COOLDOWN_SEC` | number | `300` | no | Per-rule anti-spam default |
| `INTENTIONAL_ACTION_GRACE_MS` | number | `10000` | no | Base grace for operator-action tokens (+ `kill_timeout` when known) |
| `ALLOWED_SCRIPT_ROOT` | string | — | no | Optional prefix new scripts must live under |
| `DIGEST_ENABLED` | boolean | `false` | no | Daily digest toggle |
| `DIGEST_HOUR` | number (0-23) | `8` | no | Local hour to send the digest |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` | `info` | no | Log verbosity |
| `MODE` | `standalone`\|`agent`\|`server` | `standalone` | no | Run mode (see [Run modes](#run-modes)) |
| `SERVER_URL` | url (`ws(s)://`) | — | if `agent` | Server base URL (host only; `AGENT_WS_PATH` is appended) |
| `AGENT_TOKEN` | string | — | if `agent` | Token this agent presents (redacted) |
| `AGENT_NAME` | string | — | no | Alias hint seeded on first connect (visual only) |
| `AGENT_ID_FILE` | string | `config/agent-id` | no | Persisted agent-id suffix (gitignored) |
| `AGENT_WS_PATH` | string | `/agent` | no | Agent WS path; must match on both ends; must not be `/ws` |
| `TLS_INSECURE` | boolean | `false` | no | **Agent:** skip server cert verification (unsafe) |
| `AGENT_TOKENS` | string | — | if `server` | Comma-separated valid agent tokens (redacted) |
| `ALIAS_STORE_FILE` | string | `config/agent-aliases.json` | no | Persisted alias map (gitignored) |
| `TLS_CERT_FILE` | string | — | no | **Server:** native TLS cert (pair with key) |
| `TLS_KEY_FILE` | string | — | no | **Server:** native TLS key (pair with cert) |

A channel is "enabled" when its full group of required vars is present. A
Teams-only or email-only deployment is valid; an absent channel is disabled with
a one-time startup log rather than an error.

## Run modes

The `MODE` variable selects one of three mutually exclusive runtimes. It defaults
to `standalone`, so an existing deployment with no `MODE` set behaves exactly as
before — the multi-instance machinery is entirely additive and off by default.

- **`standalone`** (default) — the classic single-process monitor: it attaches to
  the LOCAL PM2 daemon, serves the dashboard and REST/WS API, and alerts. This is
  everything documented above and is unchanged.
- **`agent`** — monitors and controls the LOCAL PM2 daemon exactly like
  standalone, but instead of serving its own dashboard it dials a **server** over
  an outbound WebSocket and streams its process state, metrics, errors, and logs
  there. An agent opens **no inbound port** and serves **no HTTP** of its own. It
  keeps monitoring local PM2 and keeps retrying the server connection
  independently, so a down server never stops local monitoring and a down local
  PM2 never drops the server link.
- **`server`** — the hub. It accepts agent connections on a dedicated WS path,
  keeps a per-agent view of every fleet process, runs the alert engine across all
  agents, and serves the **fleet dashboard** (overview of all agents, drill-down
  into each agent's processes/metrics/logs). A server has **no local PM2 daemon**
  of its own; its health reports an `agents` summary instead of `pm2Connected`.

### Example per mode

Standalone (`.env`):

```ini
# MODE unset (or MODE=standalone)
AUTH_MODE=apikey
API_KEY=change-me-to-a-long-random-string
```

Agent (`.env` on each monitored host):

```ini
MODE=agent
SERVER_URL=wss://monitor.example.com   # base host only; AGENT_WS_PATH (/agent) is appended
AGENT_TOKEN=the-shared-agent-token
AGENT_NAME=checkout-prod               # optional alias hint (visual only)
# TLS_INSECURE=false                   # keep false in production
```

Server (`.env` on the hub):

```ini
MODE=server
AUTH_MODE=apikey
API_KEY=change-me-to-a-long-random-string   # human dashboard auth (unchanged)
AGENT_TOKENS=token-a,token-b                # valid agent tokens (separate credential space)
# TLS terminated at a reverse proxy by default; set the pair below for native TLS:
# TLS_CERT_FILE=/etc/ssl/monitor/fullchain.pem
# TLS_KEY_FILE=/etc/ssl/monitor/privkey.pem
```

### Agent identity and aliases

Each agent derives a **stable id** of the form `<hostname>-<suffix>`, where the
random suffix is generated once and persisted to `AGENT_ID_FILE` (default
`config/agent-id`, gitignored) so the id is stable across restarts. `AGENT_NAME`
(if set) seeds a human-friendly **alias** the first time the agent connects.

The alias is **purely cosmetic** (how you see the agent in the dashboard) and is
independent of the id. An operator can rename an agent inline from the fleet
overview (`PUT /api/agents/:id/alias`); the operator-set alias always wins over
the `AGENT_NAME` hint, and the real id is always shown on hover and in the edit
field so agents remain unambiguous. Aliases are persisted on the server in
`ALIAS_STORE_FILE` (default `config/agent-aliases.json`, gitignored) and survive
a server restart.

### Agent↔server protocol

Agent and server speak a small, **versioned JSON protocol** over the WebSocket. A
`PROTOCOL_VERSION` integer is carried in the handshake; the server rejects a
version mismatch rather than guessing. Every frame is a `type`-discriminated
object validated by a schema that never throws on bad input (a malformed frame is
answered with `{ type: "error", code: "BAD_MESSAGE" }` and never acted on).

Message flow (A→S agent→server, S→A server→agent):

- **Handshake:** `register` (A→S, carries `protocolVersion`, `agentId`, `token`,
  and `meta` host info) → `register:ack` (S→A, with the heartbeat interval) or
  `register:nack` (S→A, `AUTH_FAILED` / `VERSION_MISMATCH`).
- **Liveness:** `heartbeat`/`heartbeat:ack` plus the transport ping/pong backstop.
- **State:** `snapshot` (full process set, re-sent on connect and whenever the set
  changes), `update:transition`, `update:metrics`, `update:error`, `update:pm2`.
- **Control (correlated by a `cid`):** `control:request` / `control:createRequest`
  (S→A) → `control:response` (A→S). An unmatched/duplicate/late response is
  ignored; a request with no response within the timeout resolves as
  `AGENT_TIMEOUT`.
- **Logs:** `log:subscribe` / `log:unsubscribe` (S→A) → `log:line` (A→S).

Control commands are validated with the SAME schemas on both ends: the server
validates before routing, and the agent re-validates before touching PM2.

### Security

- **Separate credential spaces.** Agent tokens (`AGENT_TOKENS`/`AGENT_TOKEN`) and
  human dashboard credentials (`API_KEY` / basic auth) are checked by different
  code on different paths and never cross: a human credential cannot authenticate
  an agent and vice-versa. Agent tokens are compared in constant time and the
  comparison never throws on empty/malformed input.
- **Token rotation / revocation.** `AGENT_TOKENS` is a comma-separated list, so
  multiple tokens are valid at once. To rotate: add the new token alongside the
  old, let every agent reconnect with the new token, then drop the old one — no
  agent restart is required, since an agent retries indefinitely and the next
  (capped) retry succeeds once its token is accepted. To revoke a single agent,
  remove its token and restart the server; that agent's next connect is refused
  with `AUTH_FAILED` and it simply keeps retrying (harmless) until re-authorized.
- **TLS.** Agents dial `wss://` and **verify the server certificate by default**.
  `TLS_INSECURE=true` disables verification and is for self-signed certs in
  testing only — it is logged loudly at startup and on every reconnect, and must
  not be used in production. The server supports **reverse-proxy TLS termination**
  (no cert config; point agents at the proxy's `wss://`) and **native TLS** when
  both `TLS_CERT_FILE` and `TLS_KEY_FILE` are set; setting only one is a config
  error that fails fast at boot.
- **Redaction.** `AGENT_TOKEN`, `AGENT_TOKENS`, and `SERVER_URL` (and any
  `?token=` in a URL) are redacted from all logs.

## Running

### Development

```bash
npm run dev      # tsx watch; reloads on source changes
```

### Production (plain Node)

```bash
npm run build
npm start        # node dist/index.js
```

### Under PM2

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 logs pm2-monitor
```

The monitor then appears as a process named `pm2-monitor` in its own dashboard.
The ecosystem file uses the `.cjs` extension because this project is an ES
module and PM2 loads ecosystem configs through CommonJS `require`. Prefer keeping
real secrets in `.env` (loaded by dotenv at boot) rather than inlining them in
`ecosystem.config.cjs`.

Running as a PM2 child works correctly because the monitor neutralizes the PM2
IPC channel it inherits (the `NODE_CHANNEL_FD` env var) before the `pm2` client
connects, so the client opens its own connection to the daemon instead of trying
to speak over the parent-process channel. It also binds the HTTP/WebSocket server
*before* connecting to PM2, so the dashboard and `GET /api/system/health` always
come up even if the daemon is slow to respond or temporarily unreachable; the
PM2 connection is wired up in the background and retried with backoff. Once
connected, the monitor sees its PM2 siblings — including itself — and
`GET /api/system/health` reports `pm2Connected: true`.

If you would rather not run under PM2, a `systemd` unit is a straightforward
alternative: run `node dist/index.js` from a unit whose working directory is the
project root (so dotenv loads the project-root `.env`), for example with
`WorkingDirectory=/path/to/pm2-monitor` and `ExecStart=/usr/bin/node dist/index.js`.
The same secrets-in-`.env` guidance applies.

## Authentication

Every `/api/*` endpoint requires auth **except** `GET /api/system/health`. The
only unauthenticated surface is the static dashboard shell (`/`, `/css/*`,
`/js/*`) plus that health probe.

- **API-key mode:** send `X-API-Key: <key>` or `Authorization: Bearer <key>`.
- **Basic mode:** send `Authorization: Basic <base64(user:pass)>`.

The dashboard prompts for the credential once and stores it in `sessionStorage`,
attaching it to every REST call and to the WebSocket upgrade. Credential
comparison is constant-time and never throws on malformed/wrong-length input.

## REST API reference

Base path `/api`. Success responses return the resource JSON directly; errors
return `{ "error": { "code", "message" } }` with the status below.
Content-Type is `application/json`.

| Method | Path | Auth | Destructive | Request | Success response |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/system/health` | no | no | — | standalone: `{ status, mode:'standalone', pm2Connected, maintenance, uptimeMs, version }`; server: `{ status, mode:'server', maintenance, agents:{total,online}, uptimeMs, version }` (no `pm2Connected`) |
| GET | `/api/system/status` | yes | no | — | `MonitorSnapshot` |
| GET | `/api/processes` | yes | no | — | `ProcessSnapshot[]` |
| GET | `/api/processes/:name` | yes | no | — | `ProcessSnapshot` or 404 |
| GET | `/api/processes/:name/metrics` | yes | no | `?sinceMs` (default 1h) | `{ name, samples: MetricSample[] }` |
| POST | `/api/processes/:name/start` | yes | **yes** | — | `ControlResult` |
| POST | `/api/processes/:name/stop` | yes | **yes** | — | `ControlResult` |
| POST | `/api/processes/:name/restart` | yes | **yes** | — | `ControlResult` |
| POST | `/api/processes/:name/reload` | yes | **yes** | — | `ControlResult` |
| DELETE | `/api/processes/:name` | yes | **yes** | — | `ControlResult` |
| POST | `/api/processes` | yes | **yes** | `{ script?, ecosystem?, name?, instances?, exec_mode? }` | `ControlResult` (201) |
| GET | `/api/processes/:name/logs` | yes | no | `?lines`(≤2000, default 200), `?stream`(`out`\|`err`\|`all`), `?q`, `?level`(`info`\|`error`) | `{ name, lines: LogLine[] }` |
| GET | `/api/errors` | yes | no | `?name`, `?sinceMs`, `?limit`(≤1000) | `TrackedError[]` |
| GET | `/api/errors/export` | yes | no | `?name`, `?format`(`json`\|`csv`) | file download |
| GET | `/api/alerts/rules` | yes | no | — | `AlertRule[]` |
| POST | `/api/alerts/rules/reload` | yes | no | — | `{ reloaded, count }` or 400 |
| POST | `/api/alerts/test` | yes | no | `{ channel:'teams'\|'email'\|'all' }` | `{ results: [{ channel, ok, error? }] }` |
| GET | `/api/alerts/recent` | yes | no | `?limit`(≤200) | recent alerts |
| GET | `/api/maintenance` | yes | no | — | `{ active, until, reason }` |
| POST | `/api/maintenance` | yes | no | `{ active, durationMin?, reason? }` | updated maintenance state |

**Status codes:** `200` success, `201` create, `400` validation
(`VALIDATION`), `401` auth (`UNAUTHORIZED`), `404` unknown process
(`NOT_FOUND`), `409` PM2 unavailable (`PM2_UNAVAILABLE`), `502` PM2 command
failure (`PM2_ERROR`), `500` unexpected. Destructive control endpoints require
auth; the confirmation prompt is a dashboard (UX) concern.

Example — restart a process:

```bash
curl -X POST -H "X-API-Key: $API_KEY" \
  http://127.0.0.1:3000/api/processes/api/restart
```

### Fleet API (server mode only)

In **server** mode the per-process routes above are not mounted (there is no
single local PM2); the fleet is addressed under `/api/agents` instead, behind the
**same human auth**. Each per-agent route returns the SAME shapes as its
standalone `/api/processes/...` counterpart, so the dashboard reuses the same
views with only the base path changed. `GET /api/system/status` is not mounted in
server mode; use `GET /api/agents` + `GET /api/agents/:id`.

| Method | Path | Destructive | Request | Success response |
| --- | --- | --- | --- | --- |
| GET | `/api/agents` | no | — | `[{ id, alias, online, meta, pm2Connected, processCount, lastSeen }]` (live registry; a pre-seeded alias for a never-connected id is not listed) |
| GET | `/api/agents/:id` | no | — | `{ id, alias, online, meta, pm2Connected, processes }` or 404 `AGENT_NOT_FOUND` |
| GET | `/api/agents/:id/processes` | no | — | `ProcessSnapshot[]` |
| GET | `/api/agents/:id/processes/:name/metrics` | no | `?sinceMs` (default 1h) | `{ name, samples: MetricSample[] }` |
| GET | `/api/agents/:id/processes/:name/logs` | no | `?lines`, `?stream`, `?q`, `?level` | `{ name, lines }` — recent live-relayed lines (see note) |
| GET | `/api/agents/:id/errors` | no | `?name` | `TrackedError[]` |
| POST | `/api/agents/:id/processes/:name/start` | **yes** | — | `ControlResult` |
| POST | `/api/agents/:id/processes/:name/stop` | **yes** | — | `ControlResult` |
| POST | `/api/agents/:id/processes/:name/restart` | **yes** | — | `ControlResult` |
| POST | `/api/agents/:id/processes/:name/reload` | **yes** | — | `ControlResult` |
| DELETE | `/api/agents/:id/processes/:name` | **yes** | — | `ControlResult` |
| POST | `/api/agents/:id/processes` | **yes** | `{ script?, ecosystem?, name?, instances?, exec_mode? }` | `ControlResult` (201 only on ok) |
| PUT | `/api/agents/:id/alias` | no | `{ alias }` | `{ id, alias }` or 400 `VALIDATION` |

Routed-control status codes add two fleet-specific mappings on top of the
standalone set: `409` for `AGENT_OFFLINE`/`AGENT_TIMEOUT` (the agent is not
reachable or did not answer in time) and `404` for `AGENT_NOT_FOUND`.

**Server-mode logs are live-relayed, not a historical file tail.** Unlike
standalone's `/logs`, which reads a real file tail from the local PM2, the
server-mode `GET /api/agents/:id/processes/:name/logs` returns a bounded ring of
the **last ~200 lines that were live-relayed while a WS log subscription was
active**. With nothing actively streaming for that process the ring is empty and
the endpoint returns `{ name, lines: [] }` — a well-defined empty result, not an
error. The primary server-mode log experience is the **live WS relay** (open the
agent's log view in the dashboard); the REST tail is a convenience snapshot of
what is currently streaming.

## WebSocket protocol

Single endpoint `GET /ws` on the same host/port, authenticated at the upgrade.
Browsers open `new WebSocket(url, ["apikey." + KEY])` where `KEY` is the API key
(apikey mode) or `base64(user:pass)` (basic mode); the server echoes the accepted
subprotocol back. Non-browser clients may use `?token=<KEY>` (the token is kept
out of logs via URL redaction).

Client → server frames:

```jsonc
{ "type": "subscribe", "channels": ["state", "alerts"] }
{ "type": "log:subscribe", "process": "api", "streams": ["out", "err"] }
{ "type": "log:unsubscribe", "process": "api" }
{ "type": "ping" }
```

In **server** mode `log:subscribe`/`log:unsubscribe` accept an optional
`agentId` (`{ "type": "log:subscribe", "agentId": "web-1a2b", "process": "api",
"streams": ["out","err"] }`) that selects which agent's logs to relay. The
relayed `log` frame then also carries `agentId`. With no `agentId` the frame is
byte-identical to standalone and uses the local log fan-out unchanged.

Server → client frames:

```jsonc
{ "type": "hello", "snapshot": { /* MonitorSnapshot */ }, "serverTime": 0 }
{ "type": "state", "snapshot": { /* MonitorSnapshot */ } }   // throttled ≤1/sec
{ "type": "process:transition", "name": "api", "from": "online", "to": "errored", "at": 0 }
{ "type": "log", "process": "api", "stream": "err", "line": "...", "level": "error", "ts": 0 }
{ "type": "alert", "payload": { /* AlertPayload */ }, "delivered": true }
{ "type": "pm2", "connected": false }
{ "type": "pong" }
{ "type": "error", "code": "BAD_MESSAGE", "message": "..." }
```

The client reconnects with capped backoff + jitter and re-sends its
subscriptions on reconnect. Live-tail logs have exactly two levels: `info`
(stdout) and `error` (stderr). WS fan-out is server-filtered only by stream
selection; the dashboard's search box and level toggle are client-side.

## Dashboard

Served statically at `/` (no bundler). It renders:

- **Overview** — a responsive grid of process cards with name, color-coded
  status (green online, red errored, grey stopped, amber launching/stopping),
  PID, CPU%, memory, uptime, restarts, and mode × instances, plus
  start/stop/restart/reload/delete buttons. Destructive actions
  (stop/restart/delete) open a confirmation dialog first.
- **Detail** — full metadata, a CPU/memory history chart (Chart.js via CDN;
  degrades to a numeric table if the CDN is blocked), the per-process error
  list, and a live log viewer with client-side search and an info/error toggle.
- A top bar with global WebSocket connectivity, a PM2-unreachable banner, and a
  maintenance-mode toggle.

In **server** mode the dashboard discovers `mode` from `GET /api/system/health`
and adds a **Fleet** view: a grid of agent cards (alias-or-id, online badge,
host/platform, process count, pm2-connected badge) with inline alias editing.
Selecting an agent drills into the SAME overview/detail components, now scoped to
that agent. In **standalone** mode the dashboard is byte-for-byte identical to
before — no agent concepts appear.

## Alert rules

Rules live in the optional JSON file named by `ALERT_RULES_FILE`. A sample is in
[`config/alert-rules.example.json`](./config/alert-rules.example.json). Copy it
to `config/alert-rules.json` and edit. Reload at runtime without restarting via
`POST /api/alerts/rules/reload`.

The file is `{ "rules": [ ... ] }`. Each rule:

```jsonc
{
  "id": "api-crash",                 // required unique slug: /^[a-z0-9][a-z0-9-]{0,63}$/
  "enabled": true,                   // default true
  "description": "API crashed",      // optional
  "match": {
    "processes": ["*"],              // names or "*"; default ["*"]
    "condition": { "type": "errored" }
  },
  "severity": "critical",            // info | warning | critical; default warning
  "channels": { "teams": true, "email": true },  // at least one true
  "cooldownSec": 300                 // optional; falls back to DEFAULT_COOLDOWN_SEC
}
```

Condition types:

```jsonc
{ "type": "errored" }                                           // reaches PM2 errored (restart overlimit)
{ "type": "unexpected-stop" }                                   // stops with no operator action
{ "type": "restart-threshold", "count": 5, "withinMin": 10 }    // crash-loop restarts in a window
{ "type": "cpu-threshold", "percent": 85, "forSec": 120 }       // sustained CPU
{ "type": "mem-threshold", "bytes": 1073741824, "forSec": 120 } // sustained memory (bytes)
{ "type": "error-spike", "count": 20, "withinSec": 60 }         // N error lines in M seconds
```

`errored` and `unexpected-stop` are disjoint (a single lifecycle event maps to
at most one), so subscribe to both deliberately if you want paging for each.
Operator-initiated restarts never trip `restart-threshold`.

## Alert payloads

### Microsoft Teams (MessageCard)

Posted to `TEAMS_WEBHOOK_URL` with `Content-Type: application/json`:

```json
{
  "@type": "MessageCard",
  "@context": "https://schema.org/extensions",
  "themeColor": "D7263D",
  "summary": "pm2-monitor alert: api errored",
  "title": "api errored",
  "sections": [
    {
      "activityTitle": "pm2-monitor alert",
      "facts": [
        { "name": "Process", "value": "api" },
        { "name": "Rule", "value": "any-errored" },
        { "name": "Severity", "value": "critical" },
        { "name": "Detail", "value": "process reached errored state" },
        { "name": "Time", "value": "2024-01-01T08:00:00.000Z" }
      ],
      "text": "process reached errored state (+2 more since last alert)"
    }
  ]
}
```

### Email

Sent via SMTP to `MAIL_TO` as a multipart HTML + plaintext message:

```text
From: alerts@example.com
To: oncall@example.com
Subject: [CRITICAL] pm2-monitor: api errored

Process: api
Rule:    any-errored
Severity: critical
Time:    2024-01-01T08:00:00.000Z

process reached errored state (+2 more since last alert)
```

The HTML body carries the same facts in a small table. Test delivery any time
with `POST /api/alerts/test { "channel": "all" }`.

## Error capture & export

Captured errors are deduplicated into signatures (normalized stack/message),
counted, and kept in a per-process ring buffer. Browse them in the dashboard's
detail view or via `GET /api/errors`, and download them with
`GET /api/errors/export?format=csv` (or `json`). Set `ERROR_LOG_APPEND=true` to
also append each captured error as a JSON line to `logs/errors.log`.

## Limitations (v1)

- **Whole-history log search is out of scope.** `GET /api/processes/:name/logs`
  reads only the trailing `lines` physical lines, then filters that slice; a
  match older than the tail window is not returned.
- **Duplicate process names collapse to one aggregate.** PM2 lets two processes
  share a name; the name-keyed state merges them (last-writer-wins) and logs a
  one-time warning. Use unique process names.
- **Maintenance mode is cleared on restart**, because state is in-memory. A
  timed window also simply disappears if the service restarts.
- **`instances: "max"` is not supported.** The create-process API takes a
  numeric `instances` (1–128). For all-cores clustering, use an ecosystem file.
- **Per-process HTTP health checks are backlogged.** Liveness is covered in the
  interim by the error/crash/restart-threshold/sustained-threshold alert rules.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` (strict). |
| `npm start` | Run `dist/index.js`. |
| `npm run dev` | Watch-mode dev runner (tsx). |
| `npm run typecheck` | Type-only check (`tsc --noEmit`). |
| `npm test` | Run the `node:test` suite via tsx. |

## Development notes

Backend is TypeScript (strict, ESM/NodeNext — relative imports use `.js`
suffixes). The dashboard under `public/` is plain ES-module JavaScript with no
build step. Tests use Node's built-in `node:test` + `node:assert`.
`.env`, `node_modules/`, `dist/`, and `logs/` are git-ignored.
