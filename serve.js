// Tiny static server for the dashboard - no dependencies.
// Run:  node serve.js      ->  http://127.0.0.1:4321
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'dashboard');
const requested = Number(process.env.MOTION_PORT || process.env.PORT);
const port = Number.isInteger(requested) && requested > 0 ? requested : 4321;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.normalize(path.join(root, rel));

    if (!file.startsWith(root)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden');
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, {
        'content-type': types[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`Motion Log dashboard: http://127.0.0.1:${port}`);
  });
