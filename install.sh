#!/usr/bin/env bash
# =====================================================================================
#  HostPanel — instalador de un comando
#
#    curl -fsSL https://raw.githubusercontent.com/sergineko/Host-Panel/main/install.sh | sudo bash
#
#  Al terminar muestra un enlace de un solo uso. La primera vez que se abre, el panel pide la
#  cuenta de administrador (usuario, contraseña segura, 2FA), el dominio principal y la zona
#  horaria, y explica qué cambiar en el registrador del dominio.
#
#  Opciones (también como variables de entorno), para instalaciones desatendidas:
#    --domain midominio.com   Dominio principal (panel.*, mail.*, ns1.*, ns2.*)   HP_DOMAIN
#    --email  tu@correo.com   Email para Let's Encrypt                            HP_EMAIL
#    --yes                    Sin preguntas                                       HP_YES=1
#    --update                 Actualiza el panel conservando datos y secretos
#    --keep-code              No descarga código nuevo (para cambiar solo la configuración,
#                             por ejemplo el dominio principal desde el panel)       HP_KEEP_CODE=1
#
#  Sistemas soportados: Ubuntu 22.04 o posterior y Debian 12 o posterior (x86_64 o arm64).
# =====================================================================================
set -Eeuo pipefail

HP_REPO="${HP_REPO:-https://github.com/sergineko/Host-Panel.git}"
HP_BRANCH="${HP_BRANCH:-main}"
ROUNDCUBE_FALLBACK=1.6.11
# Stalwart 1.0 changed its settings schema and database layout (no in-place upgrade from 0.16):
# the panel is integrated with the 0.16 series, so that is what gets installed.
STALWART_VERSION=v0.16.27
NODE_MAJOR=24

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
  local opts=(-y --no-install-recommends -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
  DEBIAN_FRONTEND=noninteractive q apt-get install "${opts[@]}" "$@" && return 0
  # Package lists may be old (updates skip "apt-get update" when nothing is missing): refresh, retry.
  apt_update || true
  DEBIAN_FRONTEND=noninteractive q apt-get install "${opts[@]}" "$@"
}

# All the given packages are installed.
pkgs_installed() {
  local p
  for p in "$@"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || return 1; done
}

# put_file <destination> [mode] < content: writes only when the content changed.
# Returns 0 when the file was written, 1 when it was already up to date (use it in if/&&).
put_file() {
  local tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [[ -f $1 ]] && cmp -s "$tmp" "$1"; then rm -f "$tmp"; return 1; fi
  install -m "${2:-0644}" "$tmp" "$1"
  rm -f "$tmp"
}

# restart_if <changed 0|1> <service>: restarts only when its configuration changed (or it is
# stopped), so re-running the installer doesn't interrupt websites, DNS or mail for nothing.
restart_if() {
  if [[ $1 == 1 ]] || ! systemctl is-active --quiet "$2"; then q systemctl restart "$2"; fi
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
  printf '%s
' "$content" | put_file "$2" "${3:-0644}"
}

