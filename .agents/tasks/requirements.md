# Requirements — PM2 Process Monitor & Control Panel

## Summary

Build a complete, production-ready PM2 process monitor and control-panel application in `/Users/puser/repos/phinx/Arbitrage/pm2-monitor`. The application is a Node.js + TypeScript service that connects to the local PM2 daemon, monitors managed processes, exposes a REST API and a lightweight web dashboard to view and control those processes, captures and counts errors, and raises alerts through Microsoft Teams webhooks and email. The application must itself be runnable as a PM2 process.

The target directory is an existing git repo containing only `.git` and `.gitignore`. Work happens on the current branch (no worktree). All deliverables live under `/Users/puser/repos/phinx/Arbitrage/pm2-monitor`.

### Fixed technology stack (decided — not open for substitution)

These choices are locked. Downstream design and implementation must use exactly these.

- **Runtime/language:** Node.js (target Node 20+ LTS) + TypeScript in **strict** mode, compiled with `tsc`.
- **HTTP framework:** Express.
- **Real-time transport:** WebSocket via the `ws` package (preferred over SSE). Use WebSocket consistently for all live updates; do not mix in SSE.
- **PM2 integration:** the official `pm2` npm package programmatic API — `pm2.connect`, `pm2.list`, `pm2.describe`, `pm2.restart`, `pm2.stop`, `pm2.start`, `pm2.reload`, `pm2.delete`, and `pm2.launchBus()` for real-time events (`exit`, `restart`, `log`, `process:event`). Must include robust reconnection to the PM2 daemon.
- **Email:** Nodemailer with configurable SMTP.
- **MS Teams:** outgoing webhook POST (MessageCard or Adaptive Card JSON) sent via native Node 20 global `fetch` or `axios`.
- **Frontend:** lightweight single-page dashboard served by Express — plain HTML + modern vanilla JS + CSS, **no heavy build step/bundler**. It consumes the REST API and subscribes to the WebSocket for live updates.
- **Config:** all parameters via env vars loaded with `dotenv`, plus an optional JSON config file for alert rules. A documented `.env.example` is required.
- **Input validation:** validate all API inputs (e.g. with `zod`).
- **Logging:** structured logging via a small logger (e.g. `pino`) or a simple custom logger — no large dependency tree.

### Assumptions

1. The PM2 daemon runs on the same host as the monitor and is reachable through the local programmatic API. (Noted because the task references `pm2.connect` with no remote-daemon requirement.)
2. There is a single administrative audience; auth is a shared API key or a single user/pass credential set, not multi-user accounts with roles. (The task says "simple auth (API key or user/pass)".)
3. Metrics history is kept in memory for "the last few hours"; no external time-series database is required.
4. The current `.gitignore` already ignores `node_modules/`, `dist/`, and `*.log`, but does **not** ignore `.env`. The implementation must add `.env` (and the `logs/` directory if one is used) to `.gitignore` to satisfy the secret-handling requirement.

## Functional Requirements

### FR1 — Process list & status
As an operator, I want to see every PM2-managed process with its live status so I can assess system health at a glance.
- Show per process: name, pid, status, CPU %, memory, uptime, restart count, mode (fork/cluster), instances.

### FR2 — Process control
As an operator, I want to control processes from the REST API and dashboard buttons.
- Supported actions: start, stop, restart, reload (graceful), delete, and start a new process from a script path or ecosystem file.
- Destructive actions (stop, delete, restart) require explicit confirmation in the UI before execution.
- All control endpoints are protected by authentication (see FR8).

### FR3 — Log viewing
As an operator, I want to read and follow process logs.
- Read stdout/stderr per process.
- Live tail streamed over WebSocket.
- Support text/level filtering and search over log lines.

### FR4 — Error capture & counting
As an operator, I want errors tracked and summarized per process.
- Detect error events, crashes, and unexpected restarts via the PM2 bus (`launchBus`).
- Maintain an error counter per process and per time window.
- Deduplicate repeated errors by a signature derived from the stack trace/message.
- Store recent errors in memory using a ring buffer, with an option to append to a log file.

