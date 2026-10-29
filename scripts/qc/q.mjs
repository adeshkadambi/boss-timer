// Run JavaScript in a window of the running QC build and print what it returns.
//   QC_LOG=<app log> node scripts/qc/q.mjs <main|timer> '<js body; may await; return a JSON-able value>'
// The body runs inside an async function. The result comes back through the app log
// (log_frontend), so QC_LOG must be the file the QC build's output is written to.
// Exit code: 0 ok, 1 the script threw (prints ERR + stack), 2 timed out.
import fs from 'node:fs';
import net from 'node:net';

const [, , label, body] = process.argv;
const LOG = process.env.QC_LOG;
const PORT = Number(process.env.QC_PORT ?? 47811);
if (!label || body == null || !LOG) {
  console.error('usage: QC_LOG=<app log> node q.mjs <main|timer> <js body>');
  process.exit(64);
}
const id = Math.random().toString(36).slice(2, 8);
const js = `(async()=>{const say=(m)=>window.__TAURI_INTERNALS__.invoke('log_frontend',{message:'QC ${id} '+m});
try{const r=await (async()=>{${body}})();say(JSON.stringify(r===undefined?null:r))}catch(e){say('ERR '+(e&&e.stack||e))}})()`;
const start = fs.statSync(LOG).size;
await new Promise((res, rej) => {
  const s = net.connect(PORT, '127.0.0.1', () => s.end(`${label}\n${js}`));
  let out = '';
  s.on('data', (d) => (out += d));
  s.on('end', () => (out.startsWith('ok') ? res() : rej(new Error(out.trim()))));
  s.on('error', rej);
});
for (let i = 0; i < 150; i++) {
  const m = fs.readFileSync(LOG).subarray(start).toString().match(new RegExp(`QC ${id} (.*)`));
  if (m) {
    console.log(m[1]);
    process.exit(m[1].startsWith('ERR') ? 1 : 0);
  }
  await new Promise((r) => setTimeout(r, 100));
}
console.log('timeout (did the page reload, or is the script waiting longer than 15 s?)');
process.exit(2);
