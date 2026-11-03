# Manual de instalación de HostPanel

Guía paso a paso para instalar HostPanel en un servidor Ubuntu y dejarlo funcionando con tu dominio.

## Antes de empezar

Necesitas:

| Qué | Detalle |
|---|---|
| Un servidor limpio (VPS) | **Ubuntu 22.04 o 24.04** (también Debian 12 / 13), x86_64 o arm64 |
| Memoria | 2 GB de RAM recomendados (funciona con 1 GB, más justo) |
| Acceso | Por SSH como `root` o con un usuario con `sudo` |
| Un dominio | Registrado a tu nombre, por ejemplo `miempresa.com`, con acceso al panel del registrador |

"Limpio" significa sin Apache, Nginx ni otro panel instalado: HostPanel necesita los puertos 80, 443, 53 y 25.

## 1. Entra en el servidor

Desde tu ordenador (Terminal en Mac/Linux, PowerShell en Windows):

```bash
ssh root@IP_DEL_SERVIDOR
```

## 2. Lanza el instalador

```bash
curl -fsSL https://raw.githubusercontent.com/sergineko/Host-Panel/main/install.sh | sudo bash
```

Tarda entre 5 y 10 minutos. No pregunta nada: instala el servidor web, DNS, bases de datos, PHP, Node.js y el panel,
y configura el cortafuegos.

## 3. Abre el enlace de configuración

Al terminar, el instalador muestra un enlace como este:

```
https://203.0.113.10:2087/setup?token=P5qjptvlVdsDj-NI323qn4z6
```

Ábrelo en tu navegador. Avisará de que el certificado no es seguro: es normal hasta que configures el dominio,
acepta el aviso («Avanzado» → «Continuar»).

> El enlace es personal, de un solo uso y caduca en 7 días. Si lo pierdes, genera otro en el servidor con
> `sudo hostpanel setup-link`.

## 4. Sigue el asistente

El panel no te deja entrar hasta completar estos pasos:

### Licencia

Todos los planes son de pago. La pantalla muestra los planes disponibles (Personal, Profesional, Empresa y Reseller) para
contratar uno. Si ya la tienes, pulsa **«Ya tengo licencia»** y pega la licencia que recibiste por email (un texto largo
con un punto en medio).

### Cuenta de administrador

- **Usuario**: elige un nombre poco evidente. No se permiten `admin`, `root`, `test` y similares porque son los
  primeros que prueban los ataques automáticos. También vale un correo electrónico.
- **Email de contacto**: para los certificados SSL, los informes de correo y avisos del servidor.
- **Contraseña**: mínimo 12 caracteres combinando mayúsculas, minúsculas, números y símbolos (o una frase de 16 o más).
  El botón **Generar** crea una segura: guárdala en tu gestor de contraseñas.

### Verificación en dos pasos (recomendada)

1. Escanea el código QR con la cámara del móvil o con tu app: Contraseñas de Apple (iPhone, iPad, Mac), Microsoft
   Authenticator, Google Authenticator, 1Password, Bitwarden o Authy.
2. Escribe el código de 6 dígitos que muestra.
3. **Guarda los 10 códigos de recuperación** (cópialos o descárgalos). Te permiten entrar si pierdes el móvil; cada uno
   sirve una sola vez.

### Dominio principal

Escribe tu dominio, el email de contacto y la zona horaria. El servidor pasa a ser:

| Nombre | Para qué |
|---|---|
| `ns1.tudominio.com` y `ns2.tudominio.com` | Nameservers de tu dominio y de todos los que alojes |
| `mail.tudominio.com` | Servidor de correo |
| `panel.tudominio.com` | Acceso al panel con SSL |

La configuración tarda unos minutos (instala el correo). La zona DNS completa del dominio queda en
**Dominios → DNS** dentro del panel.

## 5. Cambios en el registrador del dominio

En la web donde compraste el dominio (GoDaddy, Namecheap, IONOS, DonDominio, OVH…):

1. **Crea los nameservers propios.** Busca «Nameservers propios», «Child nameservers», «Glue records» o «Registrar
   host» y crea:

   | Host | IP |
   |---|---|
   | `ns1.tudominio.com` | IP del servidor |
   | `ns2.tudominio.com` | IP del servidor |

   Los dos con la misma IP: los registradores exigen dos nombres, no dos servidores.

2. **Cambia los nameservers del dominio** a «personalizados» y pon `ns1.tudominio.com` y `ns2.tudominio.com`.

El último paso del asistente muestra estos datos listos para copiar y comprueba solo cuándo se han propagado
(normalmente menos de una hora, como mucho 48 h). No hace falta esperar: puedes pulsar **Ir al panel** ya.

## 6. Cambios en el proveedor del VPS

Para que Gmail y Outlook acepten tu correo, en el panel de tu proveedor del servidor (Hetzner, OVH, DigitalOcean,
Contabo…), no en el registrador:

- **DNS inverso (PTR)** de la IP del servidor → `mail.tudominio.com`.
- Que **no bloqueen el puerto 25** de salida. Algunos lo cierran por defecto: pídelo a su soporte.

## 7. Listo

Cuando el DNS se propague:

- Panel: `https://panel.tudominio.com` (con certificado válido; `https://IP:2087` sigue funcionando).
- Webmail: `https://mail.tudominio.com`.
- Para tus otros dominios basta con poner `ns1.tudominio.com` y `ns2.tudominio.com` como nameservers en su registrador
  y añadirlos en **Dominios**.

## Problemas frecuentes

| Problema | Solución |
|---|---|
| Perdí el enlace de configuración | `sudo hostpanel setup-link` |
| Olvidé la contraseña | `sudo hostpanel reset-password` |
| Perdí el móvil de la verificación en dos pasos | Entra con un código de recuperación o, en el servidor, `sudo hostpanel disable-2fa` |
| Me quedé fuera por la restricción de IPs | `sudo hostpanel panel-access-reset` |
| Algo no funciona | `sudo hostpanel status` y `sudo hostpanel logs` |
| Ver las direcciones del panel | `sudo hostpanel info` |

Log completo de la instalación: `/var/log/hostpanel-install.log`.

## Instalación desatendida

Para automatizarla sin el paso del dominio en el asistente:

```bash
curl -fsSL https://raw.githubusercontent.com/sergineko/Host-Panel/main/install.sh | sudo bash -s -- --domain tudominio.com --email tu@tudominio.com --yes
```

El asistente seguirá pidiendo la cuenta de administrador y la verificación en dos pasos.
