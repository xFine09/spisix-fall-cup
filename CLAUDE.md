# SpiSix: Fall Cup

Web del torneo 1v1 de osu! SpiSix: Fall Cup. **Responde siempre en español.**

## Proyecto

- Repositorio público: https://github.com/xFine09/spisix-fall-cup
- Node.js 22.13 o superior, **sin dependencias externas**. No añadas paquetes de npm.
- SQLite con `node:sqlite`. La web es una sola página, `public/index.html`, sin compilación.
- Fechas, rondas y reglas del torneo: `config.json`.
- Documentación: `README.md` (resumen) y `docs/MANUAL.md` (detalle). Si cambias algo que esté descrito ahí, actualiza también la documentación.

```
server.js      rutas HTTP, sesiones y sincronización automática
server/        API de osu!, resultados, importación, base de datos y bot de arbitraje (IRC de Bancho)
public/        la web
config.json    fechas, rondas y reglas del torneo
scripts/       copia de seguridad manual
test/          prueba completa con servicios simulados
docs/          manual técnico
```

## Comprobar los cambios

- `npm test` ejecuta la prueba completa con osu!, Bancho y Twitch simulados. No necesita conexión ni credenciales.
- Ejecútalo después de cualquier cambio en `server.js`, `server/` o `public/`, y no des un cambio por terminado si falla.

## Despliegue

- La web corre en una VM Debian 13 (`spisix`) del Proxmox de casa de xFine, con Docker Compose.
- Docker publica la web solo en `127.0.0.1:3000`. El HTTPS lo pone **Tailscale Funnel** (`tailscale funnel --bg 3000`). No hay Caddy ni dominio propio.
- Dirección pública: https://spisix.tail75bdfd.ts.net
- La VM está aislada: el cortafuegos de Proxmox le impide llegar a la red de casa, y en Tailscale tiene la etiqueta `tag:spisix`, que no puede abrir conexiones hacia nada. No propongas cambios que necesiten acceso de la VM a la red local o al tailnet.
- Para actualizar: `git pull && docker compose up -d --build` en la VM, fuera de las horas de partido.
- El `.env` se crea a mano (ya no hay `.env.example`). Variables: `BASE_URL`, `OSU_CLIENT_ID`, `OSU_CLIENT_SECRET`, `ADMIN_IDS`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` (las de Twitch son opcionales).

## Roles

- **Host: Zaik0** (ID de osu! 18296881). Es el único en `ADMIN_IDS` y se encarga de todo el panel.
- **xFine** (ID de osu! 16565595, Discord `xfine09`): juega el torneo y mantiene el servidor. No es admin, staff ni árbitro. **No propongas añadirle a ningún rol**: vería las mappools sin publicar.

## Decisiones que no hay que cambiar

- Discord es solo un enlace en el pie de la web: sin vinculación de cuentas ni avisos por Discord.
- Los recordatorios de partidos, resultados y mappools salen solos en Inicio.
- Sin multiplicadores en clasificatorios. EZ y EZHD solo cuentan en los partidos del cuadro.
- Cada jugador juega un solo lobby de clasificatorios, y un árbitro o admin aprueba su plaza.
- No cambiar las horas por defecto de los lobbies.

## Seguridad

- Nunca leas, muestres, subas ni compartas el `.env`, el Client Secret de osu! ni contraseñas IRC.
- Para comprobar variables, sin enseñar sus valores: `awk -F= 'NF{print $1": "(length($2)?"relleno":"VACÍO")}' .env`
- **No hagas commit, push ni force push** salvo que xFine lo pida expresamente en ese momento.
- Los commits usan el correo privado de GitHub: `186963879+xFine09@users.noreply.github.com`.

## Sin probar en real

- **Bot de arbitraje con Bancho real:** solo se ha probado con un simulador y es el mayor riesgo. Si falla, se puede arbitrar a mano. Hay que hacer un lobby de prueba antes de usarlo en el torneo.
- **Aviso de directo de Twitch:** probado solo con un simulador. Es opcional: sin credenciales, todo lo demás funciona igual.
