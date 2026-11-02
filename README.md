# HostPanel

Panel de hosting tipo **cPanel / Webmin** con funciones tipo **Cloudflare**, instalado de forma
**nativa** (sin Docker) con un solo comando.

- **WordPress en un clic** (base de datos, administrador y SSL; sin GitHub)
- Sitios **estáticos, PHP y Node.js** con despliegue automático desde **GitHub** (webhook firmado, rollback, sin caídas)
- **Multidominio** con **DNS** propio (PowerDNS) y editor de registros
- **Correo** para todos los dominios (Stalwart: SMTP, IMAP, DKIM, SPF, DMARC, antispam) + **webmail** (Roundcube)
- **Proxy inverso gráfico** (Caddy): rutas, balanceo, redirecciones y **SSL automático**
- **WAF** OWASP CRS (Coraza), rate limit, reglas de IP, bloqueo de bots y **modo "bajo ataque"**
- **Bases de datos** MariaDB con consola SQL y **API HTTP estilo D1**, copias y acceso remoto
- **Workers** (API de Cloudflare Workers): editor en el navegador, rutas `dominio.com/api/*`, subdominio `nombre.workers.tu-dominio`, crons, logs en vivo, métricas y versiones
- **Colas** estilo Cloudflare Queues: lotes, reintentos, cola de fallidos, productores por Worker o HTTP y consumidores Worker o *pull*
- **KV**: almacén clave-valor con caducidad para los Workers
- **Almacenamiento estilo R2**: buckets con dominio propio, CDN, CORS y API con tokens
- **Varios servidores**: despliega en otros VPS y **balancea la carga** entre ellos
- **Varias versiones de PHP** (7.4 → 8.5) por sitio, instalables desde el panel y con avisos de cada parche (8.5.10 → 8.5.12)
- **Actualizador** del panel y de todos los componentes, con actualizaciones nocturnas opcionales
- **2FA**, sesiones, restricción de IPs del panel, fail2ban, **analítica** de tráfico en vivo, auditoría

Detalles de arquitectura y hoja de ruta en [PLAN.md](PLAN.md).

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

## Varios servidores y balanceo de carga

1. **Servidores → Añadir servidor** muestra un comando; ejecútalo como root en un VPS limpio (Ubuntu 22.04/24.04 o Debian 12/13).
   Instala Caddy, PHP y Node.js, autoriza la clave SSH del panel y abre el puerto 8443 solo para la IP del panel.
2. Añade el VPS con su IP y pulsa **Comprobar**.
3. En la configuración de cada sitio elige en qué servidores se ejecuta. El código se compila en el panel y se copia a
   cada servidor; si eliges varios, el panel reparte el tráfico entre ellos y retira los que no responden.

Para quitar el nodo de un VPS: `sudo bash node-install.sh --uninstall`.

## Workers, colas y KV

En **Workers y datos → Workers → Crear Worker** elige una plantilla (API con D1, contador KV, productor o consumidor de
cola, cron, servidor de archivos R2…). El código usa la misma API que Cloudflare:

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

- **Bindings** (Configuración del Worker): bases de datos (`env.DB`), KV (`env.KV`), buckets (`env.BUCKET`) y colas (`env.QUEUE`), más variables y secretos cifrados.
- **Disparadores**: subdominio `nombre.workers.tu-dominio` (registro `*.workers` creado automáticamente si el dominio usa el DNS del panel), rutas en tus dominios (`ejemplo.com/api/*`, tienen prioridad sobre el sitio) y crons en UTC.
- **Despliegue seguro**: se comprueba la sintaxis y, si la nueva versión no arranca, sigue funcionando la anterior. Historial de versiones con vuelta atrás.
- **Aislamiento**: cada Worker es un proceso con su propio usuario, solo puede leer su carpeta (modelo de permisos de Node), no puede lanzar programas ni usar sockets locales, y tiene límites de memoria y CPU. Sus bindings pasan por una API interna que solo da acceso a los recursos asignados.

## Almacenamiento y bases de datos por API

```bash
# Subir un archivo a un bucket
curl -X PUT -H "Authorization: Bearer $TOKEN" --data-binary @foto.jpg https://panel.midominio.com/api/storage/v1/imagenes/foto.jpg

# Consultar una base de datos (estilo D1)
curl -X POST https://panel.midominio.com/api/d1/v1/tienda/query -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"sql":"SELECT * FROM productos WHERE precio < ?","params":[20]}'
```

Los tokens se crean en cada bucket o base de datos (pestaña **API**).

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
templates/                  Configuración de PowerDNS, Stalwart, Roundcube y unidades systemd
panel/api                   Backend: Node 24 + Fastify 5 + Zod + SQLite (TypeScript nativo)
panel/web                   Frontend: React 19 + Vite + Tailwind 4 + TanStack Query
```
