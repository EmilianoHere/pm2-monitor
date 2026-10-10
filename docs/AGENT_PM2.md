# Correr un agent con PM2

Guía paso a paso para correr pm2-monitor en **modo agent** en una máquina que ya
tiene PM2. El agent monitorea el PM2 **local**, se conecta de forma **saliente**
al server central (hub) y le reporta estado/métricas/logs, ejecutando los
comandos de control que el server le manda.

> El agent corre **nativo** en el host (bajo PM2), NO en Docker: tiene que ver
> el daemon de PM2 de la máquina, y un contenedor aislado no lo vería.

> El agent abre solo una conexión **saliente** al server. No necesita puertos de
> entrada abiertos en esta máquina.

## 1. Requisitos

- Node.js 20+ (`node -v`).
- PM2 instalado y con procesos corriendo (`pm2 list`).
- El código de pm2-monitor clonado y compilado en esta máquina:

  ```bash
  git clone git@github.com:EmilianoHere/pm2-monitor.git
  cd pm2-monitor
  npm install
  npm run build
  ```

- Datos del server al que te vas a conectar (ver `docs/SERVER_DOCKER.md`):
  - URL WebSocket del server: `ws://<IP>:3000` o `wss://<host>` si tiene TLS.
  - Un token válido (uno de los de `AGENT_TOKENS` del server).

## 2. Configurar el `.env` del agent

Creá/editá el `.env` del proyecto en esta máquina:

```bash
cp .env.example .env
nano .env
```

Dejá estas variables (lo mínimo para modo agent):

```bash
# Modo agent
MODE=agent

# A dónde se conecta (WebSocket). Es SOLO el host base; el path se agrega aparte.
# ws:// si el server está en HTTP plano, wss:// si tiene TLS/reverse proxy.
SERVER_URL=ws://<IP-del-server>:3000

# Token para autenticarse (uno de los AGENT_TOKENS del server)
AGENT_TOKEN=<token>

# Path del WS de agents en el server (default /agent — debe coincidir con el server)
AGENT_WS_PATH=/agent

# (Opcional) nombre sugerido para esta instancia. Si lo dejás vacío, el agent
# genera un id estable solo (hostname + sufijo persistido). El alias visual se
# edita desde el dashboard del server y pisa este nombre.
# AGENT_NAME=prod-api

# (Solo para TLS con certificado self-signed en pruebas — NO usar en prod)
# TLS_INSECURE=false
```

### Importante sobre `SERVER_URL` y `AGENT_WS_PATH`

`SERVER_URL` es **solo el host base** (sin el path). El agent le agrega
`AGENT_WS_PATH` por su cuenta. O sea:

- Correcto: `SERVER_URL=ws://1.2.3.4:3000` + `AGENT_WS_PATH=/agent`
- Incorrecto: `SERVER_URL=ws://1.2.3.4:3000/agent` (se duplicaría a `/agent/agent`)

### Nota sobre la auth del dashboard local

El schema de config exige `API_KEY` cuando `AUTH_MODE=apikey` (el default), aun
en modo agent — es el guard de auth humana, que es independiente del modo. Con
poner cualquier `API_KEY` en el `.env` del agent alcanza para satisfacerlo
(el agent no expone dashboard de cara al exterior, pero la validación igual la
pide):

```bash
AUTH_MODE=apikey
API_KEY=<cualquier-clave>
```

## 3. Probar a mano primero

Antes de meterlo en PM2, verificá que conecta:

```bash
node dist/index.js
```

Deberías ver logs de arranque en modo agent y de conexión al server. Si el
server está arriba y el token es válido, se registra. Si el server no está
disponible, el agent **reintenta con backoff** (no crashea). Cortá con Ctrl+C.

Errores comunes acá:
- `SERVER_URL is required when MODE=agent` / `AGENT_TOKEN is required...`:
  falta esa variable en el `.env`.
- `SERVER_URL must start with ws:// or wss://`: corregí el esquema de la URL.

## 4. Arrancar el agent bajo PM2

Con el `.env` listo, lo corrés como un proceso PM2 más en esta máquina:

```bash
pm2 start dist/index.js --name pm2-agent --cwd $(pwd)
pm2 logs pm2-agent --lines 20 --nostream
```

> El `--cwd $(pwd)` asegura que arranque desde la raíz del proyecto, así carga
> bien el `.env` y el `dist/`.

Para que sobreviva reinicios del sistema:

```bash
pm2 save
pm2 startup systemd      # ejecutá el comando con sudo que imprime
pm2 save
```

## 5. Verificar desde el server

En el dashboard del server (`http://<IP-del-server>:3000`), este agent debería
aparecer **online** en la lista de flota, con sus procesos PM2 debajo. También
podés chequearlo por API desde el server con la API key humana:

```bash
curl -H "X-API-Key: <API_KEY-del-server>" http://<IP-del-server>:3000/api/agents
```

Deberías ver este agent con su id autogenerado, estado online y la cantidad de
procesos. Desde el dashboard podés ponerle un **alias** visual (solo cosmético,
no cambia el id real) que persiste en el server.

## 6. Identidad y alias

- El agent genera un **id estable** por máquina (hostname + un sufijo aleatorio
  que persiste en `config/agent-id`), así se sigue reconociendo tras reinicios.
- El **alias** es un nombre lindo que vos editás desde el dashboard del server;
  es solo para tu vista y pisa el nombre autogenerado. Vive en el server, no en
  el agent.

## 7. Un agent por máquina

Corré un agent en cada host que tenga PM2 y quieras monitorear, todos apuntando
al mismo `SERVER_URL`. Cada uno con un token válido (pueden compartir token o
tener uno distinto, según cómo armaste `AGENT_TOKENS` en el server). El server
los agrupa a todos en el dashboard unificado.

## Troubleshooting

- **El agent no aparece en el server:** revisá los logs (`pm2 logs pm2-agent`).
  Causas típicas: token que no está en `AGENT_TOKENS` del server, `SERVER_URL`
  mal (host/puerto/esquema), o `AGENT_WS_PATH` distinto al del server.
- **Reconecta en loop:** normal si el server está caído o reiniciando; el agent
  reintenta con backoff y se engancha solo cuando el server vuelve.
- **Dice que falta `API_KEY`:** poné cualquier `API_KEY` en el `.env` (ver §2).
- **Control remoto responde `PM2_UNAVAILABLE`:** el PM2 local de esta máquina no
  está corriendo o el agent todavía no se enganchó al daemon; el agent sigue
  conectado al server igual y reintenta el PM2 local.
