# Manual técnico de SpiSix: Fall Cup

Detalle completo para quien instala y mantiene la web. El resumen está en el [README](../README.md).

## Funciones

- **Login con osu!** (OAuth). El jugador no escribe su rango: se lee de su perfil.
- **Registro por el formulario de Google**: la inscripción se hace solo allí. El admin pega la hoja de respuestas y la web busca a cada jugador en osu!, comprueba su rango (#100.000 – #999.999, con excepciones de rango) y lo inscribe. Se puede repetir sin duplicar a nadie. El enlace del formulario va en `formulario`, en `config.json`.
- **Mappool**: el admin pega el ID o el enlace del mapa y la web pide a osu! el nombre, la dificultad, la portada y el SR con el mod del slot (HR/DT). También se puede pegar la ronda entera desde una hoja de cálculo (por ejemplo, la pestaña Mappools de una hoja principal): basta con que cada fila tenga el slot y el ID o el enlace.
- **Publicación programada de mappools**: se suben cuando se quiera y hasta la hora de publicación solo las ven los admins y el staff. El servidor no las envía a nadie más. Sin hora programada se publican a las 00:00 del día del showcase.
- **Lobbies de clasificatorios**: los admins crean de una vez la rejilla de lobbies (cada día una letra y cada hora un número: A1, A2… B1, B2…, con 8 plazas por defecto; no crea los que ya han pasado ni los que empezarían en la última media hora de la fase, cuando ya no llegarían a contar para las seeds) y lobbies sueltos para horas especiales. Los inscritos se apuntan en la pestaña Qualis (un lobby por jugador, hasta la hora a la que empiece) y un árbitro o admin aprueba o rechaza cada plaza. Solo se invita a los aprobados, y las plazas pendientes ocupan sitio. Los árbitros se piden los suyos ahí o se los asigna la organización, y nadie puede arbitrar un lobby en el que juega. El árbitro lo abre desde Arbitrar y la web invita a los aprobados.
- **Lobbies extraordinarios**: un inscrito propone otra hora desde Qualis. Un árbitro o admin lo acepta (con esa hora u otra) y se crea un lobby X1, X2… de una plaza con ese jugador, o lo rechaza con un motivo.
- **Normas y novedades**: los admins reescriben las normas de la pestaña Info y publican un anuncio breve en Inicio desde el panel. Mientras las normas no se reescriban, sus cifras de bans y rango salen de la configuración; después, el texto queda fijo.
- **Recordatorios en Inicio**: la web muestra sola los partidos de las próximas 24 horas, los resultados de las últimas 24 horas y las mappools publicadas hace 3 días o menos, o programadas para los 3 días siguientes.
- **Enlaces del pie**: Discord y Twitch. Discord es solo un enlace, sin integración. Están en `enlaces`, en `config.json`, y se pueden cambiar desde el panel, en **Textos de la web** → **Enlaces del pie**.
- **Contenido editable**: desde el panel, los admins cambian el nombre del torneo, la comunidad, la presentación de Inicio, «Cómo funciona», las explicaciones de Qualis y Registro, los enlaces del pie y las rondas (nombre, fechas, SR y best of). Se guarda en la base de datos y se superpone a `config.json`, que sigue siendo el valor original al que se puede volver. Las rondas cambian el torneo de verdad, no solo lo que se ve.
- **Roles**: el host (`ADMIN_IDS`) asigna desde el panel quién es admin, árbitro o staff. Se aplica al momento. Staff ve las mappools antes de publicarse, sin entrar en el panel.
- **Resultados**: el admin pega el enlace del MP y la web cuenta los mapas ganados por cada jugador. Ignora los warmups (solo cuenta mapas del pool de la ronda) y aplica EZ ×1,8 y EZHD ×2 (en clasificatorios no hay multiplicadores). Mientras se juega, se actualiza sola cada 5 minutos.
- **Clasificatorios**: se añaden los MP de los lobbies; se toma el mejor score de cada jugador en cada mapa y se ordena por Z-sum. Solo cuentan los mapas jugados en head to head: un MP por equipos se rechaza, y si solo algunos mapas se jugaron así, el panel lo indica. Los resultados no son públicos hasta la hora que programe la organización; los admins y los árbitros los ven siempre, y son los únicos que ven los enlaces a los MP.
- **Arbitraje con bot de IRC**: los árbitros conectan su cuenta de osu! a Bancho desde la página **Arbitrar** y la web manda los comandos `!mp` por ellos. Crea el lobby, invita y reparte equipos, lee los `!roll` y lleva protects, bans y picks según las reglas de cada ronda; los jugadores pueden escribir su mapa en el chat. Además pone cada mapa con sus mods (FM y TB en FreeMod), empieza cuando los dos están listos y anuncia el marcador. También lleva lobbies de clasificatorios.
- **Cuadro de doble eliminación de 16**: los cruces y los ganadores avanzan solos a partir de las seeds y los resultados.
- **Directo de Twitch** (opcional): cuando el canal está en directo, la web lo anuncia en la cabecera y muestra una ventana pequeña con la miniatura del directo, que se puede abrir como reproductor en la propia web.

Sin dependencias: solo Node.js 22.13 o superior (usa `fetch` y `node:sqlite`, incluidos en Node). La imagen Docker usa Node 24.

La guía para la organización (cómo usar el panel durante el torneo) está aparte.

## 1. Crear la aplicación OAuth en osu!

1. Entra en osu.ppy.sh → **Ajustes de cuenta** → sección **OAuth** → **Nueva aplicación OAuth**.
2. Nombre: `SpiSix Fall Cup`. **Application Callback URL**: `https://NOMBRE.TAILNET.ts.net/auth/osu/callback`
   (para probar en local: `http://localhost:3000/auth/osu/callback`).
3. Copia el **Client ID** y el **Client Secret**. El secret no se publica nunca ni se pone en el frontend.

## 2. Configurar

Crea un archivo `.env` en la carpeta del proyecto. No lo subas nunca a GitHub ni lo compartas:

```bash
BASE_URL=https://NOMBRE.TAILNET.ts.net
OSU_CLIENT_ID=
OSU_CLIENT_SECRET=
ADMIN_IDS=
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
```

- `BASE_URL`: la dirección de Tailscale, sin barra final e igual que en el callback de osu! (el apartado 3 explica cómo saberla).
- `OSU_CLIENT_ID` y `OSU_CLIENT_SECRET`: los de la aplicación de osu!.
- `ADMIN_IDS`: IDs de osu! de los hosts, separados por comas (el número de la URL de cada perfil).
- `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET`: opcionales.

Los datos del torneo están en `config.json`: fechas de cada fase (hora de Madrid), SR, best of de cada ronda, rango permitido, países (`paises`: por ejemplo `["ES"]`, o `null` para no limitar), método de clasificatorios (`"zsum"` o `"suma"`), enlace del formulario de inscripción (`formulario`), enlaces del pie de página y más miembros del equipo que no tengan cuenta en la web (`"staff": [["Mappoolers", ["nombre1", "nombre2"]]]`). Las excepciones de rango se añaden desde la pestaña Admin; `rango.excepciones` en `config.json` sigue funcionando y se suma a las del panel.

### Twitch (opcional)

El canal va en `config.json` (`"twitch": "spi6_osu"`, solo el nombre). Para saber cuándo hay directo hace falta una aplicación de Twitch: en https://dev.twitch.tv/console/apps → **Register Your Application** (pide tener activada la verificación en dos pasos en Twitch). Como **OAuth Redirect URL** vale `http://localhost`, porque no se usa. **Category**: Website Integration. **Client Type**: Confidential. Copia el **Client ID**, pulsa **New Secret** y ponlos en `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET`. La puede registrar cualquier cuenta de Twitch: leer si un canal está en directo es público.

El servidor consulta el canal una vez por minuto con un token de aplicación (`GET /helix/streams`). Sin estas variables la web funciona igual, solo que no muestra el aviso de directo. El reproductor incrustado (`player.twitch.tv`) cumple las normas de Twitch: mínimo 400×300, empieza en silencio y en móvil no se incrusta, porque Twitch no deja que arranque solo; en su lugar hay un botón que abre Twitch.

### Árbitros y bot de IRC

No hace falta configurar nada en el servidor. El host (`ADMIN_IDS`) y los admins pueden arbitrar desde el principio; al resto, el host le da el rol de árbitro en Admin → **Roles**, con su nombre o enlace de osu!. Las reglas de cada ronda se cambian en Admin → **Reglas de arbitraje por ronda**:

- bans por jugador (por defecto 2);
- protects por jugador (por defecto 1);
- mapas entre tandas de bans (por defecto 4);
- segundos para elegir (por defecto 90).

La pestaña Info muestra esas reglas.

Cada árbitro usa su propia cuenta de osu! y su **contraseña IRC**, que no es la de la cuenta: la encuentra en https://osu.ppy.sh/home/account/edit#legacy-api → IRC. La pega en la página **Arbitrar** y la web se conecta a `irc.ppy.sh:6667` con su nombre de osu!. La contraseña:

- solo está en la memoria del servidor mientras dura la conexión;
- no se escribe en la base de datos ni en los logs;
- se olvida al desconectar, al cerrar sesión, al quitar al árbitro o tras 3 horas sin usar la página.

Bancho solo ofrece IRC sin cifrar. Es lo mismo que hace cualquier cliente IRC de osu!, pero conviene saberlo.

El servidor necesita poder salir al puerto 6667 (las conexiones de casa lo permiten casi siempre).

Bancho deja a una cuenta normal 10 mensajes cada 5 segundos ([wiki de osu!](https://osu.ppy.sh/wiki/en/Bot_account)). El bot manda como mucho 8 cada 5 segundos y 18 cada 25 (el valor por defecto de bancho.js), para dejar margen a lo que el árbitro escriba desde el juego; lo que no cabe lo pone en cola. Cuenta por cuenta de osu!, así que reconectar no reinicia el límite. Tampoco repite el mismo aviso en 10 segundos (por ejemplo, si un jugador escribe varias veces un pick no válido). Después de cada mapa lee el MP en la API de osu!, como mucho una vez por minuto por MP, que es lo que piden sus términos de uso. Con ese resultado anuncia el marcador y el siguiente turno.

osu! solo deja tener 4 lobbies de torneo abiertos por cuenta. Si se llega a ese límite, la web lo dice al crear el lobby; hay que cerrar los anteriores.

## 3. Publicar con Tailscale Funnel

Necesitas un ordenador encendido durante el torneo, con Docker y Tailscale (1 vCPU y 512 MB de RAM sobran). No hace falta dominio ni abrir puertos en el router: Tailscale recibe las visitas, pone el HTTPS y las reenvía a este ordenador.

1. Descarga el proyecto:

   ```bash
   git clone https://github.com/xFine09/spisix-fall-cup.git
   cd spisix-fall-cup
   ```

2. Averigua la dirección que tendrá la web (quita el punto final):

   ```bash
   tailscale status --json | grep -m1 '"DNSName"'
   ```

   Es `https://` + ese nombre, por ejemplo `https://servidor.tu-red.ts.net`. Es pública e incluye el nombre de tu red de Tailscale.

3. Pon esa dirección + `/auth/osu/callback` como callback de la aplicación de osu! (apartado 1).

4. Crea el `.env` (apartado 2) y arranca la web:

   ```bash
   docker compose up -d --build
   docker compose logs -f        # Ctrl+C para salir; debe aparecer "SpiSix: Fall Cup en https://..."
   curl http://127.0.0.1:3000/healthz   # debe responder {"ok":true}
   ```

5. Publícala:

   ```bash
   tailscale funnel --bg 3000
   ```

   La primera vez, Tailscale da un enlace para activar Funnel en tu red. El DNS público puede tardar hasta 10 minutos.

6. Comprueba desde fuera de tu red (por ejemplo, con el móvil sin Wi-Fi) que `https://NOMBRE.TAILNET.ts.net/healthz` responde `{"ok":true}`. Después, inicia sesión con una cuenta de host y mira que aparece la pestaña Admin.

La web solo escucha en `127.0.0.1:3000`, así que desde fuera solo se entra por Funnel. Docker usa `/healthz` como healthcheck (`docker compose ps` muestra `healthy`). Funnel tiene un límite de ancho de banda que no se puede configurar; la web pesa poco, y las portadas de los mapas y el directo de Twitch se cargan desde osu! y Twitch.

| Funnel | Comando |
|---|---|
| Ver qué se está publicando | `tailscale funnel status` |
| Quitar la web de internet (sigue funcionando en local) | `tailscale funnel reset` |

| Tarea | Comando |
|---|---|
| Cambiar `config.json` | `docker compose up -d --force-recreate web` |
| Cambiar `.env` (p. ej. añadir un admin) | `docker compose up -d` |
| Actualizar el código | `git pull` y `docker compose up -d --build` |
| Ver errores | `docker compose logs --tail 100 web` |
| Copia de seguridad manual | `docker compose exec web node scripts/backup.js` |
| Bajar las copias a tu ordenador | `docker compose cp web:/data/backups ./backups` |

Los cambios en `config.json` y `.env` se leen al arrancar: la web se reinicia en un par de segundos y no se pierde nada (los datos están en el volumen `spisix-data`).

Para probar en local sin Docker: `npm start` (lee el `.env` solo) y abre `http://localhost:3000`. Para el login en local, el callback de osu! debe ser `http://localhost:3000/auth/osu/callback`.

### Copias de seguridad

La web hace una copia de la base de datos al arrancar y una vez al día en `/data/backups` (dentro del volumen) y guarda las 14 últimas. Están en el mismo disco que la web: bájalas de vez en cuando a otro sitio con `docker compose cp`, sobre todo antes de cada ronda.

Para restaurar una copia:

```bash
docker compose stop web
docker compose cp ./backups/spisix-AAAA-MM-DD.db web:/data/spisix.db
docker compose run --rm --user root --entrypoint sh web -c 'rm -f /data/spisix.db-wal /data/spisix.db-shm && chown node:node /data/spisix.db'
docker compose start web
```

## 4. Uso durante el torneo (pestaña Admin)

| Momento | Qué hacer |
|---|---|
| Antes de cada showcase | **Publicación de mappools**: fecha y hora a la que se hace pública la pool de cada ronda. Si no se programa, a las 00:00 del día del showcase. **Publicar ya** la hace pública en el momento. |
| Showcase de cada ronda | **Mappool**: ronda, slot (`NM1`, `HD2`, `FM1`, `TB`…) y enlace del mapa. O **Importar mappools desde una hoja**: subir el archivo (`.xlsx`, `.ods`, `.csv`, hasta 20 MB) o pegar las filas, revisar lo entendido y elegir la ronda de cada pool. Sustituye la ronda; es todo o nada: si falla un mapa, esa ronda se queda como estaba. |
| Clasificatorios | **Lobbies de clasificatorios**: pegar el enlace de cada MP. Se releen solos durante la fase. |
| Al acabar los clasificatorios | **Resultados de clasificatorios**: fecha y hora a la que se hacen públicos las scores, las seeds y el cuadro. Hasta entonces, y sin fecha programada, solo los ven los admins y los árbitros. **Publicar ya** los hace públicos en el momento y **Ocultar** los vuelve a esconder. Los enlaces a los MP de los lobbies solo los ven admins y árbitros, también después. |
| Al programar un partido | **Partido**: fecha (hora de Madrid) y árbitro. |
| Al empezar el partido | **Arbitrar** → elegir el partido → **Crear el lobby**: el MP, los bans y los protects se guardan solos. Si se arbitra a mano en osu!, pegar el enlace del MP en **Partido** y escribir los bans (`NM2, HD1`), porque la API no los registra. |
| Antes de cada ronda | **Reglas de arbitraje por ronda**: bans, protects, mapas entre tandas y segundos para elegir. |
| Hay un admin, árbitro o staff nuevo (solo el host) | **Roles**: su nombre o enlace de osu! y el rol. Se aplica al momento. |
| Antes de los clasificatorios | **Lobbies de clasificatorios**: **Crear la rejilla** con días, horas y plazas, y **Un lobby suelto** para horas especiales. Los jugadores se apuntan en Qualis; aquí se puede añadir o quitar a cualquiera y elegir el árbitro de cada lobby. Si sobran, **Quitar los vacíos de este día**. |
| Si alguien no se presenta | **Forfeit** → gana A o B. |
| Alguien fuera de rango que sí puede jugar no entra al importar | **Excepciones de rango**: pegar el enlace de su perfil, y volver a importar. |
| Hay inscritos en el formulario de Google | **Importar del formulario**: en la hoja de respuestas, Ctrl+A, Ctrl+C y pegar. Si la hoja tiene una columna de Discord, se ignora. |

La importación busca los nombres exactos de 50 en 50 (`GET /users/lookup`) y los que falten uno a uno con `GET /users/@nombre/osu`, que también encuentra nombres antiguos y no distingue espacios de guiones bajos. Quien esté fuera de rango no se inscribe: sale en el informe para añadirle una excepción y volver a importar. Quien ya estuviera inscrito por la web conserva sus datos, y quien se borró o quitó la organización no vuelve a entrar al importar.

### Página Arbitrar

1. **Conectar con Bancho** con la contraseña IRC.
2. Elegir el partido en la lista y pulsar **Crear el lobby**. El nombre es `SPI6: (A) vs (B)`, con TeamVS y ScoreV2; invita a los dos jugadores y pone a A en rojo y a B en azul.
3. **Roll**: la web lee el `!roll` de los dos. Solo vale sin número y, si empatan, pide repetirlo. También se puede apuntar a mano.
4. **Orden**: quien gana el roll dice quién protege, banea y elige primero, y el árbitro lo elige en tres desplegables.
5. **Protects, bans y picks**: la web dice en el chat a quién le toca y pone el temporizador. El jugador escribe el mapa en el chat (`NM2`) o el árbitro lo pulsa en la web. La web aplica estas reglas:
   - no se puede banear un mapa protegido;
   - nadie puede banear ni elegir el mismo mod que en su ban o pick anterior;
   - los bans van por tandas ABBA, con la segunda tanda tras los mapas indicados en las reglas de la ronda;
   - los picks se alternan desde el First Pick;
   - el TB (FreeMod) se pone al empatar a un mapa de ganar.
6. Cada pick pone el mapa con `!mp map` y los mods con `!mp mods` (NM con NF; HD, HR y DT con NF y el mod; FM y TB en FreeMod). El mapa empieza solo cuando los dos están listos. Al terminar, la web lee el MP y anuncia el marcador y el siguiente turno.
7. Durante el partido:
   - **Deshacer** quita el último paso apuntado;
   - **Apuntar a mano** se salta el turno y las reglas para corregir algo;
   - el chat de la página manda cualquier mensaje o comando al lobby;
   - **Poner warmup** pone un mapa fuera del pool, que no cuenta.

Si la conexión se corta, la web reconecta y vuelve a entrar en los lobbies abiertos. Si se reinicia el servidor, basta con volver a conectar y pulsar **Volver a entrar al MP**. Sin conectar a Bancho, la página sirve para apuntar el roll, los protects, los bans y los picks de un partido arbitrado a mano.

Los **lobbies de clasificatorios** se crean desde la misma página en HeadToHead con ScoreV2: los que preparó la organización, con sus plazas y sus jugadores aprobados invitados, o uno suelto con un nombre (`Lobby A`). Al volver a entrar en un lobby, si no está en HeadToHead con ScoreV2, la web lo corrige. El árbitro pulsa **Empezar la mappool**; al terminar cada mapa, la web pone el siguiente. Para repetir un mapa, se pulsa ese mapa.

Los árbitros tienen que crear los lobbies con `!mp make`, nunca con `!mp makeprivate`: osu! solo deja leer un lobby privado a quienes jugaron en él, y la web lo lee con un token de aplicación (comprobado en osu-web, `OsuAuthorize::checkMatchView`). Si alguno es privado, la web lo dice al pegar el enlace.

El cuadro se completa al terminar los clasificatorios (y solo si al menos 16 inscritos tienen scores): seeds 1 – 16 por Z-sum, y desde ahí cada resultado mueve a ganador y perdedor a su siguiente partido. La Grand Final es un único partido (sin bracket reset).

Las seeds se calculan a partir de los inscritos. Quitar a un jugador después de los clasificatorios sube al 17.º al cuadro, lo cual sirve para sustituir a alguien que se retira antes de octavos; una vez empezados los partidos, usa un forfeit en su lugar o los cruces ya jugados cambiarían.

## Endpoints de la API de osu! que se usan

| Para qué | Endpoint | Token |
|---|---|---|
| Login | `GET /oauth/authorize`, `POST /oauth/token` (`authorization_code`) | — |
| Perfil de quien inicia sesión | `GET /api/v2/me/osu` | del usuario (scope `identify`) |
| Rango al importar / actualizar rangos | `GET /api/v2/users/{id}/osu` | de aplicación (`client_credentials`, scope `public`) |
| Importar el formulario | `GET /api/v2/users/lookup` (50 nombres por petición) y `GET /api/v2/users/@{nombre}/osu` | de aplicación |
| Datos del mapa | `GET /api/v2/beatmaps/{id}` | de aplicación |
| SR con HR o DT | `POST /api/v2/beatmaps/{id}/attributes` | de aplicación |
| Resultados y clasificatorios | `GET /api/v2/matches/{id}` (con `before` para partidos de más de 100 eventos) | de aplicación |

Se hace como mucho una petición por segundo, como pide la documentación de osu! (máximo 60 por minuto). Cada partido en juego se relee cada 5 minutos, por encima del mínimo de un minuto que piden los términos de uso de la API. Las respuestas se piden en el formato por defecto (sin `x-api-version`), en el que cada score trae `score` y `mods` como lista de siglas.

## Comandos de Bancho (IRC) que usa el bot de arbitraje

`!mp make`, `!mp set 2 3 2` (TeamVS, ScoreV2, 2 plazas) o `!mp set 0 3 16` (clasificatorios), `!mp invite #<id>`, `!mp team #<id> red|blue`, `!mp map <id> 0`, `!mp mods`, `!mp timer`, `!mp aborttimer`, `!mp start 5`, `!mp abort`, `!mp settings` y `!mp close`. Lee los mensajes de BanchoBot del canal `#mp_<id>`: jugadores que entran o salen, cambios de equipo, `!roll`, cambios de mapa, «All players are ready», scores al terminar y «The match has finished!».

A los jugadores del cuadro se les invita y se les cambia de equipo por su ID (`#<id>`), que funciona aunque el nombre tenga espacios o haya cambiado. El anti-spam de Bancho puede descartar un comando igual al anterior, así que, como hace [bancho.js](https://bancho.js.org), los comandos `map`, `mods`, `set`, `timer`, `start`, `abort`, `aborttimer`, `settings` y `close` llevan al final una palabra al azar que Bancho no lee (por ejemplo `!mp start 5 k3x9qa`). Se ve así en el chat del lobby, pero no en el registro de la página.

## Endpoints de Twitch que se usan

| Para qué | Endpoint |
|---|---|
| Token de aplicación | `POST https://id.twitch.tv/oauth2/token` (`client_credentials`) |
| Saber si hay directo | `GET https://api.twitch.tv/helix/streams?user_login=CANAL`, una vez por minuto |

## Pruebas

```bash
npm test
```

Levanta una API de osu!, un Twitch y un Bancho simulados y comprueba login, rechazo por rango, excepciones, importación del formulario y de mappools, lobbies de clasificatorios, roles, permisos del panel, mappool, resultados (warmups, paginación, EZ ×1,8), clasificatorios, publicación programada de mappools, peticiones malformadas. Después arranca un segundo servidor con el reloj adelantado a octavos, 16 inscritos y un clasificatorio, para probar el aviso de directo de Twitch, que las pools se publiquen solas pasado el showcase y los partidos de octavos con forfeit y con resultado desde el MP. Con un Bancho simulado, juega también un partido entero desde la página Arbitrar:

- contraseña IRC rechazada y aceptada;
- lobby, equipos y `!roll`;
- protects, bans y picks por el chat y por la web, con sus reglas;
- marcador leído de la API;
- deshacer, apuntar a mano y reconexión;
- un lobby de clasificatorios;
- que la contraseña IRC no acabe ni en la base de datos ni en el log.

No necesita conexión ni credenciales.

## Estructura

```
server.js            rutas HTTP, sesiones, sincronización automática
server/osu.js        cliente de la API de osu! (OAuth, límite de peticiones)
server/results.js    cálculo de mapas, partidos y clasificatorios
server/import.js     interpretación de hojas: respuestas del formulario y mappools (slots, rondas, IDs)
server/sheet.js      lectura de archivos .xlsx, .ods y .csv, sin dependencias
server/twitch.js     estado del directo de Twitch (Helix)
server/bracket.js    seeds y cruces en el servidor, para el arbitraje (misma lógica que compute() de la web)
server/irc.js        cliente IRC de Bancho (con cola para el límite de mensajes)
server/refflow.js    turnos del partido: roll, orden, protects, bans ABBA, picks y TB
server/referee.js    bot de arbitraje: conexiones de los árbitros, mensajes de BanchoBot y comandos !mp
server/db.js         SQLite y copias de seguridad
server/config.js     lectura de config.json y fechas en hora de Madrid
public/index.html    la web (sin servidor muestra datos de ejemplo)
test/e2e.js          prueba completa con osu!, Twitch y Bancho simulados
scripts/backup.js    copia manual de la base de datos
Dockerfile, docker-compose.yml   despliegue con Docker (el HTTPS lo pone Tailscale Funnel)
```
