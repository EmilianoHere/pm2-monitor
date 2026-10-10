# Deploying pm2-monitor

This guide covers running pm2-monitor in **server (hub) mode** with Docker, Docker
Compose, and Kubernetes (Helm), plus how to connect **native agents** to the hub.

## 1. Overview

pm2-monitor has three run modes (`MODE` = `standalone`, `agent`, or `server`).
Only **server (hub) mode** is containerized here. The hub accepts inbound agent
WebSocket connections and serves the fleet dashboard.

Agents are **not** containerized. An agent runs natively on each host, right next
to that host's PM2 daemon, and dials **outbound** to the hub over `wss://` at the
hub's `AGENT_WS_PATH`. Running the agent in a container would isolate it from the
PM2 daemon it is meant to monitor, so keep agents native (plain Node, PM2, or
systemd) and only deploy the hub with the artifacts below.

The hub exposes an **unauthenticated** health endpoint at
`GET /api/system/health`, which returns JSON including `"mode":"server"`. It is
used for Docker `HEALTHCHECK` and Kubernetes liveness/readiness probes.

All env var names below are defined in [`src/config/env.ts`](./src/config/env.ts).

## 2. Docker image

Build the image from the repo-root `Dockerfile` (multi-stage: `node:20` build →
`node:20-slim` runtime). The runtime image runs as the non-root `node` user
(uid/gid 1000) and keeps `pm2` as a production dependency.

```bash
docker build -t pm2-monitor:1.0.0 .
```

Run the hub, supplying server-mode environment:

```bash
docker run --rm \
  -e MODE=server \
  -e HOST=0.0.0.0 \
  -e API_KEY=change-me-long-random \
  -e AGENT_TOKENS=token-a,token-b \
  -p 3000:3000 \
  -v pm2monitor-config:/app/config \
  pm2-monitor:1.0.0
```

Required server-mode environment:

| Variable      | Purpose                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `MODE`        | Must be `server` to run the hub.                                        |
| `HOST`        | Must be `0.0.0.0` inside a container so the port is reachable.          |
| `PORT`        | HTTP + WebSocket port (default `3000`).                                 |
| `API_KEY`     | Required when `AUTH_MODE=apikey` (the default). Or use basic auth.      |
| `BASIC_USER` / `BASIC_PASS` | Required instead of `API_KEY` when `AUTH_MODE=basic`.     |
| `AGENT_TOKENS`| Comma-separated list of accepted agent tokens (server mode requires this or `AGENT_TOKEN`). |
| `AGENT_WS_PATH` | Agent-facing WebSocket path (default `/agent`; must not be `/ws`).    |
| `ALIAS_STORE_FILE` | Path to the persisted agent-alias store; keep it under `/app/config`. |

Health check: `GET /api/system/health` (unauthenticated) returns
`{"status":"ok","mode":"server",...}`. The image's `HEALTHCHECK` already polls it.

**Alias persistence:** the alias store (`ALIAS_STORE_FILE`) is written with a
write-temp-then-rename in the same directory, so mount a **writable directory**
(for example a volume at `/app/config`), not a single file. The image defaults
`ALIAS_STORE_FILE` to a path under `/app/config`.

## 3. Docker Compose

The repo-root `docker-compose.yml` defines a single `pm2-monitor` service with a
named volume (`pm2monitor-config`) mounted at `/app/config` for alias persistence,
and publishes port `3000`.

1. Copy the example env file and fill in your secrets. **Never commit `.env`.**

   ```bash
   cp .env.docker.example .env
   # edit .env: set API_KEY and AGENT_TOKENS (and SMTP_*/TEAMS_WEBHOOK_URL if used)
   ```

2. Start the hub:

   ```bash
   docker compose up -d
   ```

3. Check health:

   ```bash
   curl -s http://localhost:3000/api/system/health
   ```

The compose file pins the container-correct values (`MODE=server`, `HOST=0.0.0.0`,
`PORT=3000`, `ALIAS_STORE_FILE=/app/config/agent-aliases.json`) via `environment:`,
while secrets come from `.env` via `env_file`.

### TLS

The default assumes **TLS termination at a reverse proxy** in front of the hub,
so the container serves plain HTTP. To instead terminate TLS **in-process**,
uncomment the native-TLS block in `docker-compose.yml` (mount `./certs` read-only)
and set **both**:

```env
TLS_CERT_FILE=/app/certs/fullchain.pem
TLS_KEY_FILE=/app/certs/privkey.pem
```

