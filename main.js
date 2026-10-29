// Proceso principal de CHZZK Player.
//
// Responsabilidades que en la extensión hacía el service worker:
//   - servir la interfaz bajo un origen propio (app://) para que no haya líos
//     de CORS ni las limitaciones de file://
//   - hablar con la API de CHZZK (desde aquí no hay CORS que valga)
//   - guardar los favoritos en disco
//   - lanzar ffmpeg | ffplay sin necesidad de native messaging

const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const RENDERER_DIR = path.join(__dirname, "renderer");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Un esquema propio nos da un origen real (app://chzzk), que es lo que hace
// falta para que fetch/XHR del reproductor se comporten con normalidad.
protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

let mainWindow = null;

// ------------------------------------------------------------- favoritos

function favoritesFile() {
  return path.join(app.getPath("userData"), "favorites.json");
}

function readFavorites() {
  try {
    return JSON.parse(fs.readFileSync(favoritesFile(), "utf8"));
  } catch {
    return [];
  }
}

function writeFavorites(list) {
  try {
    fs.mkdirSync(path.dirname(favoritesFile()), { recursive: true });
    fs.writeFileSync(favoritesFile(), JSON.stringify(list, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("No se pudieron guardar los favoritos:", err);
    return false;
  }
}

// ----------------------------------------------------------- ffmpeg/ffplay

// Buscamos los binarios junto al ejecutable y en las carpetas de alrededor,
// que es donde viven en este proyecto (Stream\Stream\ffmpeg.exe).
function findBinary(name) {
  const starts = [
    path.dirname(app.getPath("exe")),
    process.resourcesPath ? path.dirname(process.resourcesPath) : null,
    __dirname
  ].filter(Boolean);

  // Subimos por las carpetas padre: empaquetado, el .exe queda en
  // dist\win-unpacked y ffmpeg vive tres niveles más arriba, en Stream\Stream.
  const roots = [];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 5; i++) {
      if (!roots.includes(dir)) roots.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const root of roots) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return name; // que lo resuelva el PATH
}

// Réplica de play.ps1: ffmpeg remultiplexa a nut y ffplay lo pinta.
function launchFfplay(url) {
  const ffmpeg = findBinary("ffmpeg.exe");
  const ffplay = findBinary("ffplay.exe");

  const producer = spawn(ffmpeg, [
    "-hide_banner", "-loglevel", "warning",
    "-user_agent", UA,
    "-i", url,
    "-c", "copy", "-f", "nut", "-"
  ], { detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });

  const consumer = spawn(ffplay, [
    "-hide_banner", "-loglevel", "warning",
    "-x", "1280", "-y", "720",
    "-window_title", "CHZZK Player — ffplay",
    "-f", "nut", "-i", "-"
  ], { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });

  producer.stdout.pipe(consumer.stdin);

  // Si ffplay se cierra, ffmpeg no debe quedarse alimentando una tubería rota.
  consumer.on("exit", () => { try { producer.kill(); } catch { /* ya murió */ } });
  producer.on("error", (err) => console.error("ffmpeg:", err.message));
  consumer.on("error", (err) => console.error("ffplay:", err.message));

  producer.unref();
  consumer.unref();
}

// ------------------------------------- motor de reproducción con ffmpeg
//
// hls.js no aguanta 1080p contra el CDN de CHZZK: abre una petición nueva por
// cada segmento de 2 s y, con la latencia hasta Corea, TCP no llega a velocidad
// de crucero, así que la reproducción se va quedando atrás. ffmpeg mantiene una
// única conexión persistente y sí lo sostiene.
//
// Aquí ffmpeg tira del HLS, lo remuxa a fMP4 (sin recodificar, así que no gasta
// CPU) y lo escupe por un servidor local. El <video> de la ventana reproduce esa
// URL de 127.0.0.1, donde ya no hay cuello de botella de red.

let streamServer = null;
let streamPort = 0;

// El CDN puede comprobar de dónde viene la petición, así que le damos el
// Referer del servicio al que pertenece el stream.
const CDN_REFERERS = [
  [/\.bilivideo\.com$/, "https://live.bilibili.com/"],
  [/\.akamaized\.net$|naver/, "https://chzzk.naver.com/"]
];

function refererFor(rawUrl) {
  let host = "";
  try { host = new URL(rawUrl).host; } catch { return "https://chzzk.naver.com/"; }
  const match = CDN_REFERERS.find(([re]) => re.test(host));
  return match ? match[1] : "https://chzzk.naver.com/";
}

function ffmpegArgs(url) {
  return [
    "-hide_banner", "-loglevel", "error",
    "-user_agent", UA,
    "-referer", refererFor(url),
    // Un corte puntual del CDN no debe tumbar la reproducción.
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    // Punto de arranque: 8 segmentos (~16 s) por detrás del borde del directo.
    //
    // Con "0" arrancábamos en el segmento MÁS VIEJO de la ventana, y ahí está el
    // problema: como el <video> consume a 1x, su contrapresión impide que ffmpeg
    // se adelante, así que se queda anclado justo en el borde de caducidad. Los
    // segmentos expiran antes de leerlos y ffmpeg avisa "skipping N segments
    // ahead, expired from playlists". Cada salto descuadra el audio, y al final
    // tumba la reproducción.
    //
    // Negativo = contado desde el borde del directo. Con una ventana de 30 s,
    // esto deja ~14 s de margen antes de la caducidad y baja el retardo a la
    // mitad. Medido: con -4 hubo 3 cortes al arrancar; con -8, ninguno.
    "-live_start_index", "-8",
    // Que no se rinda si una recarga del playlist llega tarde.
    "-max_reload", "10",
    "-i", url,
    "-c", "copy",
    // Bilibili sirve algunas salas en TS con el audio AAC en ADTS (medido: nodo
    // gotcha105). Sin este filtro ffmpeg muere al segundo con "Malformed AAC
    // bitstream" y la app entra en bucle de reconexión. En fMP4 no cambia nada.
    "-bsf:a", "aac_adtstoasc",
    "-f", "mp4",
    // empty_moov permite empezar a emitir sin conocer la duración (es un
    // directo) y frag_keyframe corta fragmentos en cada keyframe.
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "1000000",
    "-"
  ];
}

// ------------------------------------------------ directos pasados (VOD)
//
// Los directos pasados de CHZZK son HLS bajo demanda de hasta 10-12 horas
// (unas 20.000 entradas en el playlist). Dos cosas condicionan cómo se sirven:
//
//  - hls.js no vale: con una petición por segmento el CDN entrega ~0,7x del
//    bitrate de 1080p, igual que pasaba en directo. Seguimos con ffmpeg.
//  - "-ss" de ffmpeg tampoco: sobre un playlist así se queda recorriéndolo y en
//    cinco minutos no llega a sacar ni un byte.
//
// Así que el salto lo hacemos nosotros: leemos el playlist una vez, buscamos el
// segmento que contiene el segundo pedido y le damos a ffmpeg un playlist
// recortado que empieza justo ahí. Medido: primer byte en 0,2 s y ~50x de
// velocidad de descarga.

const vodCache = new Map();          // url de la variante -> playlist troceado
const VOD_TTL = 20 * 60 * 1000;
const VOD_CACHE_MAX = 6;

async function loadVodPlaylist(variantUrl) {
  const hit = vodCache.get(variantUrl);
  if (hit && Date.now() - hit.at < VOD_TTL) return hit;

  const res = await net.fetch(variantUrl, {
    headers: { "User-Agent": UA, Referer: refererFor(variantUrl) },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);

  const abs = (uri) => resolveUri(uri, variantUrl);
  const head = [];
  const segments = [];
  let clock = 0;
  let pending = null;

  for (const line of (await res.text()).split(/\r?\n/)) {
    if (line.startsWith("#EXTINF:")) {
      pending = parseFloat(line.slice(8));
    } else if (line && !line.startsWith("#") && pending != null) {
      segments.push({ start: clock, dur: pending, uri: abs(line) });
      clock += pending;
      pending = null;
    } else if (!segments.length && /^#EXT-X-(VERSION|TARGETDURATION|MAP|INDEPENDENT-SEGMENTS)/.test(line)) {
      // EXT-X-MAP es la cabecera de inicialización del fMP4: sin ella ffmpeg no
      // puede decodificar ningún segmento, así que viaja con su URL absoluta.
      head.push(line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${abs(uri)}"`));
    }
  }
  if (!segments.length) throw new Error("el vídeo no tiene segmentos");

  const entry = { at: Date.now(), head, segments, duration: clock };
  vodCache.set(variantUrl, entry);
  if (vodCache.size > VOD_CACHE_MAX) vodCache.delete(vodCache.keys().next().value);
  return entry;
}

// Índice del segmento que contiene ese segundo (búsqueda binaria: son ~20.000).
function segmentAt(entry, seconds) {
  const target = Math.max(0, Math.min(Number(seconds) || 0, entry.duration - 1));
  let lo = 0;
  let hi = entry.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entry.segments[mid].start <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

async function serveVodPlaylist(url, res) {
  const source = url.searchParams.get("src") || "";
  if (!/^https:\/\//.test(source)) return void res.writeHead(400).end("origen no válido");

  try {
    const entry = await loadVodPlaylist(source);
    const first = segmentAt(entry, url.searchParams.get("t"));
    const out = ["#EXTM3U", ...entry.head, "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:" + first];
    for (const seg of entry.segments.slice(first)) out.push("#EXTINF:" + seg.dur + ",", seg.uri);
    out.push("#EXT-X-ENDLIST");
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" });
    res.end(out.join("\n"));
  } catch (err) {
    res.writeHead(502).end(String(err.message || err));
  }
}

function vodFfmpegArgs(playlistUrl, source) {
  return [
    "-hide_banner", "-loglevel", "error",
    "-user_agent", UA,
    "-referer", refererFor(source),
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", playlistUrl,
    "-c", "copy",
    // Los vídeos del reproductor de Naver vienen en TS con el audio AAC en ADTS,
    // que MP4 no admite tal cual: sin este filtro ffmpeg aborta a los pocos
    // segundos con "Error muxing a packet". En el resto no cambia nada.
    "-bsf:a", "aac_adtstoasc",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "1000000",
    "-"
  ];
}

function serveVodVideo(url, res) {
  const source = url.searchParams.get("src") || "";
  if (!/^https:\/\//.test(source)) return void res.writeHead(400).end("origen no válido");

  const t = Number(url.searchParams.get("t")) || 0;
  // ffmpeg lee el playlist recortado de nuestro propio servidor.
  const playlist = `http://127.0.0.1:${streamPort}/vod.m3u8?src=${encodeURIComponent(source)}&t=${t}`;
  pipeFfmpeg(res, vodFfmpegArgs(playlist, source));
}

// Lanza ffmpeg y vuelca su fMP4 en la respuesta HTTP. Lo comparten el directo
// y los directos pasados.
function pipeFfmpeg(res, args) {
  const ffmpeg = spawn(findBinary("ffmpeg.exe"), args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let failed = "";
  ffmpeg.stderr.on("data", (chunk) => {
    const text = String(chunk);
    failed += text;
    console.error("ffmpeg:", text.trim());
  });

  ffmpeg.on("error", (err) => {
    console.error("no se pudo lanzar ffmpeg:", err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });

  // Si el <video> se cierra, cambia de calidad o salta a otro punto, matamos el
  // proceso: si no, quedarían ffmpeg huérfanos descargando de fondo.
  const stop = () => { try { ffmpeg.kill("SIGKILL"); } catch { /* ya murió */ } };
  res.on("close", stop);
  ffmpeg.on("exit", (code) => {
    if (code && code !== 0 && !res.writableEnded) {
      console.error("ffmpeg terminó con código", code, failed.slice(0, 300));
    }
    res.end();
  });

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  ffmpeg.stdout.pipe(res);
}

function startStreamServer() {
  streamServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/vod.m3u8") return void serveVodPlaylist(url, res);
    if (url.pathname === "/vod.mp4") return void serveVodVideo(url, res);
    if (url.pathname !== "/live.mp4") {
      res.writeHead(404).end("no encontrado");
      return;
    }

    const source = url.searchParams.get("src") || "";
    if (!/^https:\/\//.test(source)) {
      res.writeHead(400).end("origen no válido");
      return;
    }

    pipeFfmpeg(res, ffmpegArgs(source));
  });

  // Puerto efímero y solo en loopback: nadie de fuera llega aquí.
  streamServer.listen(0, "127.0.0.1", () => {
    streamPort = streamServer.address().port;
    console.log("servidor de vídeo local en 127.0.0.1:" + streamPort);
  });
}

// Lee el master playlist y devuelve sus variantes, que es lo que alimenta el
// selector de calidad (antes lo hacía hls.js por su cuenta).
// Recibe una lista de candidatos porque Bilibili reparte el mismo directo entre
// varios nodos de CDN y no todos son alcanzables desde fuera de China: los
// "ov-gotcha" sobrantes se quedan colgados hasta agotar el tiempo. Probamos uno
// tras otro y nos quedamos con el primero que conteste.
async function readVariants(sources) {
  const candidates = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  if (!candidates.length) throw new Error("sin enlaces que probar");

  // En paralelo, no en cadena: si probamos uno tras otro, seis nodos muertos
  // suman seis tiempos de espera antes de rendirse. Gana el primero que conteste.
  try {
    return await Promise.any(candidates.map((c) => readOneVariant(c)));
  } catch {
    const hosts = candidates.map(hostOf);
    console.warn("ningún nodo respondió:", hosts.join(", "));
    const err = new Error(
      "El CDN de este directo no responde desde tu conexión (" +
      [...new Set(hosts)].join(", ") + ")"
    );
    err.unreachable = true;
    throw err;
  }
}

function hostOf(rawUrl) {
  try { return new URL(rawUrl).host; } catch { return String(rawUrl).slice(0, 40); }
}

// Resuelve una línea de playlist contra la URL del propio playlist. Si la línea
// no trae query y el playlist sí, la hereda: el reproductor de Naver solo firma
// el playlist (__gda__=...) y sin esa firma variantes y segmentos devuelven 403.
// Medido: en los demás CDN heredarla no cambia nada, y las líneas que ya traen
// su propia query (los EXT-X-MAP, los directos) se quedan como estaban.
function resolveUri(uri, base) {
  const url = new URL(uri, base);
  if (!uri.includes("?")) url.search = new URL(base).search;
  return url.toString();
}

async function readOneVariant(masterUrl) {
  const res = await net.fetch(masterUrl, {
    headers: { "User-Agent": UA, Referer: refererFor(masterUrl) },
    // Sin esto, un nodo muerto bloquea la reproduccion medio minuto.
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);

  const lines = (await res.text()).split(/\r?\n/);
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const target = (lines[i + 1] || "").trim();
    if (!target || target.startsWith("#")) continue;

    const resolution = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
    const bandwidth = lines[i].match(/BANDWIDTH=(\d+)/);
    const frameRate = lines[i].match(/FRAME-RATE=([\d.]+)/);

    variants.push({
      width: resolution ? Number(resolution[1]) : 0,
      height: resolution ? Number(resolution[2]) : 0,
      bitrate: bandwidth ? Number(bandwidth[1]) : 0,
      fps: frameRate ? Math.round(parseFloat(frameRate[1])) : 0,
      url: resolveUri(target, masterUrl)
    });
  }

  // Bilibili no sirve un master playlist: da directamente la lista de segmentos
  // (allí la calidad se pide por el parámetro qn de su API). En ese caso el
  // propio enlace es la única "variante".
  if (!variants.length && lines.some((l) => l.startsWith("#EXTINF"))) {
    return [{ width: 0, height: 0, bitrate: 0, fps: 0, url: masterUrl }];
  }

  variants.sort((a, b) => b.height - a.height);
  return variants;
}

// ------------------------------------------------------------------- IPC

// Cada servicio quiere que la petición parezca venir de su propia web.
const API_HOSTS = {
  "api.chzzk.naver.com": "https://chzzk.naver.com",
  "api.live.bilibili.com": "https://live.bilibili.com",
  // Reproductor de Naver: da el manifiesto de los vídeos que no traen repetición HLS.
  "apis.naver.com": "https://chzzk.naver.com"
};

function siteFor(rawUrl) {
  let host = "";
  try { host = new URL(rawUrl).host; } catch { return null; }
  return API_HOSTS[host] || null;
}

ipcMain.handle("api-fetch", async (_event, url) => {
  const site = typeof url === "string" && url.startsWith("https://") ? siteFor(url) : null;
  if (!site) throw new Error("URL no permitida");

  const res = await net.fetch(url, {
    headers: {
      "User-Agent": UA,
      "Referer": site + "/",
      "Origin": site,
      "Accept": "application/json"
    }
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
});

ipcMain.handle("favorites-get", () => readFavorites());
ipcMain.handle("favorites-set", (_event, list) => writeFavorites(Array.isArray(list) ? list : []));

ipcMain.handle("ffplay", (_event, url) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("URL no válida");
  launchFfplay(url);
  return true;
});

ipcMain.handle("open-external", (_event, url) => {
  if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.handle("stream-variants", (_event, sources) => readVariants(sources));

// URL local que el <video> puede reproducir para un stream dado.
ipcMain.handle("stream-url", (_event, source) => {
  if (!streamPort) throw new Error("el servidor de vídeo no está listo");
  return `http://127.0.0.1:${streamPort}/live.mp4?src=${encodeURIComponent(source)}`;
});

// Abre un directo pasado en el segundo pedido. Devuelve la URL local y el
// segundo real en que arranca (el inicio de su segmento), que la interfaz usa
// como desfase: el <video> siempre cuenta desde 0.
ipcMain.handle("vod-open", async (_event, source, seconds) => {
  if (!streamPort) throw new Error("el servidor de vídeo no está listo");
  if (typeof source !== "string" || !/^https:\/\//.test(source)) throw new Error("URL no válida");

  const entry = await loadVodPlaylist(source);
  const start = entry.segments[segmentAt(entry, seconds)].start;
  return {
    url: `http://127.0.0.1:${streamPort}/vod.mp4?src=${encodeURIComponent(source)}&t=${start}`,
    start,
    duration: entry.duration
  };
});

// ¿Está ffmpeg disponible? Si no, la interfaz vuelve a hls.js.
ipcMain.handle("has-ffmpeg", () => fs.existsSync(findBinary("ffmpeg.exe")));

// ---------------------------------------------------------------- ventana

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#141517",
    title: "CHZZK Player",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icons", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadURL("app://chzzk/app.html");

  // Los enlaces externos van al navegador del sistema, no a una ventana nueva.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // Sin menú: los atajos útiles los gestiona la propia interfaz.
  Menu.setApplicationMenu(null);

  startStreamServer();

  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "") || "app.html";
    const target = path.join(RENDERER_DIR, relative);

    // Nadie sale de la carpeta renderer.
    if (!target.startsWith(RENDERER_DIR)) {
      return new Response("Prohibido", { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  createWindow();

  // Actualizaciones desde GitHub (ver actualizador.js y arranque.js).
  try { require("./actualizador").iniciar(() => mainWindow); }
  catch (err) { console.error("No se pudo iniciar el actualizador:", err); }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