### FR5 — Alert engine with configurable rules
As an operator, I want configurable rules that trigger alerts on defined conditions.
- Rule conditions to support:
  - process errored or unexpectedly stopped;
  - restart threshold exceeded within X minutes;
  - CPU or memory above a threshold sustained for a duration;
  - error spike in logs (N errors within M seconds).
- Each rule can target MS Teams and/or email; each channel is toggleable per rule.
- Anti-spam: per-alert cooldown / rate limiting so repeated conditions do not flood channels.
- Rules are configurable via the optional JSON config file (with env vars for global thresholds/cooldowns where applicable).

### FR6 — Alert channels
As an operator, I want alerts delivered reliably through Teams and email.
- **MS Teams:** POST a MessageCard or Adaptive Card JSON payload to the configured outgoing webhook.
- **Email:** send via Nodemailer using configurable SMTP (host, port, user, pass, from, to).
- A delivery failure on one channel must not crash the app or block the other channel.

### FR7 — Web dashboard
As an operator, I want a usable dashboard.
- Overview with one card per process, status colors, and action buttons.
- Per-process detail view.
- Control actions with confirmation for destructive operations.
- Live log viewer fed by WebSocket.

### FR8 — Authentication (mandatory nice-to-have)
As an operator, I want control endpoints protected.
- Simple auth: API key or single user/pass.
- Protects especially the destructive/control endpoints; the dashboard must still be able to authenticate against them.

### FR9 — Maintenance mode (mandatory nice-to-have)
As an operator, I want to silence alerts during planned work.
- A maintenance mode that suppresses alert delivery while active, without stopping monitoring/visibility.

### FR10 — Daily email digest (mandatory nice-to-have)
As an operator, I want a periodic summary.
- A periodic (daily) digest email summarizing process status and error activity.

### FR11 — Additional nice-to-haves (implement where they add value)
These are optional and may be backlogged with a stated reason during design/implementation:
- Metrics history (CPU/mem) for the last few hours with a simple chart (inline or Chart.js via CDN).
- Optional per-process HTTP health checks.
- Export/download of logs/errors.

## Non-Functional Requirements

### NFR1 — Architecture & code quality
- TypeScript strict mode throughout; modular, well-commented code.
- Clear separation of concerns into distinct modules: PM2 integration layer, alert engine, alert channels (Teams/email), error tracker, metrics store, HTTP/API layer, WebSocket layer, config loader.
- Entry point at `src/index.ts`.

### NFR2 — Resilience
- Robust error handling across all fallible operations.
- Automatic PM2 daemon reconnection.
- If the PM2 daemon is unreachable, the app degrades gracefully: it logs a warning and keeps serving the dashboard rather than crashing.

### NFR3 — Logging
- Structured logging via `pino` or a small custom logger. No large dependency tree.

### NFR4 — Security
- Validate all API inputs (e.g. `zod`).
- Protect control endpoints behind auth.
- Do not expose secrets; read secrets only from env. `.env` must be gitignored.
- Verify `.gitignore` covers `node_modules`, `dist`, `.env`, and `logs`. (`.env` and `logs` are currently missing and must be added.)
- Sanitize/validate script-path and process-name inputs to prevent command/argument injection.

### NFR5 — Dependencies
- Pin dependency versions in `package.json`.

## Deliverables

All under `/Users/puser/repos/phinx/Arbitrage/pm2-monitor`:

