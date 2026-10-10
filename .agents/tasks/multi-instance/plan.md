# Implementation Plan — Multi-Instance (Hub-and-Spoke) Mode for pm2-monitor

Derived from `design.md` (source of truth) and the 59 EARS criteria in `requirements.md`, grounded in the worktree source read during exploration. Ordered by dependency; every item leaves the tree buildable (`npm run build`) and keeps the ~164 existing tests green (`npm test`). All paths are relative to the worktree root `/Users/puser/repos/phinx/Arbitrage/emi/pm2-monitor/.worktrees/multi-instance`.

Project facts (verified): Node 20+, TS strict, ESM NodeNext (relative imports carry `.js`). Build = `npm run build` (`tsc`). Tests = `npm test` (`tsx --test $(find src -name '*.test.ts')`). Config is one zod `z.object({…}).superRefine(…)` (a `ZodEffects`) in `src/config/env.ts`; `AppConfig = z.infer<typeof configSchema>`. The only `pm2` import site is `src/pm2/client.ts`. The sole credential comparator is throw-safe `safeEqual` in `src/api/auth.ts`. Logger redaction (`REDACTED_KEYS`, `redactUrl`, full-depth `redactContext`) is in `src/core/logger.ts`. Wire-reusable core types live in `src/core/types.ts`. Standalone (MODE unset) must stay byte-for-byte behaviorally unchanged (NFR-1).

Default-secure: TLS verify on, insecure toggle off, both-ends validation, no secret logged.

---

- [ ] 1. Extract `backoffDelay` into `src/core/backoff.ts` with an injected RNG seam.
      Signature `backoffDelay(attempt: number, rand: () => number = Math.random): number` (base 1s, cap 30s, ±20% jitter — the exact constants/algorithm currently inline in `src/pm2/client.ts`). Replace the private method body in `Pm2Client` to call the shared helper with the default `rand` (pure refactor, no behavior change).
      Files: src/core/backoff.ts (new), src/core/backoff.test.ts (new), src/pm2/client.ts
      Verify: `npm test` — new backoff test asserts delay sequence, deterministic ±20% bounds via injected rand (0/1/0.5 → base*0.8/base*1.2/base), 30s cap, non-negativity; all existing suites still pass.

- [ ] 2. Add `MODE` + mode-scoped vars + cross-field guards to `src/config/env.ts`.
      Insert new keys INSIDE the existing `z.object({…})` literal before the trailing `.superRefine` (do NOT use `.extend`/`.merge`/a second `.superRefine`): `MODE` (`z.enum(['standalone','agent','server']).default('standalone')`), agent vars `SERVER_URL` (url, optional), `AGENT_TOKEN` (min1, optional), `AGENT_NAME` (blank→undefined, optional), `AGENT_ID_FILE` (default `config/agent-id`), `AGENT_WS_PATH` (startsWith `/`, default `/agent`), `TLS_INSECURE` (booleanish, default false); server vars `AGENT_TOKENS` (blank→undefined, optional comma list), `ALIAS_STORE_FILE` (default `config/agent-aliases.json`), `TLS_CERT_FILE`/`TLS_KEY_FILE` (blank→undefined, optional). Add new `ctx.addIssue` guards INSIDE the existing `superRefine` body after the auth/email guards: agent requires SERVER_URL+AGENT_TOKEN; SERVER_URL must start ws://|wss://; server requires AGENT_TOKENS|AGENT_TOKEN; TLS cert/key must be set as a pair; `MODE==='server' && AGENT_WS_PATH==='/ws'` is rejected. Keep `AppConfig = z.infer<typeof configSchema>`.
      Files: src/config/env.ts, src/config/env.test.ts
      Verify: `npm test` — extended env tests: default=standalone; invalid MODE→fail; agent missing url/token→fail; server missing token→fail; half TLS pair→fail; non-ws(s) url→fail; server with AGENT_WS_PATH=/ws→fail; legacy `.env` (no MODE) unchanged.

