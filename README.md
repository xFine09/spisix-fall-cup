# SpiSix: Fall Cup

Web del torneo 1v1 de osu! de la comunidad SpiSix: inscritos, mappools, clasificatorios, cuadro, resultados y arbitraje, en un solo sitio.

## Qué hace

- **Jugadores:** entran con su cuenta de osu!. La inscripción se hace en un formulario de Google, y la web importa las respuestas y comprueba el rango de cada uno. Cada inscrito tiene una ficha con sus datos de osu! (rango, pp, precisión y la evolución de su rango) y de [o!TR](https://otr.stagec.net) (su rating de otros torneos), que se actualiza una vez al día, y sus skills en el torneo (aim, velocidad, precisión, accuracy y resistencia) calculadas solo con partidos de torneo: los clasificatorios, el cuadro y o!TR.
- **Mappools:** se suben a mano o desde una hoja de cálculo, y se publican a la hora programada.
- **Clasificatorios:** los jugadores se apuntan a un lobby, un árbitro aprueba cada plaza y las seeds se calculan por Z-sum.
- **Cuadro:** doble eliminación de 16, con cruces y resultados que avanzan solos. En Partidos se pueden ver todos los de un jugador.
- **Stats:** estadísticas de cada ronda en dos vistas, resultados individuales (match cost, medias y mejor score de cada jugador; en clasificatorios, la Z-sum) y leaderboard por mapa, con una dirección que se puede compartir (`#stats/finals?view=leaderboard-por-mapa`).
- **Arbitraje:** un bot de IRC por fases (lobby, warmups, rolls, protects, bans, picks, ready y mapa) que el árbitro lleva en modo SEMI (cada paso es un botón) o AUTO (lo hace solo), y cambia en cualquier momento. Nunca sanciona: avisa y espera al árbitro.
- **Panel de organización:** roles, normas, textos, fechas de las rondas y anuncios.
- **Inicio:** recordatorios automáticos de partidos, resultados y mappools, y aviso cuando hay directo en Twitch.

## Parte técnica

| Pieza | Qué se usa |
|---|---|
| Servidor | Node.js 22.13 o superior, sin dependencias externas |
| Web | Una sola página: `public/index.html`, sin compilación. Aparte, `/api.html`: guía de `/api/overlay` (`server/api-guide.html`), solo para los admins y quien se autorice en el panel |
| Datos | SQLite, con copia automática al arrancar y cada día (guarda las 14 últimas) |
| Despliegue | Docker Compose, con la web solo en `127.0.0.1:3000` |
| HTTPS | Tailscale Funnel; no hace falta dominio ni abrir puertos |
| osu! | API v2 (login y datos) e IRC de Bancho (bot de arbitraje) |
| Twitch | API Helix, opcional, para saber si hay directo |
| o!TR | API pública con clave propia, opcional, para el rating de torneos en la ficha |

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

**Estado:** el bot de arbitraje (modos AUTO y SEMI) solo se ha probado contra un Bancho simulado. Hay que hacer un lobby de prueba con Bancho real antes de usarlo en el torneo (qué comprobar: [manual](docs/MANUAL.md#comandos-de-bancho-irc-que-usa-el-bot-de-arbitraje)).

## Ponerla en marcha

Necesitas Docker, Tailscale y una [aplicación OAuth de osu!](https://osu.ppy.sh/home/account/edit#oauth) cuyo callback sea `https://NOMBRE.TAILNET.ts.net/auth/osu/callback`.

```bash
git clone https://github.com/xFine09/spisix-fall-cup.git
cd spisix-fall-cup
```

Crea un archivo `.env` en esa carpeta. Los ajustes de Twitch y de o!TR son opcionales:

```bash
BASE_URL=https://NOMBRE.TAILNET.ts.net
OSU_CLIENT_ID=
OSU_CLIENT_SECRET=
ADMIN_IDS=              # IDs de osu! de los hosts, separados por comas
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
OTR_API_KEY=            # opcional: clave de https://otr.stagec.net/settings
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
