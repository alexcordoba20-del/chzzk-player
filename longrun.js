const { app, BrowserWindow } = require("electron");
require("./main.js");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  for (let i=0;i<40;i++){ const n=await win.webContents.executeJavaScript(`document.querySelectorAll('.card').length`); if(n)break; await sleep(500); }
  await win.webContents.executeJavaScript(`(()=>{document.querySelector('.card').click();return true})()`);
  await sleep(8000);
  await win.webContents.executeJavaScript(`(()=>{const v=document.querySelector('video');
    window.__w=0; window.__t0=Date.now();
    v.addEventListener('waiting',()=>window.__w++);
    v.addEventListener('ended',()=>console.error('EVENTO: ended'));
    v.addEventListener('stalled',()=>console.error('EVENTO: stalled'));
    return true})()`);
  console.log("min  video      rs  currentTime  bufferPorDelante  latenciaVsReal  cortes");
  const t0 = Date.now();
  for (let i=0;i<32;i++){
    const s = await win.webContents.executeJavaScript(`(()=>{const v=document.querySelector('video');
      const b=v.buffered.length?v.buffered.end(v.buffered.length-1):0;
      return {w:v.videoWidth,rs:v.readyState,ct:v.currentTime,buf:b-v.currentTime,
              wall:(Date.now()-window.__t0)/1000, waits:window.__w, paused:v.paused};})()`);
    const min=((Date.now()-t0)/60000).toFixed(1);
    // Cuanto se ha quedado atras el reloj de reproduccion respecto al tiempo real
    const drift=(s.wall - s.ct).toFixed(1);
    console.log(`${min.padStart(4)} ${String(s.w+"px").padEnd(9)} ${String(s.rs).padStart(2)}  ${s.ct.toFixed(1).padStart(9)}s  ${s.buf.toFixed(1).padStart(14)}s  ${String(drift).padStart(12)}s  ${s.waits}${s.paused?" PAUSADO":""}`);
    if (s.rs < 3 && i > 2) console.log("   ^^ PARADO");
    await sleep(45000);
  }
  app.exit(0);
});
