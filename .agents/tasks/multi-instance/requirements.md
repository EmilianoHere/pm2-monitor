# Requirements — Multi-Instance (Hub-and-Spoke) Mode for pm2-monitor

## Summary

Add a hub-and-spoke (pm2.io / Keymetrics style) multi-instance capability to pm2-monitor so that a single central server can monitor and control PM2 across many remote machines. The feature introduces three coexisting run modes selected by a single config value (`MODE=standalone|agent|server`, default `standalone`):

- **standalone** — the existing single-process behavior (local PM2, local REST + dashboard + WS). Must remain fully intact, unchanged in behavior, and be the default so existing deployments are untouched.
- **agent** — runs on each PM2 host. Reuses the existing local PM2 integration layer (`src/pm2`) to watch and control the local daemon, and opens an **outbound-only** `wss://` connection to the central server. It registers with a stable auto-generated ID + token, streams process/metric/error/lifecycle data up, receives and executes control commands, and tails/forwards logs on demand. It reconnects with capped backoff + jitter and never crashes when the server is unreachable.
- **server** — the central hub. Accepts inbound authenticated agent WebSocket connections, keeps per-agent in-memory live state, and exposes a unified REST API + dashboard where the operator sees all agents and their processes in one place, controls any agent's process, and views live logs from any agent. The existing alert engine runs here and evaluates across all agents, with global maintenance mode. Human dashboard/REST keeps the existing user auth; agents authenticate with a **separate** token credential space. Each agent gets a stable auto-ID plus an operator-editable, cosmetic **alias** that persists to a small on-disk JSON file (no database).

The transport is a clearly specified bidirectional JSON message protocol over the agent↔server WebSocket (register/auth, heartbeat, snapshot + incremental updates, control request/response with correlation IDs, log subscribe/unsubscribe + streaming). TLS is supported via `wss://` with certificate verification and an explicit, clearly-marked insecure toggle for testing.

This document specifies **requirements only**. It does not design the implementation. Where the brief leaves a decision open, the requirement states the recommended decision and flags it as an assumption; the design review will confirm or correct these.

### Technology context (locked by the existing codebase)

Node 20+, TypeScript strict, ESM (NodeNext, relative imports carry `.js`). Existing deps: `express`, `ws`, `pm2`, `nodemailer`, `dotenv`, `zod`. Tests are `node:test` run via `tsx` (`tsx --test`), ~164 currently passing. Config is a zod-validated frozen object from `src/config/env.ts`. The single credential comparator is throw-safe `safeEqual` (`src/api/auth.ts`). The only `pm2`-package import site is `src/pm2/client.ts`. Logger redaction lives in `src/core/logger.ts` (`REDACTED_KEYS`, `redactUrl`). These are the established patterns new work must fit.

---

## Functional Requirements

### FR-1 Run-mode selection and backward compatibility
A single config value selects the run mode. Default is `standalone`. Standalone behavior, REST surface, WS surface, dashboard, alert engine, and all existing tests must be unchanged. Invalid/mis-combined mode config fails fast at startup (consistent with the existing `loadConfig` → `process.exit(1)` behavior).

### FR-2 Agent mode
Reuse `src/pm2` to watch and control the local daemon. Connect outbound over `wss://` to the configured server URL. Register with a stable auto-generated agent ID and an agent token. Stream process list / status / metrics / lifecycle transitions / captured errors upward. Receive, re-validate, and execute control commands (`start`, `stop`, `restart`, `reload`, `delete`, `start-new`) against local PM2 and return correlated results. Tail and forward logs on server demand (subscribe/unsubscribe per process+stream). Reconnect automatically with capped backoff + jitter; tolerate the server being unreachable at boot and keep retrying. Require no inbound open ports.

### FR-3 Server mode
Accept inbound agent WebSocket connections authenticated by agent token. Maintain per-agent in-memory state: processes, metrics, errors, and connection status (online/offline). Expose a unified REST API + dashboard spanning all agents. Route control commands to a specific agent + specific process and relay the result/ack back to the caller. Relay live-log subscribe/stream over the agent link to the requesting dashboard/WS client. Run the alert engine across all agents. Maintenance mode is global. Human dashboard/REST stays behind the existing user auth; agent connections use the separate agent-token space.

