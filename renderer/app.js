// CHZZK Player — navegación por los directos y reproducción HLS integrada.
//
// La ruta vive en el hash (#/live, #/watch/<channelId>, ...). Cada vista se
// dibuja entera dentro de <main>; el reproductor se destruye al salir de
// #/watch para no dejar descargas de segmentos colgando.

import {
  getCategoryLives, getCategoryInfo, getLiveDetail, getChannel,
  searchLives, searchChannels,
  getCategoryVideos, getChannelVideos, getVideo,
  thumbUrl, formatViewers, elapsedSince, formatDuration, timeAgo
} from "./chzzk-api.js";

import * as bilibili from "./bilibili-api.js";

const $ = (sel) => document.querySelector(sel);
const main = $("#main");

// La app vive dentro de una única categoría: los directos de Lost Ark.
const HOME = { type: "GAME", id: "Lost_Ark" };
const HOME_ROUTE = `#/category/${HOME.type}/${HOME.id}`;

const state = {
  route: "",
  favorites: [],
  hls: null,
  useFfmpeg: false,
  watchdog: null,
  vod: null,
  detail: null,
  pollTimer: null,
  volume: 1,
  muted: false
};

// ------------------------------------------------------------- utilidades

function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.html != null) node.innerHTML = opts.html;   // solo para iconos propios
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) {
    if (v != null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  if (opts.on) for (const [ev, fn] of Object.entries(opts.on)) node.addEventListener(ev, fn);
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

const ICON = {
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  check: '<svg viewBox="0 0 24 24" class="verified"><path d="M20 6L9 17l-5-5"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M20.8 5.6a5 5 0 00-7.1 0L12 7.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 21.5l8.8-8.8a5 5 0 000-7.1z"/></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg>',
  theater: '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="1.5"/></svg>',
  live: '<svg viewBox="0 0 24 24"><path d="M12 3v18M5 8v8M19 8v8"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 15s1-1.4 3-1.4S15 15 15 15M9.5 9.5h.01M14.5 9.5h.01"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>'
};

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { node.hidden = true; }, 2200);
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function emptyState(title, hint) {
  return el("div", { class: "empty" },
    el("div", { html: ICON.empty }),
    el("strong", { text: title }),
    hint ? el("div", { text: hint }) : null
  );
}

function skeletonGrid(count = 12) {
  const grid = el("div", { class: "grid" });
  for (let i = 0; i < count; i++) grid.append(el("div", { class: "card-skeleton" }));
  return grid;
}

// --------------------------------------------------------------- favoritos

async function loadFavorites() {
  state.favorites = (await PLATFORM.getFavorites()) || [];
  renderFavorites();
}

async function toggleFavorite(channel) {
  const idx = state.favorites.findIndex((f) => f.channelId === channel.channelId);
  if (idx >= 0) state.favorites.splice(idx, 1);
  else state.favorites.unshift({
    channelId: channel.channelId,
    channelName: channel.channelName,
    channelImage: channel.channelImage
  });
  await PLATFORM.setFavorites(state.favorites);
  renderFavorites();
  return idx < 0;
}

function isFavorite(channelId) {
  return state.favorites.some((f) => f.channelId === channelId);
}

function renderFavorites() {
  const section = $("#favSection");
  const list = $("#favList");
  clear(list);
  section.hidden = state.favorites.length === 0;
  for (const fav of state.favorites) {
    list.append(channelRow({
      channelId: fav.channelId,
      channelName: fav.channelName,
      channelImage: fav.channelImage
    }));
  }
}

// Fila de canal reutilizada por favoritos y recomendados.
function channelRow(channel) {
  const item = el("li", {
    class: "chan-item" + (channel.live ? " is-live" : ""),
    on: { click: () => navigate(`#/watch/${channel.channelId}`) }
  },
    el("img", {
      class: "chan-avatar",
      attrs: { src: channel.channelImage || "icons/icon48.png", alt: "", loading: "lazy" }
    }),
    el("div", { class: "chan-meta" },
      el("div", { class: "chan-name" },
        el("span", { text: channel.channelName }),
        channel.verified ? el("span", { html: ICON.check }) : null
      ),
      el("div", { class: "chan-sub", text: channel.categoryLabel || "" })
    ),
    channel.live ? el("span", { class: "chan-live", text: formatViewers(channel.viewers) }) : null
  );
  item.dataset.channelId = channel.channelId;
  return item;
}

// La lista lateral son los propios canales de Lost Ark que están emitiendo.
async function loadRecommended() {
  const list = $("#recList");
  try {
    const { items } = await getCategoryLives(HOME.type, HOME.id, { size: 20 });
    clear(list);
    if (!items.length) {
      list.append(el("li", { class: "chan-sub", text: "  Nadie emitiendo ahora" }));
      return;
    }
    for (const live of items) {
      list.append(channelRow({
        channelId: live.channelId,
        channelName: live.channelName,
        channelImage: live.channelImage,
        verified: live.verified,
        live: true,
        viewers: live.viewers,
        categoryLabel: live.title
      }));
    }
    markActiveChannel();
  } catch {
    clear(list);
    list.append(el("li", { class: "chan-sub", text: "  No se pudo cargar" }));
  }
}

// ------------------------------------------------------------ tarjetas

function liveCard(live) {
  const thumb = thumbUrl(live.thumbnail, 480) || live.fallbackThumbnail;

  const img = el("img", {
    attrs: { src: thumb || "icons/icon128.png", alt: "", loading: "lazy" }
  });
  img.addEventListener("error", () => {
    if (live.fallbackThumbnail && img.src !== live.fallbackThumbnail) img.src = live.fallbackThumbnail;
    else img.src = "icons/icon128.png";
  }, { once: false });

  const category = live.categoryLabel
    ? el("div", {
        class: "card-category",
        text: live.categoryLabel,
        on: {
          click: (e) => {
            e.stopPropagation();
            if (live.categoryType && live.categoryId) {
              navigate(`#/category/${live.categoryType}/${encodeURIComponent(live.categoryId)}`);
            }
          }
        }
      })
    : null;

  const route = live.source === "bilibili"
    ? `#/bwatch/${live.channelId}`
    : `#/watch/${live.channelId}`;

  return el("article", {
    class: "card",
    on: { click: () => navigate(route) }
  },
    el("div", { class: "card-thumb" },
      img,
      el("span", { class: "badge-live", text: "EN DIRECTO" }),
      el("span", { class: "badge-viewers", html: ICON.eye },
        el("span", { text: formatViewers(live.viewers) })
      )
    ),
    el("div", { class: "card-body" },
      el("img", {
        class: "card-avatar",
        attrs: { src: live.channelImage || "icons/icon48.png", alt: "", loading: "lazy" }
      }),
      el("div", { class: "card-text" },
        el("h3", { class: "card-title", text: live.title, attrs: { title: live.title } }),
        el("div", { class: "card-channel" },
          el("span", { text: live.channelName }),
          live.verified ? el("span", { html: ICON.check }) : null
        ),
        category
      )
    )
  );
}

// Añade paginación automática al llegar al final de la lista.
function attachPager(container, loadNext) {
  const sentinel = el("div", { class: "load-more" });
  container.append(sentinel);

  let busy = false;
  let done = false;

  const observer = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || busy || done) return;
    busy = true;
    sentinel.append(el("div", { class: "card-skeleton", attrs: { style: "width:180px" } }));
    try {
      done = !(await loadNext());
    } catch {
      done = true;
    }
    clear(sentinel);
    busy = false;
    if (done) observer.disconnect();
  }, { root: main, rootMargin: "600px" });

  observer.observe(sentinel);
  return () => observer.disconnect();
}

