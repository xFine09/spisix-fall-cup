# SpiSix: Fall Cup

Web del torneo 1v1 de osu! de la comunidad SpiSix: inscritos, mappools, clasificatorios, cuadro, resultados y arbitraje, en un solo sitio.

## Qué hace

- **Jugadores:** entran con su cuenta de osu!. La inscripción se hace en un formulario de Google, y la web importa las respuestas y comprueba el rango de cada uno.
- **Mappools:** se suben a mano o desde una hoja de cálculo, y se publican a la hora programada.
- **Clasificatorios:** los jugadores se apuntan a un lobby, un árbitro aprueba cada plaza y las seeds se calculan por Z-sum.
- **Cuadro:** doble eliminación de 16, con cruces y resultados que avanzan solos.
- **Arbitraje:** un bot de IRC manda los comandos `!mp` y lleva rolls, protects, bans y picks.
- **Panel de organización:** roles, normas, textos, fechas de las rondas y anuncios.
- **Inicio:** recordatorios automáticos de partidos, resultados y mappools, y aviso cuando hay directo en Twitch.

## Parte técnica

| Pieza | Qué se usa |
|---|---|
| Servidor | Node.js 22.13 o superior, sin dependencias externas |
| Web | Una sola página: `public/index.html`, sin compilación |
| Datos | SQLite, con copia automática al arrancar y cada día (guarda las 14 últimas) |
| Despliegue | Docker Compose, con la web solo en `127.0.0.1:3000` |
| HTTPS | Tailscale Funnel; no hace falta dominio ni abrir puertos |
| osu! | API v2 (login y datos) e IRC de Bancho (bot de arbitraje) |
| Twitch | API Helix, opcional, para saber si hay directo |

```
server.js      rutas HTTP, sesiones y sincronización automática
server/        API de osu!, resultados, importación, base de datos y bot de arbitraje
public/        la web
config.json    fechas, rondas y reglas del torneo
scripts/       copia de seguridad manual
test/          prueba completa con servicios simulados
docs/          manual técnico
```

**Seguridad**

- Las credenciales solo están en `.env`, que no se sube a GitHub.
- Los permisos se comprueban en el servidor, que no envía las mappools sin publicar a quien no debe verlas.
- La contraseña IRC de cada árbitro solo está en memoria mientras dura la conexión. Bancho solo ofrece IRC sin cifrar.

**Estado:** el bot de arbitraje se ha probado contra un Bancho simulado. Conviene hacer un partido de prueba real antes de usarlo en el torneo.

## Ponerla en marcha

Necesitas Docker, Tailscale y una [aplicación OAuth de osu!](https://osu.ppy.sh/home/account/edit#oauth) cuyo callback sea `https://NOMBRE.TAILNET.ts.net/auth/osu/callback`.

```bash
git clone https://github.com/xFine09/spisix-fall-cup.git
cd spisix-fall-cup
```

Crea un archivo `.env` en esa carpeta. Los ajustes de Twitch son opcionales:

```bash
BASE_URL=https://NOMBRE.TAILNET.ts.net
OSU_CLIENT_ID=
OSU_CLIENT_SECRET=
ADMIN_IDS=              # IDs de osu! de los hosts, separados por comas
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
```

Arranca y publica:

```bash
docker compose up -d --build
tailscale funnel --bg 3000
```

Para comprobarlo, abre `https://NOMBRE.TAILNET.ts.net/healthz`: debe responder `{"ok":true}`.

Las pruebas se lanzan con `npm test` y no necesitan conexión ni credenciales.

## Más información

El [manual técnico](docs/MANUAL.md) explica la configuración, el mantenimiento, cómo restaurar copias, el uso del panel y el bot de arbitraje.