1. **`package.json`** with scripts: `build` (`tsc`), `start` (`node dist/...`), `dev` (`tsx` or `ts-node` watch), and a trivial `lint` if easy to add. Pinned dependency versions.
2. **`tsconfig.json`** with strict mode enabled, Node 20+ target.
3. **Backend under `src/`** organized into the modules listed in NFR1, with entry `src/index.ts`.
4. **Frontend under `public/`** — `index.html` + JS + CSS, served by Express.
5. **`.env.example`** documenting every env var: `PORT`, auth creds/API key, SMTP host/port/user/pass/from/to, Teams webhook URL, thresholds, cooldowns, config file path, etc.
6. **Sample alert-rules JSON config file**, documented in the README.
7. **`ecosystem.config.js`** example so the monitor itself runs under PM2.
8. **`README.md`**: what it does, install, configuration of every env var, how to run in dev and under PM2, API endpoint reference, example Teams/email alert payloads, and a dashboard description.
9. **Updated `.gitignore`** adding `.env` and `logs/`.

## Acceptance Criteria

Each criterion is numbered and testable.

1. `npm install` completes successfully in the project directory.
2. `npm run build` compiles with **zero** TypeScript errors under strict mode.
3. `tsconfig.json` has `"strict": true` and targets Node 20+; `package.json` has `build`, `start`, and `dev` scripts and pinned dependency versions.
4. On start, the app boots: the HTTP server comes up on the configured `PORT` and attempts to connect to the PM2 daemon.
5. `curl http://localhost:<PORT>/` returns the dashboard HTML.
6. A health/status API endpoint returns JSON.
7. When the PM2 daemon is unreachable, the app logs a warning, keeps serving the dashboard, and does not crash (this path is explicitly verified).
8. The process list endpoint/dashboard shows, per process: name, pid, status, CPU %, memory, uptime, restart count, mode, instances.
9. REST and dashboard controls perform start, stop, restart, reload, delete, and start-new-process (from script path or ecosystem file); stop/delete/restart require UI confirmation.
10. Logs can be read per process (stdout/stderr), live-tailed over WebSocket, and filtered/searched by text/level.
11. Errors, crashes, and unexpected restarts are detected via the PM2 bus; errors are counted per process and per time window, deduplicated by stack/message signature, and stored in an in-memory ring buffer (with optional file append).
12. Alert rules support all four condition types (errored/unexpected stop; restart threshold within X min; CPU/mem threshold sustained; error spike N-in-M seconds); each rule targets Teams and/or email with per-channel toggles; per-alert cooldown/rate limiting prevents flooding.
13. A Teams alert posts valid MessageCard/Adaptive Card JSON to the configured webhook; an email alert sends via Nodemailer SMTP; a failure in one channel does not crash the app or block the other.
14. The dashboard provides an overview (cards per process with status colors and action buttons), a per-process detail view, confirmation on destructive actions, and a live log viewer.
15. Control endpoints are protected by auth (API key or user/pass); unauthenticated requests to protected endpoints are rejected.
16. Maintenance mode suppresses alert delivery while active without stopping monitoring.
17. A daily digest email summarizing status/errors is implemented.
18. All API inputs are validated (e.g. zod); invalid input is rejected with a clear error rather than being executed.
19. Script-path and process-name inputs are sanitized/validated to prevent command/argument injection.
20. Secrets are read only from env; `.gitignore` covers `node_modules`, `dist`, `.env`, and `logs`; no secret values are hard-coded or committed.
21. `.env.example` documents every env var the app reads; `ecosystem.config.js`, the sample alert-rules JSON, and `README.md` (with the required sections and example payloads) are present.
22. Temp/test artifacts are cleaned up; `node_modules` and `dist` are not committed. No git commit is created unless everything builds and boots; if a commit is made, only specific files are staged (never `git add .`) and `.env`/`node_modules`/`dist` are never committed. Leaving the work uncommitted for review is acceptable.

## Out of Scope

- Remote/multi-host PM2 daemon monitoring (single local daemon assumed).
- Multi-user accounts, roles, or RBAC beyond a single shared credential/API key.
- Persistent long-term storage of metrics/errors in an external database (in-memory retention for a few hours only).
- A heavy frontend framework or bundler/build pipeline for the dashboard.
- Production deployment infrastructure (containers, CI/CD, reverse proxy, TLS termination) beyond the `ecosystem.config.js` example.