// ------------------------------------------------------------ vistas

async function viewCategory(type, rawId) {
  const id = decodeURIComponent(rawId);

  const title = el("h1", { class: "page-title", text: id.replace(/_/g, " ") });
  const sub = el("span", { class: "page-sub", text: "Cargando directos…" });
  const poster = el("img", {
    class: "cat-hero",
    attrs: { alt: "", hidden: true }
  });

  const page = el("div", { class: "page" },
    el("div", { class: "page-head" }, poster, title, sub)
  );
  const grid = el("div", { class: "grid" });
  const loading = skeletonGrid(8);
  page.append(grid, loading);
  render(page);

  // La ficha de la categoría da el nombre real y el póster; si falla, seguimos
  // con el id formateado, que ya es legible.
  getCategoryInfo(type, id).then((info) => {
    if (!info) return;
    title.textContent = info.label;
    if (info.poster) { poster.src = info.poster; poster.hidden = false; }
  }).catch(() => {});

  let cursor = "";
  const first = await getCategoryLives(type, id, { size: 24 });
  loading.remove();

  if (!first.items.length) {
    sub.textContent = "";
    page.append(emptyState("No hay nadie emitiendo ahora mismo",
      "Vuelve a intentarlo más tarde o pulsa el botón de actualizar."));
    return;
  }

  sub.textContent = `${first.items.length}+ directos`;
  first.items.forEach((l) => grid.append(liveCard(l)));
  cursor = first.cursor;

  attachPager(page, async () => {
    if (!cursor) return false;
    const next = await getCategoryLives(type, id, { size: 24, cursor });
    next.items.forEach((l) => grid.append(liveCard(l)));
    cursor = next.cursor;
    return !!cursor && next.items.length > 0;
  });
}

// ------------------------------------------------------------- bilibili

async function viewBilibili() {
  const title = el("h1", { class: "page-title", text: "Lost Ark en Bilibili" });
  const sub = el("span", { class: "page-sub", text: "Cargando directos…" });
  const page = el("div", { class: "page" }, el("div", { class: "page-head" }, title, sub));

  const grid = el("div", { class: "grid" });
  const loading = skeletonGrid(8);
  page.append(grid, loading);
  render(page);

  let first;
  try {
    first = await bilibili.getLives({ page: 1 });
  } catch (err) {
    loading.remove();
    sub.textContent = "";
    page.append(emptyState("No se pudo conectar con Bilibili", String(err.message || err)));
    return;
  }

  loading.remove();
  if (!first.items.length) {
    sub.textContent = "";
    page.append(emptyState("No hay nadie emitiendo ahora mismo"));
    return;
  }

  sub.textContent = `${first.total} directos · 命运方舟`;
  first.items.forEach((l) => grid.append(liveCard(l)));

  let next = first.nextPage;
  attachPager(page, async () => {
    if (!next) return false;
    const more = await bilibili.getLives({ page: next });
    more.items.forEach((l) => grid.append(liveCard(l)));
    next = more.nextPage;
    return !!next && more.items.length > 0;
  });
}

async function viewBiliWatch(roomId) {
  const stage = el("div", { class: "stage" });
  const video = el("video", { attrs: { playsinline: true, autoplay: true } });
  const overlay = el("div", { class: "stage-overlay" }, el("div", { class: "spinner" }));
  stage.append(video, overlay);

  const controls = el("div", { class: "controls" });
  const info = el("div", { class: "watch-info" });
  render(el("div", { class: "watch" }, stage, controls, info));

  video.controls = true;
  video.volume = state.volume;
  video.muted = state.muted;

  let detail;
  try {
    detail = await bilibili.getLiveDetail(roomId);
  } catch (err) {
    return showStageMessage(overlay, "No se pudo abrir la sala", String(err.message || err));
  }

  // El detalle de reproducción no trae título ni autor: van en otra llamada.
  const meta = await bilibili.getRoomInfo(roomId).catch(() => null);
  if (meta) Object.assign(detail, {
    title: meta.title,
    viewers: meta.viewers,
    categoryLabel: meta.categoryLabel,
    channelName: meta.channelName,
    channelImage: meta.channelImage,
    tags: meta.tags
  });

  state.detail = detail;
  markActiveChannel();
  document.title = `${detail.channelName || "Bilibili"} · CHZZK Player`;
  buildWatchInfo(info, detail);

  if (!detail.open) {
    buildControls(controls, detail, video, null);
    return showStageMessage(overlay, "Sala sin emisión",
      "Este canal no está en directo ahora mismo.");
  }
  if (!detail.url) {
    buildControls(controls, detail, video, null);
    return showStageMessage(overlay, "Sin stream disponible",
      "Bilibili no ha devuelto ninguna pista HLS para esta sala.");
  }

  const player = startPlayback(video, streamCandidates(detail), overlay);
  buildControls(controls, detail, video, player);
}

// ------------------------------------------------- directos pasados (VOD)

const VOD_ICON = {
  play: '<svg viewBox="0 0 24 24"><path class="fill" d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path class="fill" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M11 7l-5 5 5 5"/><path d="M18 7l-5 5 5 5"/></svg>',
  forward: '<svg viewBox="0 0 24 24"><path d="M13 7l5 5-5 5"/><path d="M6 7l5 5-5 5"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'
};

// Posición guardada por vídeo, para seguir donde se dejó. localStorage basta:
// es de este equipo y no pasa nada grave si se pierde.
const resumeKey = (videoNo) => "vod-pos:" + videoNo;

function loadResume(videoNo, duration) {
  try {
    const t = Number(localStorage.getItem(resumeKey(videoNo))) || 0;
    // Ni el principio ni el final cuentan como "a medias".
    return t > 30 && (!duration || t < duration - 60) ? t : 0;
  } catch {
    return 0;
  }
}

function saveResume(videoNo, seconds) {
  try { localStorage.setItem(resumeKey(videoNo), String(Math.floor(seconds))); } catch { /* sin almacenamiento */ }
}

function clearResume(videoNo) {
  try { localStorage.removeItem(resumeKey(videoNo)); } catch { /* sin almacenamiento */ }
}

