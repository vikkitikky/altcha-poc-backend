import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const html = await readFile(new URL('./index.html', import.meta.url));
const widget = await readFile(fileURLToPath(import.meta.resolve('altcha')));
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html);
  } else if (request.method === 'GET' && request.url === '/widget.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); response.end(widget);
  } else { response.writeHead(404); response.end(); }
});
server.listen(3000, '127.0.0.1', () => console.log('Native ALTCHA demo: http://127.0.0.1:3000'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
