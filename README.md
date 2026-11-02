# HostPanel

Panel de hosting tipo **cPanel / Webmin** con funciones tipo **Cloudflare**, instalado de forma
**nativa** (sin Docker) con un solo comando.

- Sitios **estáticos, PHP y Node.js** con despliegue automático desde **GitHub** (webhook firmado, rollback, sin caídas)
- **Multidominio** con **DNS** propio (PowerDNS) y editor de registros
- **Correo** para todos los dominios (Stalwart: SMTP, IMAP, DKIM, SPF, DMARC, antispam) + **webmail** (Roundcube)
- **Proxy inverso gráfico** (Caddy): rutas, balanceo, redirecciones y **SSL automático**
- **WAF** OWASP CRS (Coraza), rate limit, reglas de IP, bloqueo de bots y **modo "bajo ataque"**
- **Bases de datos** MariaDB, **analítica** de tráfico en vivo, auditoría

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
| `hostpanel update` | Actualiza a la última versión conservando los datos |
| `hostpanel info` | URLs y configuración |

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
scripts/hostpanel           CLI (se instala en /usr/local/bin)
templates/                  Configuración de PowerDNS, Stalwart, Roundcube y unidades systemd
panel/api                   Backend: Node 24 + Fastify 5 + Zod + SQLite (TypeScript nativo)
panel/web                   Frontend: React 19 + Vite + Tailwind 4 + TanStack Query
```