`TLS_CERT_FILE` and `TLS_KEY_FILE` are both-or-neither — setting only one is a
configuration error.

## 4. Kubernetes (Helm)

A Helm chart for the hub lives under [`deploy/helm/pm2-monitor/`](./deploy/helm/pm2-monitor/).
It renders a single-replica Deployment (`MODE=server`, non-root, PVC-backed alias
store, liveness/readiness probes on `/api/system/health`), a ClusterIP Service, a
ConfigMap of non-secret env, an optional Secret, an optional PVC, and an optional
Ingress.

### Install with chart-managed secrets

```bash
helm install pm2-monitor deploy/helm/pm2-monitor \
  --set secret.apiKey=change-me-long-random \
  --set secret.agentTokens=token-a,token-b
```

`secret.apiKey` becomes `API_KEY` and `secret.agentTokens` becomes `AGENT_TOKENS`
in the chart-managed Secret.

### Install with a pre-created Secret

Create a Secret yourself (keys `API_KEY`, `AGENT_TOKENS`, optionally `SMTP_PASS`
and `TEAMS_WEBHOOK_URL`), then point the chart at it so no chart-managed Secret is
rendered:

```bash
helm install pm2-monitor deploy/helm/pm2-monitor \
  --set secret.create=false \
  --set secret.existingSecret=my-pm2-monitor-secret
```

### Ingress / TLS

TLS is best terminated at the Ingress. Enable it and set a host (and TLS block for
a terminating certificate):

```bash
helm install pm2-monitor deploy/helm/pm2-monitor \
  --set secret.apiKey=change-me-long-random \
  --set secret.agentTokens=token-a,token-b \
  --set ingress.enabled=true \
  --set 'ingress.hosts[0].host=monitor.example.com'
```

> Under zsh, single-quote `--set` arguments that contain `[` / `]` to avoid glob
> expansion.

### Alias persistence (PVC)

`persistence.enabled` (default `true`) provisions a ReadWriteOnce PVC mounted at
`/app/config`, where the chart points `ALIAS_STORE_FILE`. The pod's
`securityContext` (`runAsNonRoot`, `runAsUser: 1000`) and pod `fsGroup: 1000`
keep that volume writable by the non-root process so aliases survive restarts.
Keep `replicaCount` at `1` — the alias store is single-writer and agent socket
state is per-pod.

## 5. Connecting native agents

Each agent runs natively on a host alongside that host's PM2 and dials the hub
outbound over `wss://`. Set the following environment on the agent process:

| Variable        | Value                                                                              |
| --------------- | ---------------------------------------------------------------------------------- |
| `MODE`          | `agent`                                                                            |
| `SERVER_URL`    | `wss://monitor.example.com` — host only, no path (e.g. the hub's public hostname). |
| `AGENT_TOKEN`   | One of the tokens listed in the hub's `AGENT_TOKENS`.                               |
| `AGENT_WS_PATH` | `/agent` — must match the hub's `AGENT_WS_PATH`.                                    |
| `AGENT_NAME`    | Optional. An alias hint the operator can later override from the dashboard.        |
| `TLS_INSECURE`  | `false` (leave disabled; only enable for self-signed certs in testing).            |

Example agent `.env`:

```env
MODE=agent
SERVER_URL=wss://monitor.example.com
AGENT_TOKEN=token-a
AGENT_WS_PATH=/agent
AGENT_NAME=prod-web-01
TLS_INSECURE=false
```

`SERVER_URL` must begin with `ws://` or `wss://`; use `wss://` in production. The
agent combines `SERVER_URL` with `AGENT_WS_PATH` to reach the hub, so give
`SERVER_URL` the host only and let `AGENT_WS_PATH` carry the path.

## 6. Secret handling

- Keep secrets in `.env` (Docker / Compose) or a Kubernetes Secret — never in
  `docker-compose.yml`, chart values committed to git, or any tracked file.
  `.env` is gitignored; `.env.docker.example` holds only `CHANGE_ME` placeholders.
- `API_KEY` is required when `AUTH_MODE=apikey` (the default). Use `BASIC_USER` /
  `BASIC_PASS` with `AUTH_MODE=basic` instead.
- `AGENT_TOKENS` and `TEAMS_WEBHOOK_URL` are redacted from logs.
- **Rotating `AGENT_TOKENS`:** add the new token to `AGENT_TOKENS` (keeping the old
  one) and roll the hub so both are valid during the transition. Move agents to the
  new token, then drop the old token from `AGENT_TOKENS` and roll again.
