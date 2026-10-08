# Design Review — PM2 Process Monitor & Control Panel

Reviewed: `design.md` against `requirements.md`, read fresh without the context that produced the design. Environmental claims were verified against the actual repo (`.gitignore`, repo contents, Node version, `pm2` install state).

## Verdict

CHANGES_REQUESTED — 0 HIGH, 3 MEDIUM, 5 NIT.

The design is mature: it has absorbed two prior review rounds and most of the hard problems (auth throw-safety, intentional-action tokens, sustained-coverage tolerance, condition disjointness, WS subprotocol echo) are specified concretely and correctly. The findings below are the gaps that remain after that work. The three MEDIUMs are real specification holes (not polish) that a coder would otherwise have to invent an answer for, and inventing it wrong is observable in behavior.

---

## Findings

### 1. MEDIUM — Metrics poll never populates `MetricsStore`; no component is assigned the "push sample per tick" job

Where: "PM2 integration layer" (periodic poll paragraph), "Metrics store", "Alert engine" (Sampled rules).

The design says a periodic poll "calls `list()` to refresh CPU/memory/uptime ... and feeds the MetricsStore," and separately that `MetricsStore.push(name, sample)` appends samples, and that `sustainedAbove` reads samples, and that cpu/mem rules "are checked on each metrics poll tick." But no module is given ownership of the loop that (a) runs every `METRICS_SAMPLE_SEC`, (b) iterates the current process list, (c) calls `MetricsStore.push` per process, and (d) then triggers `AlertEngine` sampled-rule evaluation. `Pm2Client` owns `list()`; `MonitorState` owns the store; `AlertEngine` owns the rules. The hand-off between them for the sampled path is unspecified, and sampled rules (cpu/mem thresholds, AC12) cannot fire without it.

Also unspecified: `MetricsStore.push` takes a single `MetricSample` (`{ts,cpu,mem}`), but a poll yields a `ProcessSnapshot[]`. Who maps each snapshot to a sample and supplies `ts`? And does the poll push for a process whose status is not `online` (a stopped process has cpu/mem 0 — pushing zeros will make a `cpu-threshold` window look "covered" with low values, which is fine, but a *deleted* process should stop accruing samples).

Concrete fix: assign the poll loop explicitly, e.g. in `Pm2Client` emit a `metrics:tick` event carrying the fresh `ProcessSnapshot[]` after each successful `list()`, and have `MonitorState` subscribe to persist samples (`for (const p of list) store.push(p.name, {ts: p.lastUpdated, cpu: p.cpu, mem: p.memory})`), and have `AlertEngine` subscribe to `metrics:tick` to run sampled-rule evaluation. State the rule for non-online processes (skip push, or push zeros) and that samples for a deleted process name are dropped. One sentence naming the owner and the data flow closes this.

### 2. MEDIUM — `error-spike` / `restart-threshold` window length is operator-configured per rule, but the ErrorTracker's sliding-window buffers are a single fixed `METRICS_RETENTION_MIN`-independent width; the mapping is unspecified

Where: "Error tracker" (sliding-window counters; restart-window counter), alert-rule schema (`error-spike` `withinSec`, `restart-threshold` `withinMin`).

The ErrorTracker "maintains sliding-window counters per process (counts bucketed into 1-second slots over a configurable window)" and "a separate restart-window counter." But the rule schema lets each rule specify its own `withinSec` (error-spike) and `withinMin` (restart-threshold), and multiple rules with different windows can coexist. The design never says how a per-rule window is answered from the tracker's buffers. If the tracker keeps one fixed window, a rule asking for a longer window than the buffer silently under-counts; a rule asking for a shorter window needs the tracker to sum only the trailing slots. "a configurable window" (singular) does not say whose config sets it or how two rules with different windows share it.

Concrete fix: specify that the tracker keeps a ring of 1-second count slots sized to the **maximum** window any loaded rule requests (recomputed on rule reload), and exposes `countInWindow(name, sinceSec)` that sums the trailing `sinceSec` slots; the engine passes each rule's `withinSec`/`withinMin*60`. State the behavior if a rule's window exceeds the buffer (clamp + warn, or size to max — pick one). Name the method so the engine's event-driven branch has something concrete to call.

### 3. MEDIUM — `restart overlimit` is double-counted toward both `errored` and `restart-threshold`, re-opening the double-fire the design claims to have closed

