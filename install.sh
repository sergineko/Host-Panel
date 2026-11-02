#!/usr/bin/env bash
# =====================================================================================
#  HostPanel — instalador de un comando
#
#    curl -fsSL https://raw.githubusercontent.com/sergineko/Host-Panel/main/install.sh | sudo bash
#
#  Opciones (también como variables de entorno):
#    --domain midominio.com   Dominio principal (panel.*, mail.*, ns1.*, ns2.*)   HP_DOMAIN
#    --email  tu@correo.com   Email para Let's Encrypt                            HP_EMAIL
#    --yes                    Sin preguntas (usa valores por defecto)            HP_YES=1
#    --update                 Actualiza el panel conservando datos y secretos
#    --keep-code              No descarga código nuevo (para cambiar solo la configuración,
#                             por ejemplo el dominio principal desde el panel)       HP_KEEP_CODE=1
#
#  Sistemas soportados: Ubuntu 22.04 / 24.04, Debian 12 / 13 (x86_64 o arm64).
# =====================================================================================
set -Eeuo pipefail

HP_REPO="${HP_REPO:-https://github.com/sergineko/Host-Panel.git}"
HP_BRANCH="${HP_BRANCH:-main}"
ROUNDCUBE_FALLBACK=1.6.11
NODE_MAJOR=24
DEFAULT_PHP=8.4

APP_DIR=/opt/hostpanel
ETC_DIR=/etc/hostpanel
ENV_FILE=$ETC_DIR/hostpanel.env
DATA_DIR=/var/lib/hostpanel
SITES_DIR=/srv/hostpanel/sites
STORAGE_DIR=/srv/hostpanel/storage
WORKERS_DIR=/srv/hostpanel/workers
LOG_DIR=/var/log/hostpanel
INSTALL_LOG=/var/log/hostpanel-install.log

DOMAIN="${HP_DOMAIN:-}"
EMAIL="${HP_EMAIL:-}"
ASSUME_YES="${HP_YES:-0}"
UPDATE=0

# --- output helpers ------------------------------------------------------------------
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; O=$'\e[38;5;208m'; N=$'\e[0m'; else B='' G='' Y='' R='' O='' N=''; fi
STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s[%02d]%s %s%s%s\n' "$O" "$STEP" "$N" "$B" "$*" "$N"; }
info() { printf '     %s\n' "$*"; }
ok()   { printf '     %s✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '     %s!%s %s\n' "$Y" "$N" "$*"; }
die()  {
  printf '\n%s✖ %s%s\n' "$R" "$*" "$N" >&2
  printf '  Últimas líneas del log (%s):\n' "$INSTALL_LOG" >&2
  tail -n 15 "$INSTALL_LOG" 2>/dev/null | sed 's/^/    /' >&2 || true
  exit 1
}
trap 'die "Error en la línea $LINENO: $BASH_COMMAND"' ERR

# Runs a command quietly, appending its output to the install log.
q() { "$@" >>"$INSTALL_LOG" 2>&1; }
apt_install() {
  DEBIAN_FRONTEND=noninteractive q apt-get install -y --no-install-recommends \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

# ask "Pregunta" "por defecto" — reads from the terminal even when the script is piped.
ask() {
  local prompt=$1 default=$2 answer=''
  if [[ $ASSUME_YES != 1 ]] && (: </dev/tty) 2>/dev/null; then
    read -r -p "     $prompt ${default:+[$default] }" answer </dev/tty || true
  fi
  echo "${answer:-$default}"
}

rand() { local s; s=$(head -c 256 /dev/urandom | tr -dc 'A-Za-z0-9'); echo "${s:0:${1:-32}}"; }

# render <template> <destination>: replaces {{KEY}} using the TPL associative array.
declare -A TPL=()
render() {
  local content key
  content=$(<"$1")
  for key in "${!TPL[@]}"; do content=${content//"{{$key}}"/"${TPL[$key]}"}; done
  printf '%s\n' "$content" >"$2"
}

has_module() { local mods; mods=$(/usr/local/bin/caddy list-modules 2>/dev/null || true); grep -qx "$1" <<<"$mods"; }

# --- arguments -----------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN=${2:-}; shift 2 ;;
    --email) EMAIL=${2:-}; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --update) UPDATE=1; ASSUME_YES=1; shift ;;
    --keep-code) HP_KEEP_CODE=1; shift ;;
    *) die "Opción desconocida: $1" ;;
  esac
