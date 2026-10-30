/*
 * Zero-dependency static server for local development.
 *   npm run dev   ->  http://localhost:8080/
 * Only needed for working locally; the published site is plain static files.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * argv wins, then PORT, then the default. `node tools/serve.cjs 8099` used to
 * ignore the 8099 and start on 8080, which on this machine is an unrelated app -
 * so the server appeared to be running while every probe that followed got
 * connection refused (or worse, someone else's HTML). A bad value now says so
 * instead of quietly moving the port.
 */
const RAW_PORT = process.argv[2] || process.env.PORT || 8080;
const PORT = Number(RAW_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`serve: "${RAW_PORT}" is not a port number`);
  process.exit(1);
}

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
  // robots.txt and sitemap.xml are fetched by crawlers, and a crawler that is
  // handed application/octet-stream for them learns nothing about the site.
  // GitHub Pages gets these right on its own; this is so local dev matches.
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const server = http
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
  ;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Name the next port rather than hard-coding a favourite: "pick 8099" is
    // worthless in the exact case where 8099 is the port that just failed. And
    // the warning about an unrelated app on 8080 only applies to 8080.
    const note =
      PORT === 8080
        ? ' On this machine 8080 belongs to an unrelated app that answers with pages that are not ' +
          "ours, so a probe pointed at it measures someone else's site."
        : '';
    console.error(`serve: port ${PORT} is already taken.${note} Try: node tools/serve.cjs ${PORT + 1}`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  http://localhost:${PORT}/?room=DEMO1`);
});
