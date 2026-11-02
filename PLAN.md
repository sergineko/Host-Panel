# HostPanel — Plan de creación

Panel de hosting estilo **cPanel / Webmin** con funciones tipo **Cloudflare** (DNS, proxy inverso, WAF,
rate limiting, modo "bajo ataque", analítica). Instalación **nativa** (sin Docker) en un VPS limpio con
**un comando para instalar** y **otro para desinstalar**.

```bash
# Instalar (Ubuntu 22.04/24.04 o Debian 12, como root)
curl -fsSL https://raw.githubusercontent.com/sergineko/Host-Panel/main/install.sh | sudo bash

# Desinstalar
sudo hostpanel uninstall
```

---

## 1. Arquitectura

Todos los servicios se instalan como paquetes/binarios nativos gestionados por **systemd**.
El panel es el "cerebro": guarda su estado en SQLite y empuja la configuración a cada servicio por su API local.

```
                     Internet
     80/443 (web)    2087 (panel)    53 (DNS)    25/465/587/993 (correo)
          │              │              │                 │
          ▼              ▼              ▼                 ▼
   ┌─────────────────────────┐   ┌──────────┐     ┌──────────────┐
   │ Caddy + Coraza WAF      │   │ PowerDNS │     │  Stalwart     │
   │ + rate limit (SSL auto) │   │ (SQLite) │     │ SMTP/IMAP/    │
   └──┬─────┬──────┬─────┬───┘   └────▲─────┘     │ DKIM/antispam │
      │     │      │     │  admin API │ API        └──────▲───────┘
      │     │      │     └──────────┐ │                   │ API
      │     │      │            ┌───┴─┴───────────────────┴──┐
      │     │      │            │ HostPanel (Node 24)         │
      │     │      │            │ Fastify API + React SPA     │──► MariaDB (socket)
      │     │      │            │ SQLite · cola de despliegues│──► systemd / useradd
      │     │      │            └─────────────────────────────┘
      ▼     ▼      ▼
 estáticos  PHP-FPM   Apps Node.js
 (ficheros) (pool por (unidad systemd por sitio,
            sitio)     blue/green sin caídas)
```

| Componente | Origen | Función |
|---|---|---|
| **HostPanel** | este repo → `/opt/hostpanel` | API REST + interfaz web, webhooks GitHub, despliegues |
| **Caddy** | binario oficial con módulos `coraza-caddy` y `caddy-ratelimit` | Proxy inverso, SSL automático, WAF OWASP CRS, rate limit |
| **PowerDNS Authoritative** | apt `pdns-server` + `pdns-backend-sqlite3` | DNS multidominio con API |
| **Stalwart Mail** | binario oficial → `/opt/stalwart` | SMTP, IMAP, JMAP, DKIM, SPF/DMARC, antispam |
| **Roundcube** | tarball oficial → `/var/www/roundcube` | Webmail para todos los dominios |
| **MariaDB** | apt `mariadb-server` | Bases de datos de los sitios |
| **PHP-FPM** | apt `php-fpm` + extensiones | Sitios PHP (WordPress, Laravel…), un pool aislado por sitio |
| **Node.js 24** | NodeSource | Ejecuta el panel, compila y sirve sitios Node |

### Stack del panel
- **Backend**: Node.js 24 (TypeScript ejecutado nativamente, sin paso de compilación), **Fastify 5**, **Zod**, `node:sqlite`.
- **Frontend**: **React 19**, **Vite**, **Tailwind CSS 4**, **TanStack Query**, **React Router 7**, Lucide icons.

### Decisiones clave
- **El panel genera la configuración completa de Caddy en JSON** y la carga por la API de administración
  (`POST /load`): el proxy inverso es 100 % gráfico y los cambios son atómicos (si Caddy la rechaza, sigue la anterior).
- **Aislamiento por sitio** (como cPanel): cada sitio tiene su usuario Linux `hp-<id>`, su pool PHP-FPM o su
  unidad systemd con `ProtectSystem=strict`, `NoNewPrivileges` y límite de memoria.