// Los errores que llegan por IPC traen delante el nombre del método remoto.
function ipcMessage(err) {
  return String((err && err.message) || err || "")
    .replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function vodCard(video) {
  const img = el("img", {
    attrs: { src: video.thumbnail || "icons/icon128.png", alt: "", loading: "lazy" }
  });
  img.addEventListener("error", () => { img.src = "icons/icon128.png"; }, { once: true });

  const resume = loadResume(video.videoNo, video.duration);
  const progress = resume && video.duration
    ? el("div", { class: "resume-bar" },
        el("span", { attrs: { style: `width:${Math.min(100, (resume / video.duration) * 100).toFixed(1)}%` } }))
    : null;

  return el("article", {
    class: "card" + (video.geoBlocked ? " unavailable" : ""),
    attrs: {
      "data-video-no": String(video.videoNo),
      title: video.geoBlocked ? "El canal no permite verlo fuera de Corea" : null
    },
    on: { click: () => navigate(`#/vod/${video.videoNo}`) }
  },
    el("div", { class: "card-thumb" },
      img,
      el("span", { class: "badge-duration", text: formatDuration(video.duration) }),
      video.geoBlocked ? el("span", { class: "badge-blocked", text: "Solo Corea" }) : null,
      video.views
        ? el("span", { class: "badge-viewers", html: ICON.eye }, el("span", { text: formatViewers(video.views) }))
        : null,
      progress
    ),
    el("div", { class: "card-body" },
      el("img", {
        class: "card-avatar",
        attrs: { src: video.channelImage || "icons/icon48.png", alt: "", loading: "lazy" }
      }),
      el("div", { class: "card-text" },
        el("h3", { class: "card-title", text: video.title, attrs: { title: video.title } }),
        el("div", { class: "card-channel" },
          el("span", { text: video.channelName }),
          video.verified ? el("span", { html: ICON.check }) : null
        ),
        el("div", { class: "card-category", text: timeAgo(video.publishedAt) })
      )
    )
  );
}

async function viewVods() {
  const page = el("div", { class: "page" },
    el("div", { class: "page-head" },
      el("h1", { class: "page-title", text: "Directos pasados" }),
      el("span", { class: "page-sub", text: "Lost Ark en CHZZK · los más recientes primero" })
    )
  );
  const grid = el("div", { class: "grid" });
  const loading = skeletonGrid(8);
  page.append(grid, loading);
  render(page);

  const first = await getCategoryVideos(HOME.type, HOME.id, { size: 24 });
  loading.remove();
  if (!first.items.length) {
    page.append(emptyState("No hay directos pasados"));
    return;
  }
  first.items.forEach((v) => grid.append(vodCard(v)));

  let cursor = first.cursor;
  attachPager(page, async () => {
    if (!cursor) return false;
    const next = await getCategoryVideos(HOME.type, HOME.id, { size: 24, cursor });
    next.items.forEach((v) => grid.append(vodCard(v)));
    cursor = next.cursor;
    return !!cursor && next.items.length > 0;
  });
}

// Rejilla con los directos pasados de un canal, debajo del reproductor.
async function appendChannelVideos(container, channelId, title = "Directos pasados", skipVideoNo = null) {
  let result;
  try {
    result = await getChannelVideos(channelId, { size: 12 });
  } catch {
    return;   // es un extra: si falla, la vista principal sigue igual
  }
  if (!document.body.contains(container)) return;

  const items = result.items.filter((v) => v.videoNo !== skipVideoNo);
  if (!items.length) return;

  const grid = el("div", { class: "grid" });
  items.forEach((v) => grid.append(vodCard(v)));
  const section = el("section", { class: "page channel-vods" },
    el("div", { class: "page-head" },
      el("h2", { class: "page-title", text: title }),
      el("span", { class: "page-sub", text: `${result.total} vídeos` })
    ),
    grid
  );
  container.append(section);

  let nextPage = 1;
  if (result.totalPages > 1) {
    attachPager(section, async () => {
      if (nextPage >= result.totalPages) return false;
      const more = await getChannelVideos(channelId, { page: nextPage, size: 12 });
      nextPage++;
      more.items.filter((v) => v.videoNo !== skipVideoNo).forEach((v) => grid.append(vodCard(v)));
      return nextPage < result.totalPages && more.items.length > 0;
    });
  }
}

function buildVodInfo(info, video) {
  clear(info);
  const tags = el("div", { class: "watch-tags" });
  if (video.categoryLabel) tags.append(el("span", { class: "tag category", text: video.categoryLabel }));
  if (video.publishedAt) tags.append(el("span", { class: "tag", text: "Emitido " + timeAgo(video.publishedAt) }));
  if (video.duration) tags.append(el("span", { class: "tag", text: formatDuration(video.duration) }));
  if (video.views) tags.append(el("span", { class: "tag", text: formatViewers(video.views) + " visualizaciones" }));

  info.append(
    el("img", {
      class: "watch-avatar",
      attrs: { src: video.channelImage || "icons/icon48.png", alt: "" }
    }),
    el("div", { class: "watch-text" },
      el("div", {
        class: "watch-channel link",
        attrs: { title: "Ir al canal" },
        on: { click: () => video.channelId && navigate(`#/watch/${video.channelId}`) }
      },
        el("span", { text: video.channelName }),
        video.verified ? el("span", { html: ICON.check }) : null
      ),
      el("h1", { class: "watch-title", text: video.title }),
      tags
    )
  );
}

async function viewVod(videoNo) {
  const stage = el("div", { class: "stage" });
  const video = el("video", { class: "vod", attrs: { playsinline: true, autoplay: true } });
  const overlay = el("div", { class: "stage-overlay" }, el("div", { class: "spinner" }));
  stage.append(video, overlay);

  const controls = el("div", { class: "controls vod-bar" });
  const info = el("div", { class: "watch-info" });
  const wrap = el("div", { class: "watch" }, stage, controls, info);
  render(wrap);

  video.volume = state.volume;
  video.muted = state.muted;

  let meta;
  try {
    meta = await getVideo(videoNo);
  } catch (err) {
    return showStageMessage(overlay, "No se pudo abrir el vídeo", String(err.message || err));
  }
  if (!document.body.contains(video)) return;   // se cambió de vista mientras tanto

  document.title = `${meta.title || "Directo pasado"} · CHZZK Player`;
  buildVodInfo(info, meta);
  if (meta.channelId) {
    void appendChannelVideos(wrap, meta.channelId, "Más directos de " + meta.channelName, meta.videoNo);
  }

  if (meta.geoBlocked) {
    return showStageMessage(overlay, "Solo disponible en Corea",
      "El canal no permite ver esta grabación desde fuera de Corea.");
  }
  if (meta.adultBlocked) {
    return showStageMessage(overlay, "Contenido +19",
      "Este vídeo exige verificación de edad en tu cuenta de Naver.");
  }
  if (meta.unsupported) {
    return showStageMessage(overlay, "Vídeo no compatible",
      "No tiene repetición HLS (pasa con vídeos subidos a mano o muy antiguos). Puedes verlo en chzzk.naver.com.");
  }
  startVodPlayback(video, meta, overlay, controls);
}

function vodLinkButton(meta) {
  return el("button", {
    class: "btn", html: ICON.external, attrs: { title: "Abrir en chzzk.naver.com" },
    on: { click: () => PLATFORM.openExternal(`https://chzzk.naver.com/video/${meta.videoNo}`) }
  });
}

function startVodPlayback(video, meta, overlay, bar) {
  destroyPlayer();
  const duration = meta.duration || 0;
  const resumeAt = loadResume(meta.videoNo, duration);

  // Sin ffmpeg (la extensión de navegador): hls.js con los controles nativos,
  // que en un VOD sí saben saltar por su cuenta.
  if (!(state.useFfmpeg && PLATFORM.vodOpen)) {
    video.controls = true;
    startHlsPlayback(video, meta.url, overlay);
    video.addEventListener("loadedmetadata", () => { if (resumeAt) video.currentTime = resumeAt; }, { once: true });
    let lastSave = 0;
    video.addEventListener("timeupdate", () => {
      if (Date.now() - lastSave < 5000) return;
      lastSave = Date.now();
      saveResume(meta.videoNo, video.currentTime);
    });
    clear(bar);
    bar.append(el("div", { class: "ctrl-spacer" }), vodLinkButton(meta));
    return;
  }

  // El <video> recibe un flujo que empieza en el punto del salto, así que su
  // reloj cuenta desde 0: la posición real es desfase + currentTime.
  const s = {
    variants: [], level: 0, offset: 0, token: 0, lastPos: resumeAt,
    dragging: false, recovering: false, retries: 0, lastProgress: Date.now(), lastSave: 0
  };
  const position = () => s.offset + (video.currentTime || 0);

  // --- barra de controles propia ---------------------------------------
  // Los controles nativos no sirven aquí: sin duración conocida y empezando en
  // el punto del salto, su barra de progreso mentiría.
  const playBtn = el("button", {
    class: "ctrl", html: VOD_ICON.pause, attrs: { title: "Reproducir / pausa (espacio)" },
    on: { click: () => (video.paused ? video.play().catch(() => {}) : video.pause()) }
  });
  const backBtn = el("button", {
    class: "ctrl", html: VOD_ICON.back, attrs: { title: "Atrás 10 s (←)" },
    on: { click: () => seekBy(-10) }
  });
  const fwdBtn = el("button", {
    class: "ctrl", html: VOD_ICON.forward, attrs: { title: "Adelante 10 s (→)" },
    on: { click: () => seekBy(10) }
  });
  const cur = el("span", { class: "vod-time", text: formatDuration(resumeAt) });
  const total = el("span", { class: "vod-time", text: formatDuration(duration) });
  const seek = el("input", {
    class: "seek",
    attrs: {
      type: "range", min: "0", step: "1", "aria-label": "Posición",
      max: String(Math.max(1, Math.floor(duration))), value: String(Math.floor(resumeAt))
    }
  });
  const volume = el("input", {
    class: "volume",
    attrs: { type: "range", min: "0", max: "1", step: "0.05", "aria-label": "Volumen",
             value: String(video.muted ? 0 : video.volume) }
  });
  const quality = el("select", { class: "select", attrs: { title: "Calidad" } });
  const toggleFullscreen = () =>
    (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen()).catch(() => {});

  clear(bar);
  bar.append(
    playBtn, backBtn, fwdBtn, cur, seek, total, volume, quality,
    el("button", {
      class: "btn", html: ICON.theater, attrs: { title: "Modo teatro (t)" },
      on: { click: () => document.body.classList.toggle("theater") }
    }),
    el("button", {
      class: "btn", html: VOD_ICON.fullscreen, attrs: { title: "Pantalla completa (f)" },
      on: { click: toggleFullscreen }
    }),
    vodLinkButton(meta)
  );

  seek.addEventListener("input", () => {
    s.dragging = true;
    cur.textContent = formatDuration(Number(seek.value));
  });
  seek.addEventListener("change", () => {
    s.dragging = false;
    seekTo(Number(seek.value));
  });
  volume.addEventListener("input", () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
  });
  quality.addEventListener("change", () => {
    s.level = Number(quality.value);
    void open(s.lastPos);
  });

  video.addEventListener("click", () => playBtn.click());
  video.addEventListener("dblclick", toggleFullscreen);
  video.addEventListener("play", () => { playBtn.innerHTML = VOD_ICON.pause; });
  video.addEventListener("pause", () => { playBtn.innerHTML = VOD_ICON.play; });
  video.addEventListener("playing", () => { overlay.hidden = true; s.retries = 0; });
  video.addEventListener("volumechange", () => {
    state.volume = video.volume;
    state.muted = video.muted;
  });
  video.addEventListener("timeupdate", () => {
    s.lastProgress = Date.now();
    const pos = position();
    s.lastPos = pos;
    if (!s.dragging) {
      seek.value = String(Math.floor(pos));
      cur.textContent = formatDuration(pos);
    }
    if (Date.now() - s.lastSave > 5000) {
      s.lastSave = Date.now();
      saveResume(meta.videoNo, pos);
    }
  });
  video.addEventListener("ended", () => {
    if (s.lastPos >= duration - 8) {
      clearResume(meta.videoNo);
      showStageMessage(overlay, "Fin del vídeo", "Has llegado al final de este directo.");
    } else {
      void recover("el vídeo se cortó");
    }
  });
  video.addEventListener("error", () => {
    if (video.getAttribute("src")) void recover("error de reproducción");
  });

  function seekTo(target) {
    const t = Math.max(0, Math.min(target, duration - 2));
    const local = t - s.offset;
    const buffered = video.buffered;
    // Si ese tramo ya está descargado basta con mover el cursor: instantáneo.
    for (let i = 0; i < buffered.length; i++) {
      if (local >= buffered.start(i) && local <= buffered.end(i) - 0.5) {
        video.currentTime = local;
        saveResume(meta.videoNo, t);
        return;
      }
    }
    void open(t);
  }

  function seekBy(delta) {
    seekTo(s.lastPos + delta);
  }

  async function open(t) {
    const variant = s.variants[s.level];
    if (!variant) return;
    const token = ++s.token;

    clear(overlay);
    overlay.append(el("div", { class: "spinner" }));
    overlay.hidden = false;
    s.lastPos = t;
    seek.value = String(Math.floor(t));
    cur.textContent = formatDuration(t);

    let opened;
    try {
      opened = await PLATFORM.vodOpen(variant.url, t);
    } catch (err) {
      if (token === s.token) showStageMessage(overlay, "No se pudo abrir el vídeo", ipcMessage(err));
      return;
    }
    // Si mientras tanto se pidió otro salto (arrastrando la barra), éste sobra.
    if (token !== s.token || !document.body.contains(video)) return;

    s.offset = opened.start;
    s.lastProgress = Date.now();
    // El parámetro extra fuerza una conexión nueva, y con ella un ffmpeg nuevo.
    video.src = opened.url + "&_r=" + Date.now();
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
  }

  // Si el flujo muere a medias, se retoma en el mismo segundo.
  async function recover(reason) {
    if (s.recovering || !document.body.contains(video)) return;
    s.recovering = true;
    s.retries++;
    const at = s.lastPos;
    showStageMessage(overlay, "Reconectando…",
      "Se ha cortado el vídeo (" + reason + "). Retomando en " + formatDuration(at) + ".");
    await new Promise((r) => setTimeout(r, Math.min(1000 * s.retries, 5000)));
    s.recovering = false;
    if (!document.body.contains(video)) return;
    if (s.retries > 6) {
      showStageMessage(overlay, "No se pudo retomar el vídeo",
        "Demasiados cortes seguidos. Prueba otra calidad o vuelve a abrirlo.");
      return;
    }
    void open(at);
  }

  // Vigilante: 15 s sin avanzar y sin estar en pausa = flujo muerto.
  state.watchdog = setInterval(() => {
    if (!document.body.contains(video)) return;
    if (video.paused || s.recovering) { s.lastProgress = Date.now(); return; }
    if (Date.now() - s.lastProgress > 15000) void recover("se quedó congelado");
  }, 4000);

  state.vod = { seekBy };

  PLATFORM.streamVariants([meta.url]).then((variants) => {
    if (!variants || !variants.length) throw new Error("sin calidades");
    s.variants = variants;
    clear(quality);
    variants.forEach((v, i) => {
      const label = v.height ? `${v.height}p${v.fps > 30 ? v.fps : ""}` : `Nivel ${i}`;
      quality.append(el("option", { text: label, attrs: { value: String(i) } }));
    });
    quality.hidden = variants.length <= 1;
    // En VOD ffmpeg descarga a ~50x, así que la mejor calidad va sobrada.
    quality.value = "0";
    if (resumeAt) toast("Continuando donde lo dejaste · " + formatDuration(resumeAt));
    return open(resumeAt);
  }).catch((err) => {
    showStageMessage(overlay, "No se pudo abrir el vídeo", ipcMessage(err));
  });
}

