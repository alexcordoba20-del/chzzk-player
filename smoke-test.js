// Prueba de humo sobre el código real: carga main.js tal cual (servidor local,
// IPC y ventana incluidos) y comprueba contra la ventana que crea.
// Uso:  npx electron smoke-test.js

const { app, BrowserWindow } = require("electron");

require("./main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, label, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log("FAIL  no se creó ninguna ventana"); return app.exit(1); }

  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  // Esperamos a que la grilla se pinte con datos reales de la API.
  let view = {};
  for (let i = 0; i < 50; i++) {
    view = await win.webContents.executeJavaScript(`(() => ({
      cards: document.querySelectorAll('.card').length,
      sidebar: document.querySelectorAll('#recList .chan-item').length,
      title: (document.querySelector('.page-title') || {}).textContent || '',
      engine: typeof PLATFORM !== 'undefined' && PLATFORM.name || 'AUSENTE'
    }))()`);
    if (view.cards && view.sidebar) break;
    await sleep(500);
  }

  check(view.engine === "desktop", "PLATFORM expuesto", view.engine);
  check(view.cards > 0, "tarjetas de directos pintadas", String(view.cards));
  check(view.sidebar > 0, "canales en la barra lateral", String(view.sidebar));
  check(!!view.title, "título de la categoría", `"${view.title}"`);

  // Entramos en un directo: esto arranca ffmpeg y el servidor local.
  // Hay que devolver un valor serializable, o executeJavaScript falla.
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.card');
    if (!card) return false;
    card.click();
    return true;
  })()`);
  check(clicked, "entrando en un directo");
  await sleep(16000);

  const play = await win.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    const sel = document.querySelector('.controls .select');
    const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    return {
      src: v ? v.src : '',
      w: v ? v.videoWidth : 0,
      h: v ? v.videoHeight : 0,
      readyState: v ? v.readyState : -1,
      error: v && v.error ? v.error.code : 0,
      quality: opt ? opt.text : '(selector vacío)',
      options: sel ? sel.options.length : 0,
      aviso: (document.querySelector('.stage-msg strong') || {}).textContent || ''
    };
  })()`);
  if (play.aviso) console.log("      aviso en pantalla:", play.aviso);

  check(/127\.0\.0\.1:\d+\/live\.mp4/.test(play.src), "sirviendo desde ffmpeg en local",
    play.src.replace(/\?.*/, "?…"));
  check(play.w > 0, "vídeo decodificando", `${play.w}x${play.h} (readyState ${play.readyState})`);
  check(play.h >= 1080, "arranca en 1080p", play.quality);
  check(play.options > 1, "calidades en el selector", String(play.options));

  // Medimos estabilidad: sin cortes y sin que la reproducción se quede atrás.
  await win.webContents.executeJavaScript(
    `window.__w = 0; document.querySelector('video').addEventListener('waiting', () => window.__w++);`);
  const before = await win.webContents.executeJavaScript(
    `(() => { const v = document.querySelector('video'); return { t: v.currentTime }; })()`);
  await sleep(30000);
  const after = await win.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    const b = v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
    return { t: v.currentTime, buf: b, waits: window.__w, h: v.videoHeight };
  })()`);

  const advanced = after.t - before.t;
  check(advanced > 27, "reproducción avanzando en tiempo real",
    `${advanced.toFixed(1)}s en 30s`);
  check(after.waits <= 1, "sin cortes", `${after.waits} eventos de espera`);
  check(after.buf > 2, "buffer con colchón", `${after.buf.toFixed(1)}s por delante`);
  check(after.h >= 1080, "se mantiene en 1080p", `${after.h}p`);

  // ------------------------------------------------------------ bilibili
  console.log("\n--- Bilibili ---");
  await win.webContents.executeJavaScript(`(() => { location.hash = '#/bilibili'; return true; })()`);

  let bili = {};
  for (let i = 0; i < 40; i++) {
    bili = await win.webContents.executeJavaScript(`(() => ({
      cards: document.querySelectorAll('.card').length,
      title: (document.querySelector('.page-title') || {}).textContent || '',
      sub: (document.querySelector('.page-sub') || {}).textContent || '',
      vacio: (document.querySelector('.empty strong') || {}).textContent || ''
    }))()`);
    if (bili.cards || bili.vacio) break;
    await sleep(500);
  }
  check(bili.cards > 0, "directos de Bilibili listados",
    bili.cards ? `${bili.cards} salas · ${bili.sub}` : bili.vacio);

  if (bili.cards > 0) {
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.card').click(); return true;
    })()`);
    await sleep(16000);

    const bplay = await win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      return {
        src: v ? v.src : '',
        w: v ? v.videoWidth : 0,
        h: v ? v.videoHeight : 0,
        hash: location.hash,
        canal: (document.querySelector('.watch-channel span') || {}).textContent || '',
        aviso: (document.querySelector('.stage-msg strong') || {}).textContent || ''
      };
    })()`);

    check(bplay.hash.startsWith("#/bwatch/"), "ruta propia de Bilibili", bplay.hash);
    check(/127\.0\.0\.1:\d+\/live\.mp4/.test(bplay.src), "servido por ffmpeg en local");
    check(bplay.w > 0, "vídeo de Bilibili decodificando",
      bplay.w ? `${bplay.w}x${bplay.h} · ${bplay.canal}` : "aviso: " + bplay.aviso);

    await sleep(15000);
    const bafter = await win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      return { w: v.videoWidth, playing: !v.paused && v.readyState >= 3 };
    })()`);
    check(bafter.playing && bafter.w > 0, "sigue reproduciendo tras 15 s", `${bafter.w}px`);
  }

  // -------------------------------------------------- directos pasados
  console.log("\n--- Directos pasados ---");
  await win.webContents.executeJavaScript(`(() => { location.hash = '#/vods'; return true; })()`);

  let vods = {};
  for (let i = 0; i < 40; i++) {
    vods = await win.webContents.executeJavaScript(`(() => ({
      cards: document.querySelectorAll('.card').length,
      dur: (document.querySelector('.badge-duration') || {}).textContent || ''
    }))()`);
    if (vods.cards) break;
    await sleep(500);
  }
  check(vods.cards > 0, "directos pasados listados", `${vods.cards} vídeos · el primero dura ${vods.dur}`);

  if (vods.cards > 0) {
    await win.webContents.executeJavaScript(`(() => { document.querySelector('.card:not(.unavailable)').click(); return true; })()`);
    await sleep(12000);

    const v1 = await win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      const s = document.querySelector('.seek');
      return {
        src: v ? v.src : '', w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0,
        max: s ? Number(s.max) : 0,
        cur: (document.querySelector('.vod-time') || {}).textContent || '',
        aviso: (document.querySelector('.stage-msg strong') || {}).textContent || ''
      };
    })()`);
    check(/\/vod\.mp4\?/.test(v1.src), "servido por ffmpeg desde el playlist recortado");
    check(v1.w > 0, "vídeo pasado decodificando", v1.w ? `${v1.w}x${v1.h} · ${v1.cur}` : "aviso: " + v1.aviso);
    check(v1.max > 600, "barra con la duración completa", `${Math.round(v1.max / 60)} min`);

    // Salto a mitad del vídeo, como si se soltara la barra ahí.
    const target = Math.floor(v1.max / 2);
    const t0 = Date.now();
    await win.webContents.executeJavaScript(`(() => {
      const s = document.querySelector('.seek');
      s.value = '${target}';
      s.dispatchEvent(new Event('input'));
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);

    let v2 = {};
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      v2 = await win.webContents.executeJavaScript(`(() => {
        const v = document.querySelector('video');
        return { rs: v.readyState, t: Number(document.querySelector('.seek').value), src: v.src };
      })()`);
      if (v2.rs >= 3 && Math.abs(v2.t - target) < 30 && v2.src !== v1.src) break;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    check(v2.rs >= 3 && Math.abs(v2.t - target) < 30, "salto a mitad del vídeo",
      `pedido ${target}s · está en ${v2.t}s · listo en ${secs}s`);

    await sleep(8000);
    const v3 = await win.webContents.executeJavaScript(`Number(document.querySelector('.seek').value)`);
    check(v3 > v2.t, "sigue avanzando tras el salto", `${v2.t}s → ${v3}s`);
  }

  if (errors.length) {
    console.log(`\nErrores de consola (${errors.length}):`);
    errors.slice(0, 6).forEach((e) => console.log("  ! " + String(e).slice(0, 160)));
  } else {
    check(true, "sin errores en consola");
  }

  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\nRESULTADO: ${failed} comprobaciones fallidas` : "\nRESULTADO: todo correcto");
  app.exit(failed ? 1 : 0);
});
