const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const uploadDir = path.join(__dirname, 'uploads');
const databasePath = path.join(uploadDir, 'songs.json');
const MAX_SIZE = 25 * 1024 * 1024;

async function setup() {
  await fsp.mkdir(uploadDir, { recursive: true });
  try { await fsp.access(databasePath); }
  catch { await fsp.writeFile(databasePath, '[]'); }
}

async function songs() {
  return JSON.parse(await fsp.readFile(databasePath, 'utf8'));
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9À-ÿ ._()-]/g, '_').slice(0, 120);
}

function parseMultipart(body, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(marker) + marker.length + 2;
  while (cursor > marker.length + 1 && cursor < body.length) {
    const end = body.indexOf(marker, cursor);
    if (end === -1) break;
    const part = body.subarray(cursor, end - 2);
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator !== -1) {
      const headers = part.subarray(0, separator).toString('utf8');
      const value = part.subarray(separator + 4);
      parts.push({ headers, value });
    }
    cursor = end + marker.length + 2;
  }
  return parts;
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/songs') {
      const list = await songs();
      return send(res, 200, JSON.stringify(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const type = req.headers['content-type'] || '';
      const match = type.match(/boundary=(.+)$/);
      if (!match) return send(res, 400, JSON.stringify({ error: 'Envie o arquivo usando um formulário.' }));
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_SIZE) return send(res, 413, JSON.stringify({ error: 'O arquivo deve ter no máximo 25 MB.' }));
        chunks.push(chunk);
      }
      const part = parseMultipart(Buffer.concat(chunks), match[1])[0];
      const disposition = part?.headers.match(/filename="([^"]*)"/i);
      const original = disposition?.[1] ? safeName(disposition[1]) : '';
      if (!original.toLowerCase().endsWith('.mp3') || !part.value.length) {
        return send(res, 400, JSON.stringify({ error: 'Escolha um arquivo MP3 válido.' }));
      }
      const id = crypto.randomUUID();
      const stored = `${id}.mp3`;
      await fsp.writeFile(path.join(uploadDir, stored), part.value);
      const list = await songs();
      const song = { id, name: original, size: part.value.length, createdAt: new Date().toISOString() };
      list.push(song);
      await fsp.writeFile(databasePath, JSON.stringify(list, null, 2));
      return send(res, 201, JSON.stringify(song));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
      const id = url.pathname.split('/').pop();
      const song = (await songs()).find(item => item.id === id);
      if (!song) return send(res, 404, 'Arquivo não encontrado.', 'text/plain; charset=utf-8');
      const file = path.join(uploadDir, `${id}.mp3`);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(song.name)}`,
        'Content-Length': (await fsp.stat(file)).size
      });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET') {
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(publicDir, requested);
      if (!file.startsWith(publicDir) || !fs.existsSync(file)) return send(res, 404, 'Página não encontrada.', 'text/plain; charset=utf-8');
      return send(res, 200, await fsp.readFile(file), contentType(file));
    }
    send(res, 405, JSON.stringify({ error: 'Método não permitido.' }));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'Não foi possível concluir a operação.' }));
  }
});

setup().then(() => server.listen(PORT, () => console.log(`MP3 Share em http://localhost:${PORT}`)));
