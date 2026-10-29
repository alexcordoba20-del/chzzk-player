# CHZZK Player — versión de escritorio

Aplicación de escritorio (Electron) para ver los directos de **Lost Ark**, con
dos fuentes: **CHZZK** (Corea) y **Bilibili** (China). Ventana propia, sin
navegador de por medio: explora los canales en vivo, pinchas uno y el stream se
reproduce dentro de la misma ventana.

En la barra lateral hay una entrada para cada una: *Lost Ark CHZZK* y
*Bilibili Lost Ark*. Ambas comparten grilla, reproductor y favoritos.

## Arrancar

```
cd desktop
npm install      # solo la primera vez
npm start
```

Para generar el ejecutable:

```
npm run dist     # deja dist\win-unpacked\CHZZK Player.exe
```

No se instala nada: se ejecuta ese `.exe` y ya. Para llevarlo a otro equipo,
copia la carpeta `win-unpacked` entera (el `.exe` necesita los archivos que la
acompañan) junto con `ffmpeg.exe`.

> Existe también `npm run dist:portable`, que empaqueta todo en un único `.exe`
> autoextraíble. **Requiere activar el Modo de desarrollador de Windows**:
> electron-builder descomprime sus herramientas de firma creando enlaces
> simbólicos, y sin ese permiso falla con *«Cannot create symbolic link»*.

## El motor de reproducción

La app usa **ffmpeg**, no el reproductor HLS del navegador. La razón es medible:

| | hls.js (navegador) | ffmpeg |
|---|---|---|
| Conexión al CDN | una petición por segmento (2 s) | una sola, persistente |
| 1080p sostenido | se queda atrás (~0,2 s de retraso por segundo) | estable |

El CDN de CHZZK está en Corea. Con esa latencia, abrir una conexión nueva cada
2 s impide que TCP alcance velocidad de crucero, así que hls.js nunca llega a
los 8,4 Mbps que pide el 1080p y la reproducción se va rezagando hasta cortarse.
ffmpeg mantiene una única conexión y sí lo sostiene.

Cómo encaja dentro de la app:

```
 ventana                  proceso principal              internet
 ┌──────────────┐         ┌──────────────────┐
 │   <video>    │◀────────│  127.0.0.1:PORT  │◀── ffmpeg ◀── CDN de CHZZK
 └──────────────┘  fMP4   └──────────────────┘   (remux)     (HLS)
```

ffmpeg **remuxa** (`-c copy`): cambia el envoltorio de HLS a fMP4 sin
recodificar, así que el gasto de CPU es mínimo y no se pierde calidad. El
`<video>` reproduce desde `127.0.0.1`, donde ya no hay cuello de botella.

Si `ffmpeg.exe` no aparece, la app vuelve automáticamente a hls.js (con 720p por
defecto, que sí es estable).

### Dónde busca ffmpeg

Por orden: junto al ejecutable, en la carpeta `desktop`, y en las dos carpetas
superiores — que es donde ya lo tienes (`Stream\Stream\ffmpeg.exe`). Si no lo
encuentra en ninguna, prueba con el `PATH`.

Para repartir el `.exe` a otro equipo, copia `ffmpeg.exe` junto a él.

## De dónde salen los datos

No hace falta esnifar tráfico: las APIs públicas ya dan el enlace del directo.
Las llamadas salen del proceso principal, que les pone el `Referer` del sitio
correspondiente y no sufre CORS.

### CHZZK — `api.chzzk.naver.com`

```
/service/v1/categories/GAME/Lost_Ark/info    → nombre real y póster
/service/v2/categories/GAME/Lost_Ark/lives   → directos + paginación
/service/v2/channels/<channelId>/live-detail → livePlaybackJson → master .m3u8
```

Ojo con las versiones: `v1/live-detail` responde error `9004`, y `v1/…/lives`
devuelve como mucho 10 directos y sin cursor. Hay que usar la `v2` en ambas.

### Bilibili — `api.live.bilibili.com`

El área es `parent_area_id=2` (网游, juegos en línea) / `area_id=590`
(命运方舟, o sea Lost Ark).

```
/room/v3/area/getRoomList                 → salas en directo, paginadas
/xlive/web-room/v2/index/getRoomPlayInfo  → HLS (fmp4 y ts)
/xlive/web-room/v1/index/getInfoByRoom    → título y datos del canal
```

Dos diferencias respecto a CHZZK que condicionan el código:

- El endpoint que usa su propia web (`xlive/…/second/getList`) exige **firma
  WBI** y responde `-352` sin ella. `room/v3/area/getRoomList` devuelve lo mismo
  y no la pide.
- Bilibili **no sirve un master playlist**: da directamente la lista de
  segmentos. La calidad se pide con el parámetro `qn` de su API, no eligiendo
  variante dentro del m3u8. Por eso el selector de calidad se oculta en sus
  directos.

> Sin iniciar sesión, `qn=10000` (原画, calidad original) se degrada a `qn=250`
> (超清). En la práctica sigue dando 1080p en la mayoría de salas.

## Directos pasados

Los directos que ya terminaron se ven desde **Pasados CHZZK** (todos los de
Lost Ark, del más reciente al más antiguo) y debajo del reproductor de cada
canal. Se puede saltar a cualquier punto, y la app recuerda por dónde ibas: la
miniatura muestra una barra de progreso y al volver a abrirlo continúa ahí.

