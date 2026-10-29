// Puente entre la interfaz y el proceso principal.
//
// La interfaz es la misma que la de la extensión, así que expone el mismo
// contrato que allí cubría chrome.*: PLATFORM. Cambiando este archivo se puede
// llevar la misma UI a otro entorno.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("PLATFORM", {
  name: "desktop",

  // En escritorio no hay pestañas que espiar, así que no hay detección pasiva
  // de .m3u8; la UI oculta esa sección cuando esto es false.
  hasDetection: false,

  // Las llamadas a la API se hacen desde el proceso principal: allí no hay CORS
  // y podemos mandar el Referer que espera Naver.
  apiFetch: (url) => ipcRenderer.invoke("api-fetch", url),

  getFavorites: () => ipcRenderer.invoke("favorites-get"),
  setFavorites: (list) => ipcRenderer.invoke("favorites-set", list),

  launchFfplay: (url) => ipcRenderer.invoke("ffplay", url),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  detectedStreams: () => Promise.resolve([]),

  // Motor de reproducción por ffmpeg: remuxa el HLS y lo sirve en local, que es
  // lo que permite sostener 1080p. Si ffmpeg no está, la UI usa hls.js.
  hasFfmpeg: () => ipcRenderer.invoke("has-ffmpeg"),
  streamVariants: (masterUrl) => ipcRenderer.invoke("stream-variants", masterUrl),
  streamUrl: (source) => ipcRenderer.invoke("stream-url", source),

  // Directos pasados: abre un VOD en el segundo pedido (el salto lo resuelve
  // el proceso principal recortando el playlist).
  vodOpen: (source, seconds) => ipcRenderer.invoke("vod-open", source, seconds)
});
