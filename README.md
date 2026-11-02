# HostPanel

Panel de hosting tipo **cPanel / Webmin** con funciones tipo **Cloudflare**, instalado de forma
**nativa** (sin Docker) con un solo comando.

- **WordPress en un clic** (base de datos, administrador y SSL; sin GitHub)
- **Administrador de archivos** por sitio: subir arrastrando, editor con resaltado (HTML, CSS, JS, PHP, JSON), renombrar, mover, descomprimir .zip/.tar.gz y descargar
- **Copias de seguridad** por sitio (archivos + bases de datos), manuales o diarias/semanales con retención, descarga y restauración con copia previa automática
- **Tareas cron** por sitio con atajos de frecuencia, ejecución manual y salida de la última ejecución
- **Cuentas SFTP** por sitio: accesos solo-SFTP encerrados (chroot) en la carpeta del sitio, sin consola ni acceso a otros sitios; contraseña que se muestra una sola vez y claves SSH opcionales
- **Rutas protegidas con contraseña** (privacidad de directorios): `/` o `/admin` piden usuario y contraseña desde Caddy (bcrypt); la ruta más específica manda, como con `.htaccess`
- **Ajustes de PHP por sitio** (memoria, subida, tiempo, variables, zona horaria, mostrar errores) y registro de errores PHP en el panel
- Sitios **estáticos, PHP y Node.js** con despliegue automático desde **GitHub** (webhook firmado, rollback, sin caídas)
- **Multidominio** con **DNS** propio (PowerDNS) y editor de registros
- **SSL de Let's Encrypt por dominio**: cada dominio vinculado a un sitio, Worker, balanceador o proxy recibe su certificado y se renueva solo; el panel muestra caducidad, renovación y el motivo si falla (DNS, puertos, límites)
- **Correo** para todos los dominios (Stalwart: SMTP, IMAP, DKIM, SPF, DMARC, antispam) + **webmail** (Roundcube)
- **Proxy inverso gráfico** (Caddy): rutas, balanceo, redirecciones y **SSL automático**
- **Balanceadores de carga**: un dominio (o una ruta) repartido entre varios servidores de origen, con 8 políticas (por turnos, con peso, menos conexiones, por IP, cookie de sesión, principal/reserva…), comprobación de salud y estado en vivo
- **WAF** OWASP CRS (Coraza), rate limit, reglas de IP, bloqueo de bots y **modo "bajo ataque"**
- **Bases de datos SQL** (MariaDB) con consola, **API HTTP**, copias y acceso remoto
- **Bases de datos NoSQL**: documentos JSON en colecciones, filtros tipo `$gt`/`$in`/`$regex`, operadores de actualización, índices (también únicos), API HTTP, exportar/importar `.jsonl` y acceso desde Workers
- **Workers** (API de Cloudflare Workers): editor en el navegador, rutas `dominio.com/api/*`, subdominio `nombre.workers.tu-dominio`, crons, logs en vivo, métricas y versiones
- **Colas** estilo Cloudflare Queues: lotes, reintentos, cola de fallidos, productores por Worker o HTTP y consumidores Worker o *pull*
- **KV**: almacén clave-valor con caducidad para los Workers
- **Almacenamiento** de objetos: buckets con dominio propio, CDN, CORS y API con tokens
- **Varios servidores**: despliega en otros VPS y **balancea la carga** entre ellos
- **Varias versiones de PHP** (7.4 → 8.5) por sitio, instalables desde el panel y con avisos de cada parche (8.5.10 → 8.5.12)
- **Varias versiones de Node.js** a la vez: cada sitio elige una versión exacta, la última de una rama (`22.x`), la del sistema o **«siempre la última instalada»**
- **Actualizador** del panel y de todos los componentes, con actualizaciones nocturnas opcionales
- **2FA**, sesiones, restricción de IPs del panel, fail2ban, **analítica** de tráfico en vivo, auditoría