async function viewSearch(rawQuery) {
  const query = decodeURIComponent(rawQuery);
  $("#searchInput").value = query;
  $("#searchClear").hidden = !query;

  const page = el("div", { class: "page" },
    el("div", { class: "page-head" },
      el("h1", { class: "page-title", text: "Resultados" }),
      el("span", { class: "page-sub", text: `“${query}”` })
    )
  );
  render(page);

  const [channels, lives] = await Promise.all([
    searchChannels(query, { size: 12 }).catch(() => []),
    searchLives(query, { size: 24 }).catch(() => ({ items: [], nextOffset: null }))
  ]);

  if (!channels.length && !lives.items.length) {
    page.append(emptyState("Sin resultados", "Prueba con otro nombre de canal o palabra clave."));
    return;
  }

  if (channels.length) {
    page.append(el("h2", { class: "page-title", text: "Canales", attrs: { style: "font-size:16px;margin:8px 0 12px" } }));
    const list = el("ul", { class: "chan-list", attrs: { style: "margin-bottom:28px" } });
    for (const ch of channels) {
      list.append(channelRow({ ...ch, categoryLabel: ch.live ? "En directo" : "Desconectado" }));
    }
    page.append(list);
  }

  if (lives.items.length) {
    page.append(el("h2", { class: "page-title", text: "Directos", attrs: { style: "font-size:16px;margin:8px 0 12px" } }));
    const grid = el("div", { class: "grid" });
    lives.items.forEach((l) => grid.append(liveCard(l)));
    page.append(grid);

    let offset = lives.nextOffset;
    attachPager(page, async () => {
      if (offset == null) return false;
      const next = await searchLives(query, { size: 24, offset });
      next.items.forEach((l) => grid.append(liveCard(l)));
      offset = next.nextOffset;
      return offset != null && next.items.length > 0;
    });
  }
}