- [ ] 3. Create the shared protocol module `src/protocol/` (version, shapes, messages, codec, correlation).
      `version.ts` exports `PROTOCOL_VERSION = 1`. `shapes.ts` holds zod mirrors of `ProcessSnapshot`/`MetricSample`/`LogLine`/`TrackedError`/`ControlResult`/transition with a compile-time type-equality assertion against `src/core/types.ts`. `messages.ts` is a `z.discriminatedUnion('type', […])` over every frame in design §2 (register/register:ack/register:nack, heartbeat/heartbeat:ack, snapshot, update:transition/metrics/error/pm2, control:request/createRequest/response, log:subscribe/unsubscribe/line, error:frame); `register.agentId` uses `agentIdSchema` (safe charset 1–100) and `register.token` is `z.string().min(1)`. `codec.ts` exports `encode(msg)` and `decode(raw): {ok:true,msg}|{ok:false,code:'BAD_MESSAGE',message}` (never throws). `correlation.ts` exports `newCid(now,rand)` and `PendingRequests<T>` (create/settle/rejectAll, 15s default timeout, injected timers).
      Files: src/protocol/version.ts, shapes.ts, messages.ts, codec.ts, correlation.ts (all new) + matching *.test.ts
      Verify: `npm test` — encode→decode round-trips every frame; decode returns BAD_MESSAGE (no throw) for bad JSON/missing type/unknown type/invalid payload/blank token/malformed agentId; correlation resolves matching cid, ignores unknown/duplicate/settled, times out to AGENT_TIMEOUT, rejectAll on disconnect; shape type-equality compiles.

- [ ] 4. Extract the standalone boot body into `src/boot/standalone.ts` and dispatch from `index.ts`.
      Move the current `bootstrap()` body verbatim into `bootstrapStandalone()` (pure move); `index.ts#bootstrap()` loads config then branches on `config.MODE` (standalone now, agent/server added later). Keep `buildSmtpConfig`/`buildAuthConfig` reachable.
      Files: src/boot/standalone.ts (new), src/index.ts
      Verify: `npm run build` && `npm test` — existing server/hub/env tests unchanged; standalone path identical.

- [ ] 5. Agent identity: `src/agent/identity.ts`.
      `resolveAgentId({ idFile, hostname, logger, readFile?, writeFile?, randomSuffix? })`: read suffix file → `${sanitize(hostname)}-${suffix}`; missing/unreadable/empty → generate `randomBytes(4).hex`, persist (mkdir -p, best-effort), log info; unwritable dir → in-memory id + warn (non-fatal). Sanitize hostname to the `processNameSchema` charset.
      Files: src/agent/identity.ts, src/agent/identity.test.ts (new)
      Verify: `npm test` — new suffix generated+persisted when missing; same id reused when present; regeneration logs info on unreadable; stable across simulated restarts.

- [ ] 6. Agent connection: `src/agent/connection.ts`.
      Outbound `ws` client wrapping `new WebSocket(url, { rejectUnauthorized: !insecure })`; on open send `register`; backoff attempt reset ONLY on `register:ack` (not on socket open); unbounded retries via shared `backoffDelay`; single idempotent `onLinkDead()` funnels every teardown (register:nack, handshake-timeout/transport close, heartbeat/pong dead-link) → one close + exactly one scheduled reconnect; heartbeat default 15s from ack, dead-link threshold 2×heartbeatSec; `TLS_INSECURE` passes `rejectUnauthorized:false` + logs insecure warning on each (re)connect. Injected timers/socket factory.
      Files: src/agent/connection.ts, src/agent/connection.test.ts (new)
      Verify: `npm test` — reconnect with capped backoff+jitter; no crash when unreachable at boot and keeps retrying; register sent on open; register:nack→backoff holds at 30s cap (not hot-loop), retries unbounded; insecure toggle passes rejectUnauthorized:false + warns; onLinkDead idempotent (second trigger no-op).

