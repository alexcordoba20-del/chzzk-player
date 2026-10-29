// Capa de acceso a la API pública de CHZZK.
//
// Los distintos endpoints devuelven los directos con formas distintas
// (content.data, content.liveInfoResponseList, content.data[].live...), así que
// todo pasa por normalizeLive() y el resto de la app maneja un único formato.

const API = "https://api.chzzk.naver.com";

// La petición la hace el entorno anfitrión (el proceso principal de Electron o
// el service worker de la extensión): así se evita el CORS y se puede mandar el
// Referer que Naver espera.
async function apiGet(path) {
  const res = await PLATFORM.apiFetch(API + path);
  if (!res || !res.ok) {
    // El cuerpo del error trae el código de CHZZK (9004 = restringido fuera de
    // Corea), que distingue un contenido bloqueado de un fallo de verdad.
    const err = new Error("HTTP " + ((res && res.status) || "?"));
    err.status = res && res.status;
    try {
      const body = JSON.parse(res.body);
      err.code = body.code;
      err.apiMessage = body.message;
    } catch { /* cuerpo sin JSON */ }
    throw err;
  }
  return unwrap(JSON.parse(res.body));
}

function unwrap(json) {
  if (!json || typeof json !== "object") throw new Error("Respuesta no válida");
  if (json.code && json.code !== 200) throw new Error(json.message || "Error " + json.code);
  return json.content;
}

// ---------------------------------------------------------------- directos

// Un mismo directo llega con envoltorios distintos según el endpoint; aquí se
// aplana todo a la misma forma.
export function normalizeLive(raw) {
  if (!raw) return null;
  const live = raw.live || raw;
  const channel = live.channel || raw.channel || {};

  return {
    liveId: live.liveId,
    title: live.liveTitle || "",
    thumbnail: live.liveImageUrl || live.defaultThumbnailImageUrl || "",
    fallbackThumbnail: live.defaultThumbnailImageUrl || "",
    viewers: live.concurrentUserCount || 0,
    openDate: live.openDate || "",
    adult: !!live.adult,
    categoryType: live.categoryType || "",
    categoryId: live.liveCategory || "",
    categoryLabel: live.liveCategoryValue || "",
    tags: live.tags || [],
    channelId: channel.channelId || "",
    channelName: channel.channelName || "",
    channelImage: channel.channelImageUrl || "",
    verified: !!channel.verifiedMark
  };
}

function collectLives(content) {
  if (!content) return [];
  const rows = content.data || content.liveInfoResponseList || [];
  return rows.map(normalizeLive).filter((l) => l && l.channelId);
}

// Cursor de paginación de /lives: la API pide de vuelta los valores que ella
// misma devuelve en page.next.
function livesCursor(content) {
  const next = content && content.page && content.page.next;
  if (!next || next.liveId == null) return null;
  return `&concurrentUserCount=${next.concurrentUserCount}&liveId=${next.liveId}`;
}

// v2, no v1: la v1 devuelve como mucho 10 directos y sin cursor de paginación.
export async function getCategoryLives(categoryType, categoryId, { size = 24, cursor = "" } = {}) {
  const content = await apiGet(
    `/service/v2/categories/${encodeURIComponent(categoryType)}/` +
    `${encodeURIComponent(categoryId)}/lives?size=${size}${cursor}`
  );
  return { items: collectLives(content), cursor: livesCursor(content) };
}

// ------------------------------------------------------------- categorías

export async function getCategoryInfo(categoryType, categoryId) {
  const content = await apiGet(
    `/service/v1/categories/${encodeURIComponent(categoryType)}/` +
    `${encodeURIComponent(categoryId)}/info`
  );
  if (!content) return null;
  return {
    categoryType: content.categoryType,
    categoryId: content.categoryId,
    label: content.categoryValue || content.categoryId,
    poster: content.posterImageUrl || "",
    viewers: content.concurrentUserCount || 0,
    liveCount: content.openLiveCount || 0
  };
}

// ---------------------------------------------------------------- búsqueda

export async function searchLives(keyword, { size = 24, offset = 0 } = {}) {
  const content = await apiGet(
    `/service/v1/search/lives?keyword=${encodeURIComponent(keyword)}&size=${size}&offset=${offset}`
  );
  const next = content && content.page && content.page.next;
  return {
    items: collectLives(content),
    nextOffset: next && typeof next.offset === "number" ? next.offset : null
  };
}

export async function searchChannels(keyword, { size = 20, offset = 0 } = {}) {
  const content = await apiGet(
    `/service/v1/search/channels?keyword=${encodeURIComponent(keyword)}&size=${size}&offset=${offset}`
  );
  const rows = (content && content.data) || [];
  return rows.map((row) => {
    const ch = row.channel || row;
    return {
      channelId: ch.channelId,
      channelName: ch.channelName || "",
      channelImage: ch.channelImageUrl || "",
      description: ch.channelDescription || "",
      followers: ch.followerCount || 0,
      live: !!ch.openLive,
      verified: !!ch.verifiedMark
    };
  }).filter((c) => c.channelId);
}

