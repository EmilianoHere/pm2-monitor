# Implementation Plan — PM2 Process Monitor & Control Panel

This plan builds the entire application from scratch per `design.md` (the source of truth; read its Round-3 resolutions section). Items are ordered by dependency; each leaves the codebase in a buildable state. The project is a local git repo on `main` with only `.gitignore` committed; Node 20.19.2 and npm 10.8.2 are available.

Pinned dependency versions (exact, no `^`/`~`), chosen within the design's locked majors:
- Runtime: `express@4.22.3`, `ws@8.22.0`, `pm2@5.4.3`, `nodemailer@6.10.1`, `dotenv@16.6.1`, `zod@3.25.76`
- Dev: `typescript@5.9.3`, `tsx@4.23.15`, `@types/node@20.19.43`, `@types/express@4.17.25`, `@types/ws@8.18.2`, `@types/nodemailer@6.4.24`
- MS Teams uses the Node 20 global `fetch` — no HTTP-client dependency.

Testing: Node's built-in `node:test` + `node:assert` (no heavy test dependency, per NFR3/design Testability). Unit tests are TypeScript run via `tsx`.

Global verification commands (used throughout):
- `npm install` — completes with no error.
- `npm run build` — `tsc` strict, ZERO errors.
- `npm test` — `node:test` suite passes.
- Boot-without-pm2 check (AC4–AC7): see item 20.

---