Arquitectura y servicios en [Cómo está construido](#cómo-está-construido); hoja de ruta en [PLAN.md](PLAN.md).

## Instalar

Servidor limpio con **Ubuntu 22.04 / 24.04** o **Debian 12 / 13** (x86_64 o arm64), 2 GB de RAM recomendados:

```bash
curl -fsSL https://raw.githubusercontent.com/sergineko/Host-Panel/main/install.sh | sudo bash
```

El instalador pregunta el dominio principal (por ejemplo `midominio.com`) y el email para los certificados.
Sin preguntas:

```bash
curl -fsSL https://raw.githubusercontent.com/sergineko/Host-Panel/main/install.sh | sudo bash -s -- --domain midominio.com --email yo@midominio.com --yes
```

Al terminar muestra la URL del panel (`https://IP:2087`), el usuario `admin` y su contraseña.

**Después de instalar**, en el registrador del dominio principal:
1. Crea los *glue records* `ns1.midominio.com` y `ns2.midominio.com` apuntando a la IP del servidor.
2. Cambia los nameservers del dominio a esos dos.
3. Pide a tu proveedor el DNS inverso (PTR) de la IP → `mail.midominio.com` y que permita el puerto 25.

## Desinstalar

```bash
sudo hostpanel uninstall
```

Conserva sitios, bases de datos, correo y DNS (reinstalar los recupera). Para borrarlo **todo**:

```bash
sudo hostpanel uninstall --purge
```

## Dominios, nameservers y correo

### 1. Elige el dominio principal del servidor

El servidor necesita un dominio propio para tener **nameservers** (`ns1`/`ns2`) y **servidor de correo** (`mail`).
Si lo instalaste solo con la IP, añade uno de tus dominios en **Dominios** y elígelo en **Ajustes → Dominio principal
del servidor** (o en el aviso que aparece en Dominios). El panel reejecuta el instalador con ese dominio: instala el
correo si faltaba, abre sus puertos y configura:

| Nombre | Para qué |
|---|---|
| `ns1.<principal>` y `ns2.<principal>` | Nameservers de **todos** tus dominios |
| `mail.<principal>` | Servidor de correo: MX de todos tus dominios, IMAP y SMTP |
| `panel.<principal>` | Acceso al panel con SSL |

Al terminar, todas las zonas pasan a usar esos nameservers y todos los dominios reciben su correo.

### 2. En el registrador del dominio principal: glue records

Como `ns1.<principal>` está dentro del propio dominio, el registrador necesita saber su IP. Busca **«Nameservers
propios»**, «Child nameservers», «Glue records» o «Registrar host» y crea `ns1.<principal>` y `ns2.<principal>` con la
IP del servidor (los dos con la misma IP: los registradores exigen dos nombres, no dos máquinas). Después cambia los
nameservers del dominio a esos dos nombres.

### 3. En el resto de dominios

Solo hay que poner `ns1.<principal>` y `ns2.<principal>` como nameservers personalizados en su registrador. Si prefieres
mantener el DNS en otro proveedor (Cloudflare, tu registrador…), la pestaña **Conexión** de cada dominio lista todos los
registros que tienes que copiar allí.

La pestaña **Conexión** comprueba en vivo qué ve internet (nameservers, registro A y MX) y marca cada paso cuando se
completa. La propagación suele tardar menos de una hora (como mucho 48 h).

### 4. Reverse DNS (PTR)

Para que Gmail y Outlook acepten tu correo, configura en el **proveedor del VPS** (no en el registrador) el reverse DNS de
la IP del servidor apuntando a `mail.<principal>`.

### Qué se crea al añadir un dominio

- Zona DNS con `A`, `www`, `CAA` (solo Let's Encrypt y Sectigo) y los nameservers del servidor.
- Si el servidor tiene correo: dominio de correo con su clave **DKIM** y todos los registros que necesitan los buzones:
  `MX`, `SPF`, `DKIM`, `DMARC`, `MTA-STS`, informe TLS, `SRV` de IMAP/SMTP, `autoconfig`/`autodiscover` y
  `webmail.<dominio>`. Cualquier buzón que crees funciona sin tocar el DNS.
- Certificados SSL de Let's Encrypt en cuanto el DNS apunta al servidor.

## Comandos

| Comando | Qué hace |
|---|---|
| `hostpanel status` | Estado de todos los servicios |
| `hostpanel logs [servicio]` | Logs en vivo (`hostpanel`, `caddy`, `pdns`, `stalwart`…) |
| `hostpanel restart [servicio\|all]` | Reinicia servicios |
| `hostpanel reset-password [usuario]` | Nueva contraseña del panel |
| `hostpanel update [componente]` | Actualiza todo, o solo `panel`, `caddy`, `stalwart`, `roundcube`, `node`, `system` |
| `hostpanel disable-2fa [usuario]` | Quita la verificación en dos pasos (móvil perdido) |
| `hostpanel panel-access-reset` | Quita la restricción de IPs del panel |
| `hostpanel info` | URLs y configuración |

También se actualiza desde el panel: **Sistema → Actualizaciones**.

## Cómo está construido

Todo se instala de forma **nativa** (sin Docker): paquetes del sistema y binarios oficiales gestionados por
**systemd**. El panel es el centro: guarda su estado en SQLite y configura cada servicio por su API local, así que
nunca hay que editar a mano la configuración de Caddy, PowerDNS o Stalwart.

```
   80 · 443 web · 2087 panel             53 DNS          25 · 465 · 587 · 993 · 4190
                │                           │                       │
                ▼                           ▼                       ▼
┌────────────────────────────────┐  ┌────────────────┐  ┌───────────────────────┐
│ Caddy                          │  │ PowerDNS       │  │ Stalwart Mail         │
│ SSL Let's Encrypt · HTTP/3     │  │ DNS · DNSSEC   │  │ SMTP · IMAP · Sieve   │
│ WAF Coraza + OWASP CRS         │  │ SQLite         │  │ DKIM · SPF · DMARC    │
│ rate limit · balanceo · caché  │  └────────────────┘  │ antispam              │
└────────────────────────────────┘                      └───────────────────────┘
     │          ▲ admin API            ▲ API              ▲ API
     │          │ (socket unix)        │                  │
     │    ┌─────────────────────────────────────────────┐
     │    │ HostPanel · Node.js 24 · Fastify · SQLite   │──► MariaDB (socket)
     │    │ API REST + interfaz React                   │──► systemd · usuarios del sistema
     │    │ despliegues · copias · cron · analítica     │──► SSH/rsync a otros VPS
     │    │ colas · KV · NoSQL · certificados           │
     │    └─────────────────────────────────────────────┘
     │                             │ API interna 127.0.0.1:3001
     ▼                             ▼
  estáticos · PHP-FPM (un pool    Workers (un proceso aislado por Worker)
  por sitio) · Node.js (unidad    bindings: SQL, NoSQL, KV,
  systemd por sitio)              almacenamiento y colas
```

### Componentes

| Servicio | Qué se usa | De dónde sale | Para qué |
|---|---|---|---|
| **Web y proxy** | [Caddy 2](https://caddyserver.com) con los módulos `coraza-caddy` y `caddy-ratelimit` | Binario oficial de caddyserver.com → `/usr/local/bin/caddy` | Sirve todos los dominios, SSL, WAF, rate limit, proxy inverso, balanceadores, HTTP/3, caché y compresión zstd/gzip |
| **Certificados SSL** | Let's Encrypt (ACME) gestionado por Caddy | — | Un certificado por dominio, emitido al vincularlo y renovado solo cuando le queda un tercio de vida |
| **WAF** | [Coraza](https://coraza.io) + OWASP Core Rule Set | Dentro de Caddy | Bloquea inyecciones SQL, XSS, escaneos… con modo detección o bloqueo por dominio |
| **DNS** | [PowerDNS Authoritative](https://www.powerdns.com) con backend SQLite y DNSSEC | apt `pdns-server` + `pdns-backend-sqlite3` | DNS autoritativo de todos los dominios (`ns1`/`ns2.<dominio>`), editado por su API HTTP en `127.0.0.1:8081` |
| **Correo** | [Stalwart Mail Server](https://stalw.art) con almacén RocksDB | Binario oficial de GitHub → `/opt/stalwart` | SMTP (25, 465, 587), IMAP (993), ManageSieve (4190), DKIM/SPF/DMARC, antispam, filtros y respuestas automáticas |
| **Webmail** | [Roundcube](https://roundcube.net) con SQLite | Tarball oficial → `/var/www/roundcube` | `webmail.<dominio>` para todos los dominios con correo |
| **Bases de datos SQL** | MariaDB | apt `mariadb-server` | Una base de datos con su propio usuario por proyecto; consola, API HTTP y acceso remoto por IP |
| **Bases de datos NoSQL** | SQLite (`node:sqlite`), un archivo por base de datos | Incluido en el panel | Documentos JSON por colección con filtros, índices y API |
| **Almacenamiento de objetos** | Carpetas en disco (`/srv/hostpanel/storage`) | Incluido en el panel | Buckets públicos o privados, servidos por Caddy en su propio dominio o por API con token |
| **PHP** | PHP-FPM 7.4 → 8.5 | Repositorio de Ondřej Surý | Un pool aislado por sitio (su usuario, `open_basedir`, sus ajustes); varias versiones a la vez. Incluye Composer y WP-CLI |
| **Node.js** | Node 24 para el panel; cualquier versión para los sitios | NodeSource; versiones extra en `/opt/nodejs/<versión>` | Ejecuta el panel, compila los sitios y sirve las apps Node |
| **Workers** | Runtime propio compatible con la API de Cloudflare Workers (`panel/runtime/worker-host.mjs`) | Incluido en el panel | Funciones JavaScript con rutas, subdominio, crons, colas y bindings |
| **Colas y KV** | Tablas en la base de datos del panel | Incluido en el panel | Mensajería entre Workers y almacén clave-valor con caducidad |
| **SFTP** | OpenSSH `internal-sftp` con chroot | Sistema | Cuentas que solo ven la carpeta de su sitio, sin consola |
| **Seguridad del sistema** | ufw, fail2ban, unattended-upgrades, BBR | apt | Cortafuegos, bloqueo de ataques a SSH, parches automáticos y red optimizada |

### El panel por dentro

- **Backend** (`panel/api`): Node.js 24 ejecuta TypeScript directamente (sin compilar), con **Fastify 5**, validación con
  **Zod** y **SQLite** nativo (`node:sqlite`) en `/var/lib/hostpanel/hostpanel.db`. Escucha solo en `127.0.0.1:3000`;
  Caddy lo publica en el puerto **2087** y, si hay dominio, en `panel.<dominio>`.
- **Frontend** (`panel/web`): **React 19**, **Vite**, **Tailwind CSS 4**, **TanStack Query** y **React Router 7**. Cada
  página se descarga al visitarla por primera vez.
- **Caddy se configura entero desde el panel**: el panel genera su configuración JSON a partir de la base de datos y la
  carga por la API de administración, que solo escucha en un socket unix accesible para root. Si Caddy rechaza un cambio,
  se mantiene la configuración anterior.
- **Tareas largas** (instalar PHP o Node.js, actualizaciones, copias, restauraciones) corren como trabajos en segundo
  plano con su registro visible en **Sistema → Historial de tareas**.
- **Programadores internos**: crons de Workers y de sitios (cada minuto, en UTC), copias automáticas (cada 10 minutos
  comprueba cuáles tocan), entrega de colas, limpieza de KV, actualizaciones nocturnas opcionales y copia del
  certificado de `mail.<dominio>` a Stalwart (cada hora).
- **Analítica**: Caddy escribe un registro de accesos en JSON (`/var/log/hostpanel/access.log`); el panel lo lee
  continuamente y lo agrupa por dominio y hora.

### Cómo se publica un sitio

1. **Origen**: un repositorio Git (clonado en una *release* nueva), WordPress instalado con WP-CLI, o archivos subidos
   desde el panel o por SFTP.
2. **Compilación** en este servidor, como el usuario Linux del sitio (`hp-<id>`), con su versión de Node.js:
   `npm ci`/`composer install` y el comando de build.
3. **Publicación sin cortes**:
   - **Estáticos y PHP**: el enlace `current` pasa de forma atómica a la nueva release y PHP-FPM se recarga.
   - **Node.js**: la nueva versión arranca en el otro puerto (*blue/green*); el tráfico cambia solo cuando responde y la
     anterior se detiene después.
4. Si algo falla, la versión anterior sigue sirviendo. Se guardan las últimas 5 releases para volver atrás con un clic.

Cada sitio vive en `/srv/hostpanel/sites/<id>/`:

```
releases/<fecha>-<n>/   versiones desplegadas
current → releases/…    lo que se sirve
shared/                 archivos persistentes (subidas, .env); no se toca al desplegar
home/ · tmp/            casa y temporales del usuario del sitio (sesiones PHP, registro de errores)
```

### Varios servidores

Este servidor actúa siempre como **entrada**: termina el SSL, aplica el WAF y la analítica, y reparte el tráfico.
Los VPS añadidos con `node-install.sh` ejecutan Caddy como origen interno en el puerto **8443** (TLS con una CA
interna, abierto solo para la IP del panel), PHP-FPM y Node.js. El código se compila aquí y se copia por SSH/rsync.

### Dónde está cada cosa

| Ruta | Contenido |
|---|---|
| `/opt/hostpanel` | Código del panel |
| `/etc/hostpanel/hostpanel.env` | Configuración (dominio, IP, email para SSL, claves internas) |
| `/var/lib/hostpanel/` | Base de datos del panel, bases NoSQL (`nosql/`) y copias de seguridad (`backups/site-<id>/`) |
| `/srv/hostpanel/sites/` · `storage/` · `workers/` | Sitios, buckets de almacenamiento y Workers |
| `/var/log/hostpanel/` | Registro de accesos (analítica) y de certificados (`caddy-tls.log`) |
| `/var/lib/caddy/` | Certificados SSL de Caddy |
| `/var/lib/powerdns/pdns.sqlite3` | Zonas DNS |
| `/opt/stalwart/` | Servidor de correo (buzones en `data/`) |
| `/var/www/roundcube` | Webmail |

### Puertos abiertos

| Puerto | Servicio |
|---|---|
| 22 (o el tuyo) | SSH y SFTP |
| 80, 443 (TCP y UDP) | Web, HTTP/3 y validación de Let's Encrypt |
| 2087 | Panel de control |
| 53 (TCP y UDP) | DNS |
| 25, 465, 587 | Envío y recepción de correo |
| 993 | IMAP |
| 4190 | ManageSieve (filtros de correo) |
| 3306 | MariaDB, cerrado salvo para las IPs que autorices en el acceso remoto de una base de datos |

Los servicios internos (API del panel, API de PowerDNS, administración de Stalwart y de Caddy, Workers) solo escuchan
en `127.0.0.1` o en sockets unix.

## Varios servidores y balanceo de carga

1. **Servidores → Añadir servidor** muestra un comando; ejecútalo como root en un VPS limpio (Ubuntu 22.04/24.04 o Debian 12/13).
   Instala Caddy, PHP y Node.js, autoriza la clave SSH del panel y abre el puerto 8443 solo para la IP del panel.
2. Añade el VPS con su IP y pulsa **Comprobar**.
3. En la configuración de cada sitio elige en qué servidores se ejecuta. El código se compila en el panel y se copia a
   cada servidor; si eliges varios, el panel reparte el tráfico entre ellos y retira los que no responden.

Para quitar el nodo de un VPS: `sudo bash node-install.sh --uninstall`.

## Workers, colas y KV

En **Aplicaciones → Workers → Crear Worker** elige una plantilla (API JSON con SQL o con NoSQL, contador KV, productor o
consumidor de cola, cron, servidor de archivos…). El código usa la misma API que Cloudflare Workers:

```js
export default {
  async fetch(request, env, ctx) {
    const { results } = await env.DB.prepare('SELECT * FROM productos WHERE precio < ?').bind(20).all();
    await env.QUEUE.send({ visto: Date.now() });
    return Response.json(results);
  },
  async queue(batch, env, ctx) { for (const m of batch.messages) m.ack(); },
  async scheduled(event, env, ctx) { console.log('cron', event.cron); },
};
```

- **Bindings** (Configuración del Worker): base de datos SQL (`env.DB.prepare(…)`), base de datos NoSQL (`env.DOCS.collection('pedidos').find({…})`), KV (`env.KV`), almacenamiento (`env.BUCKET`) y colas (`env.QUEUE`), más variables y secretos cifrados.
- **Disparadores**: subdominio `nombre.workers.tu-dominio` (registro `*.workers` creado automáticamente si el dominio usa el DNS del panel), rutas en tus dominios (`ejemplo.com/api/*`, tienen prioridad sobre el sitio) y crons en UTC.
- **Despliegue seguro**: se comprueba la sintaxis y, si la nueva versión no arranca, sigue funcionando la anterior. Historial de versiones con vuelta atrás.
- **Aislamiento**: cada Worker es un proceso con su propio usuario, solo puede leer su carpeta (modelo de permisos de Node), no puede lanzar programas ni usar sockets locales, y tiene límites de memoria y CPU. Sus bindings pasan por una API interna que solo da acceso a los recursos asignados.

## Almacenamiento y bases de datos por API

```bash
# Subir un archivo a un bucket
curl -X PUT -H "Authorization: Bearer $TOKEN" --data-binary @foto.jpg https://panel.midominio.com/api/storage/v1/imagenes/foto.jpg

# Consultar una base de datos SQL
curl -X POST https://panel.midominio.com/api/sql/v1/tienda/query -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"sql":"SELECT * FROM productos WHERE precio < ?","params":[20]}'

# Buscar en una base de datos NoSQL: /api/nosql/v1/<bd>/<colección>/<operación>
curl -X POST https://panel.midominio.com/api/nosql/v1/tienda/pedidos/find -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"filter":{"total":{"$gt":50}},"sort":{"total":-1},"limit":10}'
```

Los tokens se crean en cada bucket o base de datos (pestaña **API**). Operaciones NoSQL: `get`, `find`, `findOne`,
`count`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`.

## Versiones de Node.js

Cada sitio Node (y cada build que usa `npm`, `yarn`, `pnpm`…) elige su versión en **Configuración → Versión de Node.js**:
una exacta (`22.11.0`), la última de una rama (`22`), la del sistema o **siempre la última instalada** (por defecto).
Se detectan las versiones en `/opt/nodejs/<versión>`, las de `n` y `nvm` en `/usr/local` y el `node` del sistema.

Instalar una versión a mano:

```bash
curl -fsSLO https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz
sudo mkdir -p /opt/nodejs/22.11.0
sudo tar -xJf node-v22.11.0-linux-x64.tar.xz -C /opt/nodejs/22.11.0 --strip-components=1
```

También se pueden instalar desde **Sistema → Node.js** (binarios oficiales verificados con SHA-256). El panel no las
actualiza solo: instala la nueva versión y, cuando ningún sitio dependa de la vieja, elimínala. Al cambiar de versión, el
sitio se vuelve a compilar (si tiene repositorio) o se reinicia con la nueva.

## Despliegue automático desde GitHub

1. **Sitios web → Nuevo sitio**: dominios, tipo, URL del repo, rama y comandos (hay plantillas para Vite, Astro, Laravel, WordPress, Next.js, Express).
2. En la pestaña **Webhook GitHub** del sitio están la *Payload URL* y el *Secret*; pégalos en
   GitHub → Settings → Webhooks (content type `application/json`, evento *push*).
3. Cada push a la rama despliega una nueva release. Si falla, la versión anterior sigue sirviendo.
   Desde el historial puedes volver a cualquiera de las últimas 5 versiones.

Las apps Node deben escuchar en `process.env.PORT`.

## Desarrollo local

Cualquier sistema operativo con Node 24. En modo desarrollo (`HP_DEV=1`) los comandos del sistema
solo se registran y DNS/correo se simulan en memoria; usuario `admin`, contraseña `admin`.

```bash
cd panel/api && npm install
cd ../web && npm install && npm run build
cd ../.. && HP_DEV=1 HP_DATA_DIR=.dev-data HP_LOG_DIR=.dev-data HP_SITES_DIR=.dev-data/sites node panel/api/src/index.ts
```

Para trabajar en la interfaz con recarga en caliente: `cd panel/web && npm run dev` (abre http://localhost:5173).

## Estructura

```
install.sh / uninstall.sh   Instalador y desinstalador
node-install.sh             Prepara un VPS como nodo de despliegue
scripts/hostpanel           CLI (se instala en /usr/local/bin)
scripts/hp-update           Actualizador del panel y sus componentes
templates/                  Configuración inicial de Caddy, PowerDNS, Stalwart, Roundcube y unidades systemd
panel/api                   Backend: Node 24 + Fastify 5 + Zod + SQLite (TypeScript nativo)
panel/web                   Frontend: React 19 + Vite + Tailwind 4 + TanStack Query
panel/runtime               Proceso aislado que ejecuta cada Worker
```
