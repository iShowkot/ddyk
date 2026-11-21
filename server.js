import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const BLOCKED_PATHS = new Set([
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/bun.lock',
  '/metadata.json',
]);

const COMPRESSIBLE = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'public, max-age=0, must-revalidate' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'public, max-age=0, must-revalidate' }],
  ['/three.min.js', { file: 'three.min.js', type: 'application/javascript; charset=utf-8', cache: 'public, max-age=86400, stale-while-revalidate=604800' }],
]);

const compressedCache = new Map();
function getCompressedAsset(filename) {
  const fullPath = path.join(__dirname, filename);
  const stat = fs.statSync(fullPath);
  const hit = compressedCache.get(filename);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const raw = fs.readFileSync(fullPath);
  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    etag: `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`,
    raw,
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }),
    gz: zlib.gzipSync(raw, { level: 6 }),
  };
  compressedCache.set(filename, entry);
  return entry;
}

// Pre-warm compressed buffers at startup so first request has 0ms compression latency
for (const { file } of new Set(COMPRESSIBLE.values())) {
  try { getCompressedAsset(file); } catch { /* ignore if absent */ }
}

app.use((req, res, next) => {
  if (BLOCKED_PATHS.has(req.path) || req.path.startsWith('/node_modules')) {
    return res.status(404).end();
  }
  next();
});

function sendCompressed(req, res, meta) {
  const asset = getCompressedAsset(meta.file);
  res.setHeader('Content-Type', meta.type);
  res.setHeader('Cache-Control', meta.cache);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', asset.etag);
  if (req.headers['if-none-match'] === asset.etag) {
    return res.status(304).end();
  }
  const ae = String(req.headers['accept-encoding'] || '');
  if (ae.includes('br')) {
    res.setHeader('Content-Encoding', 'br');
    res.setHeader('Content-Length', asset.br.length);
    return res.send(asset.br);
  }
  if (ae.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', asset.gz.length);
    return res.send(asset.gz);
  }
  res.setHeader('Content-Length', asset.raw.length);
  return res.send(asset.raw);
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const meta = COMPRESSIBLE.get(req.path);
  if (meta) return sendCompressed(req, res, meta);
  next();
});

app.use(express.static(__dirname, {
  index: false,
  maxAge: '1d',
  etag: true,
}));

app.use((req, res) => {
  sendCompressed(req, res, COMPRESSIBLE.get('/'));
});

app.listen(PORT, HOST, () => {
  console.log(`DDYK static server listening at http://${HOST}:${PORT}`);
});
