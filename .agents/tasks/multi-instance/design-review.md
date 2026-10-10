# Design Review — Multi-Instance (Hub-and-Spoke) Mode for pm2-monitor

**Reviewed design:** `.agents/tasks/multi-instance/design.md`
**Against requirements:** `.agents/tasks/multi-instance/requirements.md`
**Review method:** fresh read of the design with no prior context, every "verified"/"existing behavior" claim re-checked against the actual source in the worktree.

This is the third review pass. The design carries a "Responses to the design review" ledger documenting a first pass (2 HIGH + 8 MEDIUM + 3 NIT) and a second pass (3 MEDIUM + 4 NIT), all marked resolved. My job is to confirm the current document stands on its own and to hunt for anything still unresolved. I re-verified the source claims from scratch rather than trusting the ledger.

---

## Summary verdict

The design is unusually complete and the overwhelming majority of its load-bearing claims about the existing codebase are **accurate** (see Verified Assumptions). The protocol is fully specified, both-ends validation is pinned, reconnect/backoff semantics are concrete and correct, the alias store concurrency model is sound, and backward-compatibility for standalone is defended field-by-field.

I found a small number of residual issues. They are low in count but two of them would force the implementer to guess or would produce a wrong result if coded literally, so they are MEDIUM. The rest are NIT.

Finding count: **0 HIGH, 2 MEDIUM, 4 NIT** → **CHANGES_REQUESTED**.

---

## Findings

### 1. [MEDIUM] `configSchema` is a `ZodEffects` (ends in `.superRefine`), so "add new fields to `configSchema`" is not mechanically possible as written

**Where:** §1 "New variables added to `configSchema`" and "Cross-field `superRefine` guards (added alongside the existing auth/email guards)".

**Problem.** Verified `src/config/env.ts`: `configSchema` is `z.object({...}).superRefine(...)`. The value exported as `configSchema` is therefore a `ZodEffects`, **not** a `ZodObject`. You cannot "add variables to `configSchema`" or "add guards alongside the existing guards" by editing the final node — new object fields must be added inside the `.object({...})` literal that precedes `.superRefine`, and new cross-field guards must be added inside the single existing `superRefine` callback body (which currently closes over `cfg` with only the current fields). The design describes both edits loosely ("added alongside") in a way that reads as if `configSchema` were still an object you append to. An implementer following the text literally will reach for `configSchema.extend(...)` or a second `.superRefine(...)` chained on the effects node; `.extend` does not exist on `ZodEffects`, and a second chained `superRefine` changes evaluation order and the inferred type in ways the design does not intend.

**Concrete fix.** Pin the mechanics explicitly: "The new fields are inserted into the existing `z.object({...})` object literal in `src/config/env.ts` **before** the trailing `.superRefine`. The new `MODE` cross-field guards are added as additional `ctx.addIssue` blocks **inside the body of the existing single `superRefine` callback**, after the auth/email guards. `AppConfig` remains `z.infer<typeof configSchema>` unchanged. No `.extend()` / no second `.superRefine()` is introduced." One sentence removes the ambiguity.

---

### 2. [MEDIUM] Agent-mode boot still reaches `createPm2Adapter`, which neutralizes inherited PM2 IPC and gates on a *local* daemon — the design does not say the agent keeps this behavior, and it is load-bearing

**Where:** §3 "The agent reuses the full standalone core: … `Pm2Client` are constructed exactly as in standalone"; §8 item 8 "`src/boot/agent.ts` — wire core + `Pm2Client` + `AgentRuntime`; no HTTP server."

**Problem.** Verified `src/pm2/client.ts#createPm2Adapter`: it calls `neutralizeInheritedIpc(logger)` and then gates `connect` on `pingDaemon` so it **never launches a daemon** — it attaches only to an already-running local PM2. In standalone, `index.ts` builds the adapter in a **background task after `server.listen`** precisely so a hung/absent daemon cannot block boot (the HTTP server comes up regardless). The agent has **no** HTTP server to bind, so the "bind first, wire PM2 in the background" ordering that makes this safe in standalone does not exist in agent mode. The design says the agent constructs `Pm2Client` "exactly as in standalone" and reuses `pm2:connected`/`pm2:disconnected` semantics (AC-14), but it never specifies **where in the agent boot the real adapter is built** or that the same "never block the WS dial on PM2 connect" guarantee is preserved. If the implementer builds the adapter synchronously before dialing the server (natural when there is no `listen` to anchor on), a slow/absent local daemon can delay or interact badly with the outbound WS connect — and AC-14 ("maintain the server connection even when local PM2 is unavailable") can be violated.

