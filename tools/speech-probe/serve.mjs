// node tools/speech-probe/serve.mjs <model-directory> [port]
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const models = path.resolve(process.argv[2] || '.');
const modelNames = new Set(['model.int8.onnx', 'nemo80.onnx', 'tokens.txt', 'test.wav']);
const types = { '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const name = decodeURIComponent(url.pathname);
    const isModel = name.startsWith('/models/');
    if (isModel && !modelNames.has(name.slice(8))) throw Error('Not found');
    const base = isModel ? models : root;
    const file = path.resolve(base, isModel ? name.slice(8) : '.' + name);
    if (!file.startsWith(base + path.sep)) throw Error('Not found');
    const info = await stat(file);
    if (!info.isFile()) throw Error('Not found');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Content-Length': info.size, ...(url.searchParams.get('isolation') === 'off' ? {} : {
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'
      }) });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(Number(process.argv[3]) || 8879, '127.0.0.1', () => {
  console.log('http://127.0.0.1:' + (process.argv[3] || 8879) + '/tools/speech-probe/index.html');
});
