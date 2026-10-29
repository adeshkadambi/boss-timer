// Close a window of the QC build as its close button would (runs the CloseRequested handler).
//   node scripts/qc/close.mjs <main|timer>
import net from 'node:net';
const s = net.connect(Number(process.env.QC_PORT ?? 47811), '127.0.0.1', () => s.end(`!close ${process.argv[2]}\n`));
s.on('data', (d) => process.stdout.write(d));
