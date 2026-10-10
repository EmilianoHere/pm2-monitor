# Levantar el server (hub) con Docker

Guía paso a paso para correr pm2-monitor en **modo server** con Docker Compose.
El server es el hub central: recibe las conexiones de los agents, mantiene el
estado de toda la flota y sirve el dashboard unificado. Los agents corren
nativos en cada máquina con PM2 (ver `docs/AGENT_PM2.md`).

> Todos los comandos se corren en la máquina donde va a vivir el server, dentro
> del directorio del proyecto (`cd pm2-monitor`).

## 1. Requisitos

- Docker y Docker Compose instalados (`docker --version`, `docker compose version`).
- El puerto elegido (3000 por defecto) libre y, si querés acceso remoto, abierto
  en el firewall / Security Group.

## 2. Preparar el archivo de entorno

El compose lee un archivo `.env` ubicado al lado de `docker-compose.yml`.
Partí del ejemplo:

```bash
cp .env.docker.example .env
```

Editá `.env` y completá como mínimo:

```bash
# Modo (ya viene en server)
MODE=server

# Auth del dashboard humano (apikey por defecto)
AUTH_MODE=apikey
API_KEY=<una-clave-larga-y-aleatoria>

# Tokens que los agents van a presentar para conectarse.
# Lista separada por comas. Cada agent usa UNO de estos como su AGENT_TOKEN.
AGENT_TOKENS=<token-agent-1>,<token-agent-2>
```

Generá valores fuertes para la API key y los tokens:

```bash
openssl rand -hex 32    # para API_KEY
openssl rand -hex 32    # para cada token de AGENT_TOKENS
```

Lo demás (SMTP, Teams, umbrales, digest) es opcional: si lo dejás comentado,
esos canales quedan deshabilitados y el server funciona igual.

> Nota: el compose fuerza `MODE=server`, `HOST=0.0.0.0`, `PORT=3000` y
> `ALIAS_STORE_FILE=/app/config/agent-aliases.json` por encima del `.env`, así
> que no hace falta tocar esos cuatro.

## 3. Levantar el server

```bash
docker compose up -d --build
```

Esto construye la imagen (multi-stage, usuario non-root) y arranca el contenedor
en segundo plano. Para ver los logs:

```bash
docker compose logs -f pm2-monitor
```

Deberías ver una línea de arranque (`listening ... 0.0.0.0:3000`).

## 4. Verificar

Desde la misma máquina:

```bash
curl http://localhost:3000/api/system/health
```

Tiene que responder algo como:

```json
{"status":"ok","mode":"server","maintenance":false,"uptimeMs":...,"version":"1.0.0"}
```

`mode:"server"` confirma que arrancó en modo hub. (El `/api/system/health` no
requiere auth; el resto de la API y el dashboard sí.)

## 5. Entrar al dashboard

Abrí en el navegador:

```
http://<IP-del-server>:3000
```

Te pide la `API_KEY` que pusiste en el `.env`. Si todavía no se conectó ningún
agent, la vista de flota va a estar vacía — es lo esperado hasta que levantes un
agent apuntando a este server (ver `docs/AGENT_PM2.md`).

## 6. Persistencia de los alias

Los alias que les pongas a los agents desde el dashboard se guardan en
`/app/config/agent-aliases.json`, que vive en un volumen Docker nombrado
(`pm2monitor-config`). Eso hace que **sobrevivan reinicios** del contenedor:

```bash
docker compose restart        # los alias se mantienen
docker compose down           # el contenedor se borra, el volumen NO
docker compose up -d          # vuelven los alias
```

Para borrar también los alias (reset total) tenés que eliminar el volumen:

```bash
docker compose down -v        # OJO: esto borra el volumen y los alias
```

## 7. TLS / HTTPS (producción)

Por defecto el server sirve **HTTP plano**. Para producción tenés dos caminos:

- **Reverse proxy (recomendado):** poné Nginx / Traefik / un load balancer
  adelante que termine TLS y haga proxy a `http://pm2-monitor:3000`. Los agents
  se conectan con `wss://` al proxy. No cambia nada del contenedor.
- **TLS nativo en el contenedor:** descomentá el mount de `./certs` en
  `docker-compose.yml` y seteá en el `.env`:

  ```bash
  TLS_CERT_FILE=/app/certs/fullchain.pem
  TLS_KEY_FILE=/app/certs/privkey.pem
  ```

  Hay que setear **ambos** (solo uno es un error de config). Dejá los dos vacíos
  para usar HTTP plano / reverse proxy.

## 8. Operación

```bash
docker compose ps                 # estado del contenedor
docker compose logs -f            # seguir logs
docker compose restart            # reiniciar
docker compose down               # parar y borrar el contenedor (conserva alias)
docker compose up -d --build      # reconstruir tras un git pull
```

## 9. Datos que necesitan los agents

Para conectar un agent a este server (ver `docs/AGENT_PM2.md`) vas a necesitar:

- **URL del server** en formato WebSocket: `ws://<IP>:3000` (o `wss://<host>`
  si pusiste TLS/reverse proxy).
- **Path del WS de agents:** `/agent` (valor por defecto de `AGENT_WS_PATH`).
- **Un token** de los que listaste en `AGENT_TOKENS`.

## Troubleshooting

- **`curl` da connection refused:** el contenedor no arrancó o no bindeó.
  Mirá `docker compose logs pm2-monitor` — si hay un error de config (zod),
  revisá el `.env` (por ejemplo falta `API_KEY` o `AGENT_TOKENS`).
- **No entro desde afuera por la IP:** falta abrir el puerto 3000 en el firewall
  / Security Group de la máquina. Dentro de la red del host, `localhost:3000`
  igual responde.
- **"MODE=server requires AGENT_TOKENS or AGENT_TOKEN":** definí `AGENT_TOKENS`
  en el `.env`.