# A package apt can install (not just a name other packages mention). English output to parse it.
pkg_available() {
  local c
  c=$(LC_ALL=C apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ {print $2; exit}')
  [[ -n $c && $c != "(none)" ]]
}

# PHP packages that exist for a version. Each release differs: since PHP 8.5 OPcache is built in
# (no phpX.Y-opcache package) and some builds include readline or other modules in -cli.
php_packages() {
  local v=$1 ext
  shift
  for ext in "$@"; do
    if pkg_available "php$v-$ext"; then printf 'php%s-%s\n' "$v" "$ext"; fi
  done
}

# Ubuntu's automatic updates (or the panel itself) may be using apt at the same time: wait for them
# instead of failing. Installs wait for the dpkg lock up to 10 minutes (system-wide setting, also
# used by the panel); "apt-get update" uses another lock, so it is retried.
apt_wait_setup() {
  mkdir -p /etc/apt/apt.conf.d
  printf '// Generated by HostPanel: wait for other apt/dpkg processes instead of failing.\nDPkg::Lock::Timeout "600";\n' >/etc/apt/apt.conf.d/90hostpanel-lock
}
apt_update() {
  local i out
  for i in $(seq 1 60); do
    if out=$(LC_ALL=C apt-get update 2>&1); then q printf '%s
' "$out"; return 0; fi
    q printf '%s
' "$out"
    # Only a lock held by another apt/dpkg process is worth waiting for; any other error
    # (for example a repository without packages for this release) fails right away.
    grep -qiE 'could not get lock|unable to lock|is another process using it' <<<"$out" || return 1
    (( i == 1 )) && printf '     Esperando a que termine otra instalación de paquetes (apt)…
'
    sleep 10
  done
  return 1
}

# --- operating system ----------------------------------------------------------------
# Any Ubuntu from 22.04 or Debian from 12, newer releases included. Sets CODENAME.
check_os() {
  [[ -r /etc/os-release ]] || die "Sistema operativo no soportado."
  # shellcheck disable=SC1091
  . /etc/os-release
  CODENAME=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
  local version=${VERSION_ID:-} major minor
  major=${version%%.*} minor=${version#*.}
  case ${ID:-} in
    ubuntu)
      [[ ${VERSION_ID:-} =~ ^[0-9]+\.[0-9]+$ ]] || die "No se pudo leer la versión de Ubuntu (${VERSION_ID:-?})."
      (( major >= 22 )) || die "$PRETTY_NAME es demasiado antiguo. Usa Ubuntu 22.04 o posterior."
      # LTS = even year, April release (22.04, 24.04, 26.04…).
      if (( major % 2 )) || [[ $minor != 04 ]]; then
        warn "$PRETTY_NAME no es una versión LTS: funciona, pero para producción se recomienda una LTS."
      fi
      ;;
    debian)
      if [[ -z ${VERSION_ID:-} ]]; then
        warn "Debian en pruebas ($CODENAME): no está probado, pero se intenta la instalación."
      else
        (( major >= 12 )) || die "$PRETTY_NAME es demasiado antiguo. Usa Debian 12 o posterior."
      fi
      ;;
    *) die "Sistema no soportado: ${PRETTY_NAME:-desconocido}. Usa Ubuntu (22.04 o posterior) o Debian (12 o posterior)." ;;
  esac
  [[ -n $CODENAME ]] || die "No se pudo detectar el nombre de la versión de $PRETTY_NAME."
  ok "$PRETTY_NAME"
}

# PHP only from the distribution's official repositories: third-party ones (like Ondřej Surý's)
# lag behind new releases and break the install. Uses the requested PHP_VERSION if the official
# repositories have it, otherwise the version the distribution ships (php-fpm → phpX.Y-fpm).
# A leftover third-party PHP repository from older installers is removed.
setup_php_repo() {
  local distro
  rm -f /etc/apt/sources.list.d/ondrej-ubuntu-php* /etc/apt/sources.list.d/sury-php.list /usr/share/keyrings/sury-php.gpg
  if [[ -n ${PHP_VERSION:-} ]] && pkg_available "php${PHP_VERSION}-fpm"; then return 0; fi
  distro=$(LC_ALL=C apt-cache depends php-fpm 2>/dev/null | grep -oE 'php[0-9]+\.[0-9]+-fpm' | head -1 | grep -oE '[0-9]+\.[0-9]+' || true)
  [[ -n $distro ]] || die "No hay paquetes de PHP en los repositorios oficiales de $PRETTY_NAME."
  PHP_VERSION=$distro
}

