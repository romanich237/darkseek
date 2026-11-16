const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
]);

createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const file = files.get(req.url.split('?')[0]);
  if (!file) {
    res.writeHead(404).end();
    return;
  }

  try {
    const [name, type] = file;
    const content = await readFile(join(__dirname, name));
    res.writeHead(200, {
      'Content-Type': type + '; charset=utf-8',
      'Content-Length': content.length,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(500).end();
  }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0');
