#!/usr/bin/env bash
# =====================================================================================
#  HostPanel — preparar un VPS como nodo de despliegue
#
#  El panel muestra este comando (con su IP y su clave) en Servidores → Añadir servidor:
#    curl -fsSL https://raw.githubusercontent.com/sergineko/Host-Panel/main/node-install.sh \
#      | sudo bash -s -- --panel-ip 203.0.113.10 --key "ssh-ed25519 AAAA… hostpanel@…"
#
#  Desinstalar el nodo:   sudo bash node-install.sh --uninstall
#
#  Instala: Caddy (origen TLS en :8443, solo accesible desde el panel), PHP-FPM, Node.js 24,
#  rsync y acl; autoriza la clave SSH del panel y configura el cortafuegos.
# =====================================================================================
set -Eeuo pipefail

PANEL_IP=''
PANEL_KEY=''
PHP_VERSION="${HP_PHP_VERSION:-8.3}"
NODE_MAJOR=24
UNINSTALL=0
NODE_PORT=8443
LOG=/var/log/hostpanel-node-install.log

while [[ $# -gt 0 ]]; do
  case $1 in
    --panel-ip) PANEL_IP=${2:-}; shift 2 ;;
    --key) PANEL_KEY=${2:-}; shift 2 ;;
    --php) PHP_VERSION=${2:-}; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Opción desconocida: $1" >&2; exit 1 ;;
  esac
done