// ------------------------------------------------------- canal y reproducción

export async function getChannel(channelId) {
  const content = await apiGet(`/service/v1/channels/${encodeURIComponent(channelId)}`);
  return {
    channelId: content.channelId,
    channelName: content.channelName || "",
    channelImage: content.channelImageUrl || "",
    description: content.channelDescription || "",
    followers: content.followerCount || 0,
    live: !!content.openLive,
    verified: !!content.verifiedMark
  };
}

// Devuelve los datos del directo junto con el master HLS ya extraído.
// Solo la v2 sirve: la v1 responde 9004 para canales normales.
export async function getLiveDetail(channelId) {
  const content = await apiGet(
    `/service/v2/channels/${encodeURIComponent(channelId)}/live-detail`
  );

  // Un canal que no está emitiendo responde 200 con content nulo.
  if (!content) {
    const channel = await getChannel(channelId).catch(() => null);
    return {
      channelId,
      open: false,
      offline: true,
      status: "CLOSE",
      title: "",
      viewers: 0,
      tags: [],
      sources: [],
      tracks: [],
      url: "",
      channelName: (channel && channel.channelName) || "",
      channelImage: (channel && channel.channelImage) || "",
      verified: !!(channel && channel.verified)
    };
  }

  const detail = {
    liveId: content.liveId,
    title: content.liveTitle || "",
    status: content.status,
    open: content.status === "OPEN",
    viewers: content.concurrentUserCount || 0,
    openDate: content.openDate || "",
    adult: !!content.adult,
    adultBlocked: content.adult && content.userAdultStatus !== "ADULT",
    categoryLabel: content.liveCategoryValue || "",
    categoryType: content.categoryType || "",
    categoryId: content.liveCategory || "",
    tags: content.tags || [],
    thumbnail: content.liveImageUrl || "",
    channelId,
    channelName: (content.channel && content.channel.channelName) || "",
    channelImage: (content.channel && content.channel.channelImageUrl) || "",
    verified: !!(content.channel && content.channel.verifiedMark),
    sources: [],
    tracks: []
  };

  const playback = parsePlayback(content.livePlaybackJson);
  if (playback) {
    for (const media of playback.media || []) {
      if (!media.path) continue;
      detail.sources.push({ id: media.mediaId, protocol: media.protocol, url: media.path });
      for (const track of media.encodingTrack || []) {
        if (track.encodingTrackId === "audioOnly") continue;
        if (detail.tracks.some((t) => t.id === track.encodingTrackId)) continue;
        detail.tracks.push({
          id: track.encodingTrackId,
          width: track.videoWidth || 0,
          height: track.videoHeight || 0,
          fps: track.videoFrameRate || ""
        });
      }
    }
  }

  // Preferimos HLS normal sobre LLHLS: aguanta mucho mejor el buffer.
  detail.sources.sort((a, b) => rankSource(a) - rankSource(b));
  detail.tracks.sort((a, b) => (b.height || 0) - (a.height || 0));
  detail.url = detail.sources.length ? detail.sources[0].url : "";

  return detail;
}

function rankSource(source) {
  if (source.id === "HLS") return 0;
  if (source.id === "LLHLS") return 1;
  return 2;
}

