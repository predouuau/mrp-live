// MRP Live Room — servidor de sinalização + arquivos estáticos.
// Sem dependências: apenas Node.js (>= 16). Rode com: node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PEERS_PER_ROOM = 12;
const MAX_FRAME = 256 * 1024; // mensagens de sinalização são pequenas
const CHAT_HISTORY = 100;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ---------- Configuração ICE (STUN/TURN) ----------
function iceConfig() {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  // TURN opcional (recomendado para redes restritivas): TURN_URL, TURN_USER, TURN_PASS
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return { iceServers };
}

// ---------- HTTP (arquivos estáticos) ----------
const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (urlPath === '/config.json') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(iceConfig()));
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

// ---------- WebSocket mínimo (RFC 6455) ----------
class WSConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.dead = false;
    this.alive = true;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('end', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.dead) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (!masked || len > MAX_FRAME) return this.destroy();
      const end = off + 4 + len;
      if (buf.length < end) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, end));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = buf.subarray(end);
      this._frame(fin, op, payload);
    }
  }

  _frame(fin, op, payload) {
    this.alive = true;
    if (op === 0x8) return this.close();
    if (op === 0x9) return this._send(0xa, payload);
    if (op === 0xa) return;
    if (op === 0x1 || op === 0x2) this.frags = [payload];
    else if (op === 0x0 && this.frags.length) this.frags.push(payload);
    else return;
    if (fin) {
      const msg = Buffer.concat(this.frags).toString('utf8');
      this.frags = [];
      this.emit('message', msg);
    }
  }

  _send(op, payload) {
    if (this.dead) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(obj) {
    this._send(0x1, Buffer.from(JSON.stringify(obj)));
  }

  ping() {
    this._send(0x9, Buffer.alloc(0));
  }

  close() {
    if (this.dead) return;
    try {
      this._send(0x8, Buffer.alloc(0));
    } catch {}
    this.socket.end();
    this._closed();
  }

  destroy() {
    this.socket.destroy();
    this._closed();
  }

  _closed() {
    if (this.dead) return;
    this.dead = true;
    this.emit('close');
  }
}

const conns = new Set();

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    return socket.destroy();
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const ws = new WSConn(socket);
  conns.add(ws);
  ws.on('close', () => conns.delete(ws));
  handleConnection(ws);
});

// Mantém conexões vivas atrás de proxies e derruba as mortas
setInterval(() => {
  for (const ws of conns) {
    if (!ws.alive) {
      ws.destroy();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

// ---------- Salas ----------
const rooms = new Map(); // roomId -> { peers: Map<id, peer>, chat: [] }

function publicPeer(p) {
  return { id: p.id, nick: p.nick, live: p.live, cam: p.cam, viewers: p.viewers, q: p.q };
}

function broadcast(room, msg, exceptId) {
  for (const p of room.peers.values()) if (p.id !== exceptId) p.ws.send(msg);
}

function handleConnection(ws) {
  let peer = null;
  let room = null;

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (peer) return;
      const roomId = String(m.room || '').toLowerCase();
      const nick = String(m.nick || '').trim().slice(0, 24);
      if (!/^[a-z0-9]{4,32}$/.test(roomId) || !nick) {
        return ws.send({ t: 'error', fatal: true, msg: 'Sala ou nick inválido.' });
      }
      room = rooms.get(roomId);
      if (!room) {
        room = { peers: new Map(), chat: [] };
        rooms.set(roomId, room);
      }
      if (room.peers.size >= MAX_PEERS_PER_ROOM) {
        room = null;
        return ws.send({ t: 'error', fatal: true, msg: 'A sala está cheia.' });
      }
      peer = {
        id: crypto.randomBytes(6).toString('hex'),
        room: roomId,
        nick,
        ws,
        live: false,
        cam: false,
        viewers: 0,
        q: '',
      };
      ws.send({
        t: 'joined',
        id: peer.id,
        room: roomId,
        peers: [...room.peers.values()].map(publicPeer),
        chat: room.chat,
      });
      room.peers.set(peer.id, peer);
      broadcast(room, { t: 'peer-join', peer: publicPeer(peer) }, peer.id);
      return;
    }

    if (!peer) return;

    switch (m.t) {
      case 'state': {
        if (typeof m.live === 'boolean') peer.live = m.live;
        if (typeof m.cam === 'boolean') peer.cam = m.cam;
        if (Number.isInteger(m.viewers)) peer.viewers = Math.max(0, Math.min(99, m.viewers));
        if (typeof m.q === 'string') peer.q = m.q.slice(0, 16);
        broadcast(room, { t: 'peer-state', peer: publicPeer(peer) }, peer.id);
        break;
      }
      case 'chat': {
        const text = String(m.text || '').trim().slice(0, 1000);
        if (!text) return;
        const msg = { id: crypto.randomBytes(5).toString('hex'), from: peer.id, nick: peer.nick, text, ts: Date.now() };
        room.chat.push(msg);
        if (room.chat.length > CHAT_HISTORY) room.chat.shift();
        broadcast(room, { t: 'chat', msg });
        break;
      }
      case 'relay': {
        const target = room.peers.get(m.to);
        if (target && m.data && typeof m.data === 'object') {
          target.ws.send({ t: 'relay', from: peer.id, data: m.data });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!peer || !room) return;
    room.peers.delete(peer.id);
    broadcast(room, { t: 'peer-leave', id: peer.id });
    if (room.peers.size === 0) rooms.delete(peer.room);
    peer = null;
  });
}

server.listen(PORT, () => {
  console.log(`MRP Live Room rodando em http://localhost:${PORT}`);
});