Where: "Event → MonitorEvents translation" (`restart overlimit` bullet), "Error tracker" (restart-window counter: "increments only on ... `restart overlimit`"), alert-rule schema (`errored` = "restart overlimit ONLY"; disjointness claim).

The design states two things that conflict:
- `errored` fires on the transition to `errored`, "reached via `restart overlimit`."
- The restart-window counter "increments only on `error:captured` level `restart` with `intentional === false` (and on `restart overlimit`)," and `restart-threshold` consults that counter.

So a single `restart overlimit` event both drives the `errored` condition and increments the `restart-threshold` counter. An operator who (per the design's own guidance) deliberately subscribes to both `errored` and `restart-threshold` is fine — but the design's disjointness argument is "a single lifecycle event maps to at most one of these two conditions, so there is no double alert from one event." That invariant is violated for `restart overlimit`, which maps to **both** `errored` and (via the counter) `restart-threshold`. This is a correctness claim in the doc that is not true as written.

Concrete fix: decide and state one of: (a) `restart overlimit` counts toward `errored` only and does **not** increment the restart-window counter (crash-loop restarts short of the overlimit still drive `restart-threshold`); or (b) it legitimately contributes to both and the disjointness statement is narrowed to "`errored` and `unexpected-stop` are disjoint" (dropping the broader "at most one condition per event" claim, since `restart-threshold` is a counting rule that intentionally overlaps). Either is defensible; the doc must not assert both.

### 4. NIT — `MonitorState` is keyed by process `name`, but PM2 permits duplicate names across `pm_id`s

Where: "Core data model" (`Map<string, ProcessSnapshot>` keyed by name), "Aggregate semantics."

The aggregate-by-name model is reasonable and well-specified for the cluster case (N instances of one app name). But PM2 also allows two *separately started* apps to share a name (e.g. `pm2 start x.js --name api` twice in fork mode registers two distinct `pm_id`s both named `api`). The name key then collapses them. This is an edge case, not a blocker, but the design asserts name is a safe unique key without noting the exception.

Concrete fix: one sentence — "duplicate process names are treated as one aggregate entry; operators are expected to use unique names (documented in the README)," or map-key on name and accept last-writer-wins with a logged warn on collision.

### 5. NIT — `GET /api/processes/:name/logs` returns 200 with `{lines:[]}` for a nonexistent process, inconsistent with the 404 contract elsewhere

Where: REST table (`/logs` row), "Log reading" (`readLogsTail` returns `{lines:[]}` + 200 on file missing/unreadable), Error-handling table.

`GET /api/processes/:name` returns 404 for an unknown process, but `/logs` returns 200 empty when the log file is missing/unreadable. A request for logs of a name that does not exist at all should arguably 404 (consistent with detail), while a known process whose log file is merely empty/unreadable returns 200 empty. The design conflates "unknown process" and "known process, no readable file."

Concrete fix: state that `/logs` first resolves the process via the snapshot map and 404s if the name is unknown, then returns 200 `{lines:[]}` only when the process exists but the file is missing/unreadable.

### 6. NIT — `MetricSample` carries `cpu`/`mem` but `sustainedAbove(name, metric, ...)` takes a `metric` selector whose allowed values are undefined

Where: "Metrics store" (`sustainedAbove(name, metric, threshold, durationSec)`).

`metric` is clearly `'cpu' | 'mem'` by context, but it is never typed. A coder could pass `'memory'` (the `ProcessSnapshot` field name) vs `'mem'` (the `MetricSample` field name) and mismatch silently.

Concrete fix: type it `metric: 'cpu' | 'mem'` and note it indexes `MetricSample`, not `ProcessSnapshot`.

### 7. NIT — digest "top error signatures over the last 24h" is not supported by the data structures as specified

Where: "Daily digest", "Error tracker" (ring buffer capacity `ERROR_BUFFER_SIZE`, default 500; sliding windows bucketed in 1-second slots).

The digest wants "top error signatures by count over the last 24h." The ring buffer holds the most recent `ERROR_BUFFER_SIZE` *distinct signatures* (not 24h of occurrences), and `TrackedError.count` is an all-time count for the signature, not a 24h count. The 1-second-slot sliding windows are per-process occurrence counts, not per-signature. So "top signatures over the last 24h" has no backing store unless the buffer happens to span 24h. This is a NIT because a reasonable implementer will just report top signatures by `count` present in the buffer with their `lastSeen` within 24h — but the doc should say that is what "over the last 24h" means, since exact 24h-windowed per-signature counts are not retained.

Concrete fix: redefine the digest metric as "signatures whose `lastSeen` is within 24h, ranked by total `count`," and note it is an approximation bounded by `ERROR_BUFFER_SIZE`.

### 8. NIT — `AlertPayload.facts` typed `{k,v}` but digest and `test` payloads are not alert payloads; the digest email's content type is unspecified vs the channel's `send(AlertPayload)` signature

Where: "Alert channels" (`EmailChannel.send(payload: AlertPayload)`), "Daily digest" (builds a digest and "sends it through the EmailChannel").

`EmailChannel.send` takes an `AlertPayload`. The digest is a per-process table + top signatures + alert totals — that does not fit `AlertPayload` (`title/severity/processName/ruleId/summary/facts/...`). Either the digest crams a multi-process report into a single-process `AlertPayload` (awkward: `processName` is required and singular), or it needs a separate send path on `EmailChannel`.

Concrete fix: give `EmailChannel` a second method (e.g. `sendRaw({subject, html, text})`) that the digest uses, or define a `DigestPayload` and overload. State which, so the channel interface is complete.

---

## Verified Assumptions

These design claims were checked against the actual environment/source and hold:

1. **`.gitignore` currently contains `node_modules/`, `dist/`, `*.log` but NOT `.env` and NOT `logs/`.** Verified by reading `.gitignore`. The design's plan to add two explicit lines (`.env`, `logs/`) is correct and necessary for AC20.
2. **Repo contains only `.git`, `.gitignore` (plus the `.agents` tasks dir).** Verified by directory listing. "Existing git repo containing only .git and .gitignore" holds (the `.agents` dir is the task scaffolding, not project code).
3. **Node is v20.19.2.** Verified by `node --version`. Global `fetch` is stable in Node 20, so the design's "Teams via global `fetch`, no HTTP dependency" is valid and `engines.node: ">=20"` is satisfiable locally.
4. **`pm2` is not installed in the repo.** Verified (`node_modules/pm2` absent). This substantiates the design's rationale for pinning bus packet shapes defensively and confirming the installed version at implementation time — the field-path defense (`packet.event ?? packet.data?.event`) is a reasonable mitigation given this.
5. **`crypto.timingSafeEqual` throws `RangeError` on unequal-length buffers.** Correct (documented Node behavior). The `safeEqual` sha256-to-32-byte-digest normalization genuinely prevents the throw, and reusing it on the WS upgrade path genuinely closes the uncaught-exception-kill. Finding resolved as the design claims.
6. **Browsers cannot set an `Authorization` header on a WebSocket handshake, and a server offered a `Sec-WebSocket-Protocol` must echo one back or the browser aborts.** Correct. The `new WebSocket(url, ["apikey.<KEY>"])` + `handleUpgrade` echo mechanism is a valid, standard workaround.

## Unverified / Wrong Assumptions

1. **PM2 5.x bus packet shapes (`process:event`, `process:exception`, `log:err`, `log:out`) and the exact `event` enum values.** NOT verifiable here — `pm2` is not installed. The design explicitly acknowledges this and mitigates with defensive field reads; that is the right call, but the pinned enum (`'online'|'stop'|'restart'|'exit'|'delete'|'restart overlimit'|'start'`) and the `restart = exit-then-online` bus behavior are assumptions to confirm against the installed version at implementation time. Flagged, not blocking (the design already flags it).
2. **`pm2.describe` exposes `kill_timeout`.** The intentional-action grace window adds `kill_timeout` "when `describe` exposes it." Whether the mapped `ProcessSnapshot` or raw describe output carries `kill_timeout` is unverified (it is not in the `ProcessSnapshot` type as defined — the type has no `killTimeout` field). If the snapshot does not carry it, the "`GRACE_MS = base + killTimeout`" path has no source. Confirm the field is read from raw describe output (not the snapshot) and consider adding `killTimeout?: number` to `ProcessSnapshot`. Related to Finding 1's data-flow gap.
3. **`pm_out_log_path` / `pm_err_log_path` availability from `describe`.** `readLogsTail` resolves log file paths from `describe`; these fields are standard in PM2 but unverified against the installed version (same root cause as #1).
4. **Chart.js via CDN reachable at runtime.** The design degrades to a numeric table if the CDN is blocked, so this is handled — noted only for completeness.