- [ ] 1. Scaffold the project: `package.json` (scripts `build`=`tsc`, `start`=`node dist/index.js`, `dev`=`tsx watch src/index.ts`, `typecheck`=`tsc --noEmit`, `test`=`tsx --test "src/**/*.test.ts"`, `lint` trivial no-op or `tsc --noEmit`), with exact pinned deps above and `engines.node: ">=20"`; `tsconfig.json` (strict, `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `outDir dist`, `rootDir src`, `esModuleInterop`, `skipLibCheck`, `types: ["node"]`); update `.gitignore` adding explicit `.env` and `logs/` lines.
      Files: package.json, tsconfig.json, .gitignore
      Verify: `npm install` succeeds; `npm run build` emits zero errors against an empty/`src/index.ts` stub (add a one-line stub so tsc has an input); `.gitignore` contains `.env` and `logs/`.

- [ ] 2. Core logger (`src/core/logger.ts`): structured JSON logger with levels (debug/info/warn/error gated by `LOG_LEVEL`), child loggers, a redaction set (`API_KEY`, `BASIC_PASS`, `SMTP_PASS`, `TEAMS_WEBHOOK_URL`) replacing values with `***`, and a shared `redactUrl(url)` helper that rewrites `token=…` → `token=***`. Rate-limited `warnOnce`/throttle helper for noisy paths.
      Files: src/core/logger.ts, src/core/logger.test.ts
      Verify: `npm test` — logger tests pass (level gating, redaction of known keys, `redactUrl` strips token).

- [ ] 3. Shared types + typed event emitter (`src/core/events.ts`) and the snapshot/data-model types. Define `ProcStatus`, `ProcessSnapshot`, `MetricSample`, `LogLine`, `TrackedError`, `MonitorSnapshot` (per Core data model) in `src/core/types.ts`, and a typed `MonitorEvents` EventEmitter carrying `state:update`, `process:transition`, `pm2:connected`, `pm2:disconnected`, `metrics:tick` (`ProcessSnapshot[]`), `error:captured`, `log:line`, `alert`.
      Files: src/core/types.ts, src/core/events.ts
      Verify: `npm run build` — zero errors (types compile and are importable).

- [ ] 4. Config loaders. `src/config/env.ts`: `loadConfig(): AppConfig` runs `dotenv.config()`, parses `process.env` through a zod schema (every var in the design config table, with coercion/defaults, channel-group and auth-mode cross-field refinements), fails fast (log aggregated issues, exit 1) on invalid env. `src/config/alertRules.ts`: `loadAlertRules(path): AlertRule[]` with `alertRuleSchema` = zod object whose `condition` is a `discriminatedUnion('type', …)` over the five variants; `type AlertRule = z.infer<...>`; missing file → `[]` + warn, invalid file → log issues + exit 1.
      Files: src/config/env.ts, src/config/alertRules.ts, src/config/env.test.ts, src/config/alertRules.test.ts
      Verify: `npm test` — valid/invalid env and rules inputs produce the specified typed output / validation errors.

- [ ] 5. Error signature + tracker. `src/errors/signature.ts`: pure deterministic `signature(processName, text)` per the 5-step algorithm (first stack frame or first line → normalize paths/line:col/hex/number runs → prepend name → sha1 first 16 hex). `src/errors/tracker.ts`: `ErrorTracker` subscribes to `error:captured`, dedups into per-process `Map<signature,TrackedError>`, ring buffer capacity `ERROR_BUFFER_SIZE`, two 1-second-slot rings (errors; crash-loop restarts) sized to max requested rule window (recomputed/resized on reload, 60s floor, clamp+warn guard), exposing `countInWindow(name,sinceSec)` and `restartsInWindow(name,sinceSec)`; restart ring increments only on `intentional===false` restarts (not `restart overlimit`, not operator restarts); optional best-effort append to `logs/errors.log` when `ERROR_LOG_APPEND`.
      Files: src/errors/signature.ts, src/errors/tracker.ts, src/errors/signature.test.ts, src/errors/tracker.test.ts
      Verify: `npm test` — signature stability (same error varying ts/pid/line → one sig), dedup counting, ring eviction, window sums, resize grow/shrink, restart-ring exclusions.

- [ ] 6. Metrics store (`src/metrics/store.ts`): `MetricsStore` per-process ring of `MetricSample`, capacity `ceil(METRICS_RETENTION_MIN*60/METRICS_SAMPLE_SEC)`, `push(name,sample)`, internal `getSeries(name,sinceMs)`, and `sustainedAbove(name, metric:'cpu'|'mem', threshold, durationSec)` with the coverage-tolerance contract (`required = max(1, ceil(durationSec/sampleSec)-1)`, gap > `2*sampleSec` → false, insufficient coverage → false fail-safe, else true iff every in-window sample exceeds threshold). Clock injectable for tests.
      Files: src/metrics/store.ts, src/metrics/store.test.ts
      Verify: `npm test` — under-coverage→false, gap→false, steady-state arms within one window, eviction, `sustainedAbove` true/false cases.

- [ ] 7. State hub (`src/core/state.ts`): `MonitorState` owns `Map<string,ProcessSnapshot>` (name-keyed aggregate), the owned `MetricsStore` and `ErrorTracker`, `pm2Connected`, `maintenance` (+optional `until`/`reason`), and the `MonitorEvents` ref. Read methods `snapshot()`, `getProcess(name)`, `getMetrics(name,sinceMs)` (delegates to owned `MetricsStore.getSeries`). Mutations `applyPm2List(list)`, `setConnected(bool)`, `setMaintenance(...)` emit events. Subscribes to `metrics:tick`: push each `online` snapshot as a sample (`mem: snap.memory`), skip non-online, drop series for names no longer present.
      Files: src/core/state.ts, src/core/state.test.ts
      Verify: `npm test` — applyPm2List updates+emits, getMetrics delegates, metrics:tick push skips non-online and prunes deleted names, maintenance set/expire.

- [ ] 8. PM2 mapper (`src/pm2/mapper.ts`): pure `mapProcess(raw): ProcessSnapshot` (aggregate per name) plus bus-packet normalizers using the field-path defense (`packet.event ?? packet.data?.event`, `packet.process ?? packet.data?.process`); one-time warn on name collision across differing `pm_id` sets.
      Files: src/pm2/mapper.ts, src/pm2/mapper.test.ts
      Verify: `npm test` — recorded `pm2.list` fixtures map correctly; both flat and nested packet layouts resolve; `process:exception` packet normalizes; collision warns once.

- [ ] 9. PM2 client (`src/pm2/client.ts`): `Pm2Client` — the only module touching `pm2`. Promisified connect/list/describe/control/startNew/readLogsTail; connect+exponential-backoff reconnection (1→2→4…cap 30s, ±20% jitter, warn-then-debug); `launchBus` subscribing to `process:event`, `process:exception`, `log:err`, `log:out` with the pinned event→`MonitorEvents` translation (including `restart overlimit` → errored only, no restart-counter increment; `exit`/`stop` token classification); the intentional-action FIFO token queue (one token per instance, `kill_timeout`-aware grace via `INTENTIONAL_ACTION_GRACE_MS`, FIFO consume, 30s janitor); the `setInterval(METRICS_SAMPLE_SEC)` poll loop that lists → `applyPm2List` → emits one `metrics:tick`; `readLogsTail` bounded end-of-file read then level-then-q in-memory filter; disconnected control short-circuits to `{ok:false, PM2_UNAVAILABLE}`.
      Files: src/pm2/client.ts, src/pm2/client.test.ts (token model + classification with injected clock/fake pm2 and fake snapshot for `instances`)
      Verify: `npm test` — token one-per-instance/FIFO/expiry/restart-exit-online suppression; `npm run build` zero errors (depends on `pm2` + `@types/node` installed in item 1).

- [ ] 10. Alert channels. `src/alerts/channels/types.ts` (`AlertChannel`, `AlertPayload`, `EmailChannel extends AlertChannel` with `sendRaw`). `src/alerts/channels/teams.ts`: `TeamsChannel.send` builds MessageCard JSON (themeColor by severity, activityTitle, facts) and POSTs via `fetch` with a 10s `AbortController` timeout; non-2xx/network rejects. `src/alerts/channels/email.ts`: `EmailChannel` Nodemailer transport built once, `verify()`-ed at startup (failed verify disables channel + warn), `send(payload)` (HTML+text) and `sendRaw({subject,html,text})`; disabled when SMTP config absent.
      Files: src/alerts/channels/types.ts, src/alerts/channels/teams.ts, src/alerts/channels/email.ts, src/alerts/channels/teams.test.ts (pure payload builder)
      Verify: `npm test` — Teams payload builder produces valid MessageCard shape for each severity; `npm run build` zero errors.

- [ ] 11. Cooldown + alert engine. `src/alerts/cooldown.ts`: `CooldownTracker` in-memory `Map<string,{lastFired,suppressed}>` keyed `(ruleId,processName)`, injectable clock. `src/alerts/engine.ts`: `AlertEngine` holds rules/cooldown/channels; event-driven eval (`errored` on transition→errored, `unexpected-stop` on token-less stop/exit, `restart-threshold` via `restartsInWindow`, `error-spike` via `countInWindow`) and sampled eval on `metrics:tick` (subscribed after `MonitorState`) via `MonitorState.getMetrics`→`sustainedAbove`; builds `AlertPayload`, cooldown gate with `suppressedCount` rollup, maintenance gate (record+log, no dispatch), dispatch via `Promise.allSettled` (one channel failure never throws/blocks); keeps a recent-alerts list.
      Files: src/alerts/cooldown.ts, src/alerts/engine.ts, src/alerts/cooldown.test.ts, src/alerts/engine.test.ts
      Verify: `npm test` — cooldown fire/suppress/reset; engine cooldown + maintenance gating + `allSettled` isolation with fake state/clock/spy channels.

- [ ] 12. Daily digest (`src/alerts/digest.ts`): scheduler computing next `DIGEST_HOUR` local-time occurrence via `setTimeout`, building the digest (per-process status table, restart counts, top error signatures = `lastSeen` within 24h ranked by all-time `count` top N, labeled approximation; totals dispatched/suppressed) and sending via `EmailChannel.sendRaw`; independent of maintenance mode; send failure warns and reschedules.
      Files: src/alerts/digest.ts, src/alerts/digest.test.ts (payload builder + next-fire computation with injected clock)
      Verify: `npm test` — next-fire time computed correctly across hour boundaries; digest payload builder output shape.

- [ ] 13. Auth (`src/api/auth.ts`): the single length-guarded `safeEqual(provided,expected)` (sha256 both sides to 32-byte digests then `timingSafeEqual`; never throws). Express middleware for apikey mode (`X-API-Key` or `Authorization: Bearer`) and basic mode (`Authorization: Basic`, both user+pass each via `safeEqual`), rejecting `401` (+`WWW-Authenticate` in basic). Exported `safeEqual` reused by the WS upgrade handler.
      Files: src/api/auth.ts, src/api/auth.test.ts
      Verify: `npm test` — `safeEqual` returns false (never throws) on empty/wrong-length/malformed input, true on exact match; middleware 401 paths.

- [ ] 14. Request validation + schemas (`src/api/validate.ts`, `src/api/schemas.ts`): `validate(schema)` middleware parsing `{body,query,params}` → `400 {error:{code:'VALIDATION',message}}`; process-name rule `/^[A-Za-z0-9._-]{1,100}$/`; script-path rule (absolute, normalized, no `..`, allowed extension, exists, optional `ALLOWED_SCRIPT_ROOT`); ecosystem-path rule; create-process body with `instances 1..128`, `exec_mode enum`, XOR script/ecosystem refinement, `instances>1 ⇒ cluster`; numeric query clamps (`lines≤2000`, `limit`, `sinceMs`, `durationMin`).
      Files: src/api/schemas.ts, src/api/validate.ts, src/api/schemas.test.ts
      Verify: `npm test` — injection strings rejected, bounds/refinements enforced, clamps applied, XOR enforced.

- [ ] 15. REST routes (`src/api/routes/*.ts`): `system.ts` (health unauth; status auth), `processes.ts` (list/detail/metrics/control start·stop·restart·reload·delete/startNew, 404/409/502 codes, name resolved before readLogsTail for logs 404-vs-200, `logs` endpoint), `logs.ts`, `errors.ts` (list + export json/csv), `alerts.ts` (rules read, rules/reload, test, recent, maintenance get/set). All use `validate` + `auth` except `GET /api/system/health`.
      Files: src/api/routes/system.ts, src/api/routes/processes.ts, src/api/routes/logs.ts, src/api/routes/errors.ts, src/api/routes/alerts.ts
      Verify: `npm run build` zero errors (integration-tested in item 17).

- [ ] 16. Express server factory (`src/api/server.ts`): `createServer(deps): http.Server` — JSON body parser (64KB limit), request logger using `redactUrl`, auth middleware wiring, route mounts under `/api`, static mount of `public/` at `/`, terminal error handler mapping to `{error:{code,message}}` (5xx→error log, 4xx→debug), returns the shared `http.Server`.
      Files: src/api/server.ts
      Verify: `npm run build` zero errors (exercised in item 17).

- [ ] 17. WebSocket hub (`src/ws/hub.ts`): `WsHub` attaches `ws` `WebSocketServer` in `noServer` mode to the shared server, handles `upgrade` with `safeEqual` auth (credential from `apikey.<KEY>` subprotocol or `?token=`, echoing the accepted subprotocol via `handleUpgrade`; `401`+destroy on failure; never logs `req.url`, only `"/ws"`+`authed`); per-client subscription sets; broadcasts `hello`/`state`(throttled 1/s)/`process:transition`/`log`/`alert`/`pm2`/`pong`; per-client log-tail subscription fan-out off `log:line`.
      Files: src/ws/hub.ts
      Verify: integration test (item 18) — `hello`, subscription filtering, log fan-out, upgrade-auth rejection without crashing.

- [ ] 18. API + WS integration tests via `node:test` + a `supertest`-style approach (use Node's `http` + `ws` client against the real app with a fake `Pm2Client`): auth 401, validation 400, control happy/error, `409` when disconnected, graceful-degradation path (`pm2Connected:false`), and WS `hello`/subscription/log fan-out/upgrade-auth rejection.
      Files: src/api/server.test.ts, src/ws/hub.test.ts, src/testutil/fakePm2Client.ts
      Verify: `npm test` — all integration tests pass.

- [ ] 19. Entry/bootstrap (`src/index.ts`): boot order per design (loadConfig → logger → loadAlertRules → MonitorState/MetricsStore/ErrorTracker → channels → AlertEngine wiring → Pm2Client.start() non-blocking → createServer + WsHub → listen(PORT,HOST) → digest scheduler); SIGINT/SIGTERM graceful shutdown (stop accepting, close WS, pm2Client.stop(), flush error log, exit 0); `unhandledRejection`/`uncaughtException` logged, uncaught → graceful shutdown exit 1.
      Files: src/index.ts
      Verify: `npm run build` zero errors; boot check in item 20.

- [ ] 20. Boot-without-PM2 verification (AC4–AC7). With `pm2` NOT running (do not start a daemon), build and launch the app with a minimal `.env` (apikey mode); confirm it stays up, `GET /` returns dashboard HTML, `GET /api/system/health` returns JSON with `pm2Connected:false`, and no crash; the reconnect loop logs a warning. Capture the behavior, then stop the process.
      Files: (none — runtime verification)
      Verify: `npm run build` then `node dist/index.js` with pm2 absent; `curl -s localhost:$PORT/ | head` returns HTML and `curl -s localhost:$PORT/api/system/health` returns JSON `pm2Connected:false`; process does not exit.

- [ ] 21. Dashboard (`public/`): `index.html` (ES modules, Chart.js CDN with graceful degradation), `css/styles.css`, `js/app.js` (sessionStorage auth + login prompt, routing overview/detail), `js/api.js` (REST client adding auth header), `js/ws.js` (WS client opening `new WebSocket(url,["apikey."+KEY])`, backoff reconnect, re-subscribe), `js/views/overview.js` (process cards grid, status colors, action buttons, confirm dialog on stop/restart/delete), `js/views/detail.js` (metadata, metrics chart→numeric-table fallback, error list), `js/views/logs.js` (WS live tail + client-side search/level filter + GET /logs backfill); PM2-unreachable banner + maintenance toggle.
      Files: public/index.html, public/css/styles.css, public/js/app.js, public/js/api.js, public/js/ws.js, public/js/views/overview.js, public/js/views/detail.js, public/js/views/logs.js
      Verify: with the app running (item 20 setup), `GET /` returns the dashboard HTML referencing the JS modules; manual load shows cards/empty state and the PM2-unreachable banner while pm2 is down.

- [ ] 22. Supporting artifacts: `.env.example` (every env var from the config table with comments), `config/alert-rules.example.json` (valid sample matching the schema), `ecosystem.config.js` (runs `dist/index.js`), `README.md` (what it does, install, every env var, run in dev + under PM2, full REST API reference, example Teams MessageCard + email payloads, WS protocol note, dashboard description, documented limitations: whole-history log search out of scope, duplicate-name aggregate, maintenance cleared on restart, `instances:"max"` unsupported→use ecosystem).
      Files: .env.example, config/alert-rules.example.json, ecosystem.config.js, README.md
      Verify: `node -e "require('./ecosystem.config.js')"` loads; `node -e "JSON.parse(require('fs').readFileSync('config/alert-rules.example.json','utf8'))"` parses; the sample validates against `loadAlertRules` (a tiny tsx check); `npm run build` still zero errors.

- [ ] 23. Final full verification + cleanup: `npm install`, `npm run build` (zero strict errors), `npm test` (all pass), and the boot-without-pm2 check (item 20) once more end-to-end; remove any temp/test artifacts; confirm `.gitignore` prevents `.env`/`node_modules`/`dist`/`logs/` from being staged. Do not commit unless everything builds and boots; if committing, stage specific files only (never `git add .`).
      Files: (none — verification + cleanup)
      Verify: `npm install && npm run build && npm test` all succeed; boot-without-pm2 smoke passes.

## Notes / assumptions

- Dependency majors follow `design.md` exactly (Express 4, zod 3, TypeScript 5, dotenv 16, nodemailer 6, pm2 5, ws 8). Exact patch versions pinned above are the latest within each locked major as of planning; the implementer may bump to the newest patch within the same major if install resolves differently, keeping versions exact (no ranges).
- Test runner is `node:test` run through `tsx` (no extra heavy dependency), matching the design's Testability section. If a `supertest` equivalent is wanted it can be added as a devDependency without changing module boundaries; the plan uses Node's own `http`/`ws` clients to avoid it.
- `logs/` is created lazily at runtime only when `ERROR_LOG_APPEND` is true; it is gitignored.