function parsePlayback(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// ------------------------------------------------------------------ utils

// Las miniaturas llegan con un hueco {type} que hay que rellenar con el ancho.
export function thumbUrl(url, size = 480) {
  if (!url) return "";
  return url.replace("{type}", String(size));
}

export function formatViewers(n) {
  if (!n && n !== 0) return "";
  if (n >= 10000) return (n / 1000).toFixed(0) + "K";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// "2026-08-12 14:45:51" -> "hace 1 h 20 min"
export function elapsedSince(openDate) {
  if (!openDate) return "";
  const started = new Date(openDate.replace(" ", "T"));
  if (isNaN(started)) return "";
  const mins = Math.floor((Date.now() - started.getTime()) / 60000);
  if (mins < 1) return "recién empezado";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ------------------------------------------------ directos pasados (VOD)

export function normalizeVideo(raw) {
  if (!raw || !raw.videoNo) return null;
  const channel = raw.channel || {};
  return {
    source: "chzzk-vod",
    videoNo: raw.videoNo,
    title: raw.videoTitle || "",
    thumbnail: raw.thumbnailImageUrl || "",
    duration: raw.duration || 0,
    // publishDate viene en hora de Corea; publishDateAt es epoch y no engaña.
    publishedAt: raw.publishDateAt || 0,
    views: raw.readCount || 0,
    adult: !!raw.adult,
    videoType: raw.videoType || "",
    categoryLabel: raw.videoCategoryValue || "",
    channelId: channel.channelId || "",
    channelName: channel.channelName || "",
    channelImage: channel.channelImageUrl || "",
    verified: !!channel.verifiedMark,
    // "ABROAD": el canal no deja verlo fuera de Corea. Medido en 96 vídeos:
    // coincide exactamente con los que la API rechaza después con el código 9004.
    geoBlocked: raw.blindType === "ABROAD"
  };
}

// v2, no v1: la v1 por categoría solo devuelve los ~8 últimos y sin paginar.
// La v2 pagina con un cursor (publishDateAt + readCount) que hay que devolverle.
export async function getCategoryVideos(categoryType, categoryId, { size = 24, cursor = "" } = {}) {
  const content = await apiGet(
    `/service/v2/categories/${encodeURIComponent(categoryType)}/` +
    `${encodeURIComponent(categoryId)}/videos?size=${size}${cursor}`
  );
  const rows = (content && content.data) || [];
  const next = content && content.page && content.page.next;
  return {
    items: rows.map(normalizeVideo).filter(Boolean),
    cursor: next && next.publishDateAt != null
      ? `&publishDateAt=${next.publishDateAt}&readCount=${next.readCount}`
      : null
  };
}

export async function getChannelVideos(channelId, { page = 0, size = 12 } = {}) {
  const content = await apiGet(
    `/service/v1/channels/${encodeURIComponent(channelId)}/videos` +
    `?sortType=LATEST&pagingType=PAGE&page=${page}&size=${size}`
  );
  return {
    items: ((content && content.data) || []).map(normalizeVideo).filter(Boolean),
    total: (content && content.totalCount) || 0,
    totalPages: (content && content.totalPages) || 0
  };
}

// Detalle de un vídeo con su HLS. Medido sobre 96 directos pasados de Lost Ark:
//  - 69 traen la repetición en liveRewindPlaybackJson.
//  - 15 solo traen videoId + inKey: su manifiesto lo da el reproductor de Naver
//    como un DASH pasado a JSON, pero dentro, en el adaptationSet de vídeo TS,
//    viene también el HLS (otherAttributes.m3u).
//  - 11 están restringidos a Corea: HTTP 500 con código 9004.
export async function getVideo(videoNo) {
  let content;
  try {
    content = await apiGet(`/service/v2/videos/${encodeURIComponent(videoNo)}`);
  } catch (err) {
    // 9004: "해외 시청 불가능한 컨텐츠", contenido no visible fuera de Corea.
    if (err.code === 9004) return { videoNo, geoBlocked: true, sources: [], url: "", unsupported: true };
    throw err;
  }
  if (!content || !content.videoNo) throw new Error("vídeo no encontrado");

  const video = normalizeVideo(content) || { videoNo };
  video.sources = [];
  const playback = parsePlayback(content.liveRewindPlaybackJson);
  for (const media of (playback && playback.media) || []) {
    if (media.path && media.protocol === "HLS") video.sources.push({ id: media.mediaId, url: media.path });
  }
  if (!video.sources.length && content.inKey && content.videoId) {
    const hls = await neonplayerHls(content.videoId, content.inKey).catch(() => "");
    if (hls) video.sources.push({ id: "NEONPLAYER_HLS", url: hls });
  }
  video.url = video.sources.length ? video.sources[0].url : "";
  video.unsupported = !video.url;
  video.adultBlocked = !!content.adult && content.userAdultStatus !== "ADULT";
  return video;
}

// 38880 -> "10:48:00"; 125 -> "2:05".
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}

// epoch en ms -> "hace 3 h", "ayer", "hace 5 días", "12 ago 2026".
export function timeAgo(epochMs) {
  if (!epochMs) return "";
  const mins = Math.floor((Date.now() - epochMs) / 60000);
  if (mins < 1) return "hace un momento";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;
  return new Date(epochMs).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
}

// Enlace HLS de un vídeo servido por el reproductor de Naver (los que no traen
// repetición propia). Devuelve "" si el manifiesto no lo incluye.
async function neonplayerHls(videoId, inKey) {
  const res = await PLATFORM.apiFetch(
    "https://apis.naver.com/neonplayer/vodplay/v2/playback/" +
    encodeURIComponent(videoId) + "?key=" + encodeURIComponent(inKey)
  );
  if (!res || !res.ok) return "";
  const manifest = JSON.parse(res.body);
  const period = (manifest.period || [])[0] || {};
  const ts = (period.adaptationSet || []).find((set) => set.mimeType === "video/mp2t");
  return (ts && ts.otherAttributes && ts.otherAttributes.m3u) || "";
}