# PHP2Shell (CVE-2026-109618 / CVE-2026-109619, remote code execution, fixed 21-10-2026): only
# builds with the fix are accepted. Fixed if the upstream version is at least the fixed release
# of its branch, or if the Debian/Ubuntu changelog lists both CVEs (backported fix).
php2shell_fixed() {
  local v=$1 full fixed log=''
  full=$("php$v" -r 'echo PHP_VERSION;' 2>/dev/null | tail -n 1 | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true)
  case $v in 8.2) fixed=8.2.35 ;; 8.3) fixed=8.3.36 ;; 8.4) fixed=8.4.27 ;; 8.5) fixed=8.5.12 ;; *) fixed='' ;; esac
  if [[ -n $full && -n $fixed ]] && [[ $(printf '%s\n%s\n' "$fixed" "$full" | sort -V | head -n 1) == "$fixed" ]]; then
    PHP2SHELL_DETAIL="PHP $full"
    return 0
  fi
  for f in "/usr/share/doc/php$v-common/changelog.Debian.gz" "/usr/share/doc/php$v-fpm/changelog.Debian.gz"; do
    [[ -f $f ]] && log=$(zcat "$f" 2>/dev/null || true) && break
  done
  if grep -q 'CVE-2026-109618' <<<"$log" && grep -q 'CVE-2026-109619' <<<"$log"; then
    PHP2SHELL_DETAIL="PHP ${full:-$v} con el parche de la distribución"
    return 0
  fi
  PHP2SHELL_DETAIL="PHP ${full:-$v}"
  return 1
}

has_module() { local mods; mods=$(/usr/local/bin/caddy list-modules 2>/dev/null || true); grep -qx "$1" <<<"$mods"; }

# --- arguments -----------------------------------------------------------------------
ORIG_ARGS=("$@")
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

if [[ $EUID -ne 0 ]]; then echo "Ejecuta el instalador como root (sudo)." >&2; exit 1; fi
# Systemd units (updates from the panel) run without HOME, and npm needs it.
export HOME=${HOME:-/root}
mkdir -p "$(dirname "$INSTALL_LOG")"
# A fresh log, except when continuing with the downloaded installer (see below).
if [[ ${HP_REEXEC:-0} != 1 ]]; then : >"$INSTALL_LOG"; fi
apt_wait_setup