### FR-4 Agent identity (stable auto-ID)
Each agent derives a stable ID from the host (hostname + a persisted random suffix) so it survives restarts and is stable per machine. The agent persists its generated suffix locally. The ID is what the server keys all per-agent state on and never changes for a given machine.

### FR-5 Agent alias (operator-editable, cosmetic, persisted)
The server lets the operator set a human-friendly alias per agent. The alias is display-only and never changes the real agent ID or any routing. It persists across server restarts in a small on-disk JSON file (no database). A REST endpoint updates it (`PUT /api/agents/:id/alias`). The dashboard shows the alias with the real ID available on hover/detail.

### FR-6 Unified REST + dashboard (server)
The server exposes agent-scoped versions of the existing read and control surfaces so the operator can list agents, view each agent's processes/metrics/errors/logs, and issue control commands to a chosen agent's process from one place.

### FR-7 Transport protocol
A bidirectional JSON message protocol over the agent↔server WebSocket with explicit, versioned message types for: register/auth handshake (agent ID + token + instance metadata), heartbeat/keepalive, snapshot + incremental state updates (processes, metrics, errors, transitions), control command request/response carrying a correlation ID, and log subscribe/unsubscribe + log-line streaming. Reuse existing internal type shapes (`ProcessSnapshot`, `MetricSample`, `LogLine`, `TrackedError`, `ControlResult`, transition shape) on the wire where possible.

### FR-8 Security
Agent tokens are a separate credential space from human auth, compared with the existing throw-safe `safeEqual`. Agent tokens are configurable per server (a single shared token or a list of valid tokens via env/config) with documented rotation/revocation. Every control command is validated and sanitized on **both** ends using the existing zod schemas + process-name/script-path sanitizers; the agent re-validates every command received over the wire before touching PM2. Secrets are never logged (reuse logger redaction); tokens and any `wss://` URL query credentials are redacted. Correlation IDs prevent a duplicate/forged ack from being matched to the wrong command.

### FR-9 TLS
The server supports running behind TLS, either terminated at a reverse proxy (operator connects agents via `wss://`) and/or via native TLS options on the server. Agents connect with `wss://` and verify the server certificate by default. An opt-in insecure/self-signed toggle exists for testing and is clearly marked insecure in config, logs, and docs.

### FR-10 Documentation & verification
`README.md` and `.env.example` document the three modes, agent-token setup/rotation, TLS/insecure toggle, alias persistence file, and the protocol. The project must build (`tsc`) and all tests (`tsx --test`) must pass, including the preserved standalone suite plus new tests for the added subsystems.

---

## Non-Functional Requirements

- **NFR-1 Backward compatibility (hard constraint).** Standalone is the default and must not regress. The REST envelope `{ error: { code, message } }`, auth model, WS subprotocol/`?token=` handshake, and existing route semantics are unchanged in standalone and preserved for the human-facing side of server mode.
- **NFR-2 Resilience.** Neither agent nor server crashes on a dropped/unreachable peer. The agent keeps retrying with capped backoff + jitter; the server marks a dropped agent offline and keeps serving the rest.
- **NFR-3 Security posture.** Remote cross-machine process control is high-stakes. Default-secure: TLS verification on, insecure toggle off, no secret ever logged, both-ends validation, constant-time credential comparison.
- **NFR-4 Resource bounds.** Per-agent in-memory state (metrics retention, error buffer, log fan-out) must be bounded per agent, reusing the existing retention/buffer config semantics so the server does not grow unbounded with many agents.
- **NFR-5 Pattern fidelity.** New config goes through the zod schema in `src/config/env.ts`; new wire messages are zod-validated; PM2 access stays confined to `src/pm2/client.ts`; secret keys are added to the logger redaction set. No new runtime dependency is added unless justified in design (prefer the native `ws` client already present).
- **NFR-6 State durability (v1 scope).** Live server state is in-memory and may be lost on restart. The **only** persisted datum is the agent alias map (on-disk JSON). Agents persist only their ID suffix.