```
/service/v2/categories/GAME/Lost_Ark/videos   → pasados de la categoría (cursor)
/service/v1/channels/<channelId>/videos       → pasados de un canal (por páginas)
/service/v2/videos/<videoNo>                  → liveRewindPlaybackJson → HLS
apis.naver.com/neonplayer/vodplay/v2/playback → HLS de los vídeos con inKey
```

Tres cosas medidas que condicionan cómo está hecho:

- **La `v1` por categoría solo devuelve los ~8 últimos** y no pagina. La `v2`
  pagina con un cursor (`publishDateAt` + `readCount`).
- **hls.js no sirve tampoco aquí**: pidiendo segmento a segmento, el CDN de
  vídeos entrega ×0,7 del bitrate de 1080p. Se sigue usando ffmpeg.
- **`ffmpeg -ss` no sirve para saltar**: con un playlist de ~20.000 segmentos
  se queda recorriéndolo y en cinco minutos no saca ni un byte.

Así que el salto lo resuelve el proceso principal: lee el playlist una vez
(queda en caché 20 min), busca por bisección el segmento que contiene el segundo
pedido y le sirve a ffmpeg un playlist recortado que empieza ahí
(`/vod.m3u8` → `/vod.mp4` en el servidor local). Resultado: primer byte en
0,2 s y descarga a ~50×, así que en VOD la calidad por defecto es la máxima.

Como el `<video>` recibe un flujo que empieza en el punto del salto, sus
controles nativos mentirían sobre la duración; por eso los directos pasados
tienen una barra propia. Si un corte deja el flujo a medias, se retoma solo en
el mismo segundo.

### Los tres tipos de vídeo que devuelve la API

Midiendo 96 directos pasados recientes de Lost Ark:

| Tipo | Cuántos | Cómo se reproduce |
|---|---|---|
| Con `liveRewindPlaybackJson` | 69 | HLS fMP4 directo |
| Solo `videoId` + `inKey` | 15 | Manifiesto de `apis.naver.com/neonplayer` |
| `blindType=ABROAD` | 11 | Restringido a Corea: HTTP 500, código 9004 |
| Ninguno de los anteriores | 1 | No se puede |

Los de `inKey` dan un DASH convertido a JSON, pero dentro (`otherAttributes.m3u`
del adaptationSet `video/mp2t`) viene también un HLS normal. Dos detalles para
que funcione, ambos medidos:

- **La firma solo va en el playlist** (`__gda__=…`). Las líneas de variante y
  de segmento son relativas y sin query, y al resolverlas la query se pierde:
  **403**. Por eso el proceso principal hace que hereden la del playlist
  (`resolveUri`); en los demás CDN eso no cambia nada.
- **El audio viene en AAC ADTS dentro de TS**, que MP4 no admite tal cual:
  ffmpeg abortaba a los pocos segundos con *Error muxing a packet*. Se corrige
  con `-bsf:a aac_adtstoasc`, que no afecta a los otros vídeos.

Los restringidos a Corea siguen apareciendo en la lista. Su detalle responde
*«해외 시청 불가능한 컨텐츠 입니다»* (no visible fuera de Corea), pero no hace
falta pedirlo: la propia lista trae `blindType=ABROAD`, que en la muestra
coincide exactamente con el código 9004. Así la grilla los marca como
**Solo Corea** sin ninguna petición extra. (`exposure` no sirve para esto: viene
a `false` en todos.)

## La interfaz

- **Portada** — grilla de directos de Lost Ark con scroll infinito.
- **Barra lateral** — quién está emitiendo ahora y tus favoritos (se guardan en
  `%APPDATA%\chzzk-player\favorites.json`).
- **Buscador** — canales y directos de todo CHZZK (`/` para enfocarlo).
- **Pasados CHZZK** — directos ya terminados de Lost Ark, con barra de progreso
  si los dejaste a medias.

Al ver un directo: selector de calidad (arranca en 1080p), *Ir al directo*,
favorito, modo teatro, botón **ffplay** (ventana nativa aparte) y enlace a
`chzzk.naver.com`.

Atajos: `espacio`/`k` pausa · `m` mudo · `f` pantalla completa · `t` teatro ·
`↑`/`↓` volumen · `/` buscar.
En directos pasados, `←`/`→` (o `j`/`l`) saltan 10 s.

## Archivos

| Archivo | Cometido |
|---|---|
| `main.js` | Ventana, servidor local de vídeo, ffmpeg, API y favoritos |
| `preload.js` | Puente `PLATFORM` entre la ventana y el proceso principal |
| `renderer/app.js` | Interfaz: router por hash, vistas y los dos motores |
| `renderer/chzzk-api.js` | Llamadas a la API y normalización de respuestas |
| `smoke-test.js` | Prueba de humo sobre el código real (`npx electron smoke-test.js`) |

La interfaz es la misma que la de la extensión del navegador; todo lo que
depende del entorno está detrás de `PLATFORM`, que define `preload.js` aquí y
`platform-extension.js` allí.

## Probar

```
npx electron smoke-test.js
```

Arranca la app de verdad y comprueba contra la API en vivo: que la grilla se
pinta, que el vídeo llega desde ffmpeg en local, que arranca en 1080p y que
durante 30 s no se corta ni se queda atrás.