- [ ] 7. Agent runtime + log forwarder: `src/agent/runtime.ts`, `src/agent/logForwarder.ts`.
      `AgentRuntime` subscribes to `MonitorEvents` and forwards (while connected): snapshot on (re)connect and on process-set change (throttled ≤1/s, coalesced like WsHub); `update:transition`/`update:metrics` (each online snap → `{name, ts:snap.lastUpdated, cpu, mem}`, ts verbatim)/`update:error`/`update:pm2`. Inbound `control:request` re-validates `processNameSchema`; `control:createRequest` validates `createProcess.safeParse({ body: opts })`, consumes the POST-transform body (cluster injection), checks path existence on the agent disk, returns correlated `ControlResult` (`VALIDATION` on failure, PM2 never touched). `LogForwarder` filters live `log:line` events per subscribed (process,streams); unsubscribe/disconnect stops.
      Files: src/agent/runtime.ts, src/agent/logForwarder.ts (new) + *.test.ts
      Verify: `npm test` — valid control calls Pm2Client + correlated response; invalid name/opts→VALIDATION, PM2 not called; createProcess `{body}` wrapper, instances>1 no exec_mode→transformed cluster reaches startNew, non-existent script→VALIDATION, unknown keys rejected; log subscribe forwards matching lines, unsubscribe stops.

- [ ] 8. Agent boot: `src/boot/agent.ts` + `index.ts` branch.
      Build core hub + a `Pm2Deps` facade (mutable `pm2Client` ref returning `PM2_UNAVAILABLE`/`[]` until wired, same shape as `index.ts`) + `AgentRuntime`; START the `AgentConnection` dial loop first/concurrently; wire the real `createPm2Adapter`/`Pm2Client.start()` in a background task (same `void (async…)` + try/catch as `index.ts`) so the dial is never blocked by a hung/absent local PM2 and a `control:request` before PM2 attaches returns correlated `PM2_UNAVAILABLE`. Build validators via `buildSchemas({ allowedScriptRoot: config.ALLOWED_SCRIPT_ROOT })`. No HTTP server, no listening port. `buildAgentDialConfig(cfg)` helper. `index.ts` calls it for `MODE==='agent'`.
      Files: src/boot/agent.ts (new), src/index.ts
      Verify: `npm run build` && `npm test` — agent boot test (fakes) registers and heartbeats with PM2 absent; control before PM2 attach → PM2_UNAVAILABLE; standalone/server paths unaffected.

- [ ] 9. Agent-token auth: `src/server/agentAuth.ts`.
      `validate(provided, tokens)` = `tokens.some(t => safeEqual(provided, t))` reusing the throw-safe `safeEqual`; `buildAgentAuthConfig(cfg)` splits `AGENT_TOKENS` on `,`, trims, drops empties, appends `AGENT_TOKEN`, dedupes.
      Files: src/server/agentAuth.ts, src/server/agentAuth.test.ts (new)
      Verify: `npm test` — valid token accepted; invalid/missing/empty/wrong-length rejected without throwing; list rotation (any entry matches).

- [ ] 10. Alias store: `src/server/aliasStore.ts` + `aliasSchema` in `src/api/schemas.ts`.
      `aliasSchema = z.string().trim().min(1).max(100).refine(no control chars)` in `schemas.ts`. `AliasStore` with `load()` (missing→{}, corrupt→warn+{}), `get`, `set` (validate→sync in-memory update→serialized/coalesced async write-temp+rename, last-writer-wins, write failure warns + keeps in-memory), `all()`. Unknown-agent id accepted+persisted. File = `ALIAS_STORE_FILE`.
      Files: src/server/aliasStore.ts (new), src/api/schemas.ts, src/server/aliasStore.test.ts (new), src/api/schemas.test.ts
      Verify: `npm test` — set/get/persist; reload after restart; missing→empty continue; corrupt→warn+empty no crash; invalid alias (too long/control/blank)→rejected; unknown id accepted; atomic write; concurrent set() coalesce to latest; get() sees value before write settles.