- **Despliegues atómicos**: cada despliegue va a `releases/<id>`; los sitios estáticos/PHP cambian el enlace
  `current`; los sitios Node usan *blue/green* (arranca el nuevo, se comprueba, se cambia el tráfico, se para el viejo).
- **Fuentes de verdad**: el DNS vive en PowerDNS y los buzones en Stalwart; el panel guarda dominios, sitios,
  reglas de seguridad, despliegues y analítica.
- **Servicios internos solo en 127.0.0.1** (APIs de Caddy, PowerDNS, Stalwart, panel). Hacia fuera solo
  80/443, 2087, 53 y los puertos de correo (UFW).

---

## 2. Módulos y fases

### Fase 1 — Núcleo (esta entrega)
| Módulo | Funcionalidad |
|---|---|
| **Instalador** | `install.sh`: paquetes, usuarios, configuración de cada servicio, secretos, firewall, arranque |
| **Desinstalador** | `hostpanel uninstall`: para y elimina servicios, ficheros y (opcional) datos |
| **CLI `hostpanel`** | `status`, `restart`, `logs`, `reset-password`, `update`, `uninstall` |
| **Autenticación** | Login, sesión en cookie HttpOnly, scrypt, bloqueo por intentos, auditoría |
| **Dominios + DNS** | Multidominio; zona creada con registros por defecto; editor A/AAAA/CNAME/MX/TXT/SRV/CAA/NS |
| **Sitios** | Estático (con SPA), PHP, Node.js. Repo Git, rama, install/build/start, variables de entorno |
| **Despliegue automático** | Webhook de GitHub con firma HMAC-SHA256, filtro por rama, logs en vivo, rollback |
| **Proxy inverso** | Rutas host[/ruta] → upstream(s), balanceo, TLS a backend, cabecera Host |
| **Redirecciones** | host/ruta → destino 301/302 conservando ruta opcionalmente |
| **SSL** | Automático (Let's Encrypt) para todos los hosts; certificado interno para el acceso por IP |
| **Seguridad (WAF)** | Por dominio: Coraza + OWASP CRS (detectar/bloquear, paranoia 1-4), rate limit, reglas IP/CIDR, bloqueo de bots/escáneres, modo "bajo ataque" (reto JS), cabeceras de seguridad, HSTS, compresión |
| **Correo** | Activar por dominio → crea DKIM y publica MX/SPF/DKIM/DMARC en el DNS; buzones, alias, cuotas, webmail |
| **Bases de datos** | Crear/borrar BD + usuario MariaDB con contraseña generada |
| **Analítica** | Peticiones, tráfico, errores y bloqueos por dominio + log en vivo |
| **Sistema** | CPU, RAM, disco, estado de servicios |

### Fase 2 — Paridad cPanel
Gestor de archivos, SFTP por sitio, cron por sitio, copias de seguridad (local/S3), 2FA TOTP,
multiusuario con roles y cuotas, phpMyAdmin con SSO, versiones múltiples de PHP.

### Fase 3 — Paridad Cloudflare
Caché en el borde con purga, bloqueo por país (GeoIP), certificados wildcard por DNS-01 contra PowerDNS,
DNSSEC con un clic, páginas de error personalizadas, notificaciones de ataques y despliegues.

---

## 3. Estructura del repositorio

```
install.sh                  Instalador de un comando (también descarga el repo si se usa con curl)
uninstall.sh                Desinstalador
scripts/hostpanel           CLI que se instala en /usr/local/bin
templates/                  Configuraciones de PowerDNS, Stalwart, Roundcube y unidades systemd
panel/api/                  Backend Fastify (TypeScript)
  src/services/             caddy, dns, mail, system, deploy, databases, analytics
  src/routes/               endpoints REST
panel/web/                  Frontend React
```

## 4. Rutas en el servidor
| Ruta | Contenido |
|---|---|
| `/opt/hostpanel` | Código del panel |
| `/etc/hostpanel/hostpanel.env` | Configuración y secretos (0600) |
| `/var/lib/hostpanel` | Base de datos SQLite del panel |
| `/srv/hostpanel/sites/<id>` | `releases/`, `current` y `shared/` de cada sitio |
| `/var/log/hostpanel` | Logs de acceso de Caddy |
