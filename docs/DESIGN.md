# Diseño de la web de SpiSix: Fall Cup

Dirección visual de `public/index.html`. Cualquier cambio de diseño parte de aquí; si algo de este documento deja de encajar, se cambia aquí primero.

> **Pendiente de confirmar por la organización.** La dirección la propuso Claude, con la skill frontend-design, durante el rediseño de noviembre de 2026. Lo que no encaje se cambia en este documento.

## Lectura

Web de un torneo 1v1 de osu! para jugadores de rango de 6 cifras de una comunidad hispanohablante. La usan los jugadores para ver horarios, mappools y resultados, y la organización para administrar el torneo.
El lenguaje visual es el de osu!, en colores de otoño.

**Diales: ENERGY 2 / RHYTHM 2 / MOTION 1.**

- **ENERGY 2:** un solo punto llamativo, el playfield de Inicio. El resto es una herramienta que se consulta deprisa.
- **RHYTHM 2:** cada vista tiene la forma de su contenido (calendario, cuadro, tablas, fichas de mapa). No se busca variar por variar.
- **MOTION 1:** solo estados al pasar el ratón y al pulsar, más dos animaciones breves que se ven una vez: el slider que se dibuja y el approach circle que cierra tres veces. Nada se repite en bucle.

## Motivo propio

El torneo se reconoce por las piezas de osu!:

- **Hit circle con número:** el logo «6», el favicon y la cuenta atrás de Inicio.
- **Approach circle:** el anillo que cierra sobre el hit circle al entrar.
- **Slider:** la curva que sale del hit circle en el playfield.
- **Combo numerado:** las fases del calendario son círculos 1, 2, 3… unidos.
- **Mods en hexágono** con su color de siempre (NM, HD, HR, DT, FM, TB).

## Decisiones y su razón

| Decisión | Razón |
|---|---|
| Fondo gris azulado claro con tarjetas blancas; tema oscuro equivalente | La web se consulta mucho y con datos densos; el tema lo elige el sistema o el botón de la cabecera. |
| Acento naranja óxido (`#B23F0E` claro, `#FF8A4C` oscuro) | Otoño (Fall Cup) y contraste de 5,8:1 sobre blanco. Se usa en la acción principal, la sección actual, el hit circle y el foco. |
| Playfield oscuro (`--pf`) solo en el bloque de Inicio | Es el único sitio con fuerza visual. Imita la pantalla de juego y deja el resto tranquilo. |
| Verde, rojo y ocre de estado | Terminado, en directo y pendiente. El color siempre va con texto, nunca solo. |
| Colores de mods | Son la convención de osu!; los jugadores los reconocen sin leer. |
| Títulos en M PLUS Rounded 1c | Redondeada y gruesa, del mismo aire que la tipografía de osu!. |
| Texto y datos en Atkinson Hyperlegible Next y Mono | Pensada para leerse bien a tamaño pequeño: cifras, rangos y nombres de usuario. Su cero va tachado. |
| Menú con subrayado y desplegable «Más» | Las secciones que no caben pasan al desplegable y la actual siempre se ve. En móvil, el botón lleva el nombre de la sección. |
| Etiquetas en minúscula, sin espaciado ancho | Se leen mejor que las mayúsculas y no parecen una plantilla. |
| Punto de color solo en estados reales | El punto significa «está pasando» o «ha terminado». Las etiquetas como «Upper bracket» no lo llevan. |
| Sombras | Solo dos: el desplegable «Más» y la ventana del directo, que flotan sobre el contenido. El resto está plano, separado por bordes. |
| Bordes | Suaves (`--line`) en tarjetas y separadores; marcados (`--field`, 3:1 como mínimo) en los campos, para ver dónde escribir. |
| Radios | Píldora en botones y etiquetas, 10 px en campos y de 16 a 28 px en tarjetas y en el playfield. Así botón, campo y bloque se distinguen. |
| Franja izquierda roja | Solo en partidos en directo; marca un estado, no decora. |
| Flechas | Solo en rutas («Admin → Resultados») y en el enlace externo de Twitch (↗). |

## Normas para cambios

- El contraste del texto es de 4,5:1 como mínimo y el de bordes y estados de 3:1, en los dos temas.
- En pantallas táctiles, todo lo que se pulsa mide 44 px como mínimo.
- Los colores se usan con sus variables de `:root`, nunca a mano.
- Nada se mueve en bucle; todo movimiento respeta «reducir movimiento».
- En los textos de la web no se usa la raya (—).
