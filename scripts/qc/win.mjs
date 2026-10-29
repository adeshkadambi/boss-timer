// Close or show a window of the QC build, as its close button or the tray's Show Today would.
//   node scripts/qc/win.mjs <main|timer>          close it (runs the CloseRequested handler)
//   node scripts/qc/win.mjs --show <main|timer>   unminimize, show and focus it
import net from 'node:net';
const show = process.argv[2] === '--show';
const label = process.argv[show ? 3 : 2];
const s = net.connect(Number(process.env.QC_PORT ?? 47811), '127.0.0.1', () => s.end(`${show ? '!show' : '!close'} ${label}\n`));
s.on('data', (d) => process.stdout.write(d));