---

## Acceptance Criteria (EARS-style, numbered)

Format: user story, then WHEN/IF/WHILE … THE SYSTEM SHALL …

### Run modes & backward compatibility
*As an operator, I want mode selection that defaults to today's behavior so existing deployments keep working untouched.*

1. WHEN `MODE` is unset, THE SYSTEM SHALL run in `standalone` mode.
2. WHEN running in `standalone` mode, THE SYSTEM SHALL behave identically to the current single-process monitor (local PM2, existing REST, existing WS, existing dashboard, local alert engine).
3. WHEN the full existing test suite runs against the standalone code paths, THE SYSTEM SHALL keep all currently passing tests green with no behavioral change.
4. IF `MODE` is set to any value other than `standalone`, `agent`, or `server`, THEN THE SYSTEM SHALL log an aggregated config error and exit with code 1 at startup.
5. IF `MODE=agent` and no server URL is configured, OR `MODE=server` and no agent-token credential is configured, THEN THE SYSTEM SHALL fail config validation and exit with code 1 before binding or dialing.
6. WHEN running in `agent` or `server` mode, THE SYSTEM SHALL load and validate all new config through the existing zod schema path in `src/config/env.ts`.

### Agent — connectivity, identity, resilience
*As an operator of a PM2 host, I want the agent to connect out to the hub reliably without opening ports.*

7. WHEN an agent starts, THE SYSTEM SHALL open only an outbound `wss://` connection to the server and SHALL NOT open any inbound listening port.
8. WHEN an agent first generates its identity, THE SYSTEM SHALL derive a stable ID from the hostname plus a locally persisted random suffix, and SHALL reuse the same ID across restarts.
9. IF the persisted ID suffix is missing or unreadable at startup, THEN THE SYSTEM SHALL generate a new random suffix, persist it, log the regeneration at info level, and continue.
10. WHEN the agent connects, THE SYSTEM SHALL send a register/auth handshake containing the agent ID, the agent token, and instance metadata (e.g. hostname, platform, PM2/monitor version).
11. IF the server is unreachable at boot, THEN THE SYSTEM SHALL NOT crash and SHALL keep retrying the connection.
12. WHILE the agent is disconnected from the server, THE SYSTEM SHALL retry with exponential backoff capped at a maximum delay and SHALL apply jitter to each retry (consistent with the existing `src/pm2/client.ts` backoff: base 1s, cap 30s, ±20% jitter — recommended, see Open Questions).
13. WHEN the agent's connection to the server drops, THE SYSTEM SHALL continue monitoring/controlling the local PM2 daemon and SHALL buffer or resynchronize state on reconnect per the protocol (recommended: send a fresh full snapshot on each (re)connect rather than replaying missed deltas).
14. WHEN the local PM2 daemon is unavailable, THE SYSTEM SHALL still maintain the server connection and SHALL report its PM2-connectivity status upward (reusing the existing `pm2:connected`/`pm2:disconnected` semantics).

### Agent — streaming & command execution
*As an operator, I want the hub to see live data from each agent and control its processes.*

15. WHILE connected, THE SYSTEM SHALL stream the agent's process list, status transitions, metric samples, and captured errors to the server using the existing internal type shapes.
16. WHEN the agent (re)connects, THE SYSTEM SHALL send a full snapshot before incremental updates.
17. WHEN the agent receives a control command (`start`, `stop`, `restart`, `reload`, `delete`, or `start-new`), THE SYSTEM SHALL re-validate and sanitize it against the existing zod schemas/sanitizers before invoking PM2.
18. IF a received command fails wire-side validation/sanitization, THEN THE SYSTEM SHALL reject it without touching PM2 and SHALL return a correlated error response (reusing the `{ ok: false, code, message }` `ControlResult` shape).
19. WHEN the agent executes a valid control command, THE SYSTEM SHALL return a correlated response carrying the resulting `ControlResult` (`{ ok: true, process }` or `{ ok: false, code, message }`).
20. WHEN the server requests a log subscription for a given process+stream, THE SYSTEM SHALL tail that process's logs and forward `LogLine` entries upward until an unsubscribe (or disconnect) stops the stream.
21. WHEN the server sends a log unsubscribe, THE SYSTEM SHALL stop forwarding that process's log lines.