done

printf '\n%s%s  HostPanel%s — instalación nativa (sin Docker)\n' "$O" "$B" "$N"

# =====================================================================================
step "Comprobando el sistema"
if [[ $EUID -ne 0 ]]; then echo "Ejecuta el instalador como root (sudo)." >&2; exit 1; fi
mkdir -p "$(dirname "$INSTALL_LOG")"; : >"$INSTALL_LOG"
[[ -r /etc/os-release ]] || die "Sistema operativo no soportado."
# shellcheck disable=SC1091
. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ok "$PRETTY_NAME" ;;
  *) die "Sistema no soportado: ${PRETTY_NAME:-desconocido}. Usa Ubuntu 22.04/24.04 o Debian 12/13." ;;
esac
case "$(uname -m)" in
  x86_64) ARCH=amd64; STALWART_TRIPLE=x86_64-unknown-linux-gnu ;;
  aarch64|arm64) ARCH=arm64; STALWART_TRIPLE=aarch64-unknown-linux-gnu ;;
  *) die "Arquitectura no soportada: $(uname -m)" ;;
esac
ok "Arquitectura $ARCH"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( MEM_MB < 900 )); then warn "Solo hay ${MEM_MB} MB de RAM; se recomiendan 2 GB."; else ok "Memoria: ${MEM_MB} MB"; fi
for svc in apache2 nginx lighttpd; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    die "$svc está activo y ocupa los puertos 80/443. Usa un servidor limpio o desinstálalo antes."
  fi
done

# --- configuration -------------------------------------------------------------------
if [[ -f $ENV_FILE ]]; then
  # Reinstall / update: keep every secret and choice made the first time.
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  ok "Instalación existente: se conservan configuración, secretos y datos"
  PREVIOUS_DOMAIN=${HP_BASE_DOMAIN:-}
  DOMAIN=${DOMAIN:-${HP_BASE_DOMAIN:-}}
  EMAIL=${EMAIL:-${HP_ADMIN_EMAIL:-}}
  # New main domain (for example a server installed with only its IP): derive panel.*, mail.*,
  # ns1.* and ns2.* from it again instead of keeping the old names.
  if [[ -n ${DOMAIN:-} && ${DOMAIN,,} != "${PREVIOUS_DOMAIN,,}" ]]; then
    unset HP_PANEL_DOMAIN HP_MAIL_HOSTNAME HP_NS1 HP_NS2
    ok "Nuevo dominio principal: $DOMAIN"
  fi
elif [[ $UPDATE == 1 ]]; then
  die "No hay ninguna instalación que actualizar."
fi

