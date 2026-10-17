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
// A conexão é direta sempre que possível. Quando a rede de alguém bloqueia a
// conexão direta (4G, algumas operadoras), o vídeo passa por um servidor TURN.
//
// TURN da Cloudflare (recomendado, 1.000 GB/mês grátis): variáveis de ambiente
//   CF_TURN_KEY_ID e CF_TURN_API_TOKEN. O servidor gera credenciais temporárias,
//   então a chave secreta nunca vai para o navegador.
// TURN próprio (opcional): TURN_URL (separadas por vírgula), TURN_USER, TURN_PASS.
const https = require('https');
const STUN = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const CF_TTL = 24 * 3600; // credenciais valem 24h; renovamos na metade
let cfCache = { at: 0, servers: null };

function cloudflareTurn() {
  const keyId = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_API_TOKEN;
  if (!keyId || !token) return Promise.resolve(null);
  if (cfCache.servers && Date.now() - cfCache.at < (CF_TTL / 2) * 1000) return Promise.resolve(cfCache.servers);
  return new Promise((resolve) => {
    const body = JSON.stringify({ ttl: CF_TTL });
    const req = https.request({
      method: 'POST',
      host: 'rtc.live.cloudflare.com',
      path: `/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const list = JSON.parse(data).iceServers;
          if (res.statusCode >= 300 || !Array.isArray(list)) throw new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          // a Cloudflare avisa que as URLs na porta 53 podem travar no navegador
          const servers = list
            .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53\b/.test(u)) }))
            .filter((s) => s.urls.length);
          cfCache = { at: Date.now(), servers };
          resolve(servers);
        } catch (e) {
          console.error('TURN Cloudflare: não foi possível gerar credenciais —', e.message);
          resolve(cfCache.servers);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', (e) => { console.error('TURN Cloudflare:', e.message); resolve(cfCache.servers); });
    req.end(body);
  });
}

async function iceConfig() {
  const iceServers = [...STUN];
  const cf = await cloudflareTurn();
  if (cf) iceServers.push(...cf);
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return { iceServers, turn: !!(cf || process.env.TURN_URL) };
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
    iceConfig().then((cfg) => {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(cfg));
    });
    return;
  }
  // Diagnóstico técnico de uma sala (só quem tem o código da sala consegue ver)
  if (urlPath === '/diag') {
    const roomId = (new URLSearchParams(req.url.split('?')[1] || '').get('sala') || '').toLowerCase();
    const d = diagStore.get(roomId);
    res.writeHead(d ? 200 : 404, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(d ? { sala: roomId, amostras: d.samples } : { erro: 'sem dados para esta sala' }));
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
    this.lastSeen = Date.now();
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
    this.lastSeen = Date.now();
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

// Mantém conexões vivas atrás de proxies e derruba as mortas.
// Tolerância de 45s sem nenhuma mensagem: com o upload saturado pela transmissão,
// as mensagens podem atrasar bastante — com 10s, gente que continuava ali era
// derrubada. Quem sai de propósito (botão Sair / fechar a guia) avisa e sai na hora.
const HEARTBEAT_MS = 15000;
const DEAD_AFTER_MS = 45000;
// Tempo para quem caiu (sem clicar em Sair) voltar e retomar a vaga sem ninguém perceber
const GRACE_MS = 15000;
setInterval(() => {
  const now = Date.now();
  for (const ws of conns) {
    if (now - ws.lastSeen > DEAD_AFTER_MS) {
      ws.timedOut = true;
      ws.destroy();
      continue;
    }
    ws.ping();
  }
}, HEARTBEAT_MS);

// ---------- Salas ----------
const rooms = new Map(); // roomId -> { peers: Map<id, peer>, chat: [] }

// Diagnóstico: últimas amostras técnicas (fps, resolução, perdas...) de cada sala.
// Fica guardado 30 min depois da última amostra, mesmo que a sala esvazie.
const diagStore = new Map(); // roomId -> { updated, samples: [] }
const DIAG_MAX = 400;
setInterval(() => {
  for (const [id, d] of diagStore) if (Date.now() - d.updated > 30 * 60 * 1000) diagStore.delete(id);
}, 60 * 1000);

function publicPeer(p) {
  return { id: p.id, nick: p.nick, live: p.live, cam: p.cam, q: p.q, watching: p.watching, relay: p.relay };
}

function broadcast(room, msg, exceptId) {
  // p.ws pode estar vazio: pessoa no "tempo de graça" depois de uma queda
  for (const p of room.peers.values()) if (p.id !== exceptId && p.ws) p.ws.send(msg);
}

// Tira alguém da sala e libera tudo o que ele ocupava (idempotente)
function removePeer(peer, quiet) {
  clearTimeout(peer.graceTimer);
  const room = rooms.get(peer.room);
  if (!room || room.peers.get(peer.id) !== peer) return;
  room.peers.delete(peer.id);
  broadcast(room, { t: 'peer-leave', id: peer.id, quiet: !!quiet });
  if (room.peers.size === 0) rooms.delete(peer.room); // sala vazia: apaga sala e chat
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
      // Identificador fixo do aparelho/navegador (não usamos IP: quem está no
      // mesmo Wi-Fi tem o mesmo IP e um derrubaria o outro)
      const device = /^[a-z0-9]{8,32}$/.test(String(m.device || '')) ? m.device : '';
      room = rooms.get(roomId);
      if (!room) {
        room = { peers: new Map(), chat: [] };
        rooms.set(roomId, room);
      }
      // O mesmo aparelho entrando de novo (caiu e voltou, ou outra aba): ASSUME a
      // vaga antiga, com o MESMO id. Para os outros nada muda — e as conexões de
      // vídeo, que vão direto entre os navegadores, continuam funcionando.
      if (device) {
        const old = [...room.peers.values()].find((p) => p.device === device);
        if (old) {
          clearTimeout(old.graceTimer);
          const oldWs = old.ws;
          old.ws = ws;
          peer = old;
          if (oldWs) {
            oldWs.send({ t: 'error', fatal: true, msg: 'Você entrou nesta sala em outra aba ou aparelho.' });
            oldWs.close();
          }
          ws.send({
            t: 'joined',
            id: peer.id,
            resumed: true,
            room: roomId,
            peers: [...room.peers.values()].filter((p) => p !== peer).map(publicPeer),
            chat: room.chat,
          });
          if (old.nick !== nick) {
            old.nick = nick;
            broadcast(room, { t: 'peer-state', peer: publicPeer(peer) }, peer.id);
          }
          return;
        }
      }
      // Já tinha saído por falta de sinal (mais de 45s fora): volta com id novo,
      // mas avisa qual era o antigo para quem o assistia reabrir a tela sozinho.
      let rejoin = false;
      let prev = null;
      const recent = device && room.recent && room.recent.get(device);
      if (recent && Date.now() - recent.at < 120000) {
        rejoin = true;
        prev = recent.id;
        room.recent.delete(device);
      }
      if (room.peers.size >= MAX_PEERS_PER_ROOM) {
        if (room.peers.size === 0) rooms.delete(roomId);
        room = null;
        return ws.send({ t: 'error', fatal: true, msg: 'A sala está cheia.' });
      }
      peer = {
        id: crypto.randomBytes(6).toString('hex'),
        room: roomId,
        device,
        nick,
        ws,
        live: false,
        cam: false,
        q: '',
        watching: [],
        relay: true,
      };
      ws.send({
        t: 'joined',
        id: peer.id,
        room: roomId,
        peers: [...room.peers.values()].map(publicPeer),
        chat: room.chat,
      });
      room.peers.set(peer.id, peer);
      // prev: id antigo de quem caiu e voltou (quem o assistia reabre a tela sozinho)
      broadcast(room, { t: 'peer-join', peer: publicPeer(peer), rejoin, prev }, peer.id);
      return;
    }

    // "ping" do site: responde para ele saber que a conexão está viva
    if (m.t === 'ping') return ws.send({ t: 'pong' });

    // conexão antiga de quem já voltou por outra: ignora
    if (!peer || peer.ws !== ws) return;

    switch (m.t) {
      case 'leave': {
        // Saída avisada (botão Sair ou guia fechada): libera na hora
        removePeer(peer, false);
        peer = null;
        ws.close();
        break;
      }
      case 'state': {
        if (typeof m.live === 'boolean') peer.live = m.live;
        if (typeof m.cam === 'boolean') peer.cam = m.cam;
        if (typeof m.relay === 'boolean') peer.relay = m.relay;
        if (Array.isArray(m.watching)) {
          peer.watching = m.watching.filter((s) => typeof s === 'string').slice(0, 4).map((s) => s.slice(0, 16));
        }
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
      case 'diag': {
        if (!m.d || typeof m.d !== 'object' || JSON.stringify(m.d).length > 8000) return;
        let d = diagStore.get(peer.room);
        if (!d) diagStore.set(peer.room, (d = { updated: 0, samples: [] }));
        d.updated = Date.now();
        d.samples.push({ hora: new Date().toISOString().slice(11, 19), nick: peer.nick, ...m.d });
        if (d.samples.length > DIAG_MAX) d.samples.splice(0, d.samples.length - DIAG_MAX);
        break;
      }
      case 'relay': {
        const target = room.peers.get(m.to);
        if (target && target.ws && m.data && typeof m.data === 'object') {
          target.ws.send({ t: 'relay', from: peer.id, data: m.data });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    // só age se esta ainda for a conexão atual da pessoa (não a antiga substituída)
    if (!peer || peer.ws !== ws) { peer = null; return; }
    const p = peer;
    peer = null;
    p.ws = null;
    // Fechou sem avisar (não clicou em Sair nem fechou a guia): dá um tempo de
    // graça para voltar. Se voltar nesse tempo, retoma a vaga e ninguém percebe.
    const forget = () => {
      if (p.ws) return; // já voltou
      const r = rooms.get(p.room);
      if (r && p.device) {
        if (!r.recent) r.recent = new Map();
        r.recent.set(p.device, { id: p.id, at: Date.now() });
      }
      removePeer(p, ws.timedOut);
    };
    if (ws.timedOut) forget();
    else p.graceTimer = setTimeout(forget, GRACE_MS);
  });
}

server.listen(PORT, () => {
  console.log(`MRP Live Room rodando em http://localhost:${PORT}`);
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) {
    cloudflareTurn().then((s) => console.log(s ? 'TURN Cloudflare: ativo' : 'TURN Cloudflare: FALHOU (veja o erro acima)'));
  } else if (!process.env.TURN_URL) {
    console.log('TURN: não configurado (conexões bloqueadas por algumas redes não vão funcionar)');
  }
});