// Streams .m3u8 vistos pasar en cualquier pestaña abierta.
async function viewDetected() {
  const page = el("div", { class: "page" },
    el("div", { class: "page-head" },
      el("h1", { class: "page-title", text: "Streams detectados" }),
      el("span", { class: "page-sub", text: "URLs .m3u8 capturadas en tus otras pestañas" })
    )
  );
  render(page);

  const items = (await PLATFORM.detectedStreams()) || [];

  if (!items.length) {
    page.append(emptyState(
      "No se ha detectado ningún stream",
      "Abre cualquier web con vídeo HLS en otra pestaña y vuelve aquí."
    ));
    return;
  }

  for (const item of items) {
    page.append(el("div", { class: "det-item" },
      el("div", { class: "det-url", text: item.url, attrs: { title: item.url } }),
      el("button", {
        class: "btn", html: ICON.copy,
        on: { click: () => { navigator.clipboard.writeText(item.url); toast("URL copiada"); } }
      }),
      el("button", {
        class: "btn", text: "ffplay",
        on: { click: (e) => launchFfplay(item.url, e.currentTarget) }
      }),
      el("button", {
        class: "btn primary", text: "Reproducir",
        on: { click: () => navigate(`#/url/${encodeURIComponent(item.url)}`) }
      })
    ));
  }
}

// ------------------------------------------------------- vista de canal

async function viewWatch(channelId) {
  const stage = el("div", { class: "stage" });
  const video = el("video", { attrs: { id: "video", playsinline: true, autoplay: true } });
  const overlay = el("div", { class: "stage-overlay" }, el("div", { class: "spinner" }));
  stage.append(video, overlay);

  const controls = el("div", { class: "controls" });
  const info = el("div", { class: "watch-info" });
  const wrap = el("div", { class: "watch" }, stage, controls, info);
  render(wrap);
  // Sus directos pasados, debajo: útil sobre todo si ahora no está emitiendo.
  void appendChannelVideos(wrap, channelId);

  video.volume = state.volume;
  video.muted = state.muted;
  video.controls = true;

  let detail;
  try {
    detail = await getLiveDetail(channelId);
  } catch (err) {
    // Puede ser un canal que no está emitiendo: mostramos su ficha igualmente.
    const channel = await getChannel(channelId).catch(() => null);
    return showStageMessage(overlay, "Este canal no está en directo",
      channel ? `${channel.channelName} no está emitiendo ahora mismo.` : String(err));
  }

  state.detail = detail;
  markActiveChannel();
  document.title = `${detail.channelName} · CHZZK Player`;

  buildWatchInfo(info, detail);

  if (!detail.open) {
    buildControls(controls, detail, video, null);
    return showStageMessage(overlay, "Emisión terminada",
      `${detail.channelName} ya no está en directo. Debajo tienes sus directos pasados.`);
  }
  if (detail.adultBlocked) {
    buildControls(controls, detail, video, null);
    return showStageMessage(overlay, "Contenido +19",
      "Este directo exige verificación de edad en tu cuenta de Naver.");
  }
  if (!detail.url) {
    buildControls(controls, detail, video, null);
    return showStageMessage(overlay, "Sin stream disponible",
      "La API no ha devuelto ninguna pista HLS para este directo.");
  }

  const player = startPlayback(video, streamCandidates(detail), overlay);
  buildControls(controls, detail, video, player);
  startPolling(channelId, controls);
}

// Todos los enlaces equivalentes del mismo directo, en orden de preferencia.
// El proceso principal los prueba hasta dar con uno que responda.
function streamCandidates(detail) {
  const urls = (detail.sources || []).map((s) => s.url).filter(Boolean);
  if (detail.url && !urls.includes(detail.url)) urls.unshift(detail.url);
  return urls.length ? urls : [detail.url];
}

function showStageMessage(overlay, title, body) {
  clear(overlay);
  overlay.hidden = false;
  overlay.append(el("div", { class: "stage-msg" },
    el("strong", { text: title }),
    el("span", { text: body || "" })
  ));
}

function buildWatchInfo(info, detail) {
  clear(info);
  const tags = el("div", { class: "watch-tags" });
  if (detail.categoryLabel) {
    tags.append(el("span", {
      class: "tag category", text: detail.categoryLabel,
      on: {
        click: () => detail.categoryType && detail.categoryId &&
          navigate(`#/category/${detail.categoryType}/${encodeURIComponent(detail.categoryId)}`)
      }
    }));
  }
  for (const tag of detail.tags.slice(0, 6)) tags.append(el("span", { class: "tag", text: tag }));
  if (detail.openDate) {
    tags.append(el("span", { class: "tag", text: "En directo desde hace " + elapsedSince(detail.openDate) }));
  }

  info.append(
    el("img", {
      class: "watch-avatar",
      attrs: { src: detail.channelImage || "icons/icon48.png", alt: "" }
    }),
    el("div", { class: "watch-text" },
      el("div", { class: "watch-channel" },
        el("span", { text: detail.channelName }),
        detail.verified ? el("span", { html: ICON.check }) : null
      ),
      el("h1", { class: "watch-title", text: detail.title }),
      tags
    )
  );
}