- [ ] 11. Fleet registry: `src/server/registry.ts`.
      `FleetRegistry` keyed by stable `agentId` with per-agent `AgentEntry` (meta, online, lastSeen, socket, `processes` Map, per-agent `MetricsStore`/`ErrorTracker` using existing retention/buffer semantics, pm2Connected, `PendingRequests<ControlResult>`, logSubscribers). Frame handling: `snapshot` replaces processes map, sets flags, PRUNES departed metric series (ports `MonitorState.onMetricsTick` prune to the snapshot handler); `update:metrics` pushes only (no prune, ts verbatim); transition/error/pm2 updates; `control:response`→settle; `log:line`→fan out to subscribed human clients. `routeControl(agentId, action, name)`: unknown→AGENT_NOT_FOUND, offline→AGENT_OFFLINE (neither blocks), else cid+create+send+return promise (resolves on response / 15s AGENT_TIMEOUT / disconnect AGENT_OFFLINE). Disconnect: online=false, rejectAll(AGENT_OFFLINE), clear logSubscribers, retain entry, emit agent:offline. Bounded 200-line live log ring per (agentId,process), ref-counted. Isolation across agents.
      Files: src/server/registry.ts (new), src/server/registry.test.ts (new)
      Verify: `npm test` — keys by stable id; online/offline transitions; isolation; routeControl correlated result; offline/unknown codes don't block; disconnect rejectAll; log fan-out to subscribers only; snapshot prunes departed series (update:metrics alone does not); wire ts pushed verbatim.

- [ ] 12. Agent gateway: `src/server/gateway.ts`.
      `AgentGateway` as `WebSocketServer({ noServer:true })` sharing the HTTP server on `AGENT_WS_PATH` (default `/agent`); upgrade handler inspects pathname and handles only its own (coexists with `WsHub` which already yields on non-`/ws`). Accept `/agent` upgrade unconditionally, then require a valid `register` within a 5s non-extendable handshake window. On register: version check→VERSION_MISMATCH nack; token via `agentAuth.validate`→AUTH_FAILED nack+close (no registration); success→register in `FleetRegistry`, ack, online. Pre-auth hardening: only `register` accepted before auth (else error:frame+close); `MAX_PENDING_AGENT_SOCKETS` (50) cap → 503-and-destroy at upgrade; heartbeat/ping timers start only after ack. Never log token/url (only `{path,agentId,authed}`).
      Files: src/server/gateway.ts (new), src/server/gateway.test.ts (new)
      Verify: `npm test` — accept on valid register; AUTH_FAILED/VERSION_MISMATCH nack + no registration; handshake-timeout close (not reset by malformed frame); non-register before auth→error:frame+close; cap→503-and-destroy, registered agents not counted; blank/garbage identity rejected at decode; never logs token/url.

- [ ] 13. Agent-aware alert engine + rule schema widening + payload fields.
      In `src/alerts/engine.ts`: extend `ruleTargets(rule,key)` to match `*` | full `agentId/name` | bare name-part (split on last `/`); extend `targetNames(rule,present)` for composite expansion; inject `resolveAgent(key)=>{agentId?,agentAlias?,name}` (default = identity resolver returning `{name:key}` so standalone output is byte-identical) and have `buildPayload` split the key, attach optional `agentId`/`agentAlias`, prefix summary/title only when agent present. In `src/config/alertRules.ts`: widen `processSelector` with `compositeTargetRule` (`agentId/name`, each part the safe charset). In `src/alerts/channels/types.ts`: add optional `agentId?`/`agentAlias?` to `AlertPayload`.
      Files: src/alerts/engine.ts, src/config/alertRules.ts, src/alerts/channels/types.ts + extended engine.test.ts, alertRules.test.ts
      Verify: `npm test` — matcher matches `*`/full/bare on composite present set; two agents same-named process don't cross-trigger/share cooldown; bare rule fires fleet-wide; standalone identity resolver → payload agentId/agentAlias absent + unprefixed (byte-identical); rule schema accepts agentId/name, rejects two-slash/empty-part; existing engine/rules tests pass.

- [ ] 14. Fleet events + server alert wiring: `src/server/fleetEvents.ts`.
      Re-emit fleet frames with composite keys; server `AlertStateHub`/`AlertErrorWindows` implementations over `FleetRegistry` (processNames→`agentId/name` across online agents; getProcess/sustainedAbove/countInWindow/restartsInWindow split on last `/` and dispatch to the owning agent store); `resolveAgent` closure over registry + `AliasStore`; single cooldown-gated agent-offline alert (synthetic rule id `__agent_offline__`), suppress per-process crash alerts on orderly disconnect; global `MaintenanceState` holder read by `getMaintenance`.
      Files: src/server/fleetEvents.ts (new), src/server/fleetEvents.test.ts (new)
      Verify: `npm test` — cross-agent evaluation over composite surface; payload carries agentId+agentAlias; global maintenance suppresses across agents; single agent-offline alert, no per-process crash on orderly disconnect.