### Server — registry, unified surface, routing, relay
*As an operator, I want one dashboard and API across all machines.*

22. WHEN an agent presents a valid agent token in its handshake, THE SYSTEM SHALL accept the connection and register the agent in its in-memory registry keyed by the agent's stable ID.
23. IF an agent presents a missing, malformed, or invalid agent token, THEN THE SYSTEM SHALL reject the connection using the throw-safe `safeEqual` comparison and SHALL NOT register the agent.
24. WHEN an agent connects or disconnects, THE SYSTEM SHALL update that agent's connection status (online/offline) and reflect it in the unified API/dashboard.
25. WHEN an operator queries the unified API, THE SYSTEM SHALL return the set of known agents and, per agent, that agent's processes, metrics, errors, and connection status.
26. WHEN an operator issues a control command to a specific agent + specific process via the unified API, THE SYSTEM SHALL validate it with the existing zod schemas, route it over that agent's link with a correlation ID, and return the agent's correlated `ControlResult` to the caller.
27. IF the target agent is offline or unknown when a control command is issued, THEN THE SYSTEM SHALL return a defined error (recommended HTTP 409 with code `AGENT_OFFLINE`, or 404 `AGENT_NOT_FOUND`) and SHALL NOT block.
28. WHEN an operator requests live logs for an agent's process, THE SYSTEM SHALL relay a log subscribe over that agent's link and stream the forwarded lines to the requesting human WS client, and SHALL send an unsubscribe when the client disconnects or unsubscribes.
29. WHILE multiple agents are connected, THE SYSTEM SHALL keep each agent's state isolated so one agent's data, errors, or disconnect never corrupts or drops another's.

### Server — cross-agent alerts & global maintenance
*As an operator, I want alerting and maintenance to span the whole fleet.*

30. WHEN the alert engine evaluates on the server, THE SYSTEM SHALL evaluate rules across all connected agents' processes and metrics.
31. WHEN an alert fires for a process on a given agent, THE SYSTEM SHALL identify the originating agent (ID and alias) in the alert payload/notification.
32. WHILE global maintenance mode is active, THE SYSTEM SHALL suppress alerts across all agents per the existing maintenance semantics.
33. WHEN an agent goes offline, THE SYSTEM SHALL handle alerting for that transition per a defined rule (recommended: emit a single "agent offline" alert subject to the existing cooldown; do not emit per-process crash alerts for an orderly agent disconnect — see Open Questions).

### Alias
*As an operator, I want to rename agents cosmetically without breaking identity.*

34. WHEN an operator calls `PUT /api/agents/:id/alias` with a valid alias, THE SYSTEM SHALL store the alias for that agent ID and return success.
35. WHEN an alias is set, THE SYSTEM SHALL use it for display only and SHALL NOT change the agent's real ID or any routing/keying.
36. WHEN the server restarts, THE SYSTEM SHALL reload previously set aliases from the on-disk JSON file.
37. WHEN the dashboard displays an agent, THE SYSTEM SHALL show the alias (when set) with the real ID available on hover/detail; WHEN no alias is set, THE SYSTEM SHALL display the real ID.
38. IF the alias input fails validation (recommended rule: 1–100 chars, printable, trimmed, control characters rejected), THEN THE SYSTEM SHALL return HTTP 400 with the existing `VALIDATION` envelope and SHALL NOT persist it.
39. IF the alias file is missing at startup, THEN THE SYSTEM SHALL treat all aliases as unset and continue; IF it exists but is corrupt/invalid JSON, THEN THE SYSTEM SHALL log a warning and continue with no aliases rather than crash (recommended — see Open Questions).
40. IF `:id` names an unknown agent on a `PUT …/alias`, THEN THE SYSTEM SHALL behave per a defined rule (recommended: accept and persist so an alias can be pre-set before an agent first connects; alternative is 404 — see Open Questions).