**Concrete fix.** Specify the agent boot ordering explicitly, mirroring the standalone deferral: "In `bootstrapAgent()`, the `AgentConnection` dial loop is started first (or concurrently) and the real `createPm2Adapter`/`Pm2Client.start()` is wired in a background task exactly as `index.ts` does today, so a hung or absent local PM2 daemon never blocks or delays the outbound server connection. The agent uses the same `Pm2Deps`-style facade that returns `PM2_UNAVAILABLE` for control/`[]` for logs until the real client is wired, so a `control:request` arriving before PM2 attaches is answered with a correlated `PM2_UNAVAILABLE` `ControlResult` rather than hanging." This also pins the (currently unstated) behavior for a control command that arrives while the agent's local PM2 is still down.

---

### 3. [NIT] `logger.ts` docstring says "shallow + one level nested" but the code recurses to full depth — the design relies on the code, not the doc, and should note the doc is stale

**Where:** §7 "Redaction depth (second-pass finding #4, corrected)".

**Problem.** The design's correction is **right**: verified `src/core/logger.ts`, `redactContext` recurses into every nested plain object with no depth bound, `REDACTED_KEYS` matches at any depth, `redactValue` redacts `token=` strings at any depth, and arrays are the one gap (`!Array.isArray(value)`). However, the **module docstring** in `logger.ts` still says "(shallow + one level nested)", which directly contradicts the real behavior the design now depends on. An implementer adding the redaction test and reading that docstring may "fix" the test to match the stale doc, or weaken the design's assumption. The design does not flag that the doc comment is stale.

**Concrete fix.** Add one line to §7: "Note: the `logger.ts` module docstring still reads '(shallow + one level nested)', which is stale — the implementation recurses to full depth. The redaction-depth test (§9) is the source of truth; update the docstring to match while adding the keys." This keeps the implementer from trusting the wrong comment.

---

### 4. [NIT] Agent `start-new` sanitization uses the agent's `ALLOWED_SCRIPT_ROOT`, but the agent config section (§1) never adds `ALLOWED_SCRIPT_ROOT` to agent mode nor states it is reused

**Where:** §3 "Inbound command execution" ("The agent builds its own `RequestSchemas` at boot from its own `ALLOWED_SCRIPT_ROOT`"); §1 config block (agent-only vars list).

**Problem.** `ALLOWED_SCRIPT_ROOT` already exists in `configSchema` (verified) and is optional in all modes, so it is *available* to the agent. But the §1 agent-only variable list does not mention it, and the design does not state that agent mode threads `config.ALLOWED_SCRIPT_ROOT` into `buildSchemas({ allowedScriptRoot })` the way standalone's `index.ts` does. Since §3 makes the agent's filesystem policy the authoritative gate for `start-new` (correctly), omitting the wiring note leaves it ambiguous whether an operator can constrain where remote `start-new` may launch scripts on each agent host.

**Concrete fix.** Add to §3 (or the §1 agent list): "The agent constructs its `RequestSchemas` via `buildSchemas({ allowedScriptRoot: config.ALLOWED_SCRIPT_ROOT })`, reusing the existing (all-mode) `ALLOWED_SCRIPT_ROOT` variable, so an operator can confine remote `start-new` to a directory per agent host exactly as standalone does." No new variable is needed; this is a one-line wiring statement.

---

### 5. [NIT] Create-success HTTP status: the agents route must return 201 to match standalone, but §4's `statusForControlCode` + the stated "200 (or 201 for create)" leaves the create-ok branch underspecified

**Where:** §4 "Command routing — HTTP status mapping"; §5 REST endpoint table (`POST /api/agents/:id/processes → create (startNew) routed to the agent`).

**Problem.** Verified `src/api/routes/processes.ts`: standalone create (`POST /api/processes`) returns **201** on success via `sendControlResult(res, result, 201)`. The design's `statusForControlCode` maps only **failure** codes; success is described as "`200` (or `201` for create)". That is correct in intent, but the routed create path has an extra wrinkle the design does not pin: `routeControl` resolves a `ControlResult`, and a *failed* create still flows through `statusForControlCode` (e.g. `VALIDATION` → 400, `AGENT_OFFLINE` → 409). The design should state unambiguously that **only the ok branch of a create** yields 201, and every not-ok create result uses `statusForControlCode` like any other control — otherwise an implementer may hardcode 201 for the create route regardless of ok-ness, or map a create failure to 200/201.

**Concrete fix.** In §4, pin: "The agents create route returns **201** only when `result.ok === true`; a not-ok create result is written with `statusForControlCode(result.code)` and the `{ error: { code, message } }` envelope, identical to the other control endpoints. The non-create control endpoints return **200** on ok."

---

### 6. [NIT] `register:nack` reconnect vs. the handshake-timeout close: two close paths exist on the agent side and the design does not say they share the idempotent `onLinkDead` guard

