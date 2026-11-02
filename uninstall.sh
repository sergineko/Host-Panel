#!/usr/bin/env bash
# =====================================================================================
#  HostPanel — desinstalador
#
#    sudo hostpanel uninstall            Quita el panel y sus servicios, CONSERVA los datos
#    sudo hostpanel uninstall --purge    Borra también sitios, bases de datos, correo y DNS
#    --yes                               Sin confirmación
# =====================================================================================
set -Euo pipefail

PURGE=0
ASSUME_YES=0
for arg in "$@"; do
  case $arg in
    --purge) PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
  esac
done

if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B='' G='' Y='' R='' N=''; fi
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
q()    { "$@" >/dev/null 2>&1; }

if [[ $EUID -ne 0 ]]; then echo "Ejecuta como root (sudo)." >&2; exit 1; fi

PHP_VERSION=$(grep -E '^HP_PHP_VERSION=' /etc/hostpanel/hostpanel.env 2>/dev/null | cut -d= -f2 || true)
PHP_VERSION=${PHP_VERSION:-$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;' 2>/dev/null || true)}

echo
printf '%sDesinstalar HostPanel%s\n\n' "$B" "$N"
if [[ $PURGE == 1 ]]; then
  printf '  %sSe BORRARÁ TODO:%s sitios web, bases de datos MariaDB, buzones de correo,\n' "$R" "$N"
  printf '  zonas DNS, certificados y la configuración. No se puede deshacer.\n'
  printf '  También se desinstalan MariaDB, PowerDNS, PHP y Node.js.\n'
  WORD=BORRAR
else
  printf '  Se quitarán el panel, Caddy, Stalwart, Roundcube y los procesos de los sitios.\n'
  printf '  %sSe conservan%s los datos: /srv/hostpanel, /var/lib/hostpanel, /etc/hostpanel,\n' "$B" "$N"
  printf '  /opt/stalwart/data y las bases de datos. Reinstalar los recupera.\n'
  WORD=si
fi
if [[ $ASSUME_YES != 1 ]]; then
  if (: </dev/tty) 2>/dev/null; then
    read -r -p "  Escribe '$WORD' para continuar: " answer </dev/tty || true
  else
    echo "  Sin terminal: usa --yes para confirmar." >&2; exit 1
  fi
  [[ ${answer:-} == "$WORD" ]] || { echo "  Cancelado."; exit 1; }
fi
echo

# --- services ------------------------------------------------------------------------
for unit in /etc/systemd/system/hp-site-*.service; do
  [[ -e $unit ]] || continue
  name=$(basename "$unit" .service)
  q systemctl disable --now "$name"
  rm -f "$unit"
done
ok "Procesos de los sitios detenidos"

for svc in hostpanel caddy stalwart; do
  q systemctl disable --now "$svc"
  rm -f "/etc/systemd/system/$svc.service"
done
q systemctl daemon-reload
ok "Servicios hostpanel, caddy y stalwart eliminados"

if [[ -n $PHP_VERSION && -d /etc/php/$PHP_VERSION/fpm/pool.d ]]; then
  rm -f /etc/php/"$PHP_VERSION"/fpm/pool.d/hp-*.conf
  q systemctl reload "php${PHP_VERSION}-fpm"
  ok "Pools PHP-FPM de HostPanel eliminados"
fi

rm -rf /opt/hostpanel /usr/local/bin/caddy /etc/caddy /var/www/roundcube /opt/stalwart/bin /opt/stalwart/etc
rm -f /usr/local/bin/hostpanel
ok "Programas eliminados"

# --- system DNS resolver back to default ---------------------------------------------
if [[ -f /etc/systemd/resolved.conf.d/hostpanel.conf ]]; then
  q systemctl stop pdns
  rm -f /etc/systemd/resolved.conf.d/hostpanel.conf
  ln -sf ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
  q systemctl restart systemd-resolved
  ok "Resolución DNS del sistema restaurada"
fi

# --- firewall ------------------------------------------------------------------------
if command -v ufw >/dev/null; then
  for rule in 80/tcp 443/tcp 443/udp 2087/tcp 53/tcp 53/udp 25/tcp 465/tcp 587/tcp 993/tcp 4190/tcp; do q ufw delete allow "$rule"; done
  ok "Reglas de cortafuegos de HostPanel eliminadas (SSH se mantiene)"
fi

# --- data (only with --purge) --------------------------------------------------------
if [[ $PURGE == 1 ]]; then
  # Site users (hp-<id>) and databases created from the panel.
  if [[ -f /var/lib/hostpanel/hostpanel.db ]] && command -v sqlite3 >/dev/null && command -v mariadb >/dev/null; then
    while IFS='|' read -r db user; do
      [[ -n $db ]] && q mariadb -e "DROP DATABASE IF EXISTS \`$db\`; DROP USER IF EXISTS '$user'@'localhost';"
    done < <(sqlite3 /var/lib/hostpanel/hostpanel.db 'SELECT name, username FROM databases' 2>/dev/null || true)
  fi
  for user in $(getent passwd | cut -d: -f1 | grep -E '^hp-' || true); do q userdel "$user"; done
  for user in caddy stalwart; do q userdel "$user"; done
  rm -rf /srv/hostpanel /var/lib/hostpanel /etc/hostpanel /var/log/hostpanel /var/lib/caddy /opt/stalwart /var/lib/roundcube /var/log/hostpanel-install.log
  ok "Datos borrados"

  export DEBIAN_FRONTEND=noninteractive
  q systemctl disable --now pdns mariadb
  q apt-get purge -y 'pdns-*' 'mariadb-*' 'php*' composer nodejs
  q apt-get autoremove -y
  rm -rf /var/lib/powerdns /etc/powerdns /var/lib/mysql /etc/mysql
  ok "Paquetes desinstalados (PowerDNS, MariaDB, PHP, Node.js)"
else
  q systemctl disable --now pdns
  warn "PowerDNS detenido. MariaDB, PHP y Node.js siguen instalados (con --purge se eliminan)."
fi

echo
printf '%s  ✔ HostPanel desinstalado.%s\n\n' "$G" "$N"
