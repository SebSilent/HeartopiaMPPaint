/*
 * Zero-dependency static server for local development.
 *   npm run dev   ->  http://localhost:8080/
 * Only needed for working locally; the published site is plain static files.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

http
  .createServer((req, res) => {
    // A malformed request line must not kill the server: one bad URL from a
    // proxy or a typo'd client used to take the whole dev server down.
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      res.writeHead(400).end('bad request');
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(PORT, () => {
    console.log(`serving ${ROOT}`);
    console.log(`  http://localhost:${PORT}/`);
    console.log(`  http://localhost:${PORT}/?room=DEMO1`);
  });