### Transport protocol
*As an implementer, I want an unambiguous, validated wire contract.*

41. WHEN any party sends a protocol message, THE SYSTEM SHALL use a JSON object carrying a string `type` discriminator and SHALL support at least these categories: register/auth, heartbeat/keepalive, snapshot, incremental update (processes/metrics/errors/transitions), control request, control response, log subscribe, log unsubscribe, and log line.
42. WHEN a party receives a protocol message, THE SYSTEM SHALL validate it against a zod schema and SHALL reject unknown/malformed messages with a defined error (reusing the existing `BAD_MESSAGE` error-frame pattern from `src/ws/hub.ts`).
43. WHEN a control request is sent, THE SYSTEM SHALL include a unique correlation ID, and the matching response SHALL carry the same correlation ID.
44. IF a control response arrives with an unknown, duplicate, or already-settled correlation ID, THEN THE SYSTEM SHALL ignore it and SHALL NOT resolve any waiting command with it.
45. IF a control request receives no correlated response within a defined timeout, THEN THE SYSTEM SHALL resolve the caller with a defined timeout error (recommended code `AGENT_TIMEOUT`) and SHALL NOT hang.
46. WHEN streaming state, THE SYSTEM SHALL reuse the existing `ProcessSnapshot`, `MetricSample`, `LogLine`, `TrackedError`, transition, and `ControlResult` shapes on the wire wherever a matching concept exists.
47. WHEN the protocol evolves, THE SYSTEM SHALL carry a protocol version in the handshake so incompatible peers can be rejected or warned (recommended — see Open Questions).

### Security
*As a security-conscious operator, I want remote control to be safe by default.*

48. WHERE agent authentication is performed, THE SYSTEM SHALL use a credential space entirely separate from the human dashboard/REST auth (API key / basic).
49. WHEN comparing any agent token, THE SYSTEM SHALL use the throw-safe constant-time `safeEqual` and SHALL NOT throw on length mismatch or empty/malformed input.
50. WHEN agent tokens are configured as a list, THE SYSTEM SHALL accept a connection whose token matches any valid entry and SHALL support rotation by allowing multiple valid tokens simultaneously.
51. WHEN any secret (agent token, API key, basic pass, SMTP pass, Teams webhook, or a `wss://` URL carrying a `token=` query) would be logged, THE SYSTEM SHALL redact it using the existing logger redaction (extend `REDACTED_KEYS`/`redactUrl` as needed).
52. WHEN a control command crosses the wire, THE SYSTEM SHALL validate and sanitize it on the server before sending and again on the agent before executing (defense in depth; the agent never trusts the wire).
53. WHEN agent connections are authenticated, THE SYSTEM SHALL keep the human dashboard/REST behind the existing user auth unchanged, so the two credential spaces never substitute for one another.

### TLS
*As an operator, I want encrypted transport with a clearly-marked testing escape hatch.*

54. WHEN an agent connects to the server, THE SYSTEM SHALL use `wss://` and SHALL verify the server's TLS certificate by default.
55. WHERE the operator opts into the insecure/self-signed toggle, THE SYSTEM SHALL skip certificate verification only when explicitly enabled and SHALL log a clearly-marked insecure warning at startup; the toggle SHALL default to off.
56. WHEN the server runs behind TLS, THE SYSTEM SHALL support both reverse-proxy termination (operator points agents at `wss://`) and/or native TLS options, documented in README/`.env.example`.

### Verification & testing
*As a maintainer, I want the feature proven and the baseline protected.*