function buildControls(bar, detail, video, player) {
  clear(bar);

  const pill = el("span", {
    class: "live-pill" + (detail.open ? "" : " off"),
    text: detail.open ? "EN DIRECTO" : "OFFLINE"
  });
  const viewers = el("span", { class: "ctrl-viewers", html: ICON.eye },
    el("span", { text: formatViewers(detail.viewers) })
  );
  bar.append(pill, viewers);

  // Volver al borde del directo tras una pausa.
  if (player) {
    bar.append(el("button", {
      class: "btn ghost", text: "Ir al directo",
      on: {
        click: () => {
          player.seekToLive();
          video.play().catch(() => {});
          toast("Sincronizado con el directo");
        }
      }
    }));
  }

  bar.append(el("div", { class: "ctrl-spacer" }));

  if (player) {
    // Con el motor de ffmpeg no hay ABR, así que tampoco tiene sentido "Auto".
    const hasAuto = !player.variants;
    const quality = el("select", { class: "select", attrs: { title: "Calidad" } });
    quality.addEventListener("change", () => player.setLevel(parseInt(quality.value, 10)));

    player.onLevels = (levels) => {
      clear(quality);
      // Bilibili solo ofrece una pista (la calidad se pide a su API), así que
      // un selector con una única opción sobra.
      const single = levels.length <= 1 && !hasAuto;
      quality.hidden = single;
      if (single) return;
      if (hasAuto) quality.append(el("option", { text: "Auto", attrs: { value: "-1" } }));
      levels.forEach((lv, i) => {
        const height = lv.height ? `${lv.height}p` : `Nivel ${i}`;
        const rate = lv.fps
          || (lv.attrs && lv.attrs["FRAME-RATE"] ? Math.round(parseFloat(lv.attrs["FRAME-RATE"])) : 0);
        quality.append(el("option", {
          text: rate > 30 ? `${height}${rate}` : height,
          attrs: { value: String(i) }
        }));
      });
      // Reflejamos la calidad realmente fijada, no "Auto".
      const shown = player.defaultLevel != null ? player.defaultLevel : player.currentLevel();
      quality.value = String(shown);
    };
    // Si el manifiesto ya se parseó antes de llegar aquí, rellenamos ya mismo.
    if (player.levels && player.levels.length) player.onLevels(player.levels);
    bar.append(quality);
  }

  // En la reproducción de una URL suelta no hay canal al que dar favorito.
  if (detail.channelId) {
    bar.append(el("button", {
      class: "btn fav" + (isFavorite(detail.channelId) ? " on" : ""),
      html: ICON.heart,
      attrs: { title: "Favorito" },
      on: {
        click: async (e) => {
          const added = await toggleFavorite(detail);
          e.currentTarget.classList.toggle("on", added);
          toast(added ? "Añadido a favoritos" : "Quitado de favoritos");
        }
      }
    }));
  }

  bar.append(
    el("button", {
      class: "btn", html: ICON.theater, attrs: { title: "Modo teatro" },
      on: {
        click: (e) => {
          document.body.classList.toggle("theater");
          e.currentTarget.classList.toggle("on", document.body.classList.contains("theater"));
        }
      }
    }),
    el("button", {
      class: "btn", text: "ffplay",
      attrs: { title: "Abrir en ffplay (ventana nativa)" },
      on: { click: (e) => launchFfplay(player ? player.activeUrl() : detail.url, e.currentTarget) }
    }),
    detail.channelId ? el("button", {
      class: "btn",
      html: ICON.external,
      attrs: { title: detail.source === "bilibili" ? "Abrir en live.bilibili.com" : "Abrir en chzzk.naver.com" },
      on: {
        click: () => PLATFORM.openExternal(detail.source === "bilibili"
          ? `https://live.bilibili.com/${detail.channelId}`
          : `https://chzzk.naver.com/live/${detail.channelId}`)
      }
    }) : el("button", {
      class: "btn", html: ICON.copy, attrs: { title: "Copiar la URL del stream" },
      on: {
        click: () => {
          navigator.clipboard.writeText(player ? player.activeUrl() : detail.url);
          toast("URL copiada");
        }
      }
    })
  );
}

// Refresca espectadores y detecta el fin de la emisión.
function startPolling(channelId, bar) {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.route.startsWith(`#/watch/${channelId}`)) return stopPolling();
    try {
      const fresh = await getLiveDetail(channelId);
      const viewers = bar.querySelector(".ctrl-viewers span");
      if (viewers) viewers.textContent = formatViewers(fresh.viewers);
      if (!fresh.open) {
        const pill = bar.querySelector(".live-pill");
        if (pill) { pill.textContent = "OFFLINE"; pill.classList.add("off"); }
        stopPolling();
      }
    } catch { /* un fallo puntual de red no debe romper la vista */ }
  }, 45000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

// Reproducción de una URL suelta (streams detectados o pegados a mano).
function viewUrl(encoded) {
  const url = decodeURIComponent(encoded);
  const stage = el("div", { class: "stage" });
  const video = el("video", { attrs: { playsinline: true, autoplay: true } });
  const overlay = el("div", { class: "stage-overlay" }, el("div", { class: "spinner" }));
  stage.append(video, overlay);

  const controls = el("div", { class: "controls" });
  render(el("div", { class: "watch" }, stage, controls,
    el("div", { class: "watch-info" },
      el("div", { class: "watch-text" },
        el("h1", { class: "watch-title", text: "Reproducción directa" }),
        el("div", { class: "det-url", text: url })
      )
    )
  ));

  video.controls = true;
  video.volume = state.volume;
  const player = startPlayback(video, url, overlay);

  buildControls(controls, {
    channelId: "", channelName: "", open: true, viewers: 0, url
  }, video, player);
}

// ------------------------------------------------------------ reproductor

function destroyPlayer() {
  // El vigilante de reconexión pertenece al reproductor anterior: si no se
  // para, sigue latiendo de fondo al cambiar de directo.
  if (state.watchdog) { clearInterval(state.watchdog); state.watchdog = null; }
  state.vod = null;
  if (state.hls) {
    try { state.hls.destroy(); } catch { /* ya destruido */ }
    state.hls = null;
  }
  // Soltar el <video> cierra la conexión al servidor local y con ella el
  // ffmpeg que la alimentaba; si no, quedaría descargando de fondo.
  const video = main.querySelector("video");
  if (video && video.src) {
    video.removeAttribute("src");
    try { video.load(); } catch { /* la ventana puede estar cerrándose */ }
  }
  stopPolling();
  document.body.classList.remove("theater");
}

// Acepta una URL suelta o una lista de nodos equivalentes (Bilibili sirve el
// mismo directo desde varios CDN y no todos responden desde fuera de China).
function startPlayback(video, source, overlay) {
  const sources = (Array.isArray(source) ? source : [source]).filter(Boolean);
  if (state.useFfmpeg && PLATFORM.streamUrl) return startFfmpegPlayback(video, sources, overlay);
  return startHlsPlayback(video, sources[0], overlay);
}

