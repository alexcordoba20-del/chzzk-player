// Capa de acceso a los directos de Lost Ark en Bilibili.
//
// Devuelve los datos ya normalizados con las mismas claves que chzzk-api.js,
// para que las vistas y el reproductor no tengan que distinguir la procedencia.
// Lo único que cambia es el campo `source`, que decide a qué ruta navega cada
// tarjeta.

const API = "https://api.live.bilibili.com";

// 网游 (juegos en línea) → 命运方舟 (Lost Ark).
export const AREA = { parentId: 2, areaId: 590, label: "Lost Ark" };

async function apiGet(path) {
  const res = await PLATFORM.apiFetch(API + path);
  if (!res || !res.ok) throw new Error("HTTP " + ((res && res.status) || "?"));
  const json = JSON.parse(res.body);
  // code -352 es su control anti-bot; el resto de códigos son errores normales.
  if (json.code !== 0) {
    throw new Error(json.code === -352
      ? "Bilibili ha bloqueado la petición (control anti-bot)"
      : json.message || "Error " + json.code);
  }
  return json.data;
}

function normalizeRoom(raw) {
  if (!raw || !raw.roomid) return null;
  return {
    source: "bilibili",
    liveId: raw.roomid,
    channelId: String(raw.roomid),
    title: raw.title || "",
    // system_cover es el fotograma en vivo; user_cover, la portada fija.
    thumbnail: raw.system_cover || raw.user_cover || raw.cover || "",
    fallbackThumbnail: raw.user_cover || raw.cover || "",
    viewers: raw.online || 0,
    channelName: raw.uname || "",
    channelImage: raw.face || "",
    categoryLabel: raw.area_name || "",
    categoryType: "",
    categoryId: "",
    verified: false,
    tags: [],
    openDate: ""
  };
}

// Nota: el endpoint que usa su propia web (xlive/.../second/getList) exige firma
// WBI y responde -352 sin ella. Este otro devuelve lo mismo y no la pide.
export async function getLives({ page = 1, pageSize = 30 } = {}) {
  const data = await apiGet(
    `/room/v3/area/getRoomList?platform=web&parent_area_id=${AREA.parentId}` +
    `&area_id=${AREA.areaId}&sort_type=online&page=${page}&page_size=${pageSize}`
  );
  const rows = (data && data.list) || [];
  const items = rows.map(normalizeRoom).filter(Boolean);
  return {
    items,
    total: (data && data.count) || 0,
    // No hay cursor: se pagina por número de página hasta agotar el total.
    nextPage: items.length === pageSize ? page + 1 : null
  };
}

// Detalle de una sala con el HLS ya extraído, en el mismo formato que
// getLiveDetail() de CHZZK.
export async function getLiveDetail(roomId) {
  const data = await apiGet(
    `/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${encodeURIComponent(roomId)}` +
    `&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8`
  );

  const detail = {
    source: "bilibili",
    channelId: String(roomId),
    liveId: data.room_id,
    title: "",
    open: data.live_status === 1,
    viewers: 0,
    channelName: "",
    channelImage: "",
    categoryLabel: "",
    categoryType: "",
    categoryId: "",
    tags: [],
    openDate: "",
    verified: false,
    adultBlocked: false,
    sources: [],
    tracks: [],
    url: ""
  };

  if (!detail.open) {
    detail.offline = true;
    return detail;
  }

  // Guardamos TODOS los nodos que ofrece, no solo el primero: Bilibili reparte
  // el directo entre varios CDN y desde fuera de China buena parte de los
  // "ov-gotcha" no responden. El proceso principal los prueba en orden.
  const streams = ((data.playurl_info || {}).playurl || {}).stream || [];
  for (const stream of streams) {
    if (stream.protocol_name !== "http_hls") continue;      // el flv no nos sirve
    for (const format of stream.format || []) {
      for (const codec of format.codec || []) {
        if (!codec.base_url) continue;
        for (const host of codec.url_info || []) {
          if (!host || !host.host) continue;
          detail.sources.push({
            id: format.format_name,
            protocol: "hls",
            qn: codec.current_qn,
            host: host.host,
            url: host.host + codec.base_url + (host.extra || "")
          });
        }
      }
    }
  }

  // fmp4 antes que ts: menos sobrecarga y ffmpeg lo remuxa igual de bien.
  detail.sources.sort((a, b) => rank(a) - rank(b));
  if (detail.sources.length) detail.url = detail.sources[0].url;

  return detail;
}

function rank(source) {
  if (source.id === "fmp4") return 0;
  if (source.id === "ts") return 1;
  return 2;
}

// Datos del canal para la cabecera; van en otra llamada que la de reproducción.
export async function getRoomInfo(roomId) {
  const data = await apiGet(
    `/xlive/web-room/v1/index/getInfoByRoom?room_id=${encodeURIComponent(roomId)}`
  );
  const info = (data && data.room_info) || {};
  const anchor = ((data || {}).anchor_info || {}).base_info || {};
  return {
    title: info.title || "",
    viewers: info.online || 0,
    categoryLabel: info.area_name || "",
    channelName: anchor.uname || "",
    channelImage: anchor.face || "",
    thumbnail: info.cover || info.keyframe || "",
    tags: info.tags ? String(info.tags).split(",").filter(Boolean) : []
  };
}