PUBLIC_IP=$(curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 6 https://ifconfig.me 2>/dev/null || true)
if [[ ! $PUBLIC_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  PUBLIC_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)
fi
[[ $PUBLIC_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "No se pudo detectar la IP pública."
PUBLIC_IP6=$(curl -6 -fsS --max-time 4 https://api64.ipify.org 2>/dev/null || true)
[[ $PUBLIC_IP6 == *:* ]] || PUBLIC_IP6=''
ok "IP pública: $PUBLIC_IP${PUBLIC_IP6:+ · IPv6: $PUBLIC_IP6}"

if [[ -z $DOMAIN && ! -f $ENV_FILE ]]; then
  echo
  info "Dominio principal del servidor: se usará para panel.<dominio>, mail.<dominio>,"
  info "ns1.<dominio> y ns2.<dominio>. Déjalo vacío para usar solo la IP (sin correo)."
  DOMAIN=$(ask "Dominio principal:" "")
fi
DOMAIN=$(echo "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*##; s#^www\.##')
if [[ -n $DOMAIN && ! $DOMAIN =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]]; then die "Dominio no válido: $DOMAIN"; fi
if [[ -z $EMAIL ]]; then EMAIL=$(ask "Email para los certificados SSL:" "admin@${DOMAIN:-example.com}"); fi

FQDN=$(hostname -f 2>/dev/null || hostname)
if [[ -n $DOMAIN ]]; then
  PANEL_DOMAIN=${HP_PANEL_DOMAIN:-panel.$DOMAIN}
  MAIL_HOSTNAME=${HP_MAIL_HOSTNAME:-mail.$DOMAIN}
  NS1=${HP_NS1:-ns1.$DOMAIN}
  NS2=${HP_NS2:-ns2.$DOMAIN}
else
  PANEL_DOMAIN=${HP_PANEL_DOMAIN:-}
  MAIL_HOSTNAME=${HP_MAIL_HOSTNAME:-}
  NS1=${HP_NS1:-ns1.$FQDN}
  NS2=${HP_NS2:-ns2.$FQDN}
fi

SECRET=${HP_SECRET:-$(rand 48)}
PDNS_KEY=${HP_PDNS_KEY:-$(rand 40)}
STALWART_PASSWORD=${HP_STALWART_PASSWORD:-$(rand 32)}
ROUNDCUBE_KEY=${HP_ROUNDCUBE_KEY:-$(rand 24)}
FIRST_INSTALL=0
ADMIN_PASSWORD=''
if [[ ! -f $DATA_DIR/hostpanel.db ]]; then FIRST_INSTALL=1; ADMIN_PASSWORD=$(rand 16); fi
if [[ -f /proc/net/if_inet6 ]]; then ANY='[::]'; PDNS_LISTEN='0.0.0.0, ::'; else ANY='0.0.0.0'; PDNS_LISTEN='0.0.0.0'; fi
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)

# =====================================================================================
step "Paquetes base"
export DEBIAN_FRONTEND=noninteractive
q apt-get update
apt_install ca-certificates curl gnupg git acl ufw openssl sqlite3 unzip tar rsync jq cron logrotate iproute2 procps \
  openssh-client lsb-release fail2ban
ok "Paquetes base instalados"

# Network performance: BBR congestion control, bigger queues, TCP Fast Open.
cat >/etc/sysctl.d/90-hostpanel.conf <<'EOF'
# Generated by HostPanel.
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.ip_local_port_range = 10240 65000
fs.file-max = 2097152
vm.swappiness = 10
EOF
q sysctl --system || warn "No se pudieron aplicar todos los ajustes de red (normal en algunos contenedores)"

# Brute-force protection for SSH.
mkdir -p /etc/fail2ban/jail.d
cat >/etc/fail2ban/jail.d/hostpanel.conf <<'EOF'
# Generated by HostPanel.
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 6
backend = systemd

[sshd]
enabled = true
EOF
q systemctl enable fail2ban
q systemctl restart fail2ban || warn "fail2ban no arrancó"
ok "Red optimizada (BBR) y fail2ban para SSH"

# Free ports 25 and 53 from distro defaults.
for svc in exim4 postfix sendmail; do
  if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
    q systemctl disable --now "$svc" || true
    warn "$svc desactivado (Stalwart gestionará el correo)"
  fi
done
if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
  mkdir -p /etc/systemd/resolved.conf.d
  printf '[Resolve]\nDNSStubListener=no\nDNS=1.1.1.1 9.9.9.9\n' >/etc/systemd/resolved.conf.d/hostpanel.conf
  ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
  q systemctl restart systemd-resolved
  ok "Puerto 53 liberado (systemd-resolved sin stub local)"
fi

# =====================================================================================
step "Código de HostPanel"
if [[ ${HP_KEEP_CODE:-0} == 1 && -f $APP_DIR/panel/api/package.json ]]; then
  ok "Se mantiene el código instalado"
elif [[ -f $SCRIPT_DIR/panel/api/package.json && $SCRIPT_DIR != "$APP_DIR" ]]; then
  mkdir -p "$APP_DIR"
  rsync -a --delete --exclude node_modules --exclude dist --exclude .git "$SCRIPT_DIR/" "$APP_DIR/"
  ok "Copiado desde $SCRIPT_DIR"
elif [[ -d $APP_DIR/.git ]]; then
  q git -C "$APP_DIR" fetch --depth 1 origin "$HP_BRANCH"
  q git -C "$APP_DIR" reset --hard FETCH_HEAD
  ok "Actualizado a $(git -C "$APP_DIR" rev-parse --short HEAD)"
elif [[ ! -f $APP_DIR/panel/api/package.json ]]; then
  q git clone --depth 1 --branch "$HP_BRANCH" "$HP_REPO" "$APP_DIR" || die "No se pudo descargar $HP_REPO"
  ok "Descargado de $HP_REPO"
fi
T=$APP_DIR/templates

# =====================================================================================
step "Node.js $NODE_MAJOR"
NODE_OK=0
if command -v node >/dev/null && (( $(node -p 'process.versions.node.split(".")[0]') >= NODE_MAJOR )); then NODE_OK=1; fi
if [[ $NODE_OK == 0 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  q bash /tmp/nodesource_setup.sh
  rm -f /tmp/nodesource_setup.sh
  apt_install nodejs
fi
ok "Node $(node -v)"

# =====================================================================================
step "MariaDB"
apt_install mariadb-server mariadb-client
q systemctl enable --now mariadb
# Secure defaults: no anonymous users, no test database, root only via unix socket.
q mariadb -e "DELETE FROM mysql.global_priv WHERE User=''; DROP DATABASE IF EXISTS test; FLUSH PRIVILEGES;" || true
# Buffer pool sized to ~25 % of RAM (min 128 MB); the rest is for PHP, Node and the mail server.
BUFFER_MB=$(( MEM_MB / 4 )); (( BUFFER_MB < 128 )) && BUFFER_MB=128
cat >/etc/mysql/mariadb.conf.d/90-hostpanel.cnf <<EOF
# Generated by HostPanel.
[mysqld]
innodb_buffer_pool_size = ${BUFFER_MB}M
innodb_log_file_size = 128M
innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT
max_connections = 300
table_open_cache = 4000
tmp_table_size = 64M
max_heap_table_size = 64M
skip_name_resolve = ON
character_set_server = utf8mb4
collation_server = utf8mb4_unicode_ci
EOF
q systemctl restart mariadb
ok "MariaDB $(mariadb --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"

# =====================================================================================
step "PHP (varias versiones disponibles)"
# Repository with every maintained PHP version (Ondřej Surý), so the panel can install more.
if [[ $ID == ubuntu ]]; then
  apt_install software-properties-common
  q add-apt-repository -y ppa:ondrej/php
else
  curl -fsSL https://packages.sury.org/php/apt.gpg -o /usr/share/keyrings/sury-php.gpg
  echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" >/etc/apt/sources.list.d/sury-php.list
fi
q apt-get update
PHP_VERSION=${HP_PHP_VERSION:-$DEFAULT_PHP}
PHP_PKGS=()
for ext in fpm cli mysql sqlite3 gd intl mbstring xml zip curl bcmath opcache readline; do PHP_PKGS+=("php${PHP_VERSION}-${ext}"); done
apt_install "${PHP_PKGS[@]}"
for opt in imagick redis apcu; do apt_install "php${PHP_VERSION}-${opt}" || true; done
apt_install composer || warn "composer no disponible en los repositorios"
# WP-CLI: one-click WordPress installs from the panel.
if [[ ! -x /usr/local/bin/wp || $UPDATE == 1 ]]; then
  if curl -fsSL --retry 3 --max-time 120 https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o /tmp/wp-cli.phar \
    && php /tmp/wp-cli.phar --info >/dev/null 2>&1; then
    install -m 0755 /tmp/wp-cli.phar /usr/local/bin/wp
  else
    warn "No se pudo instalar WP-CLI: la instalación de WordPress en un clic no estará disponible"
  fi
  rm -f /tmp/wp-cli.phar
fi
for sapi in fpm cli; do
  cat >"/etc/php/$PHP_VERSION/$sapi/conf.d/99-hostpanel.ini" <<'EOF'
; Generated by HostPanel.
opcache.enable=1
opcache.memory_consumption=192
opcache.interned_strings_buffer=16
opcache.max_accelerated_files=20000
opcache.validate_timestamps=1
opcache.revalidate_freq=2
realpath_cache_size=4096K
realpath_cache_ttl=600
expose_php=Off
EOF
done
rm -f "/etc/php/$PHP_VERSION/fpm/pool.d/www.conf"
printf '; Generated by HostPanel: keeps FPM running when no site uses this version.\n[hp-idle]\nuser = nobody\ngroup = nogroup\nlisten = /run/php/hp-idle-%s.sock\npm = ondemand\npm.max_children = 1\n' "$PHP_VERSION" \
  >"/etc/php/$PHP_VERSION/fpm/pool.d/hp-idle.conf"
q systemctl enable --now "php${PHP_VERSION}-fpm"
q systemctl restart "php${PHP_VERSION}-fpm"
ok "PHP $PHP_VERSION (más versiones desde el panel: Sistema → PHP)"

# =====================================================================================
step "PowerDNS (DNS autoritativo)"
# Don't let the package start pdns with its default bind backend: we configure it first.
printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d
apt_install pdns-server pdns-backend-sqlite3 || { rm -f /usr/sbin/policy-rc.d; die "No se pudo instalar PowerDNS"; }
rm -f /usr/sbin/policy-rc.d
q systemctl stop pdns || true
rm -f /etc/powerdns/pdns.d/bind.conf
mkdir -p /var/lib/powerdns
if [[ ! -s /var/lib/powerdns/pdns.sqlite3 ]]; then
  SCHEMA=$(find /usr/share -name 'schema.sqlite3.sql' 2>/dev/null | head -1 || true)
  [[ -n $SCHEMA ]] || die "No se encontró el esquema SQLite de PowerDNS"
  sqlite3 /var/lib/powerdns/pdns.sqlite3 <"$SCHEMA"
fi
chown -R pdns:pdns /var/lib/powerdns
TPL=([PDNS_KEY]="$PDNS_KEY" [NS1]="$NS1" [PDNS_LISTEN]="$PDNS_LISTEN")
render "$T/pdns.conf" /etc/powerdns/pdns.conf
chown root:pdns /etc/powerdns/pdns.conf; chmod 0640 /etc/powerdns/pdns.conf
q systemctl enable pdns
q systemctl restart pdns || die "PowerDNS no arrancó. ¿Está ocupado el puerto 53? (ss -lunp | grep :53)"
ok "PowerDNS escuchando en el puerto 53"

# =====================================================================================
step "Caddy con WAF (Coraza + OWASP CRS) y rate limit"
id caddy >/dev/null 2>&1 || q useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
if [[ $UPDATE == 1 ]] || ! has_module http.handlers.waf || ! has_module http.handlers.rate_limit; then
  CADDY_URL="https://caddyserver.com/api/download?os=linux&arch=${ARCH}&p=github.com%2Fcorazawaf%2Fcoraza-caddy%2Fv2&p=github.com%2Fmholt%2Fcaddy-ratelimit"
  rm -f /tmp/caddy.new
  for attempt in 1 2 3; do
    if curl -fsSL --max-time 300 "$CADDY_URL" -o /tmp/caddy.new; then break; fi
    warn "Descarga de Caddy fallida (intento $attempt), reintentando…"; sleep 5
  done
  [[ -s /tmp/caddy.new ]] || die "No se pudo descargar Caddy con los módulos WAF."
  install -m 0755 /tmp/caddy.new /usr/local/bin/caddy; rm -f /tmp/caddy.new
fi
has_module http.handlers.waf || die "El binario de Caddy no incluye el módulo WAF"
mkdir -p /etc/caddy "$LOG_DIR"
cp "$T/caddy-bootstrap.json" /etc/caddy/bootstrap.json
chown caddy:caddy "$LOG_DIR"; chmod 0750 "$LOG_DIR"
cp "$T/systemd/caddy.service" /etc/systemd/system/caddy.service
q systemctl daemon-reload
q systemctl enable caddy
q systemctl restart caddy
ok "Caddy $(/usr/local/bin/caddy version | awk '{print $1}') con módulos waf y rate_limit"

# =====================================================================================
if [[ -n $MAIL_HOSTNAME ]]; then
  step "Servidor de correo (Stalwart)"
  id stalwart >/dev/null 2>&1 || q useradd --system --user-group --home-dir /opt/stalwart --shell /usr/sbin/nologin stalwart
  mkdir -p /opt/stalwart/{bin,etc/certs,data,logs}
  if [[ $UPDATE == 1 || ! -x /opt/stalwart/bin/stalwart ]]; then
    curl -fsSL --max-time 300 "https://github.com/stalwartlabs/stalwart/releases/latest/download/stalwart-${STALWART_TRIPLE}.tar.gz" -o /tmp/stalwart.tgz \
      || die "No se pudo descargar Stalwart"
    tar -xzf /tmp/stalwart.tgz -C /opt/stalwart/bin; rm -f /tmp/stalwart.tgz
    if [[ -f /opt/stalwart/bin/stalwart-mail && ! -f /opt/stalwart/bin/stalwart ]]; then mv /opt/stalwart/bin/stalwart-mail /opt/stalwart/bin/stalwart; fi
    chmod 0755 /opt/stalwart/bin/stalwart
  fi
  if [[ ! -s /opt/stalwart/etc/certs/mail.crt ]]; then
    q openssl req -x509 -newkey rsa:2048 -nodes -days 90 -subj "/CN=$MAIL_HOSTNAME" \
      -keyout /opt/stalwart/etc/certs/mail.key -out /opt/stalwart/etc/certs/mail.crt
  fi
  TPL=([MAIL_HOSTNAME]="$MAIL_HOSTNAME" [STALWART_PASSWORD]="$STALWART_PASSWORD" [ANY]="$ANY")
  render "$T/stalwart.toml" /opt/stalwart/etc/config.toml
  chown -R stalwart:stalwart /opt/stalwart
  chmod 0600 /opt/stalwart/etc/config.toml /opt/stalwart/etc/certs/mail.key
  cp "$T/systemd/stalwart.service" /etc/systemd/system/stalwart.service
  q systemctl daemon-reload
  q systemctl enable stalwart
  q systemctl restart stalwart
  for _ in $(seq 1 30); do curl -sS -o /dev/null http://127.0.0.1:8080/ 2>/dev/null && break; sleep 1; done
  if curl -sS -o /dev/null http://127.0.0.1:8080/ 2>/dev/null; then ok "Stalwart en marcha"; else warn "Stalwart no responde aún: journalctl -u stalwart"; fi

  ROUNDCUBE_VERSION=$(curl -fsSL --max-time 10 https://api.github.com/repos/roundcube/roundcubemail/releases/latest 2>/dev/null | jq -r '.tag_name // empty' || true)
  ROUNDCUBE_VERSION=${ROUNDCUBE_VERSION:-$ROUNDCUBE_FALLBACK}
  step "Webmail (Roundcube $ROUNDCUBE_VERSION)"
  id hp-roundcube >/dev/null 2>&1 || q useradd --system --user-group --home-dir /var/lib/roundcube --shell /usr/sbin/nologin hp-roundcube
  if [[ ! -f /var/www/roundcube/index.php || $UPDATE == 1 ]]; then
    if curl -fsSL --max-time 180 "https://github.com/roundcube/roundcubemail/releases/download/${ROUNDCUBE_VERSION}/roundcubemail-${ROUNDCUBE_VERSION}-complete.tar.gz" -o /tmp/roundcube.tgz; then
      mkdir -p /var/www/roundcube
      tar -xzf /tmp/roundcube.tgz -C /var/www/roundcube --strip-components=1; rm -f /tmp/roundcube.tgz
    else
      warn "No se pudo descargar Roundcube; el webmail no estará disponible."
    fi
  fi
  if [[ -f /var/www/roundcube/index.php ]]; then
    mkdir -p /var/lib/roundcube/temp /var/lib/roundcube/logs
    TPL=([ROUNDCUBE_KEY]="$ROUNDCUBE_KEY")
    render "$T/roundcube.config.inc.php" /var/www/roundcube/config/config.inc.php
    rm -rf /var/www/roundcube/installer
    chown -R root:hp-roundcube /var/www/roundcube; chmod -R g+rX,o-rwx /var/www/roundcube
    setfacl -R -m u:caddy:rX /var/www/roundcube
    chown -R hp-roundcube:hp-roundcube /var/lib/roundcube
    if [[ ! -s /var/lib/roundcube/roundcube.db ]]; then
      q runuser -u hp-roundcube -- php /var/www/roundcube/bin/initdb.sh --dir=/var/www/roundcube/SQL || warn "No se pudo inicializar la BD de Roundcube"
    else
      q runuser -u hp-roundcube -- php /var/www/roundcube/bin/updatedb.sh --package=roundcube --dir=/var/www/roundcube/SQL || true
    fi
    cp "$T/roundcube-pool.conf" "/etc/php/$PHP_VERSION/fpm/pool.d/hp-roundcube.conf"
    q systemctl reload "php${PHP_VERSION}-fpm"
    ok "Webmail preparado en https://$MAIL_HOSTNAME"
  fi
else
  warn "Sin dominio principal: se omite el correo. Reinstala con --domain para activarlo."
fi

# =====================================================================================
step "Panel de control"
mkdir -p "$ETC_DIR" "$DATA_DIR" "$SITES_DIR" "$STORAGE_DIR" "$WORKERS_DIR"
chmod 0700 "$ETC_DIR" "$DATA_DIR"; chmod 0755 /srv/hostpanel "$SITES_DIR"; chmod 0751 "$STORAGE_DIR"
# Each Worker has its own 0750 folder; the parent only allows traversal.
chmod 0711 "$WORKERS_DIR"
setfacl -m u:caddy:x "$STORAGE_DIR"
cat >"$ENV_FILE" <<EOF
# HostPanel — generado por el instalador el $(date -u +%FT%TZ). Contiene secretos: no lo compartas.
HP_BASE_DOMAIN=$DOMAIN
HP_PANEL_DOMAIN=$PANEL_DOMAIN
HP_PANEL_PORT=2087
HP_MAIL_HOSTNAME=$MAIL_HOSTNAME
HP_NS1=$NS1
HP_NS2=$NS2
HP_SERVER_IP=$PUBLIC_IP
HP_SERVER_IPV6=$PUBLIC_IP6
HP_ADMIN_EMAIL=$EMAIL
HP_ADMIN_USER=admin
HP_SECRET=$SECRET
HP_PDNS_KEY=$PDNS_KEY
HP_STALWART_PASSWORD=$STALWART_PASSWORD
HP_ROUNDCUBE_KEY=$ROUNDCUBE_KEY
HP_PHP_VERSION=$PHP_VERSION
HP_DATA_DIR=$DATA_DIR
HP_SITES_DIR=$SITES_DIR
HP_STORAGE_DIR=$STORAGE_DIR
HP_WORKERS_DIR=$WORKERS_DIR
HP_WORKERS_DOMAIN=${DOMAIN:+workers.$DOMAIN}
HP_LOG_DIR=$LOG_DIR
HP_APP_DIR=$APP_DIR
EOF
chmod 0600 "$ENV_FILE"

info "Instalando dependencias y compilando la interfaz (1-3 min)…"
(cd "$APP_DIR/panel/api" && q npm ci --omit=dev --no-audit --no-fund)
# Lockfiles created on another OS can miss platform binaries: fall back to a fresh install.
(cd "$APP_DIR/panel/web" && { q npm ci --no-audit --no-fund || { rm -rf node_modules && q npm install --no-audit --no-fund; }; } && q npm run build && rm -rf node_modules)
ok "Panel compilado"

install -m 0755 "$APP_DIR/scripts/hostpanel" /usr/local/bin/hostpanel
chmod 0755 "$APP_DIR/scripts/hp-update"
cp "$T/systemd/hostpanel.service" /etc/systemd/system/hostpanel.service
q systemctl daemon-reload
q systemctl enable hostpanel

NODE_RUN=(node --disable-warning=ExperimentalWarning src/cli.ts)
if [[ $FIRST_INSTALL == 1 ]]; then
  # The admin password is shown once at the end and only its hash is stored.
  (cd "$APP_DIR/panel/api" && q "${NODE_RUN[@]}" reset-password admin "$ADMIN_PASSWORD")
fi
q systemctl restart hostpanel
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/api/health 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null http://127.0.0.1:3000/api/health || die "El panel no arrancó: journalctl -u hostpanel -n 50"
ok "Panel en marcha"

if [[ -n $DOMAIN ]]; then
  if (cd "$APP_DIR/panel/api" && q "${NODE_RUN[@]}" bootstrap-domain "$DOMAIN"); then
    ok "Dominio $DOMAIN dado de alta (zona DNS${MAIL_HOSTNAME:+ y correo})"
  else
    warn "No se pudo dar de alta $DOMAIN automáticamente; hazlo desde el panel."
  fi
fi

# =====================================================================================
step "Cortafuegos y mantenimiento"
SSH_PORT=$(ss -tlnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]; exit}' || true)
SSH_PORT=${SSH_PORT:-22}
q ufw allow "$SSH_PORT/tcp" comment 'SSH'
for rule in 80/tcp 443/tcp 443/udp 2087/tcp 53/tcp 53/udp; do q ufw allow "$rule"; done
if [[ -n $MAIL_HOSTNAME ]]; then for rule in 25/tcp 465/tcp 587/tcp 993/tcp 4190/tcp; do q ufw allow "$rule"; done; fi
q ufw --force enable
ok "UFW: SSH ($SSH_PORT), web 80/443, panel 2087, DNS 53${MAIL_HOSTNAME:+, correo 25/465/587/993}"
apt_install unattended-upgrades || true
ok "Actualizaciones de seguridad automáticas"

# =====================================================================================
trap - ERR
echo
printf '%s%s  ✔ HostPanel está listo%s\n\n' "$G" "$B" "$N"
printf '  %sPanel%s        https://%s:2087   (certificado interno: acepta el aviso del navegador)\n' "$B" "$N" "$PUBLIC_IP"
if [[ -n $PANEL_DOMAIN ]]; then printf '               https://%s   (en cuanto el DNS apunte aquí)\n' "$PANEL_DOMAIN"; fi
if [[ $FIRST_INSTALL == 1 ]]; then
  printf '  %sUsuario%s      admin\n' "$B" "$N"
  printf '  %sContraseña%s   %s\n' "$B" "$N" "$ADMIN_PASSWORD"
  printf '               %sGuárdala ahora: no se volverá a mostrar (sudo hostpanel reset-password).%s\n' "$Y" "$N"
fi
if [[ -n $DOMAIN ]]; then
  cat <<EOF

  ${B}Siguiente paso: DNS${N}
  En el registrador de ${B}$DOMAIN${N}:
    1. Crea los "glue records":  $NS1 → $PUBLIC_IP   y   $NS2 → $PUBLIC_IP
    2. Cambia los nameservers de $DOMAIN a  $NS1  y  $NS2
  ${B}Correo${N}: pide a tu proveedor que configure el DNS inverso (PTR) de $PUBLIC_IP
  como $MAIL_HOSTNAME y que abra el puerto 25 de salida si lo bloquea.
EOF
fi
cat <<EOF

  Comandos:  hostpanel status · hostpanel logs · hostpanel update · hostpanel uninstall
  Log de instalación: $INSTALL_LOG

EOF