// Motor por ffmpeg: el proceso principal remuxa el HLS y lo sirve en local, así
// que aquí basta un <video> apuntando a 127.0.0.1. Sin hls.js de por medio no
// hay ABR que se desmadre ni una petición nueva por cada segmento.
function startFfmpegPlayback(video, sources, overlay) {
  const primary = sources[0];
  destroyPlayer();

  const api = {
    levels: [],
    variants: [],
    defaultLevel: null,
    lastUrl: "",
    onLevels: null,
    setLevel: () => {},
    currentLevel: () => (api.defaultLevel == null ? -1 : api.defaultLevel),
    seekToLive: () => {
      // En un flujo progresivo, "el directo" es el final de lo ya recibido.
      if (video.buffered.length) video.currentTime = video.buffered.end(video.buffered.length - 1);
    },
    activeUrl: () => {
      const v = api.variants[api.defaultLevel];
      return (v && v.url) || primary;
    }
  };

  const play = async (index) => {
    const variant = api.variants[index];
    if (!variant) return;
    api.defaultLevel = index;
    overlay.hidden = false;
    api.lastUrl = await PLATFORM.streamUrl(variant.url);
    arrancar(api.lastUrl);
  };

  function arrancar(localUrl) {
    // El parámetro extra obliga a abrir una conexión nueva (y con ella un
    // ffmpeg nuevo) en vez de reutilizar la respuesta anterior.
    video.src = localUrl + "&_r=" + Date.now();
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
  }

  // --- reenganche automático ------------------------------------------
  //
  // Un directo puede morirse por su cuenta: el CDN cierra la conexión, ffmpeg
  // pierde demasiados segmentos y termina, o la red parpadea. Antes eso dejaba
  // la ventana congelada para siempre; ahora el stream se reabre solo.
  let reintentos = 0;
  let ultimoAvance = Date.now();
  let reconectando = false;

  async function reconectar(motivo) {
    if (reconectando || !api.lastUrl) return;
    if (!document.body.contains(video)) return;   // ya no estamos en esta vista
    reconectando = true;
    reintentos++;

    showStageMessage(overlay, "Reconectando…",
      "Se ha cortado la emisión (" + motivo + "). Volviendo a abrir el directo.");

    // Espera creciente, con tope, para no machacar el CDN si está caído.
    await new Promise((r) => setTimeout(r, Math.min(1000 * reintentos, 5000)));

    try {
      if (!document.body.contains(video)) return;
      arrancar(api.lastUrl);
      ultimoAvance = Date.now();
    } finally {
      // Pase lo que pase hay que soltar el cerrojo, o no habría más intentos.
      reconectando = false;
    }
  }

  video.addEventListener("ended", () => void reconectar("el stream terminó"));
  video.addEventListener("timeupdate", () => {
    ultimoAvance = Date.now();
    // Tras un buen rato reproduciendo bien, olvidamos los fallos anteriores.
    if (reintentos && video.currentTime > 30) reintentos = 0;
  });

  // Vigilante: si el reloj no avanza durante 12 s sin estar en pausa, damos la
  // reproducción por muerta aunque no haya saltado ningún evento.
  state.watchdog = setInterval(() => {
    if (!document.body.contains(video)) return;
    if (video.paused || reconectando) { ultimoAvance = Date.now(); return; }
    if (Date.now() - ultimoAvance > 12000) void reconectar("se quedó congelado");
  }, 4000);

  // Aquí no hay "Auto": sin ABR, -1 se interpreta como la mejor calidad.
  api.setLevel = (index) => { void play(index < 0 ? 0 : index); };

  video.addEventListener("playing", () => { overlay.hidden = true; });
  video.addEventListener("volumechange", () => {
    state.volume = video.volume;
    state.muted = video.muted;
  });
  video.addEventListener("error", () => {
    if (api.lastUrl) return void reconectar("error de reproducción");
    showStageMessage(overlay, "No se pudo reproducir",
      "ffmpeg no consiguió abrir el stream. Pulsa actualizar para pedir un enlace nuevo.");
  });

  PLATFORM.streamVariants(sources).then((variants) => {
    if (!variants || !variants.length) throw new Error("sin variantes");
    api.variants = variants;
    // Se exponen con la misma forma que los niveles de hls.js, para que la
    // barra de controles no tenga que saber qué motor hay debajo.
    api.levels = variants.map((v) => ({ height: v.height, bitrate: v.bitrate, fps: v.fps }));
    // Antes de avisar a la barra: si no, el selector no encuentra qué marcar y
    // se queda sin ninguna opción seleccionada.
    api.defaultLevel = 0; // vienen ordenadas de mayor a menor: la 0 es la mejor
    if (api.onLevels) api.onLevels(api.levels);
    return play(0);
  }).catch((err) => {
    // El proceso principal explica si el problema es que el CDN no responde;
    // merece la pena decirlo tal cual en vez de un mensaje genérico.
    const detalle = String((err && err.message) || "")
      .replace(/^Error invoking remote method '[^']+': Error: /, "");
    showStageMessage(overlay, "No se pudo abrir el directo",
      detalle || "No se han podido obtener las calidades de este directo.");
  });

  return api;
}

function startHlsPlayback(video, url, overlay) {
  destroyPlayer();

  // levels se guarda aquí porque el manifiesto puede llegar antes de que la
  // barra de controles se haya construido y asigne onLevels.
  const api = {
    levels: [],
    defaultLevel: null,
    onLevels: null,
    setLevel: () => {},
    currentLevel: () => -1,
    seekToLive: () => { if (video.duration) video.currentTime = video.duration; },
    activeUrl: () => url
  };

  video.addEventListener("volumechange", () => {
    state.volume = video.volume;
    state.muted = video.muted;
  });

  if (window.Hls && Hls.isSupported()) {
    // Margen amplio respecto al borde del directo: CHZZK corta mucho si se
    // intenta ir pegado al último segmento.
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      // En segundos, no en "cuentas de segmento": CHZZK declara
      // TARGETDURATION:10 aunque sus segmentos duran 2 s, así que
      // liveSyncDurationCount daba 4x10 = 40 s de retardo objetivo, más que la
      // ventana de directo entera (30 s).
      //
      // Nos colocamos por detrás del borde del directo, que es justo lo que
      // hace ffmpeg (empieza al principio de la ventana) y por lo que aguanta
      // 1080p sin cortarse.
      //
      // El tope de latencia va holgado a propósito: cuando se rebasa, hls.js
      // salta al borde del directo y tira el buffer entero, que era justo lo
      // que provocaba los cortes en bucle. Con maxLiveSyncPlaybackRate recupera
      // acelerando un pelín la reproducción, sin saltos ni vaciar el buffer.
      liveSyncDuration: 12,
      liveMaxLatencyDuration: 30,
      maxLiveSyncPlaybackRate: 1.5,
      nudgeMaxRetry: 10,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 6,
      fragLoadingMaxRetry: 6,
      // La primera medición del ABR sale falseada (la petición al borde del
      // directo espera a que exista el segmento), así que arrancaría en 144p.
      // Sembramos una estimación razonable y elegimos el nivel inicial a mano;
      // a partir de ahí el ABR manda, que es lo correcto: este CDN entrega los
      // segmentos casi al ritmo del propio bitrate, así que hay que dejarle
      // bajar de calidad cuando la red no da para más.
      abrEwmaDefaultEstimate: 3000000,
      autoStartLoad: false
    });
    state.hls = hls;

    hls.loadSource(url);
    hls.attachMedia(video);

    api.setLevel = (level) => { hls.currentLevel = level; };
    api.currentLevel = () => hls.currentLevel;
    api.seekToLive = () => {
      const target = hls.liveSyncPosition;
      if (target != null) video.currentTime = target;
      else if (video.duration) video.currentTime = video.duration;
    };
    api.activeUrl = () => {
      const level = hls.levels && hls.levels[hls.currentLevel];
      if (level && level.url && level.url[0]) return level.url[0];
      return url;
    };

    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      overlay.hidden = true;
      api.levels = data.levels || [];

      // Calidad fija por defecto: la mejor hasta 720p.
      //
      // No dejamos el ABR al mando porque su estimación aquí no vale (mide la
      // descarga de segmentos que ya existen en la ventana y oscila). Midiendo
      // la deriva de latencia, 1080p se queda atrás de forma sostenida contra
      // este CDN mientras 720p se mantiene o recupera. Quien quiera 1080p lo
      // tiene en el selector, o el botón de ffplay, que sí lo aguanta porque
      // reutiliza una única conexión persistente.
      if (api.levels.length) {
        let pick = 0;
        api.levels.forEach((lv, i) => {
          const h = lv.height || 0;
          if (h <= 720 && h > (api.levels[pick].height || 0)) pick = i;
        });
        api.defaultLevel = pick;
        hls.startLevel = pick;
      }
      hls.startLoad();
      if (api.defaultLevel != null) hls.currentLevel = api.defaultLevel;

      if (api.onLevels) api.onLevels(api.levels);
      video.play().catch(() => {
        // El autoplay con sonido puede estar bloqueado: reintentamos en mudo.
        video.muted = true;
        video.play().catch(() => {});
      });
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
      if (api.onLevels && hls.levels) { /* el <select> ya refleja la selección manual */ }
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        showStageMessage(overlay, "Problema de red", "Reintentando conectar con el CDN…");
        setTimeout(() => { overlay.hidden = true; hls.startLoad(); }, 800);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        showStageMessage(overlay, "No se pudo reproducir",
          "El enlace del directo puede haber caducado. Pulsa actualizar para pedir uno nuevo.");
        hls.destroy();
        state.hls = null;
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.addEventListener("loadedmetadata", () => {
      overlay.hidden = true;
      video.play().catch(() => {});
    });
  } else {
    showStageMessage(overlay, "HLS no soportado", "Este navegador no puede reproducir streams HLS.");
  }

  return api;
}