57. WHEN the build runs (`tsc`), THE SYSTEM SHALL compile with no type errors under the existing strict/NodeNext settings.
58. WHEN the test suite runs (`tsx --test`), THE SYSTEM SHALL pass all preserved standalone tests plus new tests for: mode selection/config, agent ID generation+persistence, agent reconnect/backoff, both-ends command validation, protocol encode/decode + correlation-ID matching (including duplicate/unknown ack rejection and timeout), server registry + command routing + offline handling, log relay subscribe/unsubscribe, alias CRUD + persistence + reload + corrupt-file tolerance, cross-agent alert attribution, and redaction of agent tokens/URLs.
59. WHERE a unit test cannot cover an end-to-end path (real sockets/TLS), THE SYSTEM SHALL provide at least one integration test exercising an in-process agent↔server WebSocket handshake, a routed command round-trip, and a log relay, using injected fakes/loopback consistent with the existing `fakePm2Client`/injected-timer test style.

---

## Out of Scope (v1)

- Any database or durable store for live state; only the agent alias map and the agent ID suffix persist to disk.
- Replaying missed incremental updates after a reconnect (a fresh full snapshot per reconnect is the chosen approach).
- Agent auto-update, remote agent deployment/provisioning, or remote agent config push.
- Per-agent or role-based human authorization (all authenticated human users see/control all agents in v1).
- Mutual TLS / client-certificate auth for agents (token auth over verified `wss://` is the v1 mechanism).
- Horizontal scaling / clustering of the server itself, cross-server federation, or shared state between multiple servers.
- Historical/long-term metric or log storage, aggregation, or export beyond the existing in-memory retention + current export endpoints.
- Changing the human-facing auth model (API key / basic) or the existing REST/WS contract in standalone mode.

---

## Assumptions & Open Questions

Each item lists the recommended decision baked into the acceptance criteria above; the design review should confirm or correct.

1. **Config surface for the new modes.** Assumed: a single `MODE` plus mode-specific vars (e.g. `SERVER_URL`, `AGENT_TOKEN` for agents; `AGENT_TOKENS` list and alias-file path for the server; TLS/insecure toggle), all validated via the existing zod schema with cross-field `superRefine` guards. Open: exact variable names.
2. **Agent↔server port/path.** Assumed agents connect to a dedicated path (e.g. `/agent`) distinct from the human `/ws`, on the same server port, so one listener serves both with different auth. Open: same port vs. a separate agent port.
3. **Reconnect/resync strategy.** Recommended: full snapshot on every (re)connect, no delta replay (AC-13, AC-16). Confirm this is acceptable for v1 given in-memory, loss-tolerant state.
4. **Backoff parameters.** Recommended: reuse `src/pm2/client.ts` values (1s base, 30s cap, ±20% jitter). Confirm or specify agent-specific values.
5. **Alias for unknown agent ID.** Recommended: accept + persist (pre-seed aliases before first connect) rather than 404 (AC-40). Confirm.
6. **Corrupt alias file handling.** Recommended: warn + continue with empty aliases rather than crash (AC-39). Confirm (alternative: refuse to start to avoid silently losing aliases).
7. **Agent-offline alerting.** Recommended: single cooldown-gated "agent offline" alert; suppress per-process crash alerts for an orderly disconnect (AC-33). Confirm the intended operator experience.
8. **Protocol versioning.** Recommended: include a version field in the handshake and reject/warn on mismatch (AC-47). Confirm whether v1 needs strict rejection or just a logged warning.
9. **Control-response timeout value.** Recommended a bounded default (e.g. 10–30s) for AC-45. Confirm the value and whether it should be configurable.
10. **Per-agent resource bounds.** Assumed the existing `METRICS_RETENTION_MIN`, `METRICS_SAMPLE_SEC`, and `ERROR_BUFFER_SIZE` semantics apply per agent on the server (NFR-4). Confirm whether these should be global caps across all agents instead.
11. **`ws` client dependency.** Assumed the agent's outbound client uses the already-present `ws` package (no new dependency). Confirm.
12. **Dashboard scope.** Assumed the existing vanilla HTML/JS/CSS dashboard is extended with an agent selector/overview rather than replaced. Confirm the intended UX depth for v1 (full parity per agent vs. overview + drill-down).