if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; O=$'\e[38;5;208m'; N=$'\e[0m'; else B='' G='' R='' O='' N=''; fi
step() { printf '\n%s▶%s %s%s%s\n' "$O" "$N" "$B" "$*" "$N"; }
ok() { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
die() { printf '\n%s✖ %s%s\n' "$R" "$*" "$N" >&2; tail -n 15 "$LOG" 2>/dev/null | sed 's/^/    /' >&2; exit 1; }
trap 'die "Error en la línea $LINENO: $BASH_COMMAND"' ERR
q() { "$@" >>"$LOG" 2>&1; }
export DEBIAN_FRONTEND=noninteractive
apt_install() { q apt-get install -y --no-install-recommends -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }

[[ $EUID -eq 0 ]] || { echo "Ejecuta como root (sudo)." >&2; exit 1; }
: >"$LOG"

# --- uninstall ----------------------------------------------------------------------
if [[ $UNINSTALL == 1 ]]; then
  step "Desinstalando el nodo HostPanel"
  for unit in $(systemctl list-units --all --plain --no-legend 'hp-site-*' | awk '{print $1}'); do systemctl disable --now "$unit" || true; done
  rm -f /etc/systemd/system/hp-site-*.service /etc/php/*/fpm/pool.d/hp-*.conf
  systemctl disable --now caddy 2>/dev/null || true
  rm -f /etc/systemd/system/caddy.service /usr/local/bin/caddy /usr/local/bin/hostpanel-node
  systemctl daemon-reload
  sed -i '/hostpanel@/d' /root/.ssh/authorized_keys 2>/dev/null || true
  for u in $(getent passwd | cut -d: -f1 | grep -E '^hp-[0-9]+$' || true); do userdel "$u" || true; done
  rm -rf /srv/hostpanel
  ufw status numbered 2>/dev/null | grep -q "$NODE_PORT" && ufw --force delete allow "$NODE_PORT/tcp" >/dev/null 2>&1 || true
  ok "Nodo desinstalado (PHP y Node.js se conservan)"
  exit 0
fi

[[ $PANEL_IP =~ ^[0-9a-fA-F:.]+$ ]] || die "Falta --panel-ip (IP del servidor del panel)"
[[ $PANEL_KEY == ssh-* ]] || die "Falta --key (clave pública SSH del panel)"

. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ok "$PRETTY_NAME" ;;
  *) die "Sistema no soportado: ${PRETTY_NAME:-?}. Usa Ubuntu 22.04/24.04 o Debian 12/13." ;;
esac
case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "Arquitectura no soportada" ;; esac

printf '\n%s%s  HostPanel%s — nodo de despliegue para el panel %s\n' "$O" "$B" "$N" "$PANEL_IP"

step "Paquetes base"
q apt-get update
apt_install ca-certificates curl gnupg rsync acl ufw jq lsb-release
ok "Listo"

step "Clave SSH del panel"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
# Only the panel's IP may use this key.
LINE="from=\"$PANEL_IP\" $PANEL_KEY"
grep -qF "$PANEL_KEY" /root/.ssh/authorized_keys || echo "$LINE" >>/root/.ssh/authorized_keys
ok "El panel puede conectarse desde $PANEL_IP"

step "PHP $PHP_VERSION"
if [[ $ID == ubuntu ]]; then
  apt_install software-properties-common
  q add-apt-repository -y ppa:ondrej/php
else
  curl -fsSL https://packages.sury.org/php/apt.gpg -o /usr/share/keyrings/sury-php.gpg
  echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" >/etc/apt/sources.list.d/sury-php.list
fi
q apt-get update
apt_install "php${PHP_VERSION}-fpm" "php${PHP_VERSION}-cli" "php${PHP_VERSION}-mysql" "php${PHP_VERSION}-sqlite3" "php${PHP_VERSION}-gd" \
  "php${PHP_VERSION}-intl" "php${PHP_VERSION}-mbstring" "php${PHP_VERSION}-xml" "php${PHP_VERSION}-zip" "php${PHP_VERSION}-curl" \
  "php${PHP_VERSION}-bcmath" "php${PHP_VERSION}-opcache"
rm -f "/etc/php/$PHP_VERSION/fpm/pool.d/www.conf"
printf '[hp-idle]\nuser = nobody\ngroup = nogroup\nlisten = /run/php/hp-idle-%s.sock\npm = ondemand\npm.max_children = 1\n' "$PHP_VERSION" \
  >"/etc/php/$PHP_VERSION/fpm/pool.d/hp-idle.conf"
q systemctl enable --now "php${PHP_VERSION}-fpm"
q systemctl restart "php${PHP_VERSION}-fpm"
ok "PHP $PHP_VERSION (se instalan otras versiones automáticamente si un sitio las pide)"

step "Node.js $NODE_MAJOR"
if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < NODE_MAJOR )); then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  q bash /tmp/nodesource_setup.sh
  rm -f /tmp/nodesource_setup.sh
  apt_install nodejs
fi
ok "Node $(node -v)"

step "Caddy (servidor de origen)"
id caddy >/dev/null 2>&1 || q useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
if [[ ! -x /usr/local/bin/caddy ]]; then
  curl -fsSL --retry 3 --max-time 300 "https://caddyserver.com/api/download?os=linux&arch=${ARCH}" -o /tmp/caddy.new
  install -m 0755 /tmp/caddy.new /usr/local/bin/caddy
  rm -f /tmp/caddy.new
fi
mkdir -p /etc/caddy
echo '{"admin":{"listen":"127.0.0.1:2019"}}' >/etc/caddy/bootstrap.json
cat >/etc/systemd/system/caddy.service <<'EOF'
# Generated by HostPanel node installer.
[Unit]
Description=Caddy (HostPanel node)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --resume --config /etc/caddy/bootstrap.json
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/bootstrap.json --force
Restart=on-failure
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
q systemctl daemon-reload
q systemctl enable caddy
q systemctl restart caddy
ok "Caddy $(/usr/local/bin/caddy version | awk '{print $1}') escuchando en :$NODE_PORT (el panel envía la configuración)"

step "Agente hostpanel-node"
cat >/usr/local/bin/hostpanel-node <<'EOF'
#!/usr/bin/env bash
# HostPanel node agent: reports the node state to the panel as JSON.
set -uo pipefail
case ${1:-info} in
  info)
    mem_total=$(awk '/MemTotal/ {print $2*1024}' /proc/meminfo)
    mem_free=$(awk '/MemAvailable/ {print $2*1024}' /proc/meminfo)
    read -r disk_total disk_free < <(df -B1 --output=size,avail / | tail -1)
    php=$(ls /usr/sbin/php-fpm* 2>/dev/null | sed 's#.*php-fpm##' | jq -R . | jq -sc .)
    ca=$(cat /var/lib/caddy/caddy/pki/authorities/local/root.crt 2>/dev/null || true)
    . /etc/os-release
    jq -nc --arg hostname "$(hostname)" --arg os "$PRETTY_NAME" --argjson cpus "$(nproc)" \
      --argjson mem_total "$mem_total" --argjson mem_free "$mem_free" \
      --argjson disk_total "$disk_total" --argjson disk_free "$disk_free" \
      --arg load "$(cut -d' ' -f1 /proc/loadavg)" --argjson php "${php:-[]}" \
      --arg node "$(node -v 2>/dev/null)" --arg caddy "$(/usr/local/bin/caddy version 2>/dev/null | awk '{print $1}')" --arg ca "$ca" \
      '{hostname:$hostname,os:$os,cpus:$cpus,mem_total:$mem_total,mem_free:$mem_free,disk_total:$disk_total,disk_free:$disk_free,load:$load,php:$php,node:$node,caddy:$caddy,ca:$ca}'
    ;;
  *) echo "Uso: hostpanel-node info" >&2; exit 1 ;;
esac
EOF
chmod 0755 /usr/local/bin/hostpanel-node
mkdir -p /srv/hostpanel/sites && chmod 0755 /srv/hostpanel /srv/hostpanel/sites
ok "Instalado"

step "Cortafuegos"
SSH_PORT=$(ss -tlnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]; exit}' || true)
q ufw allow "${SSH_PORT:-22}/tcp" comment 'SSH'
q ufw allow from "$PANEL_IP" to any port "$NODE_PORT" proto tcp comment 'HostPanel'
q ufw --force enable
ok "SSH abierto; puerto $NODE_PORT solo para $PANEL_IP"

trap - ERR
printf '\n%s%s  ✔ Nodo listo.%s Vuelve al panel y pulsa "Comprobar" en el servidor.\n\n' "$G" "$B" "$N"