**Where:** §3 "Connection + reconnect" (`register:nack` → "close, and still schedule a reconnect"); §3 "Heartbeat and single-path liveness" (`onLinkDead()` idempotent single-close).

**Problem.** The design carefully routes the two *liveness* paths (app heartbeat timeout, transport pong timeout) through a single idempotent `onLinkDead()`. But there are additional close triggers on the agent side that are **not** liveness: a `register:nack` close, and the server's 5s handshake-timeout close (which the agent observes as a transport close). The design does not state whether `register:nack`'s "close + schedule reconnect" goes through `onLinkDead()` or is a separate code path. If it is separate and the socket *also* trips a transport close for the same event, two reconnects could be scheduled (the exact double-trigger the heartbeat section was careful to prevent — just via a different pair of triggers).

**Concrete fix.** One sentence in §3: "All socket-teardown paths on the agent — `register:nack`, handshake-timeout/transport close, heartbeat/pong dead-link — funnel through the single idempotent `onLinkDead()` (which closes once and schedules exactly one reconnect); `register:nack` additionally logs the nack code before calling it. The `alreadyDead` guard therefore covers every teardown trigger, not only the two liveness timers."

---

## Verified Assumptions

Every item below was checked against the actual source in the worktree and the design's claim is **accurate**:

1. **`WsHub` yields on non-`/ws` upgrades without destroying** — confirmed `src/ws/hub.ts#handleUpgrade`: `if (pathname !== '/ws') return;` with the explicit "a future second WS path is not clobbered" comment. The §4 coexistence contract for `/agent` holds.
2. **`WsHub` `log:subscribe` validates only `typeof m.process === 'string'`** — confirmed; the design's finding #3 (tighten with `agentIdSchema`/`processNameSchema` on the relay path) correctly targets a real gap.
3. **`BAD_MESSAGE` error-frame pattern** — confirmed `WsHub.handleMessage` emits `{ type:'error', code:'BAD_MESSAGE', message }` for bad JSON / missing `type` / unknown `type`. The protocol codec's mirror of this is faithful.
4. **Backoff constants** — confirmed `src/pm2/client.ts`: `BACKOFF_BASE_MS=1000`, `BACKOFF_CAP_MS=30_000`, `base * 0.2 * (Math.random()*2-1)` jitter, `Math.max(0, …)`. The shared `backoffDelay(attempt, rand=Math.random)` extraction is a faithful pure refactor and the injected-RNG test seam is valid (the current function calls global `Math.random` with no seam).
5. **`Pm2Client` resets `backoffAttempt` on connect success** — confirmed `onConnectSuccess` sets `backoffAttempt = 0`. The design's deliberate divergence (agent resets on `register:ack`, not socket `open`) is correctly contrasted and sound for the AUTH_FAILED hot-loop concern (finding #10).
6. **`metrics:tick` carries `ProcessSnapshot[]`** — confirmed `src/core/events.ts` `MonitorEventMap['metrics:tick']: [ProcessSnapshot[]]`. The §3 `update:metrics` derivation from `ProcessSnapshot` is correct.
7. **`MonitorState.onMetricsTick` pushes online-only and prunes departed names** — confirmed `src/core/state.ts`: online-only `metrics.push`, then `for (const name of this.metrics.names()) if (!liveNames.has(name)) this.metrics.drop(name)`. `MetricSample.ts = snap.lastUpdated` confirmed. The §4 prune-on-snapshot port and the §3 `ts`-verbatim pin are faithful.
8. **`MetricsStore` API** — confirmed `push`/`drop`/`names`/`sustainedAbove`/`getSeries` exist with those signatures; the per-agent reuse and the snapshot prune using `names()`+`drop()` are valid.
9. **`createProcess` schema shape** — confirmed `src/api/schemas.ts`: `z.object({ body: z.object({...}).strict().superRefine(XOR + fork/instances).transform(cluster-injection) })`. The `createProcess.safeParse({ body: opts })` wrapping, `.strict()` unknown-key rejection, and consuming the post-transform `parsed.data.body` are all correct (finding #6).
10. **`processNameSchema`** — confirmed `/^[A-Za-z0-9._-]{1,100}$/`; the `agentIdSchema` reuse and the composite `agentId/name` split-on-last-`/` are unambiguous because neither part contains `/`.
11. **`alertRules.ts` `processSelector`** — confirmed `z.union([z.literal('*'), processNameRule])` with `/`-excluding charset; the widening to add `compositeTargetRule` is a true superset, so existing rule files still validate (finding #2).
12. **`AlertEngine` is NOT unchanged** — confirmed: `ruleTargets` uses literal `includes()`, `targetNames` returns `present`/`rule.match.processes`, `handleTick` has `if (!present.has(name)) continue`, `buildPayload` builds from bare `name`. The four bounded edits + injected `resolveAgent` default-identity (compile-compatible with existing callers) are correctly scoped and the standalone no-op is real.
13. **`AlertStateHub`/`AlertErrorWindows` are injected interfaces** — confirmed; `index.ts` already constructs an inline `engineStateHub`, so a `FleetRegistry`-backed composite-key implementation is a drop-in. `getMaintenance()`/`sustainedAbove`/`processNames` all present.
14. **`AlertPayload` shape** — confirmed `src/alerts/channels/types.ts`; adding optional `agentId`/`agentAlias` is purely additive and `AlertChannel.send(payload)` renderers that ignore them are unaffected (finding #3 / payload section).
15. **`safeEqual`** — confirmed `src/api/auth.ts`: sha256-normalizes both sides then `timingSafeEqual`, never throws on empty/length-mismatch, returns boolean. The `tokens.some(t => safeEqual(provided, t))` list rotation and `safeEqual('', configured)===false` defense-in-depth are correct.
16. **`sendControlResult` is binary** — confirmed `src/api/routes/processes.ts`: `result.code === 'PM2_UNAVAILABLE' ? 409 : 502`, no 400/VALIDATION path, create success passes `201`. The separate `statusForControlCode` table for the fleet path (leaving standalone untouched) is justified (finding #5).
17. **`createHealthRouter`/`createSystemRouter` depend on `deps.state`** — confirmed `src/api/routes/system.ts`: health reads `isConnected()`+`getMaintenance().active`, status reads `snapshot()`. The dedicated `createServerHealthRouter` (no `StateDeps`) and not mounting `/status` in server mode are the correct resolution (finding #4). `ApiDeps.state` is a required `StateDeps` (confirmed `src/api/server.ts`).
18. **Logger redaction** — confirmed full-depth recursion into plain objects, `REDACTED_KEYS` by key name at any depth, `token=` string redaction at any depth, arrays NOT recursed (`!Array.isArray(value)`). The design's corrected depth analysis and the single "never array-wrap a secret" contract are exactly right.
19. **`env.ts` patterns** — confirmed `booleanish`, `numeric`, `z.preprocess(blank→undefined)` on `ALLOWED_SCRIPT_ROOT`, `superRefine` with `ctx.addIssue({ path })`, `parseConfig` exported, `loadConfig → process.exit(1)`, `Object.freeze`. The config approach fits the established pattern.
20. **`index.ts` boot body is self-contained** — confirmed `bootstrap()` holds the full wiring; extracting it to `bootstrapStandalone()` is a behavior-neutral move. The deferred-PM2-after-listen pattern is present (and is the basis for finding #2).
21. **`createServer` returns the shared `http.Server`** — confirmed; `WsHub`/`AgentGateway` both attaching via `noServer` on the same server, and `https.createServer` for native TLS, are consistent with the existing design.
22. **`buildSmtpConfig`/`buildAuthConfig` precedent** — confirmed in `index.ts`; the new `buildAgentAuthConfig`/`buildAgentDialConfig` derived helpers mirror these faithfully.

## Unverified / Wrong Assumptions

- **No wrong source claims were found.** Every "verified"/"existing behavior" assertion in the design that I checked matched the actual code. Notably, the design's own corrections of earlier passes (engine-not-unchanged, redaction full-depth, `sendControlResult` binary, `createProcess` `{body}` envelope, `metrics:tick` payload type, `onMetricsTick` prune) are all accurate against source.
- **Not verifiable from the design/source alone (noted, not findings):**
  - Open-Q item names (exact env var names) are explicitly flagged by the design as a naming decision; acceptable.
  - The `public/` dashboard parameterization (optional `agentId` threading through `overview.js`/`detail.js`/`api.js`/`ws.js`) is described but the current `public/` files were not read in this pass; the approach is additive and gated on `mode==='server'`, so standalone risk is low, but the parameterization detail is taken on the design's word.
  - Integration-test feasibility (in-process loopback `ws` with injected `fakePm2Client`) is consistent with the existing test style but not executed here.

---

## Verdict rationale

0 HIGH + 2 MEDIUM (+ 4 NIT). Per the mechanical rule (any HIGH or MEDIUM ⇒ CHANGES_REQUESTED), the verdict is **CHANGES_REQUESTED**. The two MEDIUMs are both "one or two sentences of pinning" fixes — the design's architecture is sound and its source claims are accurate; what remains is removing two spots where an implementer would otherwise guess (how to extend a `ZodEffects` schema, and how agent-mode boot defers local-PM2 wiring so it never blocks the server dial). The four NITs are precision tightenings. A quick loop-back resolves all six without any structural change.