- [ ] 15. Control-status mapper: `src/api/routes/controlStatus.ts`.
      `statusForControlCode(code)`: PM2_UNAVAILABLE/AGENT_OFFLINE/AGENT_TIMEOUT→409, AGENT_NOT_FOUND→404, VALIDATION→400, PM2_ERROR/default→502. Leave `sendControlResult` in `processes.ts` unchanged (binary 409/502).
      Files: src/api/routes/controlStatus.ts (new), src/api/routes/controlStatus.test.ts (new)
      Verify: `npm test` — mapper returns the above; a separate assertion confirms standalone `sendControlResult` unchanged.

- [ ] 16. Unified REST routes: `src/api/routes/agents.ts` + `FleetDeps`.
      New router mounted under `/api/agents` behind existing human auth, taking an injectable `FleetDeps`: `GET /api/agents`, `/:id`, `/:id/processes`, `/:id/processes/:name/metrics`, `/:id/processes/:name/logs` (returns `{name,lines}` from the live ring; empty when no subscription), `/:id/errors`, control POSTs (start/stop/restart/reload/delete) via `routeControl`+`statusForControlCode`, `POST /:id/processes` create (201 ONLY on `result.ok`; server-side `createProcess.safeParse({ body: opts })` before routing), `PUT /:id/alias` (`aliasSchema`→`AliasStore.set`). `:id` via `agentIdSchema`, `:name` via `processNameSchema`. List keyed by live registry (pre-seeded aliases for never-connected ids NOT listed).
      Files: src/api/routes/agents.ts (new), src/api/routes/agents.test.ts (new)
      Verify: `npm test` — list keyed by registry (pre-seeded alias not listed); per-agent reads/control via fake FleetDeps; PUT alias validation+persistence; routed-control HTTP mapping (409/404/400/502); server-side `{body}` create validation; human auth enforced.

- [ ] 17. Health routes: add `mode` + `createServerHealthRouter` in `src/api/routes/system.ts`.
      Add `mode` to the standalone health payload (otherwise unchanged). Add `createServerHealthRouter(deps)` returning `{status, mode:'server', maintenance:<global>, agents:{total,online}, version, uptimeMs}` (no `pm2Connected`), reading the global `MaintenanceState` + `FleetRegistry` summary (no `StateDeps`). `/api/system/status` is NOT mounted in server mode.
      Files: src/api/routes/system.ts, src/api/routes/system.test.ts
      Verify: `npm test` — standalone health gains `mode:'standalone'`, otherwise unchanged; server health shape as above with no pm2Connected.

- [ ] 18. WsHub relay hook + validated `agentId` on `log:subscribe`.
      Add optional `relay` hook + optional `agentId` on `log:subscribe`. When `agentId` present: validate with `agentIdSchema` and `process` with `processNameSchema` BEFORE any registry lookup/upstream frame (failure → existing `{type:'error',code:'BAD_MESSAGE'}`, touch neither registry nor upstream); register with the relay (ref-counted per `(agentId,process)`), push arriving `log:line` as existing `{type:'log',…}` frames; unsubscribe/disconnect → upstream unsubscribe. When `agentId` absent: existing local fan-out path, byte-identical.
      Files: src/ws/hub.ts, src/ws/hub.test.ts
      Verify: `npm test` — valid agentId reaches relay + upstream subscribe; malformed agentId → BAD_MESSAGE, relay/registry untouched; no agentId → local fan-out unchanged.

- [ ] 19. Server boot: `src/boot/server.ts` + `index.ts` branch.
      Wire human `createServer` (mount `createServerHealthRouter`, NOT `/status`) + `WsHub`+relay + `AgentGateway` + `FleetRegistry` + `AliasStore` + global `MaintenanceState` + agent-aware `AlertEngine` (fleet-fed, injected resolver) + `/api/agents` router. Reuse existing `/api/maintenance` routes to toggle the global state. `buildAgentAuthConfig(cfg)`. Native TLS when both `TLS_CERT_FILE`/`TLS_KEY_FILE` set (`https.createServer`), else reverse-proxy termination. `index.ts` calls it for `MODE==='server'`.
      Files: src/boot/server.ts (new), src/index.ts
      Verify: `npm run build` && `npm test` — server boot test (fakes) mounts agents routes + gateway, health reports mode:server; standalone/agent paths unaffected.

