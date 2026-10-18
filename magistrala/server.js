// Magistrala server: serves the PWA and relays game rooms over WebSocket. Zero dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgrade } from './lib/ws.js';
import { Rooms } from './lib/rooms.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.FARUL_DATA || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
};

export function createServer({ persist = true } = {}) {
  let saveTimer = null;
  const save = () => {
    if (!persist) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(rooms.serialize()));
        fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
      } catch (err) {
        console.error('save failed:', err.message);
      }
    }, 500);
  };
  const rooms = new Rooms({ onChange: save });
  if (persist) {
    try { rooms.restoreAll(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch { /* first start */ }
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, HEADERS).end();
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      res.writeHead(400, HEADERS).end();
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, HEADERS).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403, HEADERS).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        ...HEADERS,
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file).pipe(res);
    });
  });

  const conns = new Set();
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const conn = upgrade(req, socket, head);
    if (!conn) return;
    conns.add(conn);
    conn.on('message', (raw) => rooms.handle(conn, raw));
    conn.on('close', () => {
      conns.delete(conn);
      rooms.detach(conn);
    });
  });

  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        conn.close(1001);
        continue;
      }
      conn.alive = false;
      conn.ping();
    }
  }, 30000);
  heartbeat.unref();
  const shutdown = () =>
    new Promise((resolve) => {
      clearInterval(heartbeat);
      for (const conn of conns) conn.close(1001);
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  return { server, rooms, shutdown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 8090;
  const { server } = createServer();
  server.listen(port, '0.0.0.0', () => console.log(`Magistrala pornită pe http://localhost:${port}`));
}
