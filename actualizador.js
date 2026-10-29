// Actualizador de CHZZK Player desde GitHub.
//
// Cada 30 minutos (y a los pocos segundos de abrir) mira el último commit del
// repositorio. Si hay uno nuevo, descarga su zip, lo descomprime en
// %APPDATA%\CHZZK Player\actualizacion\<commit> y apunta actual.json a esa
// carpeta. arranque.js la carga la próxima vez que se abra la app. Si el código
// nuevo es igual al que está corriendo, se aplica sin preguntar; si cambia algo,
// pregunta si reiniciar ahora.
const { app, dialog } = require("electron");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const REPO = "alexcordoba20-del/chzzk-player";
const RAMA = "main";
const CADA = 30 * 60 * 1000;
const DIR = path.join(app.getPath("appData"), "CHZZK Player", "actualizacion");
const PUNTERO = path.join(DIR, "actual.json");

let ocupado = false;
let avisado = null;   // commit por el que ya se preguntó (no insistir)

function get(url, redirecciones = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "chzzk-player-actualizador", Accept: "application/vnd.github+json" }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirecciones > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirecciones - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} en ${url}`)); }
      const trozos = [];
      res.on("data", (c) => trozos.push(c));
      res.on("end", () => resolve(Buffer.concat(trozos)));
    });
    req.on("timeout", () => req.destroy(new Error("tiempo agotado")));
    req.on("error", reject);
  });
}

function leerPuntero() {
  try { return JSON.parse(fs.readFileSync(PUNTERO, "utf8")); } catch { return null; }
}

function archivos(dir, rel = "") {
  let out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out = out.concat(archivos(dir, r)); else out.push(r);
  }
  return out;
}

// ¿El código descargado es igual al que está corriendo? (solo lo que usa la app)
function igualQueActual(nueva) {
  const actual = global.CHZZK_BASE || path.join(__dirname);
  const usados = (f) => /^(main\.js|preload\.js|actualizador\.js|renderer[\\/]|icons[\\/])/.test(f);
  const a = archivos(nueva).filter(usados), b = archivos(actual).filter(usados);
  if (a.length !== b.length) return false;
  return a.every((f) => {
    try { return fs.readFileSync(path.join(nueva, f)).equals(fs.readFileSync(path.join(actual, f))); } catch { return false; }
  });
}

function limpiarViejas(conservar) {
  const enUso = global.CHZZK_BASE ? path.basename(global.CHZZK_BASE) : null;
  for (const e of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === conservar || e.name === enUso) continue;
    try { fs.rmSync(path.join(DIR, e.name), { recursive: true, force: true }); } catch { /* en uso: la próxima vez */ }
  }
}

async function comprobar(ventana) {
  if (ocupado) return;
  ocupado = true;
  try {
    const sha = JSON.parse(await get(`https://api.github.com/repos/${REPO}/commits/${RAMA}`)).sha;
    const p = leerPuntero();
    if (p && p.sha === sha) return;                 // ya descargada (o marcada como fallida)

    fs.mkdirSync(DIR, { recursive: true });
    const zip = path.join(os.tmpdir(), `chzzk-player-${sha.slice(0, 7)}.zip`);
    fs.writeFileSync(zip, await get(`https://codeload.github.com/${REPO}/zip/${sha}`));
    const tmp = path.join(DIR, `${sha.slice(0, 7)}.tmp`);
    fs.rmSync(tmp, { recursive: true, force: true });
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`],
      { windowsHide: true, timeout: 120000 });
    fs.rmSync(zip, { force: true });
    if (r.status !== 0) throw new Error("no se pudo descomprimir: " + String(r.stderr || "").trim());

    // el zip trae todo dentro de "chzzk-player-<sha>/"
    const dentro = fs.readdirSync(tmp);
    const raiz = dentro.length === 1 ? path.join(tmp, dentro[0]) : tmp;
    if (!fs.existsSync(path.join(raiz, "main.js")) || !fs.existsSync(path.join(raiz, "renderer", "app.html"))) {
      throw new Error("la versión descargada está incompleta");
    }
    const carpeta = sha.slice(0, 7);
    const destino = path.join(DIR, carpeta);
    fs.rmSync(destino, { recursive: true, force: true });
    fs.renameSync(raiz, destino);
    fs.rmSync(tmp, { recursive: true, force: true });

    const igual = igualQueActual(destino);
    fs.writeFileSync(PUNTERO, JSON.stringify({ sha, carpeta, fecha: new Date().toISOString() }, null, 1));
    limpiarViejas(carpeta);
    console.log(`Actualización ${carpeta} descargada${igual ? " (sin cambios en el código)" : ""}.`);

    if (!igual && avisado !== sha) {
      avisado = sha;
      const { response } = await dialog.showMessageBox(ventana && !ventana.isDestroyed() ? ventana : undefined, {
        type: "info",
        title: "Vigía",
        message: "Hay una versión nueva de Vigía.",
        detail: "Se aplicará la próxima vez que abras la app. ¿Reiniciar ahora?",
        buttons: ["Reiniciar ahora", "Más tarde"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) { app.relaunch(); app.exit(0); }
    }
  } catch (err) {
    console.error("Actualizador:", err.message || err);
  } finally {
    ocupado = false;
  }
}

// obtenerVentana: función que devuelve la ventana principal (para anclar el aviso).
function iniciar(obtenerVentana) {
  if (!app.isPackaged) return;                      // con "npm start" no se actualiza
  const base = global.CHZZK_BASE || __dirname;
  console.log("CHZZK Player: versión en uso:", base.includes("actualizacion") ? path.basename(base) + " (descargada)" : "incluida");
  setTimeout(() => comprobar(obtenerVentana()), 8000);
  setInterval(() => comprobar(obtenerVentana()), CADA);
}

module.exports = { iniciar, comprobar };