- [ ] 20. Logger redaction keys + docstring correction.
      Add `AGENT_TOKEN`, `AGENT_TOKENS`, `SERVER_URL` to `REDACTED_KEYS`. Fix the stale module docstring ("shallow + one level nested") to describe full-depth recursion + the single array edge.
      Files: src/core/logger.ts, src/core/logger.test.ts
      Verify: `npm test` — `{AGENT_TOKEN}`, `{AGENT_TOKENS}`, `{dial:{url:'wss://h/agent?token=secret'}}`, and depth-≥2 `{a:{b:{AGENT_TOKEN}}}` redact; `{list:[{AGENT_TOKEN}]}` documented NOT key-redacted.

- [ ] 21. Dashboard: fleet overview + drill-down (server mode), standalone unchanged.
      `public/js/api.js`: add `listAgents/getAgent/agentProcesses/agentMetrics/agentLogs/agentControl/setAlias` and make existing methods accept an optional `agentId` selecting the base path (standalone call sites pass none). `public/js/ws.js`: `logSubscribe` accepts optional `agentId` passed into the frame. `public/js/views/agents.js` (new): fleet cards (alias-or-id, online badge, host/platform, process count, pm2 badge, inline alias edit via `PUT /api/agents/:id/alias`, real id on hover). `app.js`/`overview.js`/`detail.js`: discover `mode` from `/api/system/health`; gate agent UI behind `mode==='server'`; parameterize views by optional `agentId`. Standalone identical.
      Files: public/js/api.js, public/js/ws.js, public/js/views/agents.js (new), public/js/app.js, public/js/views/overview.js, public/js/views/detail.js, public/index.html
      Verify: `npm run build` && manual smoke — standalone dashboard byte-identical; server mode shows fleet overview + drill-down.

- [ ] 22. Integration + end-to-end smoke test.
      `src/server/integration.test.ts`: in-process agent↔server over loopback `ws` (real sockets, no TLS): register → snapshot received → routed control round-trip (routeControl→agent executes against `fakePm2Client`→correlated response→HTTP result) → log subscribe relays a line to a human client → unsubscribe stops it. Uses injected `fakePm2Client` + human `WsHub`.
      Files: src/server/integration.test.ts (new)
      Verify: `npm run build` && `npm test` — integration passes; full suite green.

- [ ] 23. Docs + ecosystem config.
      `README.md` + `.env.example`: document the three modes with an example config per mode, agent-token setup/rotation/revocation + security guidance, TLS/insecure toggle, alias persistence file, the protocol summary, new REST endpoints, and the server-mode `/logs` live-ring semantics vs. standalone file tail. `.gitignore`: add the data paths (`config/agent-id`, `config/agent-aliases.json`). `ecosystem.config.cjs`: document the new env vars per mode.
      Files: README.md, .env.example, .gitignore, ecosystem.config.cjs
      Verify: `npm run build` && `npm test` — build/tests green; manual doc review confirms all three modes, token rotation, TLS, alias file, protocol, endpoints are covered.

---

Testing summary (all `node:test` via `tsx --test`, injected fakes/timers per existing style): backoff bounds; env mode selection/guards; protocol round-trip + correlation; agent identity/connection/runtime; agent-token auth; alias CRUD/persist/reload/corrupt-tolerance/concurrency; registry + routing + offline + prune; gateway handshake/pre-auth; engine composite matching + standalone no-op; fleet alerts attribution + global maintenance + agent-offline; control-status mapping; unified REST; server/standalone health; WsHub relay validation; logger redaction (incl. depth); integration round-trip. Keep all ~164 existing tests green (AC-3/57/58). End-to-end smoke: `tsc` clean, `tsx --test` green, and a scripted one-server/one-agent hub-and-spoke run (agent appears online, control round-trips, live logs stream, alias persists across restart, MODE unset serves identical standalone).
