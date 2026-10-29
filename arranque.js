// Arranque fijo de CHZZK Player. Va dentro de app.asar y NO se actualiza.
//
// Si hay una versión descargada de GitHub (actualizador.js la deja en
// %APPDATA%\CHZZK Player\actualizacion) y no está marcada como fallida, carga
// esa; si no, la que viene incluida en el ejecutable. Si la descargada falla al
// cargar, la marca como fallida y arranca con la incluida, así una actualización
// rota nunca deja la app sin abrir.
const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const INCLUIDA = __dirname;
const DIR = path.join(app.getPath("appData"), "CHZZK Player", "actualizacion");
const PUNTERO = path.join(DIR, "actual.json");

function leerPuntero() {
  try { return JSON.parse(fs.readFileSync(PUNTERO, "utf8")); } catch { return null; }
}

function cargar(base) {
  global.CHZZK_BASE = base;            // actualizador.js lo usa para saber qué versión corre
  require(path.join(base, "main.js"));
}

let base = INCLUIDA;
const p = app.isPackaged ? leerPuntero() : null;   // con "npm start" siempre el código local
if (p && p.carpeta && !p.fallida) {
  const candidata = path.join(DIR, p.carpeta);
  if (fs.existsSync(path.join(candidata, "main.js"))) base = candidata;
}

if (base === INCLUIDA) {
  cargar(INCLUIDA);
} else {
  try {
    cargar(base);
  } catch (err) {
    console.error("La versión descargada no arranca; uso la incluida:", err);
    try { fs.writeFileSync(PUNTERO, JSON.stringify({ ...p, fallida: true, error: String(err && err.stack || err) }, null, 1)); } catch { /* sin permiso */ }
    cargar(INCLUIDA);
  }
}