# --- code first ----------------------------------------------------------------------
# The script piped from GitHub can be a cached copy a few minutes old. Download (or update) the
# code before anything else and continue with the installer that comes with it: every step runs
# once and always matches the code. A local copy of the repository is installed as it is.
SELF=$(readlink -f "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null || echo /dev/null)
if [[ ${HP_REEXEC:-0} != 1 && ${HP_KEEP_CODE:-0} != 1 ]] \
  && ! [[ $SELF != "$APP_DIR/install.sh" && -f $(dirname "$SELF")/panel/api/package.json ]]; then
  printf '\n%s%s  HostPanel%s — descargando la última versión…\n' "$O" "$B" "$N"
  if ! command -v git >/dev/null; then apt_update || true; apt_install git ca-certificates || die "No se pudo instalar git"; fi
  mkdir -p "$APP_DIR"
  if [[ ! -d $APP_DIR/.git ]]; then
    # Fresh install, or code copied without git: turn the folder into a checkout in place.
    q git -C "$APP_DIR" init -q
    q git -C "$APP_DIR" remote add origin "$HP_REPO" || q git -C "$APP_DIR" remote set-url origin "$HP_REPO"
  fi
  q git -C "$APP_DIR" fetch --depth 1 origin "$HP_BRANCH" && q git -C "$APP_DIR" reset --hard FETCH_HEAD \
    || die "No se pudo descargar el código de $HP_REPO"
  trap - ERR
  exec env HP_REEXEC=1 HP_KEEP_CODE=1 HP_BRANCH="$HP_BRANCH" HP_REPO="$HP_REPO" bash "$APP_DIR/install.sh" "${ORIG_ARGS[@]}"
fi

if [[ -f $ENV_FILE ]]; then EXISTING=1; else EXISTING=0; fi
if [[ $EXISTING == 1 ]]; then
  printf '\n%s%s  HostPanel%s — actualización (solo se cambia lo necesario)\n' "$O" "$B" "$N"
else
  printf '\n%s%s  HostPanel%s — instalación nativa (sin Docker)\n' "$O" "$B" "$N"
fi

# =====================================================================================
step "Comprobando el sistema"
check_os
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
# Behind a router or NAT (home server, VirtualBox…) the public IP belongs to the router: the panel
# is then opened with the machine's own IP, and the router must forward the ports to it.
LOCAL_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)
[[ $LOCAL_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || LOCAL_IP=''
if [[ -n $LOCAL_IP ]] && ! ip -4 -o addr show 2>/dev/null | grep -q " inet $PUBLIC_IP/"; then
  warn "Este servidor está detrás de un router o NAT: su IP en la red local es $LOCAL_IP."
else
  LOCAL_IP=''
fi

# A fresh install asks nothing here: the first visit to the panel asks for the main domain,
# the contact email and the administrator account (see "Configuración inicial" at the end).
DOMAIN=$(echo "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*##; s#^www\.##')
if [[ -n $DOMAIN && ! $DOMAIN =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]]; then die "Dominio no válido: $DOMAIN"; fi

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
if [[ -f /proc/net/if_inet6 ]]; then ANY='[::]'; PDNS_LISTEN='0.0.0.0, ::'; else ANY='0.0.0.0'; PDNS_LISTEN='0.0.0.0'; fi
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)

# =====================================================================================
step "Paquetes base"
export DEBIAN_FRONTEND=noninteractive
# Third-party PHP repositories from older installers are no longer used (they break on new releases).
rm -f /etc/apt/sources.list.d/ondrej-ubuntu-php* /etc/apt/sources.list.d/sury-php.list /usr/share/keyrings/sury-php.gpg
BASE_PKGS=(ca-certificates curl gnupg git acl ufw openssl sqlite3 unzip tar rsync jq cron logrotate iproute2 procps
  openssh-client fail2ban python3-systemd)
if pkgs_installed "${BASE_PKGS[@]}"; then
  ok "Paquetes base ya instalados"
else
  if ! apt_update; then
    warn "Algún repositorio de apt da error; se continúa con los demás:"
    grep -E '^(E|Err):' "$INSTALL_LOG" | tail -n 2 | sed 's/^/       /' || true
  fi
  apt_install "${BASE_PKGS[@]}"
  ok "Paquetes base instalados"
fi

# Network performance: BBR congestion control, bigger queues, TCP Fast Open.
if put_file /etc/sysctl.d/90-hostpanel.conf <<'EOF'
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
then
  q sysctl --system || warn "No se pudieron aplicar todos los ajustes de red (normal en algunos contenedores)"
fi

# Brute-force protection for SSH.
mkdir -p /etc/fail2ban/jail.d
F2B_CHANGED=0
put_file /etc/fail2ban/jail.d/hostpanel.conf <<'EOF' && F2B_CHANGED=1
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
restart_if "$F2B_CHANGED" fail2ban || warn "fail2ban no arrancó"
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
  if printf '[Resolve]\nDNSStubListener=no\nDNS=1.1.1.1 9.9.9.9\n' | put_file /etc/systemd/resolved.conf.d/hostpanel.conf; then
    ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
    q systemctl restart systemd-resolved
    ok "Puerto 53 liberado (systemd-resolved sin stub local)"
  fi
fi

# =====================================================================================
step "Código de HostPanel"
if [[ ${HP_KEEP_CODE:-0} == 1 && -f $APP_DIR/panel/api/package.json ]]; then
  ok "Versión $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo local)"
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
DB_CHANGED=0
put_file /etc/mysql/mariadb.conf.d/90-hostpanel.cnf <<EOF && DB_CHANGED=1
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
restart_if "$DB_CHANGED" mariadb
ok "MariaDB $(mariadb --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"

# =====================================================================================
step "PHP"
PHP_VERSION=${HP_PHP_VERSION:-}
setup_php_repo
pkg_available "php${PHP_VERSION}-fpm" && pkg_available "php${PHP_VERSION}-cli" || die "No hay paquetes de PHP $PHP_VERSION (fpm y cli) para $PRETTY_NAME."
mapfile -t PHP_PKGS < <(php_packages "$PHP_VERSION" fpm cli mysql sqlite3 gd intl mbstring xml zip curl bcmath opcache readline)
apt_install "${PHP_PKGS[@]}"
if ! php2shell_fixed "$PHP_VERSION"; then
  die "$PHP2SHELL_DETAIL no tiene corregida la vulnerabilidad PHP2Shell (CVE-2026-109618 y CVE-2026-109619). \
Los paquetes de PHP de los repositorios oficiales de $PRETTY_NAME aún no incluyen el parche: espera a que tu \
distribución publique la actualización y vuelve a ejecutar el instalador."
fi
ok "$PHP2SHELL_DETAIL: PHP2Shell corregido"
for opt in $(php_packages "$PHP_VERSION" imagick redis apcu); do apt_install "$opt" || true; done
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
PHP_CHANGED=0
for sapi in fpm cli; do
  put_file "/etc/php/$PHP_VERSION/$sapi/conf.d/99-hostpanel.ini" <<'EOF' && PHP_CHANGED=1
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
; PHP2Shell follow-up (CVE-2026-115560): upload progress tracking stays off.
session.upload_progress.enabled=0
EOF
done
if [[ -f /etc/php/$PHP_VERSION/fpm/pool.d/www.conf ]]; then rm -f "/etc/php/$PHP_VERSION/fpm/pool.d/www.conf"; PHP_CHANGED=1; fi
printf '; Generated by HostPanel: keeps FPM running when no site uses this version.\n[hp-idle]\nuser = nobody\ngroup = nogroup\nlisten = /run/php/hp-idle-%s.sock\npm = ondemand\npm.max_children = 1\n' "$PHP_VERSION" \
  | put_file "/etc/php/$PHP_VERSION/fpm/pool.d/hp-idle.conf" && PHP_CHANGED=1
q systemctl enable "php${PHP_VERSION}-fpm"
restart_if "$PHP_CHANGED" "php${PHP_VERSION}-fpm"
ok "PHP $PHP_VERSION de los repositorios oficiales de $PRETTY_NAME"

# =====================================================================================
step "PowerDNS (DNS autoritativo)"
PDNS_CHANGED=0
if ! pkgs_installed pdns-server pdns-backend-sqlite3; then
  # Don't let the package start pdns with its default bind backend: we configure it first.
  printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d
  apt_install pdns-server pdns-backend-sqlite3 || { rm -f /usr/sbin/policy-rc.d; die "No se pudo instalar PowerDNS"; }
  rm -f /usr/sbin/policy-rc.d
  q systemctl stop pdns || true
  PDNS_CHANGED=1
fi
if [[ -f /etc/powerdns/pdns.d/bind.conf ]]; then rm -f /etc/powerdns/pdns.d/bind.conf; PDNS_CHANGED=1; fi
# pdns.conf includes pdns.d (replication to a secondary nameserver): set aside any other file there.
for f in /etc/powerdns/pdns.d/*.conf; do
  if [[ -e $f && $(basename "$f") != hostpanel-* ]]; then mv "$f" "$f.disabled-by-hostpanel"; PDNS_CHANGED=1; fi
done
mkdir -p /var/lib/powerdns
if [[ ! -s /var/lib/powerdns/pdns.sqlite3 ]]; then
  SCHEMA=$(find /usr/share -name 'schema.sqlite3.sql' 2>/dev/null | head -1 || true)
  [[ -n $SCHEMA ]] || die "No se encontró el esquema SQLite de PowerDNS"
  sqlite3 /var/lib/powerdns/pdns.sqlite3 <"$SCHEMA"
fi
chown -R pdns:pdns /var/lib/powerdns
TPL=([PDNS_KEY]="$PDNS_KEY" [NS1]="$NS1" [PDNS_LISTEN]="$PDNS_LISTEN")
render "$T/pdns.conf" /etc/powerdns/pdns.conf 0640 && PDNS_CHANGED=1
chown root:pdns /etc/powerdns/pdns.conf
q systemctl enable pdns
restart_if "$PDNS_CHANGED" pdns || die "PowerDNS no arrancó. ¿Está ocupado el puerto 53? (ss -lunp | grep :53)"
ok "PowerDNS escuchando en el puerto 53"

# =====================================================================================
step "Caddy con WAF (Coraza + OWASP CRS) y rate limit"
id caddy >/dev/null 2>&1 || q useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
CADDY_CHANGED=0
if [[ $UPDATE == 1 ]] || ! has_module http.handlers.waf || ! has_module http.handlers.rate_limit; then
  CADDY_URL="https://caddyserver.com/api/download?os=linux&arch=${ARCH}&p=github.com%2Fcorazawaf%2Fcoraza-caddy%2Fv2&p=github.com%2Fmholt%2Fcaddy-ratelimit"
  rm -f /tmp/caddy.new
  for attempt in 1 2 3; do
    if curl -fsSL --max-time 300 "$CADDY_URL" -o /tmp/caddy.new; then break; fi
    warn "Descarga de Caddy fallida (intento $attempt), reintentando…"; sleep 5
  done
  [[ -s /tmp/caddy.new ]] || die "No se pudo descargar Caddy con los módulos WAF."
  install -m 0755 /tmp/caddy.new /usr/local/bin/caddy; rm -f /tmp/caddy.new
  CADDY_CHANGED=1
fi
has_module http.handlers.waf || die "El binario de Caddy no incluye el módulo WAF"
mkdir -p /etc/caddy "$LOG_DIR"
put_file /etc/caddy/bootstrap.json <"$T/caddy-bootstrap.json" && CADDY_CHANGED=1
chown caddy:caddy "$LOG_DIR"; chmod 0750 "$LOG_DIR"
put_file /etc/systemd/system/caddy.service <"$T/systemd/caddy.service" && { CADDY_CHANGED=1; q systemctl daemon-reload; }
q systemctl enable caddy
restart_if "$CADDY_CHANGED" caddy
ok "Caddy $(/usr/local/bin/caddy version | awk '{print $1}') con módulos waf y rate_limit"

# =====================================================================================
if [[ -n $MAIL_HOSTNAME ]]; then
  step "Servidor de correo (Stalwart)"
  id stalwart >/dev/null 2>&1 || q useradd --system --user-group --home-dir /opt/stalwart --shell /usr/sbin/nologin stalwart
  mkdir -p /opt/stalwart/{bin,etc/certs,data,logs}
  MAIL_CHANGED=0
  STALWART_INSTALLED=$(/opt/stalwart/bin/stalwart --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)
  if [[ -n $STALWART_INSTALLED && $STALWART_INSTALLED != 0.16.* ]]; then
    warn "Stalwart $STALWART_INSTALLED no es compatible con el panel: se instala ${STALWART_VERSION#v}"
    q systemctl stop stalwart || true
    # A 1.x data folder can't be read by 0.16: keep it aside, never delete it.
    if [[ -d /opt/stalwart/data && -n $(ls -A /opt/stalwart/data 2>/dev/null) ]]; then
      mv /opt/stalwart/data "/opt/stalwart/data.v$STALWART_INSTALLED-$(date +%Y%m%d%H%M%S)"
      mkdir -p /opt/stalwart/data
    fi
  fi
  if [[ $UPDATE == 1 || ! -x /opt/stalwart/bin/stalwart || $STALWART_INSTALLED != 0.16.* ]]; then
    curl -fsSL --max-time 300 "https://github.com/stalwartlabs/stalwart/releases/download/${STALWART_VERSION}/stalwart-${STALWART_TRIPLE}.tar.gz" -o /tmp/stalwart.tgz \
      || die "No se pudo descargar Stalwart"
    tar -xzf /tmp/stalwart.tgz -C /opt/stalwart/bin; rm -f /tmp/stalwart.tgz
    if [[ -f /opt/stalwart/bin/stalwart-mail && ! -f /opt/stalwart/bin/stalwart ]]; then mv /opt/stalwart/bin/stalwart-mail /opt/stalwart/bin/stalwart; fi
    chmod 0755 /opt/stalwart/bin/stalwart
    MAIL_CHANGED=1
  fi
  if [[ ! -s /opt/stalwart/etc/certs/mail.crt ]]; then
    q openssl req -x509 -newkey rsa:2048 -nodes -days 90 -subj "/CN=$MAIL_HOSTNAME" \
      -keyout /opt/stalwart/etc/certs/mail.key -out /opt/stalwart/etc/certs/mail.crt
  fi
  TPL=([MAIL_HOSTNAME]="$MAIL_HOSTNAME" [STALWART_PASSWORD]="$STALWART_PASSWORD" [ANY]="$ANY")
  render "$T/stalwart.toml" /opt/stalwart/etc/config.toml 0600 && MAIL_CHANGED=1
  chown -R stalwart:stalwart /opt/stalwart
  chmod 0600 /opt/stalwart/etc/certs/mail.key
  put_file /etc/systemd/system/stalwart.service <"$T/systemd/stalwart.service" && { MAIL_CHANGED=1; q systemctl daemon-reload; }
  q systemctl enable stalwart
  restart_if "$MAIL_CHANGED" stalwart
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
    render "$T/roundcube.config.inc.php" /var/www/roundcube/config/config.inc.php || true
    rm -rf /var/www/roundcube/installer
    chown -R root:hp-roundcube /var/www/roundcube; chmod -R g+rX,o-rwx /var/www/roundcube
    setfacl -R -m u:caddy:rX /var/www/roundcube
    chown -R hp-roundcube:hp-roundcube /var/lib/roundcube
    if [[ ! -s /var/lib/roundcube/roundcube.db ]]; then
      q runuser -u hp-roundcube -- php /var/www/roundcube/bin/initdb.sh --dir=/var/www/roundcube/SQL || warn "No se pudo inicializar la BD de Roundcube"
    else
      q runuser -u hp-roundcube -- php /var/www/roundcube/bin/updatedb.sh --package=roundcube --dir=/var/www/roundcube/SQL || true
    fi
    if put_file "/etc/php/$PHP_VERSION/fpm/pool.d/hp-roundcube.conf" <"$T/roundcube-pool.conf"; then
      q systemctl reload "php${PHP_VERSION}-fpm"
    fi
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
put_file "$ENV_FILE" 0600 <<EOF || true
# HostPanel — generado por el instalador. Contiene secretos: no lo compartas.
HP_BASE_DOMAIN=$DOMAIN
HP_PANEL_DOMAIN=$PANEL_DOMAIN
HP_PANEL_PORT=2087
HP_MAIL_HOSTNAME=$MAIL_HOSTNAME
HP_NS1=$NS1
HP_NS2=$NS2
HP_SERVER_IP=$PUBLIC_IP
HP_LOCAL_IP=$LOCAL_IP
HP_SERVER_IPV6=$PUBLIC_IP6
HP_ADMIN_EMAIL=$EMAIL
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

# Dependencies and interface are rebuilt only when the code changed since the last build.
BUILD_ID=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo local-$(date +%s))
if [[ -f $APP_DIR/.hp-build && $(<"$APP_DIR/.hp-build") == "$BUILD_ID" && -d $APP_DIR/panel/api/node_modules && -f $APP_DIR/panel/web/dist/index.html ]]; then
  ok "Panel ya compilado para esta versión"
else
  info "Instalando dependencias y compilando la interfaz (1-3 min)…"
  (cd "$APP_DIR/panel/api" && q npm ci --omit=dev --no-audit --no-fund)
  # Lockfiles created on another OS can miss platform binaries: fall back to a fresh install.
  (cd "$APP_DIR/panel/web" && { q npm ci --no-audit --no-fund || { rm -rf node_modules && q npm install --no-audit --no-fund; }; } && q npm run build && rm -rf node_modules)
  printf '%s\n' "$BUILD_ID" >"$APP_DIR/.hp-build"
  ok "Panel compilado"
fi

install -m 0755 "$APP_DIR/scripts/hostpanel" /usr/local/bin/hostpanel
chmod 0755 "$APP_DIR/scripts/hp-update"
put_file /etc/systemd/system/hostpanel.service <"$T/systemd/hostpanel.service" && q systemctl daemon-reload
q systemctl enable hostpanel

NODE_RUN=(node --disable-warning=ExperimentalWarning src/cli.ts)
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

# One-time link to the first-run wizard while there is no administrator yet.
SETUP_URLS=''
SETUP_URLS=$(cd "$APP_DIR/panel/api" && "${NODE_RUN[@]}" setup-link 2>>"$INSTALL_LOG") || SETUP_URLS=''

# =====================================================================================
trap - ERR
echo
printf '%s%s  ✔ HostPanel está listo%s\n\n' "$G" "$B" "$N"
if [[ -n $SETUP_URLS ]]; then
  SETUP_IP_URL=$(head -n 1 <<<"$SETUP_URLS")
  if [[ -n $LOCAL_IP ]]; then
    SETUP_PUBLIC_URL=$(grep -m 1 "://$PUBLIC_IP:" <<<"$SETUP_URLS" || true)
    cat <<EOF
  ${B}Configuración inicial${N}: abre este enlace en tu navegador para terminar.

      Desde tu red local:  ${O}${SETUP_IP_URL}${N}
      Desde internet:      ${SETUP_PUBLIC_URL}
                           (solo si el router redirige el puerto 2087 a $LOCAL_IP)
EOF
  else
    cat <<EOF
  ${B}Configuración inicial${N}: abre este enlace en tu navegador para terminar.

      ${O}${SETUP_IP_URL}${N}
EOF
  fi
  cat <<EOF

  El navegador avisará del certificado (es interno hasta que tengas dominio): acéptalo.
  El panel te pedirá:
    · tu cuenta de administrador (usuario poco evidente y contraseña segura)
    · la verificación en dos pasos (Contraseñas de Apple, Microsoft Authenticator…)
    · el dominio principal del servidor y la zona horaria
  y te dirá qué cambiar en el registrador del dominio (glue records y nameservers).

  ${Y}El enlace es personal y de un solo uso (caduca en 7 días).${N}
  ¿Lo has perdido?  sudo hostpanel setup-link
EOF
else
  printf '  %sPanel%s        https://%s:2087   (certificado interno: acepta el aviso del navegador)\n' "$B" "$N" "${LOCAL_IP:-$PUBLIC_IP}"
  if [[ -n $PANEL_DOMAIN ]]; then printf '               https://%s   (en cuanto el DNS apunte aquí)\n' "$PANEL_DOMAIN"; fi
fi
if [[ -n $DOMAIN && -z $SETUP_URLS ]]; then
  cat <<EOF

  ${B}Siguiente paso: DNS${N}
  En el registrador de ${B}$DOMAIN${N}:
    1. Crea los "glue records":  $NS1 → $PUBLIC_IP   y   $NS2 → $PUBLIC_IP
    2. Cambia los nameservers de $DOMAIN a  $NS1  y  $NS2
  ${B}Correo${N}: pide a tu proveedor que configure el DNS inverso (PTR) de $PUBLIC_IP
  como $MAIL_HOSTNAME y que abra el puerto 25 de salida si lo bloquea.
EOF
fi
if [[ -n $LOCAL_IP ]]; then
  cat <<EOF

  ${Y}Detrás de un router${N}: para que internet llegue al servidor, redirige en el router a $LOCAL_IP
  los puertos 80, 443 y 2087 (web y panel), 53 TCP/UDP (DNS) y 25, 465, 587, 993 (correo).
EOF
fi
cat <<EOF

  Comandos:  hostpanel status · hostpanel logs · hostpanel update · hostpanel uninstall
  Log de instalación: $INSTALL_LOG

EOF
