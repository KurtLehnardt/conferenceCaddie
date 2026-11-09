import { createServer } from 'node:http';

const port = Number(process.env.PORT) || 8080;

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Conference Caddie hello\n');
}).listen(port, () => console.log(`hello listening on ${port}`));
