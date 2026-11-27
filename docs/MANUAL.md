# Manual técnico de SpiSix: Fall Cup

Detalle completo para quien instala y mantiene la web. El resumen está en el [README](../README.md).

## Funciones

- **Login con osu!** (OAuth). El jugador no escribe su rango: se lee de su perfil.
- **Registro por el formulario de Google**: la inscripción se hace solo allí. El admin pega la hoja de respuestas y la web busca a cada jugador en osu!, comprueba su rango (#100.000 – #999.999, con excepciones de rango) y lo inscribe. Se puede repetir sin duplicar a nadie. El enlace del formulario va en `formulario`, en `config.json`.
- **Mappool**: el admin pega el ID o el enlace del mapa y la web pide a osu! el nombre, la dificultad, la portada y el SR con el mod del slot (HR/DT). También se puede pegar la ronda entera desde una hoja de cálculo (por ejemplo, la pestaña Mappools de una hoja principal): basta con que cada fila tenga el slot y el ID o el enlace.
- **Publicación programada de mappools**: se suben cuando se quiera y hasta la hora de publicación solo las ven los admins y el staff. El servidor no las envía a nadie más. Sin hora programada se publican a las 00:00 del día del showcase.
- **Lobbies de clasificatorios**: los admins crean de una vez la rejilla de lobbies (cada día una letra y cada hora un número: A1, A2… B1, B2…, con 8 plazas por defecto; no crea los que ya han pasado ni los que empezarían en la última media hora de la fase, cuando ya no llegarían a contar para las seeds) y lobbies sueltos para horas especiales. Los inscritos se apuntan en la pestaña Qualis (un lobby por jugador, hasta la hora a la que empiece) y un árbitro o admin aprueba o rechaza cada plaza. Solo se invita a los aprobados, y las plazas pendientes ocupan sitio. Los árbitros se piden los suyos ahí o se los asigna la organización, y nadie puede arbitrar un lobby en el que juega. El árbitro lo abre desde Arbitrar y la web invita a los aprobados. Cuando llega su hora, cada lobby sale en Qualis (y en el panel) como **Jugándose** si ya tiene MP, **Terminado** cuando osu! lo da por cerrado (`!mp close`) o ya se ha jugado toda la mappool, o **Empezado** si nadie lo ha abierto desde la web. Si algo se queda mal por un fallo, cualquier árbitro lo corrige en Qualis con **Corregir**: fija el estado del lobby a mano (o lo devuelve a automático) y pasa cada plaza de aprobada a pendiente o al revés, en cualquier momento. Una plaza pendiente no cuenta como jugada, así que ese jugador puede apuntarse a otro lobby. Quien ya tiene scores en algún MP de clasificatorios queda aprobado siempre, aunque nadie llegara a aprobar su plaza: la web lo hace sola al leer cada MP y al arrancar.
- **Lobbies extraordinarios**: un inscrito propone otra hora desde Qualis. Un árbitro o admin lo acepta (con esa hora u otra) y se crea un lobby X1, X2… de una plaza con ese jugador, o lo rechaza con un motivo.
- **Normas y novedades**: los admins reescriben las normas de la pestaña Info y publican un anuncio breve en Inicio desde el panel. Mientras las normas no se reescriban, sus cifras de bans y rango salen de la configuración; después, el texto queda fijo.
- **Recordatorios en Inicio**: la web muestra sola los partidos de las próximas 24 horas, los resultados de las últimas 24 horas y las mappools publicadas hace 3 días o menos, o programadas para los 3 días siguientes.
- **Enlaces del pie**: Discord y Twitch. Discord es solo un enlace, sin integración. Están en `enlaces`, en `config.json`, y se pueden cambiar desde el panel, en **Textos de la web** → **Enlaces del pie**.
- **Contenido editable**: desde el panel, los admins cambian el nombre del torneo, la comunidad, la presentación de Inicio, «Cómo funciona», las explicaciones de Qualis y Registro, los enlaces del pie y las rondas (nombre, fechas, SR y best of). Se guarda en la base de datos y se superpone a `config.json`, que sigue siendo el valor original al que se puede volver. Las rondas cambian el torneo de verdad, no solo lo que se ve.
- **Roles**: el host (`ADMIN_IDS`) asigna desde el panel quién es admin, árbitro o staff. Se aplica al momento. Staff ve las mappools antes de publicarse, sin entrar en el panel.
- **Resultados**: el admin pega el enlace del MP y la web cuenta los mapas ganados por cada jugador. De cada jugador y mapa guarda también la puntuación, la precisión, el combo, los 300/100/50/fallos, los mods y la letra del rank si osu! la manda (en los clasificatorios, los de su mejor score). Ignora los warmups (solo cuenta mapas del pool de la ronda) y, en los partidos del cuadro, todo lo que se juegue cuando un jugador ya ha ganado el partido (el TB u otros mapas de showmatch no cuentan ni dan puntos). Aplica EZ ×1,8 y EZHD ×2 (en clasificatorios no hay multiplicadores). Mientras se juega, se actualiza sola cada 5 minutos.
- **Clasificatorios**: se añaden los MP de los lobbies; se toma el mejor score de cada jugador en cada mapa y se ordena por Z-sum. Solo cuentan los mapas jugados en head to head: un MP por equipos se rechaza, y si solo algunos mapas se jugaron así, el panel lo indica. Los resultados no son públicos hasta la hora que programe la organización; los admins y los árbitros los ven siempre, y son los únicos que ven los enlaces a los MP.
- **Arbitraje con bot de IRC**: los árbitros conectan su cuenta de osu! a Bancho desde la página **Arbitrar**. Cada partido del cuadro tiene un bot por fases (lobby, warmups, rolls, protects, bans, picks, ready, mapa y fin) que funciona en dos modos, que el árbitro cambia en cualquier momento con un interruptor: **SEMI** (por defecto), en el que cada paso que haría el bot sale como un botón con su texto exacto y no se manda nada al lobby hasta pulsarlo, y **AUTO**, en el que el bot hace cada paso él solo. El bot lee el chat (rolls, «sí»/«no», códigos de mapa como `NM2`), rechaza explicando el motivo lo que no vale, lleva el turno de protects, bans y picks según las reglas de cada ronda, pone cada mapa con sus mods (FM y TB en FreeMod), pide el ready con temporizador y lee el resultado de cada mapa en la API de osu!. Nunca sanciona, descalifica ni da un partido por perdido: avisa y espera al árbitro. Ver [Bot de arbitraje: modos y fases](#bot-de-arbitraje-modos-y-fases). Todo lo apuntado se puede deshacer paso a paso o empezar de cero. Un partido arbitrado sin los botones se puede **completar después del partido**: con el orden y las listas de protects, bans y picks, la web reparte cada paso con las reglas de la ronda. También lleva lobbies de clasificatorios.
- **Cuadro de doble eliminación de 16**: los cruces y los ganadores avanzan solos a partir de las seeds y los resultados.
- **Stats**: estadísticas de cada ronda, con una pestaña por ronda de `config.json` y dos vistas: **Resultados individuales** (match cost, avg. score, avg. acc, mapas jugados y mejor score de cada jugador; en clasificatorios, la Z-sum en lugar del match cost) y **Leaderboard por mapa** (todos los scores de cada mapa de la pool, de mayor a menor). Se publican a mano, ronda a ronda, cuando la ronda ha terminado; antes solo las ven los admins. Ver [Estadísticas de cada ronda](#estadísticas-de-cada-ronda-get-apistats).
- **Ficha del jugador**: en Jugadores, al pulsar a un inscrito (en Inscritos o en la tabla de Clasificatorios) se abre su ficha: avatar, país, rango global y de país, pp, precisión, partidas jugadas y una gráfica de su rango en los últimos 90 días, con «Ver sus partidos» y el enlace a su perfil de osu!. Su dirección es `#jugadores/ficha/<ID de osu!>`. Los datos no se piden a osu! al abrir la ficha: la sincronización automática guarda una vez al día una foto del perfil público de cada inscrito (`GET /users/{id}/osu`, uno a uno por la cola de 1 petición por segundo; `/users/lookup` no trae el historial de rango, el rango de país ni las pp) y la ficha enseña la última y su fecha. Al importar inscritos, la foto de los nuevos se toma en ese momento. Si osu! falla, se queda la foto anterior y ese jugador se vuelve a intentar pasada una hora. **Actualizar rangos**, en el panel, también renueva las fotos.
- **o!TR en la ficha** (opcional, con `OTR_API_KEY`): una sección «o!TR · otros torneos» con el rating de torneo (TR), el tier, el percentil y el rango global en o!TR, los torneos jugados, el % de partidos ganados. Se ve también antes de que se publiquen los resultados de clasificatorios, porque no sale de este torneo. Quien no tiene torneos verificados sale como «Sin rating de o!TR». Una vez al día, después de las fotos de osu!, la web pide `GET /api/players/{id}/stats` de cada inscrito (y al importar, de los nuevos), por su propia cola de una petición cada 1,5 segundos, y guarda la última foto buena. Si o!TR falla, se queda la anterior; también si responde 404 para alguien que ya tenía datos, porque es más probable un cambio en su API que una baja. **Actualizar rangos** también la renueva.
- **Skills en el torneo**: la ficha muestra 5 barras (aim, velocidad, precisión, accuracy y resistencia) con el percentil frente al resto de inscritos con datos («mejor que el 70 % del torneo») y una flecha con el cambio, en puntos de percentil, desde los clasificatorios. Debajo, el **rendimiento por mod** (NM, HD, HR, DT y FM; el TB cuenta como FM), con el origen de cada columna: z medio en los mapas de clasificatorios de ese mod, mapas ganados en el cuadro y, de o!TR, mapas y puntuación media en otros torneos. Todo sale de partidos de torneo; no se usan las puntuaciones del perfil de osu!. Lo sacado de los clasificatorios (skills, columnas de clasificatorios y cuadro) no se enseña hasta que se publiquen sus resultados (los árbitros y admins lo ven antes, como los resultados); hasta entonces la ficha solo tiene o!TR. Se recalcula todo desde cero cada vez que cambian los datos, así que corregir un resultado deja las skills bien. El cálculo, en «Skills del torneo».
- **Partidos de un jugador**: en Partidos, el selector **Jugador** muestra todos los partidos de un inscrito en todas las rondas, con el resultado, el rival, la ronda y el enlace al MP, y un resumen de partidos y mapas ganados y perdidos. Sale de los datos que la web ya tiene, sin pedir nada a osu!. Su dirección es `#partidos/jugador/<ID de osu!>`.
- **Directo de Twitch** (opcional): cuando el canal está en directo, la web lo anuncia en la cabecera y muestra una ventana pequeña con la miniatura del directo, que se puede abrir como reproductor en la propia web.
- **Web**: tema claro u oscuro (el del sistema, o el que se elija con el botón de la cabecera, que se recuerda en ese navegador). Las pestañas van en la dirección, así que se pueden enlazar: `#mappool/semis`, `#partidos/cuartos`, `#jugadores/clasif`, `#jugadores/ficha/<ID>`, `#partidos/jugador/<ID>`. Al compartir el enlace, Discord y otras redes muestran `public/og.png`; si se cambia el nombre del torneo, esa imagen hay que rehacerla a mano. En Admin y Registro, el navegador avisa antes de cerrar la página si hay algo escrito sin guardar.

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
OTR_API_KEY=
```

- `BASE_URL`: la dirección de Tailscale, sin barra final e igual que en el callback de osu! (el apartado 3 explica cómo saberla).
- `OSU_CLIENT_ID` y `OSU_CLIENT_SECRET`: los de la aplicación de osu!.
- `ADMIN_IDS`: IDs de osu! de los hosts, separados por comas (el número de la URL de cada perfil).
- `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET`: opcionales.
- `OTR_API_KEY`: opcional, la clave de la API de o!TR (apartado «o!TR»).

Los datos del torneo están en `config.json`: fechas de cada fase (hora de Madrid), SR, best of de cada ronda, rango permitido, países (`paises`: por ejemplo `["ES"]`, o `null` para no limitar), método de clasificatorios (`"zsum"` o `"suma"`), enlace del formulario de inscripción (`formulario`), enlaces del pie de página y más miembros del equipo que no tengan cuenta en la web (`"staff": [["Mappoolers", ["nombre1", "nombre2"]]]`). Las excepciones de rango se añaden desde la pestaña Admin; `rango.excepciones` en `config.json` sigue funcionando y se suma a las del panel.

### o!TR (opcional)

La ficha del jugador puede mostrar sus datos de [o!TR](https://otr.stagec.net) (osu! Tournament Rating). Su API necesita una clave: inicia sesión en o!TR, ve a **Settings** (`https://otr.stagec.net/settings`) y crea una (hasta 3 por cuenta; solo se ve una vez, cópiala al crearla). Ponla en `OTR_API_KEY` y reinicia la web. La clave solo se manda a o!TR en la cabecera `Authorization`; no se guarda en la base de datos ni sale en el log. o!TR deja 60 peticiones por minuto por clave y la web hace como mucho 40 al minuto, así que también caben las que haga otra herramienta con la misma clave. Sin clave, la web funciona igual sin esa sección (al arrancar lo dice en el log).

La web de o!TR está detrás de una protección de Cloudflare. Comprueba desde el servidor que la API responde: `curl -s -o /dev/null -w '%{http_code}\n' https://otr.stagec.net/api/health` debe dar `200`.

### Twitch (opcional)

El canal va en `config.json` (`"twitch": "spi6_osu"`, solo el nombre). Para saber cuándo hay directo hace falta una aplicación de Twitch: en https://dev.twitch.tv/console/apps → **Register Your Application** (pide tener activada la verificación en dos pasos en Twitch). Como **OAuth Redirect URL** vale `http://localhost`, porque no se usa. **Category**: Website Integration. **Client Type**: Confidential. Copia el **Client ID**, pulsa **New Secret** y ponlos en `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET`. La puede registrar cualquier cuenta de Twitch: leer si un canal está en directo es público.

El servidor consulta el canal una vez por minuto con un token de aplicación (`GET /helix/streams`). Sin estas variables la web funciona igual, solo que no muestra el aviso de directo. El reproductor incrustado (`player.twitch.tv`) cumple las normas de Twitch: mínimo 400×300, empieza en silencio y en móvil no se incrusta, porque Twitch no deja que arranque solo; en su lugar hay un botón que abre Twitch.

### Árbitros y bot de IRC

No hace falta configurar nada en el servidor. El host (`ADMIN_IDS`) y los admins pueden arbitrar desde el principio; al resto, el host le da el rol de árbitro en Admin → **Roles**, con su nombre o enlace de osu!. Las reglas de cada ronda se cambian en Admin → **Reglas de arbitraje por ronda**:

- bans por jugador (por defecto 2);
- protects por jugador (por defecto 1);
- mapas entre tandas de bans (por defecto 4);
- segundos para elegir (por defecto 90; con 0, sin temporizador);
- segundos para el ready (por defecto 30, de 10 a 300);
- minutos de ausencia antes de avisar al staff (por defecto 15, de 1 a 60);
- segundos entre invitaciones a quien no ha llegado (por defecto 60, de 15 a 600);
- advertencias por no estar listo antes de avisar al staff (por defecto 3, de 1 a 10).

La pestaña Info muestra los bans, los protects y los mapas entre tandas. Las horas por defecto de los lobbies no dependen de estas reglas.

Cada árbitro usa su propia cuenta de osu! y su **contraseña IRC**, que no es la de la cuenta: la encuentra en https://osu.ppy.sh/home/account/edit#legacy-api → IRC. La pega en la página **Arbitrar** y la web se conecta a `irc.ppy.sh:6667` con su nombre de osu!. La contraseña:

- solo está en la memoria del servidor mientras dura la conexión;
- no se escribe en la base de datos ni en los logs;
- se olvida al desconectar, al cerrar sesión, al quitar al árbitro o tras 3 horas sin usar la página.

Bancho solo ofrece IRC sin cifrar. Es lo mismo que hace cualquier cliente IRC de osu!, pero conviene saberlo.

El servidor necesita poder salir al puerto 6667 (las conexiones de casa lo permiten casi siempre).

Bancho deja a una cuenta normal 10 mensajes cada 5 segundos ([wiki de osu!](https://osu.ppy.sh/wiki/en/Bot_account)). El bot manda como mucho 8 cada 5 segundos y 18 cada 25 (el valor por defecto de bancho.js), para dejar margen a lo que el árbitro escriba desde el juego; lo que no cabe lo pone en cola. Cuenta por cuenta de osu!, así que reconectar no reinicia el límite. Después de cada mapa lee el MP en la API de osu!, como mucho una vez por minuto por MP, que es lo que piden sus términos de uso. El marcador se actualiza en la página; lo anuncia el bot tras cada mapa (en SEMI, al pulsar su botón) o el árbitro con **Marcador**. En AUTO, el bot hace como mucho un paso cada 1,25 s y todo pasa por la misma cola, así que nunca manda ráfagas.

Qué manda cada botón de **Arbitrar** (el comando exacto sale al pasar el ratón por encima):

| Botón | Lo que se manda al lobby |
|---|---|
| Bot: cada paso (en SEMI) | lo que pone el propio botón: `!mp make`, `!mp set 2 3 2`, `!mp password`, `!mp invite`, `!mp team`, `!mp kick`, `!mp host`, `!mp clearhost`, `!mp map`, `!mp mods`, `!mp timer`, `!mp start 5`, `!mp settings` o el mensaje del paso |
| Bot: Pausar, Deshacer, Saltar, Marcar incidencia, AUTO/SEMI | nada (al pasar a SEMI se quita de la cola lo que el bot aún no había mandado) |
| Crear lobby (clasificatorios) | `!mp make`, `!mp set 0 3 <plazas>` e invitaciones |
| Poner equipos | `!mp team #A red` y `!mp team #B blue` |
| Gana A / Gana B | quién gana el roll (el de protects o, tras los protects, el de bans y picks) y qué elige |
| Guardar el orden | tras el primer roll, quién protege primero; tras el segundo, quién banea primero y quién elige primero |
| Un mapa en protects o bans | «A protege NM1» o «B banea DT1» (y para el temporizador si estaba puesto) |
| Un mapa en picks / Poner el TB | `!mp map`, `!mp mods` y el anuncio del mapa |
| Empezar, Abortar, Temporizador, Parar temporizador | `!mp start 5`, `!mp abort`, `!mp timer <s>`, `!mp aborttimer` |
| HeadToHead y ScoreV2 (clasificatorios) | `!mp set 0 3` (si `!mp settings` muestra otro modo, la página lo avisa) |
| Mensajes: Bienvenida, Repetir el roll, Roll sin número, Turno, Marcador, GG (en clasificatorios: Bienvenida y Fin de la mappool) | ese mensaje, tal cual |
| Deshacer último paso / Empezar de cero | nada: solo cambia lo apuntado en la web |

El chat del lobby también admite cualquier mensaje o comando escrito a mano.

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
| Al terminar cada ronda | **Publicación de estadísticas**: revisar la ronda en Stats (los admins la ven antes como vista previa) y pulsar **Publicar**. Solo se puede cuando todos sus partidos tienen ganador (en clasificatorios, al pasar su fecha de fin y con los resultados publicados). **Ocultar** las vuelve a dejar solo para los admins. |
| Al empezar el partido | **Arbitrar** → elegir el partido → en la tarjeta **Bot**, elegir **SEMI** o **AUTO** y pulsar **Iniciar partido** (en AUTO también empieza solo a la hora del partido si quien lo lleva está conectado a Bancho). El MP, los protects, los bans y los picks quedan guardados. Ver [Bot de arbitraje: modos y fases](#bot-de-arbitraje-modos-y-fases). Si se arbitra a mano en osu!, pegar el enlace del MP en **Partido** y escribir los bans (`NM2, HD1`), porque la API no los registra. |
| Antes de cada ronda | **Reglas de arbitraje por ronda**: bans, protects, mapas entre tandas, segundos para elegir y para el ready, minutos de ausencia, segundos entre invitaciones y advertencias antes de avisar al staff. |
| El bot espera una decisión (aviso rojo en Arbitrar) | Leer el aviso y decidir con sus botones. Ver [Qué hacer ante incidencias](#qué-hacer-ante-incidencias). El bot no sanciona ni da partidos por perdidos: un forfeit se pone en **Partido**. |
| Hay un admin, árbitro o staff nuevo (solo el host) | **Roles**: su nombre o enlace de osu! y el rol. Se aplica al momento. |
| Antes de los clasificatorios | **Lobbies de clasificatorios**: **Crear la rejilla** con días, horas y plazas, y **Un lobby suelto** para horas especiales. Los jugadores se apuntan en Qualis; aquí se puede añadir o quitar a cualquiera y elegir el árbitro de cada lobby. Si sobran, **Quitar los vacíos de este día**. |
| Si alguien no se presenta | **Forfeit** → gana A o B. |
| Un partido se arbitró sin los botones de Arbitrar | Un árbitro o admin abre el partido en **Arbitrar** → **Completar después del partido**: quién protege, banea y elige primero, los protects, los bans en el orden en que se dijeron y los picks, que vienen rellenos con el MP. Ver [Completar un partido después de jugarlo](#completar-un-partido-después-de-jugarlo). |
| Alguien fuera de rango que sí puede jugar no entra al importar | **Excepciones de rango**: pegar el enlace de su perfil, y volver a importar. |
| Alguien va a leer los datos de los partidos desde otra web u OBS | **Guía de la API**: su nombre o enlace de osu!, y pasarle el enlace `/api.html`. Tiene que iniciar sesión con esa cuenta para verla. No le da ningún otro permiso. |
| Hay inscritos en el formulario de Google | **Importar del formulario**: en la hoja de respuestas, Ctrl+A, Ctrl+C y pegar. Si la hoja tiene una columna de Discord, se ignora. |

La importación busca los nombres exactos de 50 en 50 (`GET /users/lookup`) y los que falten uno a uno con `GET /users/@nombre/osu`, que también encuentra nombres antiguos y no distingue espacios de guiones bajos. Quien esté fuera de rango no se inscribe: sale en el informe para añadirle una excepción y volver a importar. Quien ya estuviera inscrito por la web conserva sus datos, y quien se borró o quitó la organización no vuelve a entrar al importar.

### Página Arbitrar

1. **Conectar con Bancho** con la contraseña IRC.
2. Elegir el partido en la lista. Arriba sale el marcador y el lobby; debajo, la tarjeta **Bot**, y después el chat del lobby y la botonera de siempre.
3. En la tarjeta **Bot**, elegir el modo y pulsar **Iniciar partido**. El bot sigue las fases de abajo.
4. Los botones de siempre siguen funcionando en los dos modos: Gana A / Gana B, el orden, los mapas del pool, **Apuntar a mano** (se salta el turno y las reglas para corregir algo), **Empezar de cero**, el chat (cualquier mensaje o comando) y **Poner warmup** (un mapa fuera del pool, que no cuenta). Lo que se apunte a mano lo recoge el bot y sigue desde ahí.

#### Bot de arbitraje: modos y fases

Cada partido tiene su modo, guardado en `ref_state`. El interruptor **AUTO / SEMI** de la tarjeta lo cambia en cualquier momento, también a mitad de una fase, sin reiniciar nada:

- **SEMI** (por defecto): cada paso que el bot haría solo sale como un botón grande con el texto exacto que se mandará, y no se manda nada al lobby hasta pulsarlo. Solo aparece el botón del paso siguiente válido. Lo que escriben los jugadores (rolls, «sí»/«no», `NM2`) solo prepara ese botón («Apuntar: B gana el roll de protects (80 – 30)», «Rechazar NM9 de A: no está en la mappool»).
- **AUTO**: el bot hace cada paso él solo, de uno en uno. La tarjeta dice qué va a hacer después.
- De SEMI a AUTO, el bot sigue desde la fase y el paso actuales. De AUTO a SEMI, se quita de la cola lo que el bot aún no había mandado (los temporizadores siguen) y cada paso vuelve a ser un botón.

En los dos modos están siempre **Pausar / Reanudar bot** (en pausa no hace nada solo y los temporizadores se paran), **Deshacer último paso** (solo cambia lo apuntado en la web, no manda nada; en AUTO deja el bot en pausa para revisar), **Saltar paso** (solo pasos de mandar algo o de esperar; un protect, ban o pick no se salta: se apunta a mano) y **Marcar incidencia** con una nota. Solo los árbitros y los admins pueden usarlos, y nadie en un partido que juega.

La cabecera de la tarjeta enseña la fase y el paso (por ejemplo `PICK · F3`), si el bot está en pausa, las cuentas atrás en curso (pick, ready, ausencia) y las advertencias. Debajo está el **log del bot**, con la hora de cada paso y quién lo hizo (`bot` o el árbitro). El estado se guarda en la base de datos después de cada paso: pulsar dos veces el mismo botón no repite nada (la segunda vez dice que ese paso ya no es el siguiente).

El bot actúa desde la cuenta del árbitro que lo lleva (quien lo inició o pulsó el último paso desde el lobby). Si otro árbitro entra en el mismo MP, solo mira; no se manda nada dos veces.

Fases:

1. **LOBBY.** A0: **Iniciar partido** o, en AUTO, solo a la hora del partido si quien lo lleva está conectado a Bancho. A1: comprueba jugadores, BO, mappool y reglas. A2: crea el lobby `SPI6: (A) vs (B)`; si BanchoBot no responde, lo intenta otra vez y, si tampoco, abre una incidencia. A4: TeamVS, ScoreV2 y 2 plazas. A5: contraseña al azar (solo la ven los árbitros). A6: invita a A y B. Mientras falte alguno, lo reinvita cada «segundos entre invitaciones»; pasados los «minutos de ausencia» (contados desde la hora del partido, o desde la invitación si es más tarde), abre una incidencia y avisa al staff. A12: pone a A en rojo y a B en azul. Si hay alguien más en el lobby, la expulsión (`!mp kick`) la confirma el árbitro, también en AUTO: los jugadores se reconocen por su nombre y uno que lo haya cambiado parecería un intruso.
2. **WARMUP.** Pregunta a A si quiere warmup. Si dice «sí», le da el host y espera a que termine su mapa (en SEMI, con el botón **Warmup terminado**). Lo mismo con B. Luego `!mp clearhost` y vuelve a poner la configuración oficial (`!mp set 2 3 2` y equipos). Los warmups no se leen del MP.
3. **ROLL.** Hay dos rolls. El primero, al empezar, es el de protects: quien lo gana elige quién protege primero. El segundo, después de los protects, es el de bans y picks: quien lo gana elige quién banea primero y quién elige primero (First Pick). Si la ronda no tiene protects, solo hay el segundo. En cada uno, el bot pide los rolls y lee el de cada jugador. Solo vale `!roll` sin número (si el bot ve `!roll 1000`, o el roll pasa de 100, pide repetirlo); vale el primero de cada jugador, y si empatan pide repetir los dos. Apunta quién gana (con los dos números) y le pregunta qué elige. Lo apunta el árbitro en **Orden**, como dicen las normas. Al completar un partido después de jugarlo no se piden rolls: se escribe el orden directamente.
4. **PROTECT, BAN y PICK.** Los protects van entre el primer roll y el segundo; los bans y los picks, después del segundo. El turno, las tandas ABBA, las reglas de mods y el Tiebreaker los decide `refFlow`, igual que con los botones de siempre. El bot anuncia el turno (en los picks, con `!mp timer` si la ronda tiene segundos para elegir), lee el código que escribe quien tiene el turno (`NM2`, `hd 1`) e ignora al otro. Si no vale (no existe, protegido, ya baneado o elegido, mismo mod que su anterior, el TB), lo rechaza diciendo por qué y espera otro, sin reiniciar el tiempo. Si vale, lo apunta y lo anuncia; los protects, los bans y los picks salen en `/api/overlay` al momento.
5. **READY.** Carga el mapa con sus mods y comprueba que BanchoBot confirma el mapa, los mods y los equipos. Si no, lo intenta otra vez y, si sigue mal, abre una incidencia. Pide el ready con su temporizador. Con los dos listos, empieza el mapa (`!mp start 5`). Si se acaba el tiempo, mira con `!mp settings` quién no está listo y le da una advertencia. Al llegar a las advertencias de la regla, solo avisa al staff y sigue esperando: nunca sanciona.
6. **PLAY.** Al terminar el mapa lee el resultado en la API de osu!, anuncia el marcador y vuelve a BAN (segunda tanda) o PICK. Al llegar alguien a la victoria, anuncia el ganador (FIN). El lobby no se cierra solo.

Tras reiniciar el servidor, la contraseña IRC ya no está. El bot espera, con la fase guardada, a que quien lo lleva vuelva a conectar y pulse **Volver a entrar al MP**. Entonces lee `!mp settings` y sigue desde el mismo paso, sin repetir lo que ya había mandado. Si un temporizador venció mientras tanto, cuenta como vencido: solo avisa.

#### Qué hacer ante incidencias

Cuando el bot espera una decisión sale un aviso rojo en la tarjeta, con sus botones. Mientras está abierto, el bot no hace nada solo (salvo avisar al jugador de que se le acabó el tiempo de pick).

| Aviso | Qué hacer |
|---|---|
| Un jugador no ha llegado en los minutos de la regla | Avisar al staff. **Seguir esperando** da otro plazo y vuelve a reinvitar. Si la organización decide forfeit, se pone en Admin → **Partido**. |
| Se ha acabado el tiempo de pick | Decidir. **Seguir esperando el pick** (sin tiempo) o **Volver a dar el tiempo** (se anuncia otra vez el turno). También se puede elegir el mapa a mano. El bot no elige por nadie ni da la victoria. |
| Advertencias por no estar listo | Avisar al staff por si hay sanción. **Seguir esperando**: el mapa empieza cuando los dos estén listos (o con **Iniciar el mapa sin esperar al ready**). |
| Error técnico (mapa, mods o equipos sin confirmar, o el mapa no empieza) | Mirar el lobby. **Reintentar** o **Seguir sin comprobar**. Se puede arbitrar a mano en cualquier momento. |
| No se ha podido crear el lobby | Revisar el mensaje (por ejemplo, el límite de 4 lobbies por cuenta) y volver a pulsar **Crear el lobby**. |
| La API de osu! no tiene el resultado | **Releer el MP** en un rato y resolver el aviso. |

Si el bot falla del todo, se pausa (o se pasa a SEMI) y se arbitra con los botones de siempre o a mano en osu!.

#### Completar un partido después de jugarlo

Si un partido se arbitró sin los botones (a mano en osu!, o con la web caída), se pueden apuntar después sus protects, bans y picks para que salgan en la tarjeta del partido y en el rundown de `/api/overlay`. En la página Arbitrar, la tarjeta del partido muestra **Completar después del partido** cuando:

- el partido tiene su MP leído y está terminado según el marcador;
- no es un forfeit;
- todavía no tiene nada apuntado, tiene menos picks que mapas jugados o le faltan protects.

El formulario pide:

- quién protegió, baneó y eligió primero (rojo = jugador A, azul = jugador B);
- los protects, en orden;
- los bans, en el orden en que se dijeron, con todas las tandas seguidas;
- los picks, ya rellenos con los mapas del pool jugados en el MP, en orden, sin warmups ni el TB. Se pueden corregir. El TB se añade solo si se jugó.

Los slots se escriben separados por comas (`NM1, HD2`). Al guardar, la web reparte cada paso con las mismas reglas que en directo:

- protects alternos;
- bans por tandas ABBA, con la segunda tanda tras los mapas que digan las reglas de la ronda;
- picks alternos desde el First Pick.

Para saber cuándo llega cada tanda, usa quién ganó cada mapa en el MP. También comprueba lo mismo que en directo: que no se banee un mapa protegido, que no se repita ningún slot, que nadie banee ni elija el mismo mod que en su ban o pick anterior, y que estén todos los protects y bans de la ronda. Si algo no cuadra, el formulario dice qué falla y no guarda nada.

No se manda nada al lobby ni a Bancho. Si el partido ya tenía pasos apuntados, hay que marcar **Sustituirlos por estos**. Se guarda igual que un partido arbitrado con los botones, así que después también se puede deshacer paso a paso o empezar de cero.

En la tarjeta pública del partido, los protects y los bans salen con el color de quien los hizo, igual que los mapas jugados. Los bans escritos a mano en Admin, sin pasar por Arbitrar, salen sin color.

Si la conexión se corta, la web reconecta y vuelve a entrar en los lobbies abiertos. Si se reinicia el servidor, basta con volver a conectar y pulsar **Volver a entrar al MP**. Sin conectar a Bancho, la página sirve para apuntar los rolls, los protects, los bans y los picks de un partido arbitrado a mano.

Los **lobbies de clasificatorios** se crean desde la misma página en HeadToHead con ScoreV2: los que preparó la organización, con sus plazas y sus jugadores aprobados invitados, o uno suelto con un nombre (`Lobby A`). Al volver a entrar en un lobby, si no está en HeadToHead con ScoreV2, la web lo corrige. El árbitro pulsa **Empezar la mappool**; al terminar cada mapa, la web pone el siguiente. Para repetir un mapa, se pulsa ese mapa.

Los árbitros tienen que crear los lobbies con `!mp make`, nunca con `!mp makeprivate`: osu! solo deja leer un lobby privado a quienes jugaron en él, y la web lo lee con un token de aplicación (comprobado en osu-web, `OsuAuthorize::checkMatchView`). Si alguno es privado, la web lo dice al pegar el enlace.

El cuadro se completa al terminar los clasificatorios (y solo si al menos 16 inscritos tienen scores): seeds 1 – 16 por Z-sum, y desde ahí cada resultado mueve a ganador y perdedor a su siguiente partido. La Grand Final es un único partido (sin bracket reset).

Las seeds se calculan a partir de los inscritos. Quitar a un jugador después de los clasificatorios sube al 17.º al cuadro, lo cual sirve para sustituir a alguien que se retira antes de octavos; una vez empezados los partidos, usa un forfeit en su lugar o los cruces ya jugados cambiarían.

## Datos de un partido para otras webs (`GET /api/overlay`)

`GET /api/overlay?match=<id>` devuelve en JSON los datos públicos de un partido del cuadro (`u1-1` … `gf`; da igual mayúsculas o minúsculas). Es de solo lectura, no usa la sesión y se puede leer desde cualquier web: lleva `Access-Control-Allow-Origin: *` (solo `GET`, sin cookies) y responde a `OPTIONS`. Las respuestas se pueden guardar en caché 5 segundos (`Cache-Control: public, max-age=5`). Ninguna otra ruta lleva CORS.

Para quien vaya a usarla hay una guía en `/api.html`, con la dirección de la web ya puesta. La guía no es pública: solo la ven, con la sesión iniciada, los admins y quien se añada en **Guía de la API** (pestaña Admin, tabla `api_access`). Sin sesión responde 401 y sin permiso 403, sin nada de su contenido. El archivo está en `server/api-guide.html`, fuera de `public/`, para que no se pueda abrir como archivo estático. La ruta `/api/overlay` sigue siendo pública: la guía solo la explica. Si cambias la ruta, actualiza también esa página.

```json
{
  "matchId": "u1-6",
  "scheduledAt": 1795195800000,
  "round": "octavos",
  "bestOf": 9,
  "players": {
    "red":  { "id": 32031654, "username": "suutee" },
    "blue": { "id": 22443532, "username": "Ouwo Cronii" }
  },
  "pool": [ { "slot": "NM1", "beatmap_id": 4956966, "data": { "artist": "…", "title": "…", "version": "…", "sr": 5.21 } } ],
  "rundown": [
    { "actor": "RED",  "action": "PROTECT", "pick": "NM1" },
    { "actor": "BLUE", "action": "BAN",     "pick": "DT2" },
    { "actor": "RED",  "action": "PICK",    "pick": "HD1" }
  ]
}
```

- `scheduledAt`: hora del partido en milisegundos, o `null` si no tiene.
- `round` y `bestOf`: la clave de la fase en `config.json` y su `bo`.
- `players`: `red` es el jugador A del cruce y `blue` el B, igual que los coloca **Arbitrar** con `!mp team`. Mientras un jugador no esté decidido, vale `null`. Igual que en la web, los cruces no aparecen hasta que se publican los resultados de clasificatorios.
- `pool`: los mapas de la ronda ordenados por slot, con `data` tal como se guarda. Si la mappool de la ronda aún no es pública, `[]`.
- `rundown`: protects, bans y picks apuntados en **Arbitrar**, en el orden en que se apuntaron (lo deshecho desaparece). Un partido arbitrado sin los botones también lo tiene si se completa después (ver [Completar un partido después de jugarlo](#completar-un-partido-después-de-jugarlo)). `RED` es el jugador A y `BLUE` el B. El pick del tiebreaker lleva `"actor": null`. El roll y el orden no salen. Sin nada apuntado, `[]`.

Si falta `match` responde 400, y si el partido no existe, 404, siempre con `{ "error": "…" }`.

## Estadísticas de cada ronda (`GET /api/stats`)

La pestaña **Stats** tiene una pestaña por cada ronda de `config.json` (menos Registros) y dos vistas. La ronda y la vista van en la dirección, así que se puede compartir el enlace y funcionan atrás y adelante:

```
#stats/<ronda>?view=resultados-individuales
#stats/<ronda>?view=leaderboard-por-mapa
```

`<ronda>` es la clave de la fase en `config.json` (`qualifiers`, `octavos`, `cuartos`, `semis`, `finals`, `gf`). Sin vista, o con una que no existe, sale **Resultados individuales**. Con solo `#stats`, la web elige la última ronda con estadísticas publicadas (a los admins, si no hay ninguna, la última con mapas jugados; si no, la ronda en curso) y completa la dirección.

**Publicación.** Las estadísticas de una ronda son públicas solo cuando se cumplen las tres cosas:

1. La ronda ha terminado: en el cuadro, todos sus partidos tienen ganador, por resultado o forfeit (la ronda de cada partido es la de `phaseOfMatch`; la final del lower va con la Grand Final); en clasificatorios, ha pasado la fecha de fin de la fase.
2. Un admin las ha publicado en **Admin → Publicación de estadísticas** (se guarda en `pool_release` con la clave `stats:<ronda>`). El botón **Publicar** solo funciona con la ronda terminada; el servidor lo comprueba y, si no, responde 400 con los partidos que faltan.
3. La mappool de la ronda es pública y, en clasificatorios, también los resultados. En clasificatorios no se pueden publicar antes que los resultados.

Si algo deja de cumplirse (se quita un resultado o un forfeit, o se ocultan los resultados de clasificatorios), se vuelven a ocultar solas hasta que se cumpla otra vez. Mientras tanto, el público ve «Aún no hay estadísticas» y los admins las ven como vista previa, con un aviso que dice por qué aún no son públicas.

**Qué cuenta.** Solo los mapas de la pool de la ronda (los warmups no están en ella), de los partidos con resultado leído del MP. En la vista previa de los admins, un partido en juego cuenta con los mapas que la sincronización ya ha leído (cada 5 minutos, o al pulsar **Releer el MP ahora** en el panel); la página vuelve a pedir los datos cada minuto, con el resto del estado. Los partidos ganados por forfeit no cuentan. En clasificatorios se toma el mejor score de cada inscrito en cada mapa, juntando todos sus lobbies.

**Resultados individuales.** Una fila por jugador, ordenada por la métrica de la ronda:

- **Match cost** (rondas del cuadro): en cada mapa, el score del jugador dividido entre la media de los scores de los dos jugadores en ese mapa de ese partido; el match cost es la media de ese cociente en todos los mapas que ha jugado en la ronda. 1,000 es rendir igual que el rival.
- **Z-sum** (clasificatorios, o **Total** si `metodoClasif` es `suma`): la misma métrica con la que se ordenan los clasificatorios (`qualRanking` de `server/bracket.js`).
- **Avg. score**, **Avg. acc** y **Mapas**: media de los scores, media de la precisión (de los scores que la traen) y número de mapas jugados.
- **Mejor score**: el score más alto, su precisión, el slot con los mods que añadió el jugador (FM1 +HR) y la letra del rank.

Todos los scores son los que cuentan en el partido: con EZ ×1,8 y EZHD ×2 en el cuadro (la web lo marca con «EZ ×1,8») y sin multiplicadores en clasificatorios. La letra del rank es la que manda osu!; si no la hay (resultados leídos antes de guardarla), se calcula con los 300/100/50/fallos como en stable. Los números salen en formato español con `Intl.NumberFormat('es-ES')`, con punto de miles también en los de 4 cifras.

**Leaderboard por mapa.** Una sección plegable por mapa de la pool (slot, artista, título y dificultad, y el número de plays) con todos sus scores de mayor a menor: jugador, score, precisión, mods, rank y el partido, que enlaza a su MP en osu!. En clasificatorios no hay columna de partido, porque los MP de los lobbies solo los ven los árbitros. Un mapa sin jugar sale como «Sin plays». Lo abierto o cerrado se mantiene al recargar los datos.

**La ruta.** `GET /api/stats?round=<ronda>&view=<vista>` devuelve lo que pinta la página. Es pública y de solo lectura. Sin sesión de admin, solo da lo publicado y se puede guardar en caché 5 segundos (`Cache-Control: public, max-age=5`, `Vary: Cookie`). A un admin le da siempre los datos (vista previa) con `Cache-Control: private, no-store`. No pide nada a osu!: usa lo que guarda la sincronización. Respuesta:

- `status`: `ok`; `empty` si la ronda aún no tiene mapas jugados; `hidden` si su mappool no se ha publicado; `hidden-results` en clasificatorios mientras sus resultados no se publiquen; `unpublished` si la ronda no ha terminado o no se han publicado sus estadísticas (con `over`: si la ronda ha terminado). Salvo con `ok`, no lleva mapas ni scores.
- Solo para admins: `preview` (`true` si el público aún no las ve) y `publication` = `{ published, over, pending, visible }` (hora de publicación o `null`, si la ronda ha terminado, partidos que faltan y si el público las ve).
- `metric`: `{ key, label }`, con `matchCost`, `zsum` o `total`.
- `players` (resultados individuales): `{ id, username, value, avgScore, avgAcc, maps, best }`, con la precisión de 0 a 1 y `best` = `{ score, acc, slot, mods, rank, mult, match, mp }`.
- `maps` (leaderboard): `{ slot, beatmap_id, artist, title, version, url, plays }`, y cada play con los mismos campos que `best` más `id` y `username`.

Una ronda o una vista que no existen responden 400 con `{ "error": "…" }`. Para publicar u ocultar: `POST /api/admin/stats-release` con `{ "round": "<ronda>", "publish": true }` o `false` (solo admins). `/api/state` lleva `statsPublic`, la lista de rondas con estadísticas públicas, y a los admins además `statsRelease` con el estado de cada ronda. El cálculo está en `server/stats.js` y la parte que decide qué es público, en `statsRelease` y `statsBody` de `server.js`.

## Endpoints de la API de osu! que se usan

| Para qué | Endpoint | Token |
|---|---|---|
| Login | `GET /oauth/authorize`, `POST /oauth/token` (`authorization_code`) | Ninguno |
| Perfil de quien inicia sesión | `GET /api/v2/me/osu` | del usuario (scope `identify`) |
| Rango al importar / actualizar rangos | `GET /api/v2/users/{id}/osu` | de aplicación (`client_credentials`, scope `public`) |
| Ficha del jugador (una foto al día de cada inscrito) | `GET /api/v2/users/{id}/osu` | de aplicación |
| Importar el formulario | `GET /api/v2/users/lookup` (50 nombres por petición) y `GET /api/v2/users/@{nombre}/osu` | de aplicación |
| Datos del mapa | `GET /api/v2/beatmaps/{id}` | de aplicación |
| SR con HR o DT, y atributos de cada mapa para las skills (una vez por mapa) | `POST /api/v2/beatmaps/{id}/attributes` | de aplicación |
| Resultados y clasificatorios | `GET /api/v2/matches/{id}` (con `before` para partidos de más de 100 eventos) | de aplicación |

Se hace como mucho una petición por segundo, como pide la documentación de osu! (máximo 60 por minuto). Cada partido en juego se relee cada 5 minutos, por encima del mínimo de un minuto que piden los términos de uso de la API. Las respuestas se piden en el formato por defecto (sin `x-api-version`), en el que cada score trae `score` y `mods` como lista de siglas.

## Comandos de Bancho (IRC) que usa el bot de arbitraje

`!mp make`, `!mp set 2 3 2` (TeamVS, ScoreV2, 2 plazas) o `!mp set 0 3 16` (clasificatorios), `!mp password <al azar>`, `!mp invite #<id>`, `!mp team #<id> red|blue`, `!mp kick <nombre>`, `!mp host #<id>`, `!mp clearhost`, `!mp map <id> 0`, `!mp mods`, `!mp timer`, `!mp aborttimer`, `!mp start 5`, `!mp abort`, `!mp settings` y `!mp close`. Lee los mensajes de BanchoBot del canal `#mp_<id>`: jugadores que entran o salen, cambios de equipo, `!roll`, cambios de mapa, «All players are ready», scores al terminar y «The match has finished!». Del chat de los jugadores lee `!roll`, «sí»/«no» y los códigos de mapa.

**Comprobar en el lobby de prueba con Bancho real** (el bot solo se ha probado con un Bancho simulado). Estas líneas se han escrito según la documentación y bancho.js, y si Bancho las escribe distinto el bot se queda esperando o abre una incidencia, nunca hace nada de más:

- «`<nombre>` rolls `<n>` point(s)» y que el `!roll` del jugador llegue al canal (si no llega, el roll se da por bueno), en los dos rolls: el de protects al empezar y el de bans y picks después de los protects;
- la respuesta a `!mp mods`: «Enabled Hidden, NoFail, disabled FreeMod» o «Enabled FreeMod»; y la línea «Active mods: …» de `!mp settings`;
- «Slot 1  Ready / Not Ready https://osu.ppy.sh/u/<id> <nombre> [Team Red]» en `!mp settings` (para saber quién no está listo);
- que `!mp host #<id>`, `!mp clearhost`, `!mp password` y `!mp kick` funcionan con estos argumentos, y que un jugador invitado entra con la contraseña puesta;
- «The match has finished!» al terminar el warmup que empieza el propio jugador con el host.

A los jugadores del cuadro se les invita y se les cambia de equipo por su ID (`#<id>`), que funciona aunque el nombre tenga espacios o haya cambiado. El anti-spam de Bancho puede descartar un comando igual al anterior, así que, como hace [bancho.js](https://bancho.js.org), los comandos `map`, `mods`, `set`, `timer`, `start`, `abort`, `aborttimer`, `settings` y `close` llevan al final una palabra al azar que Bancho no lee (por ejemplo `!mp start 5 k3x9qa`). Se ve así en el chat del lobby, pero no en el registro de la página.

## Skills del torneo

Están en `server/skills.js` y solo usan datos de torneo.

**1. Perfil de cada mapa.** De `/beatmaps/{id}/attributes`, con los mods del slot (HR o DT; el resto, sin mods), se guardan `aim_difficulty`, `speed_difficulty`, `slider_factor` y `speed_note_count`. HR y DT los traen al añadirse; el resto de mapas, y los que ya estaban en los pools, los pide la web de fondo, una vez por mapa. Cada mapa tiene un valor bruto por skill: aim = `aim_difficulty`, velocidad = `speed_difficulty`, precisión = CS, accuracy = OD y resistencia = `speed_note_count` (notas rápidas en todo el mapa: crece con la duración y con la densidad). Cada valor se convierte en su percentil *p* frente a todos los mapas publicados del torneo (los empates cuentan a medias) y el peso de cada skill es **(p + 0,1)² / Σ(p + 0,1)²**: los pesos de un mapa suman 1 y la skill que más destaca pesa más.

**2. Base con los clasificatorios.** En cada mapa, z-score de cada jugador frente a los que lo jugaron (los que no lo jugaron no cuentan, a diferencia del Z-sum). La base de cada skill es la media de sus z ponderada por el peso de cada mapa en esa skill, limitada a ±3.

**3. Elo por skill con el cuadro.**
- Fuerza general **G** = 1500 + 300 · z: con el TR de o!TR (z frente a los inscritos con TR) o, si no tiene, con su seed (z = Φ⁻¹(1 − (seed − 0,5)/N), con N los jugadores con clasificatorios).
- Rating inicial de cada skill: **R = G + 150 · base**.
- Cada mapa del cuadro es un duelo entre A y B. Fuerza en el mapa F = Σ peso · R; resultado esperado E = 1 / (1 + 10^((F_B − F_A)/400)); cada skill cambia **K · m · peso · (resultado − E)** con K = 80 (B, al revés). m = 1, 0,5 en FM y TB (FreeMod) y ×0,5 si alguno de los dos jugó con EZ.
- Los forfeits no cuentan.
- Las skills de la ficha son el percentil de cada R frente al resto de inscritos con datos (un empate no cuenta como mejor).

**4. Historial.** La tabla `skill_history` guarda las skills de todos tras los clasificatorios y tras cada partido, en el orden en que se jugaron.

## Endpoints de o!TR que se usan

| Para qué | Endpoint |
|---|---|
| Datos de un jugador por su ID de osu! (rating, tier, torneos y `modStats`) | `GET https://otr.stagec.net/api/players/{id}/stats?keyType=osu&ruleset=0`, con `Authorization: Bearer <OTR_API_KEY>` |

`modStats` trae, por combinación de mods (máscara de bits de osu!), cuántos mapas y la puntuación media. La web junta las que solo se diferencian en NF y cuenta NC como DT. Si o!TR no conoce al jugador (404), la ficha lo dice. La API de o!TR avisa de que todavía puede cambiar sin previo aviso.

## Endpoints de Twitch que se usan

| Para qué | Endpoint |
|---|---|
| Token de aplicación | `POST https://id.twitch.tv/oauth2/token` (`client_credentials`) |
| Saber si hay directo | `GET https://api.twitch.tv/helix/streams?user_login=CANAL`, una vez por minuto |

## Pruebas

```bash
npm test
```

La prueba fija su propio reloj (`TEST_NOW` en `test/e2e.js`: 14 de noviembre de 2026, con los clasificatorios en marcha), así que da lo mismo el día en que se ejecute. Levanta una API de osu!, un Twitch y un Bancho simulados y comprueba que los scripts de la web no tienen errores de sintaxis, login, rechazo por rango, excepciones, importación del formulario y de mappools, lobbies de clasificatorios, roles, permisos del panel, mappool, resultados (warmups, paginación, EZ ×1,8), clasificatorios, publicación programada de mappools, peticiones malformadas, y la ficha del jugador (la foto automática del perfil, que solo lleva datos públicos, que abrir la ficha no llama a osu! y que si osu! falla se conserva la última foto), y los datos de o!TR con un o!TR simulado (mods agrupados, jugador sin rating y jugador que o!TR no conoce, o!TR caído, la web sin clave y que la clave no aparece en la web ni en el log), que la guía de la API solo la vean los admins y quien se añada en el panel, y las skills: cada fórmula por separado, unos clasificatorios simulados (P01 arriba en todo, P16 abajo), un partido del cuadro que mueve las skills en la dirección esperada, el historial, que el público no ve nada de los clasificatorios hasta que se publican y el detalle por jugador y mapa del MP. Después arranca un segundo servidor con el reloj adelantado a octavos, 16 inscritos y un clasificatorio, para probar el aviso de directo de Twitch, que las pools se publiquen solas pasado el showcase, los partidos de octavos con forfeit y con resultado desde el MP (sin contar los mapas de showmatch jugados después de decidirse el partido), y `/api/overlay` (cruces solo con los resultados de clasificatorios publicados, pool solo si la mappool es pública, rundown en orden, errores y CORS), y `/api/stats` con dos partidos de octavos (uno en juego con precisión, 300/100/50/fallos y un EZ): match cost, medias, mejor score y orden (en la vista previa de los admins), el leaderboard por mapa, el aviso de una ronda sin resultados, la publicación (rechazada con la ronda sin terminar o sin los resultados de clasificatorios, visible para el público al publicarla y oculta otra vez si un partido deja de estar terminado), que una mappool o unos clasificatorios sin publicar no dejan ver mapas ni scores, y la dirección `#stats/…` y el formato de los números con las funciones de la propia página. Con un Bancho simulado, juega también un partido entero desde la página Arbitrar:

- contraseña IRC rechazada y aceptada;
- lobby, equipos y `!roll`;
- protects, bans y picks por el chat y por la web, con sus reglas;
- marcador leído de la API;
- deshacer, apuntar a mano y reconexión;
- completar después del partido un Bo9 arbitrado sin los botones: el rundown en orden, con la segunda tanda de bans tras los mapas de la regla y el TB al final; los errores, que no guardan nada; sustituir lo apuntado solo con confirmación, y que ni un jugador ni quien juega el partido puedan usarlo;
- un lobby de clasificatorios;
- que la contraseña IRC no acabe ni en la base de datos ni en el log.

Y el bot por fases (con los temporizadores 20 veces más rápidos, `REF_TIME_SCALE=0.05`):

- un partido completo en AUTO que empieza solo a su hora: lobby con un intruso expulsado, warmup de un jugador, el roll de protects (con un roll con número rechazado y un empate), protects, el roll de bans y picks, bans y picks con códigos no válidos rechazados con su motivo, cinco mapas con la segunda tanda de bans y el fin, y el rundown de `/api/overlay`;
- el mismo partido en SEMI avanzando solo con botones, comprobando antes de cada paso que no ha salido nada sin pulsar, con el cambio a AUTO y vuelta a SEMI a mitad sin perder ni repetir pasos;
- un jugador ausente: reinvitaciones y aviso al staff al acabar el tiempo, sin forfeit;
- un pick que agota el tiempo y espera al árbitro, sin autopick; tres advertencias de ready que solo avisan al staff;
- saltar, deshacer, pausar, incidencias con nota, y que pulsar dos veces no repite nada;
- un reinicio del servidor a mitad de partido que retoma desde `ref_state` sin repetir nada;
- que un jugador no puede usar el bot, ni nadie en su propio partido.

No necesita conexión ni credenciales.

## Estructura

```
server.js            rutas HTTP, sesiones, sincronización automática
server/osu.js        cliente de la API de osu! (OAuth, límite de peticiones)
server/results.js    cálculo de mapas, partidos y clasificatorios
server/stats.js      estadísticas de la página Stats: match cost, medias, mejor score, leaderboard por mapa y letra del rank
server/import.js     interpretación de hojas: respuestas del formulario y mappools (slots, rondas, IDs)
server/sheet.js      lectura de archivos .xlsx, .ods y .csv, sin dependencias
server/twitch.js     estado del directo de Twitch (Helix)
server/otr.js        cliente de la API de o!TR (con su propia cola) y resumen de los datos de cada jugador
server/skills.js     skills del torneo: pesos de cada mapa, base con clasificatorios y Elo con el cuadro
server/bracket.js    seeds y cruces en el servidor, para el arbitraje (misma lógica que compute() de la web)
server/irc.js        cliente IRC de Bancho (con cola para el límite de mensajes)
server/refflow.js    turnos del partido: roll de protects, protects, roll de bans y picks, bans ABBA, picks y TB
server/refbot.js     bot por fases (sin E/S): el paso siguiente de cada partido, temporizadores e incidencias
server/referee.js    bot de arbitraje: conexiones de los árbitros, mensajes de BanchoBot, modos AUTO/SEMI y comandos !mp
server/db.js         SQLite y copias de seguridad
server/config.js     lectura de config.json y fechas en hora de Madrid
public/index.html    la web (sin servidor muestra datos de ejemplo)
public/og.png        imagen al compartir el enlace (1200×630)
public/favicon.svg   icono de la pestaña
server/api-guide.html  guía de /api/overlay (en /api.html, solo para quien tenga permiso)
docs/DESIGN.md       dirección visual de la web y razón de cada decisión
test/e2e.js          prueba completa con osu!, Twitch y Bancho simulados
scripts/backup.js    copia manual de la base de datos
Dockerfile, docker-compose.yml   despliegue con Docker (el HTTPS lo pone Tailscale Funnel)
```