async function launchFfplay(url, btn) {
  if (!url) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Lanzando…";
  try {
    await PLATFORM.launchFfplay(url);
    toast("Abriendo en ffplay…");
  } catch {
    toast("No se pudo lanzar ffplay (¿está ffmpeg.exe junto a la app?)");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------------------------------------------------------------- router

function render(node) {
  clear(main);
  main.append(node);
  main.scrollTop = 0;
}

function navigate(hash) {
  if (location.hash === hash) handleRoute();
  else location.hash = hash;
}

function markActiveChannel() {
  const match = state.route.match(/^#\/b?watch\/(.+)$/);
  const current = match ? match[1] : "";
  document.querySelectorAll(".chan-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.channelId === current);
  });
}

function markActiveNav() {
  document.querySelectorAll(".side-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === state.route);
  });
}

async function handleRoute() {
  const hash = location.hash || HOME_ROUTE;
  state.route = hash;
  destroyPlayer();
  markActiveNav();
  markActiveChannel();
  document.title = "CHZZK Player";
  closeNav();

  const parts = hash.replace(/^#\//, "").split("/");

  try {
    switch (parts[0]) {
      case "category": return await viewCategory(parts[1], parts.slice(2).join("/"));
      case "bilibili": return await viewBilibili();
      case "bwatch":   return await viewBiliWatch(parts[1]);
      case "vods":     return await viewVods();
      case "vod":      return await viewVod(parts[1]);
      case "search":   return await viewSearch(parts.slice(1).join("/"));
      case "watch":    return await viewWatch(parts[1]);
      case "url":      return viewUrl(parts.slice(1).join("/"));
      case "detected": return await viewDetected();
      default:         return await viewCategory(HOME.type, HOME.id);
    }
  } catch (err) {
    render(el("div", { class: "page" },
      emptyState("Algo ha fallado", String(err && err.message ? err.message : err))
    ));
  }
}

// ------------------------------------------------------------- interfaz

function closeNav() {
  document.body.classList.remove("nav-open");
  $("#scrim").hidden = true;
}

$("#navToggle").addEventListener("click", () => {
  if (window.matchMedia("(max-width: 900px)").matches) {
    const open = document.body.classList.toggle("nav-open");
    $("#scrim").hidden = !open;
  } else {
    document.body.classList.toggle("nav-collapsed");
  }
});
$("#scrim").addEventListener("click", closeNav);

$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("#searchInput").value.trim();
  if (value) navigate(`#/search/${encodeURIComponent(value)}`);
});

$("#searchInput").addEventListener("input", (e) => {
  $("#searchClear").hidden = !e.target.value;
});

$("#searchClear").addEventListener("click", () => {
  $("#searchInput").value = "";
  $("#searchClear").hidden = true;
  $("#searchInput").focus();
});

$("#refreshBtn").addEventListener("click", () => {
  void loadRecommended();
  handleRoute();
  toast("Actualizado");
});

$("#openManual").addEventListener("click", () => $("#manualDialog").showModal());

$("#manualForm").addEventListener("submit", (e) => {
  const value = $("#manualInput").value.trim();
  if (e.submitter && e.submitter.value === "play" && value) {
    navigate(`#/url/${encodeURIComponent(value)}`);
  }
});

// Atajos rápidos al estilo de cualquier reproductor.
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (typing) {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  const video = main.querySelector("video");
  if (e.key === "/") { e.preventDefault(); $("#searchInput").focus(); return; }
  if (!video) return;
  if (e.key === " " || e.key === "k") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  if (e.key === "m") video.muted = !video.muted;
  if (e.key === "f") video.requestFullscreen && video.requestFullscreen().catch(() => {});
  if (e.key === "t") document.body.classList.toggle("theater");
  if (e.key === "ArrowUp") video.volume = Math.min(1, video.volume + 0.05);
  if (e.key === "ArrowDown") video.volume = Math.max(0, video.volume - 0.05);
  // En directos pasados, las flechas laterales saltan 10 s.
  if (state.vod && (e.key === "ArrowLeft" || e.key === "j")) { e.preventDefault(); state.vod.seekBy(-10); }
  if (state.vod && (e.key === "ArrowRight" || e.key === "l")) { e.preventDefault(); state.vod.seekBy(10); }
});

window.addEventListener("hashchange", handleRoute);
window.addEventListener("beforeunload", destroyPlayer);

// ------------------------------------------------------------- arranque

(async function boot() {
  // Si ffmpeg está disponible es el motor preferido: sostiene 1080p, cosa que
  // hls.js no consigue contra este CDN.
  state.useFfmpeg = PLATFORM.hasFfmpeg ? await PLATFORM.hasFfmpeg().catch(() => false) : false;

  // La captura pasiva de .m3u8 solo existe dentro del navegador.
  if (!PLATFORM.hasDetection) {
    const link = document.querySelector('.side-link[data-route="#/detected"]');
    if (link) link.remove();
  }
  await loadFavorites();
  void loadRecommended();
  await handleRoute();
})();
