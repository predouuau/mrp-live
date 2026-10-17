/* MRP Live Room — cliente
 *
 * Arquitetura (pensada para gastar pouco do PC):
 *  - WebRTC ponto a ponto. Cada transmissão (tela ou câmera) usa uma conexão
 *    unidirecional própria: quem transmite sempre faz a oferta, quem assiste responde.
 *  - A tela SÓ é enviada para quem clicou em "Assistir". Ninguém assistindo = nenhum
 *    custo de codificação/upload além da captura.
 *  - A captura já sai na resolução/FPS escolhidos (o navegador reduz na origem),
 *    e o codec VP8 é priorizado (veja preferCodecs: o H.264 por hardware da AMD travava).
 *  - Ao parar de assistir, a conexão é fechada e o decodificador é liberado.
 */
'use strict';

// ---------------------------------------------------------------- utilidades
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Ícones: Font Awesome Free (link no <head> do index.html)
const ICONS = {
  speaker: 'fa-solid fa-volume-high',
  mute: 'fa-solid fa-volume-xmark',
  cam: 'fa-solid fa-video',
  camoff: 'fa-solid fa-video-slash',
  screen: 'fa-solid fa-display',
  leave: 'fa-solid fa-phone hangup',
  chat: 'fa-regular fa-message',
  link: 'fa-solid fa-link',
  eye: 'fa-solid fa-eye',
  full: 'fa-solid fa-expand',
  x: 'fa-solid fa-xmark',
  users: 'fa-solid fa-user-group',
  live: 'fa-solid fa-tower-broadcast',
  play: 'fa-solid fa-play',
  layers: 'fa-solid fa-table-columns',
  expand: 'fa-solid fa-up-right-and-down-left-from-center',
  stop: 'fa-solid fa-stop',
};
function icon(name) { return ICONS[name] ? `<i class="${ICONS[name]}" aria-hidden="true"></i>` : ''; }

const COLORS = ['#e3242b', '#a8161c', '#5d5d68', '#c2185b', '#3d3d46', '#ff5a5f', '#7b1f24', '#80808c'];
function colorFor(nick) {
  let h = 0;
  for (const ch of nick) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function avatarHTML(nick, cls = 'avatar', live = false) {
  const first = [...nick.trim()][0] || '?';
  return `<div class="${cls}${live ? ' live' : ''}" style="background:${colorFor(nick)}">${esc(first)}</div>`;
}

function toast(text, ms = 3000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function genRoomId() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const a = crypto.getRandomValues(new Uint8Array(8));
  return [...a].map((n) => abc[n % abc.length]).join('');
}

// ------------------------------------------------------------- configuração
const QUALITY = {
  480: { w: 854, h: 480, br: { 30: 1_200_000, 60: 2_000_000 } },
  720: { w: 1280, h: 720, br: { 30: 2_500_000, 60: 4_000_000 } },
  1080: { w: 1920, h: 1080, br: { 30: 4_500_000, 60: 7_000_000 } },
};
const CAM = { w: 640, h: 360, fps: 24, br: 500_000 };
const MAX_WATCH = 2; // no máximo 2 telas lado a lado

const S = {
  ws: null,
  me: null,
  nick: '',
  room: '',
  peers: new Map(), // id -> {id, nick, live, cam, q, watching}
  self: { live: false, cam: false, q: '' },
  sentWatching: '',
  screenStream: null,
  previewStream: null, // cópia leve da minha tela, só para a prévia local
  camStream: null,
  quality: { res: '720', fps: 60, audio: true },
  watched: [], // ids das telas que estou assistindo (pode incluir a minha)
  pcs: new Map(), // `${role}:${kind}:${peerId}` -> entry
  muted: new Set(), // telas que eu silenciei
  volumes: new Map(), // volume de cada tela (0 a 1)
  focus: null, // tela ampliada quando há 2 abertas
  chatOpen: window.innerWidth > 1200,
  showMembers: false, // fileira de membros abaixo da tela (botão de pessoas)
  unread: 0,
  leaving: false,
  rtc: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  rtcReady: null, // promessa da configuração STUN/TURN vinda do servidor
  hasTurn: false,
  lastMsg: null,
};

const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

// Identificador fixo deste aparelho/navegador: se ele entrar de novo na sala,
// o servidor troca a entrada antiga em vez de ocupar mais uma vaga
const DEVICE_ID = (() => {
  let id = '';
  try { id = localStorage.getItem('mrp-device') || ''; } catch {}
  if (!/^[a-z0-9]{8,32}$/.test(id)) {
    id = [...crypto.getRandomValues(new Uint8Array(12))].map((n) => (n % 36).toString(36)).join('');
    try { localStorage.setItem('mrp-device', id); } catch {}
  }
  return id;
})();

// ---------------------------------------------------------------- entrada
function initLanding() {
  const params = new URLSearchParams(location.search);
  const invited = (params.get('sala') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nickInput = $('#nick');
  try { nickInput.value = localStorage.getItem('mrp-nick') || ''; } catch {}
  try {
    const q = JSON.parse(localStorage.getItem('mrp-quality') || 'null');
    if (q && QUALITY[q.res] && (q.fps === 30 || q.fps === 60)) S.quality = { ...S.quality, ...q };
  } catch {}

  let mode = invited.length >= 4 ? 'join' : 'create';
  setLandingMode(mode, invited);
  $('#altBtn').onclick = () => {
    mode = 'create';
    setLandingMode('create');
    history.replaceState(null, '', location.pathname);
    nickInput.focus();
  };

  if (!window.isSecureContext) {
    const w = $('#secureWarn');
    w.hidden = false;
    w.textContent = 'Atenção: o site precisa estar em HTTPS (ou localhost) para transmitir tela e câmera.';
  }

  $('#joinForm').onsubmit = (e) => {
    e.preventDefault();
    const nick = nickInput.value.trim().slice(0, 24);
    if (!nick) return nickInput.focus();
    try { localStorage.setItem('mrp-nick', nick); } catch {}
    S.nick = nick;
    S.room = mode === 'join' ? invited : genRoomId();
    enterRoom(mode === 'create');
  };
  nickInput.focus();

  // Servidores STUN/TURN (o TURN é a "ponte" para redes que bloqueiam conexão direta)
  S.rtcReady = fetch('/config.json')
    .then((r) => r.json())
    .then((c) => {
      if (c && c.iceServers) S.rtc = { iceServers: c.iceServers };
      S.hasTurn = !!(c && c.turn);
    })
    .catch(() => {});
}

// Link padrão: "Crie uma sala". Link de convite: "Entre na sala <código>".
function setLandingMode(mode, code) {
  const join = mode === 'join';
  $('#landTitle').textContent = join ? 'Entre na sala' : 'Crie uma sala';
  $('#landRoom').textContent = join ? code : '';
  $('#landRoom').hidden = !join;
  $('#mainBtn span').textContent = join ? 'Entrar na sala' : 'Criar sala';
  $('#altBox').hidden = !join;
}

function resetChat() {
  $('#msgs').innerHTML = `<div id="chatEmpty" class="chat-empty">
    <i class="fa-regular fa-comment-dots"></i>
    <b>Bem-vindo(a) à sala!</b>
    <p>Envie mensagens, compartilhe links, organize ideias e mantenha o foco.</p>
  </div>`;
  S.lastMsg = null;
}

function roomLink() {
  return `${location.origin}${location.pathname}?sala=${S.room}`;
}

function enterRoom(created) {
  S.leaving = false;
  $('#landing').hidden = true;
  $('#room').hidden = false;
  history.replaceState(null, '', `?sala=${S.room}`);
  document.title = `MRP Live Room — ${S.room}`;
  $('#chanName').textContent = `Sala ${S.room}`;
  $('#headName').textContent = `Sala ${S.room}`;
  $('#vsSub').textContent = `MRP Live Room / ${S.room}`;
  $('#meNick').textContent = S.nick;
  $('#meAvatar').outerHTML = avatarHTML(S.nick, 'avatar" id="meAvatar');
  resetChat();
  setChatOpen(S.chatOpen);
  if (created) {
    $('#linkInput').value = roomLink();
    $('#linkModal').hidden = false;
  }
  // só conecta depois de saber os servidores TURN (no máximo 4s de espera)
  Promise.race([S.rtcReady, new Promise((r) => setTimeout(r, 4000))]).then(() => { if (S.room && !S.leaving) connect(); });
  render();
}

// ------------------------------------------------------------- sinalização
function send(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}
function relay(to, data) { send({ t: 'relay', to, data }); }
function pushState() {
  const watching = S.watched.filter((id) => id !== S.me);
  S.sentWatching = watching.join(',');
  send({ t: 'state', ...S.self, relay: !IS_MOBILE, watching });
}

// ------------------------------------------------- conexão com o servidor
// Bug corrigido: a conexão podia "morrer em silêncio" (troca de Wi-Fi, 4G,
// internet saturada pela transmissão). O servidor tirava a pessoa da sala, mas o
// navegador achava que continuava conectado e nunca tentava voltar — só fechando
// e abrindo o site. Agora:
//  - a cada 5s o site manda um "ping" e o servidor responde; sem resposta em 20s,
//    a conexão é considerada morta e refeita na hora;
//  - as tentativas seguem com espera crescente (1s, 2s, 4s… até 10s), sem desistir;
//  - ao voltar, reabre sozinho as telas que a pessoa estava assistindo.
const NET = { attempt: 0, timer: 0, lastMsg: 0, openedAt: 0 };

function connect() {
  clearTimeout(NET.timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  NET.openedAt = Date.now();
  ws.onopen = () => {
    NET.lastMsg = Date.now();
    send({ t: 'join', room: S.room, nick: S.nick, device: DEVICE_ID });
  };
  ws.onmessage = (e) => {
    NET.lastMsg = Date.now();
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handle(m).catch((err) => console.warn(err));
  };
  ws.onclose = () => {
    if (S.ws === ws && !S.leaving) connectionLost();
  };
}

function connectionLost() {
  const old = S.ws;
  S.ws = null;
  if (old) {
    old.onclose = null;
    old.onmessage = null;
    try { old.close(); } catch {}
  }
  if (S.leaving || !S.room) return;
  if (NET.attempt === 0) {
    // As conexões de vídeo NÃO são fechadas: elas vão direto entre os navegadores
    // e costumam continuar funcionando enquanto a conexão com o servidor volta.
    S.reconnecting = true;
    setNetBanner(true);
  }
  const delay = Math.min(10000, 1000 * 2 ** NET.attempt);
  NET.attempt++;
  clearTimeout(NET.timer);
  NET.timer = setTimeout(() => { if (!S.leaving && S.room) connect(); }, delay);
}

// Reconecta já, sem esperar a próxima tentativa (internet voltou / voltou para a guia)
function reconnectNow() {
  if (S.leaving || !S.room) return;
  if (S.ws && S.ws.readyState === 1 && Date.now() - NET.lastMsg < 20000) return;
  clearTimeout(NET.timer);
  if (S.ws) connectionLost();
  clearTimeout(NET.timer);
  connect();
}

setInterval(() => {
  if (!S.ws || S.leaving) return;
  if (S.ws.readyState === 1) {
    send({ t: 'ping' });
    if (Date.now() - NET.lastMsg > 20000) connectionLost(); // morreu em silêncio
  } else if (S.ws.readyState === 0 && Date.now() - NET.openedAt > 10000) {
    connectionLost(); // travou tentando conectar
  }
}, 5000);

window.addEventListener('online', reconnectNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });

function setNetBanner(on) {
  let b = $('#netBanner');
  if (on && !b) {
    b = document.createElement('div');
    b.id = 'netBanner';
    b.className = 'net-banner';
    b.innerHTML = '<span class="net-spin"></span>Conexão perdida. Reconectando…';
    document.body.appendChild(b);
  } else if (!on && b) b.remove();
}

function resetConnections() {
  // guarda o que estava assistindo para reabrir sozinho ao reconectar
  S.rewatch = S.watched.slice();
  for (const key of [...S.pcs.keys()]) closePc(key);
  S.peers.clear();
  rxReports.clear();
  render();
}

// Quem caiu e voltou ganha outro id. Se eu assistia a tela dessa pessoa, volto a
// assistir sozinho quando ela reaparecer transmitindo.
const pendingRewatch = new Map(); // id antigo -> quando saiu
const autoWatch = new Set(); // id novo -> reabrir quando estiver ao vivo
const rewatchNicks = new Map(); // servidor reiniciou: nome de quem eu assistia -> quando

function rewatchIfNeeded(p) {
  if (!p.live) return;
  if (autoWatch.has(p.id)) {
    autoWatch.delete(p.id);
    if (!S.watched.includes(p.id)) {
      S.watched.push(p.id);
      while (S.watched.length > MAX_WATCH) {
        const drop = S.watched.shift();
        if (drop !== S.me) dropSub('screen', drop, true);
      }
    }
  }
  if (S.watched.includes(p.id) && !S.pcs.has(subKey('screen', p.id))) subscribe('screen', p.id);
}

async function handle(m) {
  switch (m.t) {
    case 'pong':
      break;
    case 'joined': {
      const back = S.reconnecting;
      S.reconnecting = false;
      NET.attempt = 0;
      setNetBanner(false);

      if (m.resumed && m.id === S.me) {
        // Voltou para a MESMA vaga: as conexões de vídeo continuaram funcionando
        // durante a queda; só atualiza quem está na sala e fecha o que sumiu.
        S.peers.clear();
        for (const p of m.peers) S.peers.set(p.id, p);
        for (const [k, en] of [...S.pcs]) {
          if (!S.pcs.has(k)) continue;
          if (en.role === 'sub' && !S.peers.has(en.o)) dropSub(en.kind, en.o, false);
          else if (en.role === 'sub' && en.peer !== en.o && !S.peers.has(en.peer)) resubscribe(en.kind, en.o, 300);
          else if (en.role === 'pub' && !S.peers.has(en.peer)) closePc(k);
        }
        S.watched = S.watched.filter((id) => (id === S.me ? S.self.live : (S.peers.get(id) || {}).live));
        for (const id of S.watched) if (id !== S.me && !S.pcs.has(subKey('screen', id))) subscribe('screen', id);
        if (back) toast('Reconectado!');
        pushState();
        render();
        break;
      }

      // Entrada nova (ou voltou com outro id): recomeça as conexões de vídeo
      const prevMe = S.me;
      // Se o servidor reiniciou, todo mundo ganha id novo: guarda os NOMES de quem
      // eu assistia para reabrir essas telas quando as pessoas reaparecerem.
      const oldNicks = back
        ? S.watched.filter((id) => id !== S.me).map((id) => (S.peers.get(id) || {}).nick).filter(Boolean)
        : [];
      if (back) {
        S.rewatch = S.watched.slice();
        for (const k of [...S.pcs.keys()]) closePc(k);
        rxReports.clear();
      }
      S.me = m.id;
      S.peers.clear();
      for (const p of m.peers) S.peers.set(p.id, p);
      // reabre as telas que estava assistindo antes de cair
      const rewatch = (S.rewatch || S.watched).map((id) => (id === prevMe ? S.me : id));
      S.rewatch = null;
      S.watched = rewatch.filter((id) => (id === S.me ? S.self.live : (S.peers.get(id) || {}).live));
      if (S.focus === prevMe) S.focus = S.me;
      if (!$('#msgs .msg, #msgs .sys')) for (const msg of m.chat) addChat(msg, true);
      if (back) toast('Reconectado!');
      else sysMsg(`Você entrou na sala <b>${esc(S.room)}</b>`);
      pushState();
      for (const id of S.watched) if (id !== S.me) subscribe('screen', id);
      for (const nick of oldNicks) {
        const p = [...S.peers.values()].find((x) => x.nick === nick);
        if (p && !S.watched.includes(p.id)) { autoWatch.add(p.id); rewatchIfNeeded(p); }
        else if (!p) rewatchNicks.set(nick, Date.now());
      }
      render();
      break;
    }
    case 'error':
      toast(m.msg || 'Erro');
      if (m.fatal) leaveRoom();
      break;
    case 'peer-join': {
      S.peers.set(m.peer.id, m.peer);
      if (m.prev && pendingRewatch.has(m.prev)) {
        pendingRewatch.delete(m.prev);
        autoWatch.add(m.peer.id);
        if (S.focus === m.prev) S.focus = m.peer.id;
      }
      const t0 = rewatchNicks.get(m.peer.nick);
      if (t0) {
        rewatchNicks.delete(m.peer.nick);
        if (Date.now() - t0 < 120000) autoWatch.add(m.peer.id);
      }
      if (!m.rejoin) sysMsg(`<b>${esc(m.peer.nick)}</b> entrou na sala`);
      rewatchIfNeeded(m.peer);
      render();
      break;
    }
    case 'peer-state': {
      const p = m.peer;
      const prev = S.peers.get(p.id);
      if (!prev) return;
      S.peers.set(p.id, p);
      if (!prev.live && p.live) sysMsg(`<b>${esc(p.nick)}</b> começou a transmitir`, true);
      if (prev.live && !p.live) {
        dropSub('screen', p.id, false);
        S.watched = S.watched.filter((id) => id !== p.id);
        sysMsg(`<b>${esc(p.nick)}</b> parou de transmitir`);
      }
      rewatchIfNeeded(p);
      render();
      break;
    }
    case 'peer-leave': {
      const p = S.peers.get(m.id);
      // saída "silenciosa" = caiu e está voltando: lembra se eu assistia
      if (m.quiet && S.watched.includes(m.id)) pendingRewatch.set(m.id, Date.now());
      for (const [id, t] of pendingRewatch) if (Date.now() - t > 120000) pendingRewatch.delete(id);
      S.peers.delete(m.id);
      S.watched = S.watched.filter((id) => id !== m.id);
      rxReports.delete(m.id);
      for (const [k, en] of [...S.pcs]) {
        if (!S.pcs.has(k)) continue;
        if (en.role === 'sub' && en.o === m.id) dropSub(en.kind, en.o, false); // origem saiu
        else if (en.role === 'sub' && en.peer === m.id) resubscribe(en.kind, en.o, 300 + Math.random() * 500); // retransmissor saiu
        else if (en.role === 'pub' && en.peer === m.id) closePc(k);
      }
      if (p && !m.quiet) sysMsg(`<b>${esc(p.nick)}</b> saiu da sala`);
      render();
      break;
    }
    case 'chat':
      addChat(m.msg);
      break;
    case 'relay':
      await onSignal(m.from, m.data);
      break;
  }
}

// ------------------------------------------------------------------ WebRTC
// Quem transmite atende até ORIGIN_DIRECT espectadores direto, dividindo o
// upload entre eles (UPLOAD_BUDGET) para não saturar a conexão. Só a partir daí
// entra a retransmissão: um espectador de PC repassa para até RELAY_CAP outros.
// Retransmitir obriga a decodificar e codificar de novo, por isso é o último
// recurso e celulares nunca retransmitem.
//
// Chaves: sub:<tipo>:<origem>              → o que eu recebo (de quem quer que seja)
//         pub:<tipo>:<origem>:<espectador> → o que eu envio/repasso
const ORIGIN_DIRECT = 5;
const UPLOAD_BUDGET = 16_000_000;
const MIN_SCREEN_BR = 1_500_000;
const RELAY_CAP = 2;
const RELAY_BR_MAX = 3_000_000;
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
const subKey = (kind, o) => `sub:${kind}:${o}`;
const pubKey = (kind, o, viewer) => `pub:${kind}:${o}:${viewer}`;
const rid = () => Math.random().toString(36).slice(2, 10);

function closePc(k) {
  const en = S.pcs.get(k);
  if (!en) return;
  S.pcs.delete(k);
  try { en.pc.close(); } catch {}
  // saiu um espectador da minha tela: os que ficaram ganham mais banda
  if (en.role === 'pub' && en.kind === 'screen' && en.o === S.me) setTimeout(retuneOwnScreen, 0);
}

// Taxa de bits de cada cópia da tela de `o` que eu envio
function screenBitrate(o) {
  const q = qualityOf(o);
  const full = QUALITY[q.res].br[q.fps];
  if (o !== S.me) return Math.min(full, RELAY_BR_MAX);
  const n = Math.max(1, children('screen', S.me).length);
  return Math.max(MIN_SCREEN_BR, Math.min(full, Math.floor(UPLOAD_BUDGET / n)));
}

// O WebRTC começa a ~300 kbps e sobe aos poucos (a imagem ficava ~15s em 540p).
// Começa já em 3 Mbps: em teste deu 720p a 59fps desde o 1º segundo, subindo
// para 1080p depois. Começar na taxa máxima (7 Mbps por pessoa) estourava o
// upload de internet real: o 1º quadro chegava quebrado e a tela ficava "carregando".
function fastStart(sdp, maxBps) {
  const kbps = Math.round(Math.min(maxBps, 3_000_000) / 1000);
  const extra = `x-google-start-bitrate=${kbps}`;
  const lines = sdp.split('\r\n');
  const pts = new Set();
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i.exec(l);
    if (m) pts.add(m[1]);
  }
  const hasFmtp = new Set();
  const out = lines.map((l) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (m && pts.has(m[1]) && !m[2].includes('x-google-start-bitrate')) {
      hasFmtp.add(m[1]);
      return `${l};${extra}`;
    }
    return l;
  });
  const final = [];
  for (const l of out) {
    final.push(l);
    const m = /^a=rtpmap:(\d+) /.exec(l);
    if (m && pts.has(m[1]) && !hasFmtp.has(m[1])) final.push(`a=fmtp:${m[1]} ${extra}`);
  }
  return final.join('\r\n');
}

function retuneOwnScreen() {
  for (const en of children('screen', S.me)) en.pc.getSenders().forEach((s) => tuneSender(s, 'screen', S.me));
}

function qualityOf(o) {
  if (o === S.me) return S.quality;
  const m = /^(\d+)p (\d+)fps$/.exec((S.peers.get(o) || {}).q || '');
  return m && QUALITY[m[1]] ? { res: m[1], fps: Number(m[2]) } : { res: '720', fps: 30 };
}

function preferCodecs(transceiver) {
  // H.264 primeiro (geralmente codificado/decodificado por hardware = menos CPU)
  if (!window.RTCRtpSender || !RTCRtpSender.getCapabilities || !transceiver.setCodecPreferences) return;
  try {
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps) return;
    // VP8 primeiro: testado no Chrome com placa AMD, o codificador H.264 por hardware
    // acumulava atraso (até 88 ms por quadro) e derrubava a transmissão para 11-16fps.
    // O VP8 manteve 58-60fps estáveis a ~5 ms por quadro e é leve de decodificar
    // para quem assiste (inclusive celular). H.264 fica só como último recurso.
    const order = ['video/vp8', 'video/vp9', 'video/h264'];
    const rank = (c) => {
      const i = order.indexOf(c.mimeType.toLowerCase());
      return i < 0 ? order.length : i;
    };
    const codecs = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
    transceiver.setCodecPreferences(codecs);
  } catch {}
}

async function tuneSender(sender, kind, o) {
  if (!sender.track) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  const enc = p.encodings[0];
  if (sender.track.kind === 'audio') {
    enc.maxBitrate = 128_000;
  } else if (kind === 'screen') {
    const q = qualityOf(o);
    enc.maxBitrate = screenBitrate(o);
    enc.maxFramerate = q.fps;
    enc.scaleResolutionDownBy = 1;
    enc.priority = 'high';
    enc.networkPriority = 'high';
    // Fluidez em primeiro lugar: se apertar, reduz a nitidez, nunca os quadros
    p.degradationPreference = 'maintain-framerate';
  } else {
    enc.maxBitrate = CAM.br;
    enc.maxFramerate = CAM.fps;
    p.degradationPreference = 'balanced';
  }
  try {
    await sender.setParameters(p);
  } catch {
    // Alguns navegadores não aceitam degradationPreference: tenta sem
    try { delete p.degradationPreference; await sender.setParameters(p); } catch {}
  }
}

function children(kind, o) {
  return [...S.pcs.values()].filter((en) => en.role === 'pub' && en.kind === kind && en.o === o);
}

function wanted(kind, o) {
  const p = S.peers.get(o);
  if (!p) return false;
  return kind === 'screen' ? p.live && S.watched.includes(o) : p.cam && camsVisible();
}

// Câmeras só aparecem no palco (ninguém transmitindo) ou na fileira de membros.
// Fora disso não são recebidas: cada câmera recebida é um vídeo a mais sendo
// decodificado, gastando processador e memória sem ninguém ver.
function camsVisible() { return !liveIds().length || S.showMembers; }

function syncCams() {
  for (const p of S.peers.values()) {
    const want = wanted('cam', p.id);
    const has = S.pcs.has(subKey('cam', p.id));
    if (want && !has) subscribe('cam', p.id);
    else if (!want && has) dropSub('cam', p.id, true);
  }
}

// Lado de quem ASSISTE: pede a transmissão de `o` (direto ou via um retransmissor)
function subscribe(kind, o, via = o) {
  const k = subKey(kind, o);
  if (S.pcs.has(k)) return;
  const pc = new RTCPeerConnection(S.rtc);
  const sid = rid();
  const en = { pc, kind, o, peer: via, role: 'sub', sid, stream: null, q: [], waiters: [], t0: performance.now() };
  S.pcs.set(k, en);
  pc.ontrack = (e) => {
    // Pequeno buffer de reprodução: absorve oscilações da rede em vez de engasgar
    try { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = kind === 'screen' ? 120 : 60; } catch {}
    if (!en.stream) en.stream = e.streams[0] || new MediaStream();
    if (!en.stream.getTracks().includes(e.track)) en.stream.addTrack(e.track);
    // atende quem estava esperando eu receber a imagem (após todas as faixas chegarem)
    setTimeout(() => en.waiters.splice(0).forEach((fn) => fn()), 0);
    renderStage();
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) relay(via, { k: 'ice', kind, o, sid, from: 'sub', c: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (S.pcs.get(k) !== en) return;
    if (pc.connectionState === 'failed') resubscribe(kind, o, 300);
    // Caiu: se não voltar sozinha em 3s, refaz a conexão (não espera o "failed", que leva ~30s)
    if (pc.connectionState === 'disconnected') {
      setTimeout(() => {
        if (S.pcs.get(k) !== en || pc.connectionState !== 'disconnected' || !wanted(kind, o)) return;
        if (kind === 'screen') subTries.set(o, (subTries.get(o) || 0) + 1);
        resubscribe(kind, o, 200);
      }, 3000);
    }
  };
  // Sem imagem em 12s: recomeça pela origem (desfaz qualquer corrente travada)
  setTimeout(() => {
    if (S.pcs.get(k) === en && !en.stream) resubscribe(kind, o, Math.random() * 1000);
  }, 12000);
  relay(via, { k: 'sub', kind, o, sid });
}

// Para de receber `o` e avisa quem recebia de mim, para que reconectem pela origem
function dropSub(kind, o, sendUnsub) {
  const k = subKey(kind, o);
  const en = S.pcs.get(k);
  if (en) {
    closePc(k);
    if (sendUnsub) relay(en.peer, { k: 'unsub', kind, o, sid: en.sid });
  }
  for (const c of children(kind, o)) {
    relay(c.peer, { k: 'nostream', kind, o, sid: c.sid });
    closePc(pubKey(kind, o, c.peer));
  }
}

function resubscribe(kind, o, delay) {
  dropSub(kind, o, true);
  setTimeout(() => {
    if (wanted(kind, o)) subscribe(kind, o);
    renderStage();
  }, delay);
}

// Lado de quem TRANSMITE ou RETRANSMITE: atende, ou indica outro espectador se estiver cheio
async function onSubRequest(kind, o, viewer, sid) {
  let stream = null;
  if (o === S.me) {
    stream = kind === 'screen' ? S.screenStream : S.camStream;
  } else if (kind === 'screen') {
    const up = S.pcs.get(subKey(kind, o));
    if (up && !up.stream) {
      up.waiters.push(() => onSubRequest(kind, o, viewer, sid));
      return;
    }
    stream = up ? up.stream : null;
  }
  if (!stream || !stream.getVideoTracks().some((t) => t.readyState === 'live')) {
    return relay(viewer, { k: 'nostream', kind, o, sid });
  }

  closePc(pubKey(kind, o, viewer));
  const kids = children(kind, o);
  const cap = kind === 'cam' ? Infinity : o === S.me ? ORIGIN_DIRECT : RELAY_CAP;
  if (kids.length >= cap) {
    // Só indica quem pode retransmitir (PC, não celular). Se ninguém puder, atende direto.
    const able = kids.filter((c) => (S.peers.get(c.peer) || {}).relay !== false);
    if (able.length) {
      const target = able.sort((a, b) => a.redirects - b.redirects)[0];
      target.redirects++;
      return relay(viewer, { k: 'redirect', kind, o, sid, via: target.peer });
    }
  }
  await publish(kind, o, viewer, sid, stream);
}

async function publish(kind, o, viewer, sid, stream) {
  const k = pubKey(kind, o, viewer);
  const pc = new RTCPeerConnection(S.rtc);
  const en = { pc, kind, o, peer: viewer, role: 'pub', sid, q: [], redirects: 0 };
  S.pcs.set(k, en);

  for (const track of stream.getTracks()) {
    if (track.readyState !== 'live') continue;
    const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    if (track.kind === 'video') preferCodecs(tr);
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) relay(viewer, { k: 'ice', kind, o, sid, from: 'pub', c: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (S.pcs.get(k) !== en) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePc(k);
  };

  const offer = await pc.createOffer();
  if (S.pcs.get(k) !== en) return;
  await pc.setLocalDescription(offer);
  // Minha tela: redistribui a banda entre todos os espectadores diretos
  if (kind === 'screen' && o === S.me) retuneOwnScreen();
  else for (const s of pc.getSenders()) tuneSender(s, kind, o);
  relay(viewer, { k: 'offer', kind, o, sid, sdp: pc.localDescription.toJSON() });
}

async function flushIce(en) {
  for (const c of en.q.splice(0)) {
    try { await en.pc.addIceCandidate(c); } catch {}
  }
}

async function onSignal(from, d) {
  if (!d || (d.kind !== 'screen' && d.kind !== 'cam') || typeof d.o !== 'string') return;
  const { kind, o, sid } = d;
  // conexão de recebimento válida: mesma sessão e vinda de quem me atende
  const mySub = () => {
    const en = S.pcs.get(subKey(kind, o));
    return en && en.sid === sid && en.peer === from ? en : null;
  };
  const myPub = () => {
    const en = S.pcs.get(pubKey(kind, o, from));
    return en && en.sid === sid ? en : null;
  };
  switch (d.k) {
    case 'rx': {
      // um amigo contando o que recebe da minha tela (para a minha prévia imitar)
      if (o !== S.me || !S.peers.has(from)) return;
      const num = (x, max) => Math.max(0, Math.min(max, Number(x) || 0));
      const prev = rxReports.get(from);
      const frz = num(d.frz, 1e6);
      rxReports.set(from, { fps: num(d.fps, 240), h: num(d.h, 4320), frz, frzNew: prev ? Math.max(0, frz - prev.frz) : 0, at: Date.now() });
      return;
    }
    case 'sub':
      await onSubRequest(kind, o, from, sid);
      break;
    case 'unsub':
      if (myPub()) closePc(pubKey(kind, o, from));
      break;
    case 'redirect': {
      if (!mySub()) return;
      dropSub(kind, o, false);
      const loop = d.via === S.me || d.via === o || !S.peers.has(d.via);
      if (loop) resubscribe(kind, o, 800);
      else subscribe(kind, o, d.via);
      break;
    }
    case 'nostream': {
      if (!mySub()) return;
      dropSub(kind, o, false);
      if (from === o) {
        if (kind === 'screen') S.watched = S.watched.filter((id) => id !== o);
        render();
      } else {
        // o retransmissor perdeu a imagem: volto a pedir pela origem
        resubscribe(kind, o, 300 + Math.random() * 500);
      }
      break;
    }
    case 'offer': {
      const en = mySub();
      if (!en) return;
      await en.pc.setRemoteDescription(d.sdp);
      await flushIce(en);
      const answer = await en.pc.createAnswer();
      await en.pc.setLocalDescription(answer);
      relay(from, { k: 'answer', kind, o, sid, sdp: en.pc.localDescription.toJSON() });
      break;
    }
    case 'answer': {
      const en = myPub();
      if (!en) return;
      if (kind === 'screen') d.sdp.sdp = fastStart(d.sdp.sdp, screenBitrate(o));
      await en.pc.setRemoteDescription(d.sdp);
      await flushIce(en);
      break;
    }
    case 'ice': {
      const en = d.from === 'pub' ? mySub() : myPub();
      if (!en) return;
      if (en.pc.remoteDescription) {
        try { await en.pc.addIceCandidate(d.c); } catch {}
      } else en.q.push(d.c);
      break;
    }
  }
}

// Quem está assistindo cada pessoa (cada um informa o que assiste no próprio estado)
function viewersOf(id) {
  let n = 0;
  for (const p of S.peers.values()) if (p.id !== id && (p.watching || []).includes(id)) n++;
  if (id !== S.me && S.watched.includes(id)) n++;
  return n;
}

function closeOwnPub(kind) {
  for (const [k, en] of [...S.pcs]) if (en.role === 'pub' && en.kind === kind && en.o === S.me) closePc(k);
}

// -------------------------------------------------------- tela (Go Live)
function captureConstraints() {
  const q = QUALITY[S.quality.res];
  const fps = S.quality.fps;
  return {
    width: { ideal: q.w, max: q.w },
    height: { ideal: q.h, max: q.h },
    frameRate: { ideal: fps, max: fps },
  };
}
function qualityLabel() { return `${S.quality.res}p ${S.quality.fps}fps`; }

async function startLive() {
  if (!canShare) return toast('Seu navegador não permite compartilhar a tela (use Chrome, Edge ou Firefox no PC).');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: captureConstraints(),
      audio: S.quality.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      // Tela inteira: som do PC. Janela: SÓ o som daquela janela/programa
      // (Chrome 141+). Sem windowAudio, ao escolher uma janela o Chrome
      // oferecia o som do sistema inteiro.
      systemAudio: 'include',
      windowAudio: 'window',
      monitorTypeSurfaces: 'include',
    });
  } catch (err) {
    if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast('Não foi possível compartilhar a tela.');
    return;
  }
  const old = S.screenStream;
  S.screenStream = stream;
  setupScreenTrack(stream);
  checkShareAudio(stream);

  if (old) {
    // Troca de tela durante a transmissão: substitui as faixas sem derrubar quem assiste
    for (const en of S.pcs.values()) {
      if (en.role !== 'pub' || en.kind !== 'screen' || en.o !== S.me) continue;
      for (const sender of en.pc.getSenders()) {
        if (!sender.track) continue;
        const nt = stream.getTracks().find((t) => t.kind === sender.track.kind);
        if (nt) sender.replaceTrack(nt).then(() => tuneSender(sender, 'screen', S.me)).catch(() => {});
      }
    }
    old.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    dropPreview();
  }
  // A prévia da própria tela NÃO abre sozinha: com a tela inteira ela vira um
  // "espelho infinito" que sobrecarrega a GPU e trava o Alt+Tab do Windows.
  S.self.live = true;
  S.self.q = qualityLabel();
  pushState();
  render();
}

// Avisa o que aconteceu com o som ao transmitir uma janela
function checkShareAudio(stream) {
  const v = stream.getVideoTracks()[0];
  const a = stream.getAudioTracks()[0];
  const surface = v && v.getSettings ? v.getSettings().displaySurface : '';
  S.shareAudioLabel = a ? a.label || 'audio' : '';
  if (!S.quality.audio || surface !== 'window') return;
  if (!a) {
    toast('O som desta janela não foi incluído. Marque "Compartilhar áudio" na janela do navegador; se a opção não aparecer, este navegador ainda não transmite o som de janelas — use uma guia ou a Tela inteira.', 9000);
  } else if (/system|sistema/i.test(a.label)) {
    toast('Atenção: o navegador está enviando o som do PC inteiro, não só desta janela.', 7000);
  }
}

function setupScreenTrack(stream) {
  const v = stream.getVideoTracks()[0];
  if (!v) return;
  // "motion" em qualquer fps: prioriza fluidez. Em "detail" o codificador
  // descarta quadros para manter o texto nítido, o que parece travamento.
  try { v.contentHint = 'motion'; } catch {}
  v.onended = () => { if (S.screenStream === stream) stopLive(); };
}

async function applyQuality() {
  const v = S.screenStream && S.screenStream.getVideoTracks()[0];
  if (!v) return;
  try { await v.applyConstraints(captureConstraints()); } catch {}
  try { v.contentHint = 'motion'; } catch {}
  for (const en of S.pcs.values()) {
    if (en.role === 'pub' && en.kind === 'screen' && en.o === S.me) en.pc.getSenders().forEach((s) => tuneSender(s, 'screen', S.me));
  }
  // a prévia acompanha o novo fps
  dropPreview();
  S.self.q = qualityLabel();
  pushState();
  render();
  toast(`Qualidade alterada para ${qualityLabel()}`);
}

function stopLive() {
  if (!S.screenStream) return;
  closeOwnPub('screen');
  S.screenStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  S.screenStream = null;
  dropPreview();
  S.watched = S.watched.filter((id) => id !== S.me);
  S.self.live = false;
  S.self.q = '';
  pushState();
  render();
}

// ---------------------------------------------------------------- câmera
async function toggleCam() {
  if (S.camStream) {
    closeOwnPub('cam');
    S.camStream.getTracks().forEach((t) => t.stop());
    S.camStream = null;
    S.self.cam = false;
    pushState();
    return render();
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Câmera indisponível neste navegador.');
  try {
    // Somente vídeo: o microfone nunca é solicitado
    S.camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: CAM.w }, height: { ideal: CAM.h }, frameRate: { ideal: CAM.fps, max: 30 } },
      audio: false,
    });
  } catch {
    return toast('Não foi possível acessar a câmera.');
  }
  const v = S.camStream.getVideoTracks()[0];
  if (v) {
    try { v.contentHint = 'motion'; } catch {}
    v.onended = () => { if (S.camStream) toggleCam(); };
  }
  S.self.cam = true;
  pushState();
  render();
}

// -------------------------------------------------------------- assistir
function info(id) {
  if (id === S.me) return { id, nick: S.nick, me: true, ...S.self };
  return S.peers.get(id);
}
function isLive(id) { const p = info(id); return !!(p && p.live); }
function liveIds() { return participants().filter((p) => p.live).map((p) => p.id); }
function participants() {
  const list = S.me ? [info(S.me)] : [];
  return list.concat([...S.peers.values()]);
}

function watch(id, simultaneous) {
  if (!isLive(id)) return;
  if (id === S.me) {
    const v = S.screenStream && S.screenStream.getVideoTracks()[0];
    const surface = v && v.getSettings ? v.getSettings().displaySurface : '';
    if (surface === 'monitor') toast('Você está transmitindo a tela inteira: a prévia aparece dentro da própria transmissão (efeito espelho).', 5000);
  }
  if (!simultaneous) {
    for (const w of S.watched) if (w !== id && w !== S.me) dropSub('screen', w, true);
    S.watched = [id];
  } else if (!S.watched.includes(id)) {
    // lado a lado; passando do limite, sai a tela aberta há mais tempo
    S.watched.push(id);
    while (S.watched.length > MAX_WATCH) {
      const drop = S.watched.shift();
      if (drop !== S.me) dropSub('screen', drop, true);
    }
  }
  for (const w of S.watched) if (w !== S.me) subscribe('screen', w);
  render();
}

// Com 2 telas abertas, uma pode ocupar o palco inteiro (a outra segue conectada,
// então "Ver as duas telas" volta na hora, sem recarregar)
function setFocus(id) {
  S.focus = id;
  render();
}

function unwatch(id) {
  if (S.focus === id) S.focus = null;
  subTries.delete(id);
  S.watched = S.watched.filter((x) => x !== id);
  if (id !== S.me) dropSub('screen', id, true);
  render();
}

// ---------------------------------------------------------------- render
function render() {
  if (!S.room) return;
  S.watched = S.watched.filter(isLive);
  if (S.ws && S.watched.filter((id) => id !== S.me).join(',') !== S.sentWatching) pushState();
  if (S.me) syncCams();
  renderMembers();
  renderStage();
  renderControls();
}

function actionButtons(id) {
  const p = info(id);
  if (!p || !p.live) return '';
  const watching = S.watched.includes(id);
  if (p.me) {
    return (watching
      ? `<button class="mini" data-act="unwatch" data-id="${id}">Ocultar prévia</button>`
      : `<button class="mini" data-act="watch" data-id="${id}">Ver prévia</button>`) +
      `<button class="mini outline" data-act="stoplive">Parar transmissão</button>`;
  }
  if (watching) return `<button class="mini" data-act="unwatch" data-id="${id}">Parar de assistir</button>`;
  let h = `<button class="mini red" data-act="watch" data-id="${id}">Assistir agora</button>`;
  if (S.watched.length && S.watched.length < MAX_WATCH) h += `<button class="mini outline" data-act="watchadd" data-id="${id}">Assistir simultaneamente</button>`;
  return h;
}

// Botões do aviso "alguém está compartilhando" (quando a tela ainda não está aberta)
function noticeButtons(id) {
  const p = info(id);
  const n = S.watched.length;
  if (p.me) {
    return `<button class="btn primary" data-act="watchauto" data-id="${id}">${icon('eye')}<span>Ver minha prévia</span></button>
      <button class="n-alt" data-act="stoplive">Parar transmissão</button>`;
  }
  if (n === 0) return `<button class="btn primary" data-act="watch" data-id="${id}">${icon('play')}<span>Assistir</span></button>`;
  if (n < MAX_WATCH) {
    return `<button class="btn primary" data-act="watchadd" data-id="${id}">${icon('layers')}<span>Assistir simultaneamente</span></button>
      <button class="n-alt" data-act="watch" data-id="${id}">ou assistir só esta</button>`;
  }
  const oldest = info(S.watched[0]);
  return `<button class="btn primary" data-act="watchadd" data-id="${id}">${icon('play')}<span>Assistir</span></button>
    <span class="n-hint">Limite de 2 telas: substitui a de ${esc(oldest ? oldest.nick : 'outra pessoa')}</span>`;
}

function renderMembers() {
  const html = participants().map((p) => {
    const icons = [];
    if (p.cam) icons.push(icon('cam'));
    if (p.live) {
      icons.push(`<span class="m-views" title="Assistindo">${icon('eye')}${viewersOf(p.id)}</span>`);
      icons.push('<span class="live-badge">AO VIVO</span>');
    }
    const acts = actionButtons(p.id);
    return `<li class="member${p.me ? ' me' : ''}${p.live ? ' live' : ''}" tabindex="0">
      <div class="m-row">${avatarHTML(p.nick, 'avatar', p.live)}<span class="m-nick" title="${esc(p.nick)}">${esc(p.nick)}${p.me ? ' (você)' : ''}</span><span class="m-icons">${icons.join('')}</span></div>
      ${acts ? `<div class="m-actions">${acts}</div>` : ''}
    </li>`;
  }).join('');
  const ul = $('#members');
  if (ul._html !== html) { ul.innerHTML = html; ul._html = html; }

  const n = participants().length;
  $('#headInfo').textContent = `${n} ${n === 1 ? 'pessoa' : 'pessoas'} na sala`;
  const st = $('#meStatus');
  const cap = liveHealth.capture != null ? ` · captura ${liveHealth.capture}fps` : '';
  st.textContent = S.self.live ? `${S.self.q}${cap} · ${viewersOf(S.me)} assistindo` : 'Online';
  // No lugar de microfone/fone/engrenagem: selo "Ao vivo" só quando transmitindo
  $('#meLive').hidden = !S.self.live;
}

// =============================================================== monitor único
// Um único ciclo de 2s lê as estatísticas de cada conexão UMA vez e alimenta tudo:
// indicador de fps, vigia de quem assiste, saúde da captura, prévia sincronizada,
// recuperação de qualidade (10s) e diagnóstico (6s). Antes eram 4 timers, cada um
// lendo as mesmas estatísticas de novo — mais processamento e mais lixo na memória.
const subTries = new Map(); // tentativas seguidas de abrir a tela de alguém sem imagem
const liveHealth = { capture: null, low: 0, slow: 0, slowWarned: false, warnedAt: 0, last: null };
const rxReports = new Map(); // espectador -> o que ele está recebendo da MINHA tela
const diagPrev = new WeakMap();
let monitorTick = 0;

// Extrai de um relatório só o que usamos
function pickStats(report) {
  const st = { rtp: null, src: null, pair: null, codec: null, conn: null };
  report.forEach((x) => {
    if (x.kind === 'video' && (x.type === 'outbound-rtp' || x.type === 'inbound-rtp')) st.rtp = x;
    else if (x.type === 'media-source' && x.kind === 'video') st.src = x;
    else if (x.type === 'transport' && x.selectedCandidatePairId) st.pair = report.get(x.selectedCandidatePairId);
  });
  if (st.rtp && st.rtp.codecId) st.codec = (report.get(st.rtp.codecId) || {}).mimeType;
  if (st.pair) {
    const l = report.get(st.pair.localCandidateId);
    const r = report.get(st.pair.remoteCandidateId);
    st.conn = `${l ? l.candidateType : '?'}/${r ? r.candidateType : '?'}`; // relay = passou pelo TURN
  }
  return st;
}

setInterval(async () => {
  monitorTick++;
  const list = [...S.pcs.values()];
  await Promise.all(list.map(async (en) => {
    try { en.st = pickStats(await en.pc.getStats()); } catch {}
  }));
  watchViewers();
  checkMyCapture();
  if (monitorTick % 5 === 0) recoverQuality();
  if (monitorTick % 3 === 0) sendDiag();
}, 2000);

// ---- quem assiste: indicador, vigia de "carregando" e relatório para quem transmite
//  - nenhuma imagem em 8s desde que pediu a tela → refaz a conexão (vem imagem nova)
//  - conexão caída por mais de 6s → refaz (reserva; o normal é o aviso de 3s em subscribe)
//  Não dá para usar "parou de chegar pacote": com a tela parada nenhum pacote chega.
function watchViewers() {
  const now = performance.now();
  for (const en of [...S.pcs.values()]) {
    if (en.role !== 'sub' || en.kind !== 'screen' || !en.st) continue;
    if (S.pcs.get(subKey('screen', en.o)) !== en) continue;
    const inb = en.st.rtp;
    if (inb && inb.frameHeight) en.stat = `${inb.frameHeight}p · ${Math.round(inb.framesPerSecond || 0)}fps`;
    const decoded = inb ? inb.framesDecoded || 0 : 0;
    if (decoded > 0 && subTries.has(en.o)) { subTries.delete(en.o); renderStage(); }

    let restart = decoded === 0 && now - en.t0 > 8000;
    if (en.pc.connectionState === 'disconnected') {
      if (!en.discSince) en.discSince = now;
      if (now - en.discSince > 6000) restart = true;
    } else en.discSince = 0;
    if (restart && wanted('screen', en.o)) {
      subTries.set(en.o, (subTries.get(en.o) || 0) + 1);
      resubscribe('screen', en.o, 200);
      continue;
    }
    // Conta ao dono da tela o que estou recebendo: a prévia dele imita isso
    if (decoded > 0) {
      relay(en.o, { k: 'rx', kind: 'screen', o: en.o, fps: Math.round(inb.framesPerSecond || 0), h: inb.frameHeight || 0, frz: inb.freezeCount || 0 });
    }
    const t = tiles.get(`s:${en.o}`);
    if (t) showStat(t, en.o);
  }
}

// ---- quem transmite: saúde da captura + prévia igual à dos amigos
// Testado: ao transmitir uma JANELA coberta ou minimizada, o Windows/o programa
// para de desenhá-la e a captura cai para ~1fps (parece congelado).
function checkMyCapture() {
  const v = S.screenStream && S.screenStream.getVideoTracks()[0];
  if (!v) {
    Object.assign(liveHealth, { capture: null, low: 0, slow: 0, slowWarned: false, last: null });
    rxReports.clear();
    return;
  }
  let fps = null;
  const en = children('screen', S.me)[0];
  if (en && en.st && en.st.src && en.st.src.framesPerSecond != null) fps = en.st.src.framesPerSecond;
  if (fps == null && v.stats && typeof v.stats.totalFrames === 'number') {
    // ninguém assistindo: usa o contador do próprio track (Chrome)
    const now = { t: performance.now(), n: v.stats.totalFrames };
    if (liveHealth.last) fps = Math.round(((now.n - liveHealth.last.n) * 1000) / (now.t - liveHealth.last.t));
    liveHealth.last = now;
  }
  if (fps != null) {
    liveHealth.capture = Math.round(fps);
    const surface = (v.getSettings && v.getSettings().displaySurface) || '';
    liveHealth.low = surface === 'window' && fps < 4 ? liveHealth.low + 1 : 0;
    if (liveHealth.low >= 3 && Date.now() - liveHealth.warnedAt > 60000) {
      liveHealth.warnedAt = Date.now();
      toast('A janela que você está transmitindo parou de ser desenhada (está coberta ou minimizada) e a transmissão congela. Deixe-a visível na tela ou transmita a "Tela inteira".', 9000);
    }
    // Janela visível = ~58fps; coberta ou fora de foco, muitos programas (e jogos com
    // "limite de FPS em segundo plano") passam a desenhar bem menos.
    const slow = surface === 'window' && fps >= 4 && fps < S.quality.fps * 0.5;
    liveHealth.slow = slow ? liveHealth.slow + 1 : 0;
    if (liveHealth.slow >= 5 && !liveHealth.slowWarned) {
      liveHealth.slowWarned = true;
      toast(`A janela está entregando só ${Math.round(fps)}fps. Se ela estiver atrás de outra janela ou fora de foco, o programa desenha menos (muitos jogos limitam o FPS em segundo plano). Para ficar fluido: deixe a janela visível ou use "Tela inteira".`, 10000);
    }
  }
  syncPreview();
  renderMembers();
}

// O pior caso entre os amigos (relatórios com mais de 6s são descartados)
function previewTarget() {
  const now = Date.now();
  let out = null;
  for (const [id, r] of [...rxReports]) {
    if (now - r.at > 6000 || !S.peers.has(id)) { rxReports.delete(id); continue; }
    if (!out) out = { fps: r.fps, h: r.h, n: 0, frz: 0 };
    out.fps = Math.min(out.fps, r.fps);
    out.h = Math.min(out.h, r.h || out.h);
    out.frz += r.frzNew;
    out.n++;
  }
  return out;
}

// A prévia de quem transmite mostra a mesma fluidez e resolução que os amigos
// recebem. A proporção (recebido ÷ capturado) evita falso alarme com a tela
// parada: aí a captura também entrega pouco e a prévia segue no fps cheio.
function syncPreview() {
  const tr = S.previewStream && S.previewStream.getVideoTracks()[0];
  if (!tr) { S.previewApplied = null; return; }
  const tgt = previewTarget();
  const cap = Math.max(1, liveHealth.capture || S.quality.fps);
  const ratio = tgt ? Math.min(1, tgt.fps / cap) : 1;
  const fps = Math.max(5, Math.round(S.quality.fps * ratio));
  const h = tgt && tgt.h ? Math.max(240, Math.min(tgt.h, QUALITY[S.quality.res].h)) : QUALITY[S.quality.res].h;
  const cur = S.previewApplied || {};
  if (Math.abs((cur.fps || 0) - fps) >= 3 || Math.abs((cur.h || 0) - h) >= 60) {
    S.previewApplied = { fps, h };
    tr.applyConstraints({ height: { max: h }, width: { max: Math.round((h * 16) / 9) }, frameRate: { max: fps } }).catch(() => {});
  }
  const t = tiles.get(`s:${S.me}`);
  if (t) showStat(t, S.me);
}

function previewLabel() {
  const tgt = previewTarget();
  if (!tgt) return 'ninguém assistindo ainda';
  const who = tgt.n === 1 ? 'seu amigo recebe' : `seus ${tgt.n} amigos recebem (pior caso)`;
  return `${who}: ${tgt.h}p · ${Math.round(tgt.fps)}fps${tgt.frz ? ' · ⚠ travou' : ''}`;
}

// ---- qualidade constante no longo prazo (a cada 10s)
// Quando a internet ou o processador apertam, o navegador reduz a resolução para
// manter o fps — mas nem sempre volta a subir depois. Se a resolução está reduzida
// há 30s e já sobra banda E processador, libera o navegador para voltar ao cheio.
async function resetAdaptation(sender) {
  // trocar a preferência passando por "balanced" zera as reduções acumuladas
  for (const pref of ['balanced', 'maintain-framerate']) {
    try {
      const p = sender.getParameters();
      p.degradationPreference = pref;
      await sender.setParameters(p);
    } catch {}
  }
}

function recoverQuality() {
  for (const en of children('screen', S.me)) {
    const sender = en.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    const out = en.st && en.st.rtp;
    if (!sender || !out || !out.frameHeight) continue;
    const pair = en.st.pair;
    const prev = en.ad || { enc: out.totalEncodeTime || 0, frames: out.framesEncoded || 0, low: 0 };
    const dFrames = (out.framesEncoded || 0) - prev.frames;
    const msPerFrame = dFrames > 0 ? (((out.totalEncodeTime || 0) - prev.enc) * 1000) / dFrames : 0;
    const capH = Math.min(QUALITY[S.quality.res].h, sender.track.getSettings().height || 9999);
    const reduced = out.frameHeight < capH * 0.8;
    const bandOk = pair && pair.availableOutgoingBitrate && pair.availableOutgoingBitrate >= screenBitrate(S.me) * 0.9;
    const cpuOk = msPerFrame > 0 && msPerFrame < (1000 / S.quality.fps) * 0.6;
    const low = reduced && bandOk && cpuOk ? prev.low + 1 : 0;
    en.ad = { enc: out.totalEncodeTime || 0, frames: out.framesEncoded || 0, low };
    if (low >= 3) {
      en.ad.low = 0;
      resetAdaptation(sender);
    }
  }
}

// ---- diagnóstico (a cada 6s, só com transmissão rolando)
// Números técnicos (nada da imagem) para descobrir onde engasga numa chamada real.
// Consulta: /diag?sala=<código da sala>
function pcDiag(en) {
  const o = {};
  const st = en.st;
  if (!st) return o;
  if (st.conn) o.conexao = st.conn;
  if (st.pair && st.pair.currentRoundTripTime != null) o.rtt_ms = Math.round(st.pair.currentRoundTripTime * 1000);
  const rtp = st.rtp;
  if (!rtp) return o;
  const out = rtp.type === 'outbound-rtp';
  const now = { t: performance.now(), bytes: out ? rtp.bytesSent : rtp.bytesReceived, frz: rtp.freezeCount || 0, lost: rtp.packetsLost || 0, rcv: rtp.packetsReceived || 0 };
  const p = diagPrev.get(en.pc);
  diagPrev.set(en.pc, now);
  o.fps = rtp.framesPerSecond != null ? Math.round(rtp.framesPerSecond) : 0;
  o.res = rtp.frameHeight ? `${rtp.frameHeight}p` : '-';
  o.codec = st.codec;
  if (p) o.kbps = Math.round(((now.bytes - p.bytes) * 8) / (now.t - p.t));
  if (out) {
    o.limite = rtp.qualityLimitationReason; // bandwidth = internet, cpu = processador
    if (rtp.framesEncoded) o.ms_por_quadro = +((rtp.totalEncodeTime / rtp.framesEncoded) * 1000).toFixed(1);
    if (st.pair && st.pair.availableOutgoingBitrate) o.banda_disponivel_kbps = Math.round(st.pair.availableOutgoingBitrate / 1000);
    if (st.src && st.src.framesPerSecond != null) o.captura_fps = Math.round(st.src.framesPerSecond);
  } else {
    if (p) {
      o.travadas = now.frz - p.frz;
      const lost = now.lost - p.lost;
      const got = now.rcv - p.rcv;
      o.perda_pct = lost + got > 0 ? +((lost * 100) / (lost + got)).toFixed(1) : 0;
    }
    if (rtp.jitter != null) o.jitter_ms = Math.round(rtp.jitter * 1000);
    if (rtp.jitterBufferEmittedCount) o.buffer_ms = Math.round((rtp.jitterBufferDelay / rtp.jitterBufferEmittedCount) * 1000);
  }
  return o;
}

function sendDiag() {
  if (!S.ws || !S.me) return;
  const nickOf = (id) => (id === S.me ? S.nick : (S.peers.get(id) || {}).nick || id);
  const envia = [];
  const recebe = [];
  for (const en of S.pcs.values()) {
    if (en.kind !== 'screen') continue;
    const o = pcDiag(en);
    if (en.role === 'pub') envia.push({ para: nickOf(en.peer), tela: en.o === S.me ? 'minha' : `${nickOf(en.o)} (repasse)`, ...o });
    else recebe.push({ tela_de: nickOf(en.o), via: nickOf(en.peer), ...o });
  }
  if (!envia.length && !recebe.length && !S.self.live) return;
  const v = S.screenStream && S.screenStream.getVideoTracks()[0];
  send({
    t: 'diag',
    d: {
      celular: IS_MOBILE,
      nucleos: navigator.hardwareConcurrency,
      memoria_gb: navigator.deviceMemory,
      transmitindo: S.self.live ? `${qualityLabel()} · ${v ? v.getSettings().displaySurface : '?'} · captura ${liveHealth.capture}fps · som: ${S.shareAudioLabel || 'nenhum'}` : undefined,
      envia,
      recebe,
    },
  });
}

// Tiles são reaproveitados entre renders (vídeos não são recriados)
const tiles = new Map();

// Prévia local: cópia da faixa (não passa por codificação, então é leve).
// syncPreview() ajusta fps e resolução para ficar igual ao que os amigos recebem.
function selfPreview() {
  if (!S.screenStream) return null;
  if (!S.previewStream) {
    const v = S.screenStream.getVideoTracks()[0];
    if (!v) return null;
    S.previewStream = new MediaStream([v.clone()]);
    S.previewApplied = null;
    syncPreview();
  }
  return S.previewStream;
}

function dropPreview() {
  if (!S.previewStream) return;
  S.previewStream.getTracks().forEach((t) => t.stop());
  S.previewStream = null;
  S.previewApplied = null;
}

function streamFor(kind, id) {
  if (id === S.me) return kind === 'screen' ? selfPreview() : S.camStream;
  const en = S.pcs.get(subKey(kind, id));
  return en ? en.stream : null;
}

function setVideo(video, stream, muted) {
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    video.classList.remove('ok');
  }
  video.muted = muted;
  if (stream && video.paused) {
    video.play().catch(() => {
      if (!video.muted) { video.muted = true; video.play().catch(() => {}); }
    });
  }
}

function makeTile(k) {
  const t = document.createElement('div');
  t.className = 'tile';
  const v = document.createElement('video');
  v.autoplay = true;
  v.playsInline = true;
  v.muted = true;
  v.disablePictureInPicture = false;
  t.appendChild(v);
  const rest = document.createElement('div');
  rest.className = 'tile-ui';
  rest.style.display = 'contents';
  t.appendChild(rest);
  t._video = v;
  t._ui = rest;
  t.dataset.key = k;
  v.disableRemotePlayback = true;
  v.addEventListener('playing', () => t.classList.remove('loading'));
  // 1 clique (com 2 telas abertas): amplia esta tela. 2 cliques: tela cheia.
  let clickTimer = 0;
  v.addEventListener('click', () => {
    if (!t.classList.contains('can-focus')) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => setFocus(k.slice(2)), 250);
  });
  v.addEventListener('dblclick', () => { clearTimeout(clickTimer); toggleFullscreen(t); });
  tiles.set(k, t);
  return t;
}

function setUI(t, html) {
  if (t._ui._html !== html) { t._ui.innerHTML = html; t._ui._html = html; }
}

// Volume de cada transmissão (0 a 1), escolhido por quem assiste
function volumeOf(id) { return S.volumes.has(id) ? S.volumes.get(id) : 1; }

function updateScreenTile(t, id) {
  const p = info(id);
  const stream = streamFor('screen', id);
  const vol = volumeOf(id);
  const muted = p.me || S.muted.has(id) || vol === 0;
  const many = S.watched.filter(isLive).length > 1;
  const focused = many && S.focus === id;
  t.className = `tile screen is-live${many && !focused ? ' can-focus' : ''}`;
  const hasAudio = !!(stream && stream.getAudioTracks().length);
  if (!stream || !stream.getVideoTracks().some((tr) => tr.readyState === 'live') || t._video.readyState < 2) t.classList.add('loading');
  setVideo(t._video, stream, muted);
  t._video.volume = vol;
  const tries = subTries.get(id) || 0;
  setUI(t, `<div class="t-spinner"></div>
    ${tries >= 2 ? `<div class="t-msg">Reconectando à tela de ${esc(p.nick)} (tentativa ${tries + 1})…<br><small>${S.hasTurn
      ? 'A conexão está demorando. Verifique a internet de vocês dois.'
      : 'A rede de um de vocês bloqueia a conexão direta. O dono do site precisa ativar o servidor TURN (veja o README).'}</small></div>` : ''}
    ${focused ? `<button class="t-pill" data-act="unfocus">${icon('layers')}<span>Ver as duas telas</span></button>` : ''}
    <div class="t-top">
      ${hasAudio && !p.me ? `<div class="t-vol">
        <button class="t-btn" data-act="mute" data-id="${id}" title="${muted ? 'Ativar som' : 'Silenciar'}">${icon(muted ? 'mute' : 'speaker')}</button>
        <input class="vol-range" type="range" min="0" max="100" step="1" data-id="${id}" aria-label="Volume da transmissão">
      </div>` : ''}
      ${many && !focused ? `<button class="t-btn" data-act="focus" data-id="${id}" title="Ampliar esta tela">${icon('expand')}</button>` : ''}
      <button class="t-btn" data-act="fullscreen" title="Tela cheia">${icon('full')}</button>
      <button class="t-btn stop" data-act="unwatch" data-id="${id}" title="Parar de assistir">${icon('x')}<span class="lbl">Parar de assistir</span></button>
    </div>
    <div class="t-label">${icon('screen')}<span>${esc(p.nick)}${p.me ? ' (sua prévia)' : ''}</span><span class="live-badge">AO VIVO</span><span class="q live-stat"></span></div>`);
  // o valor do volume não entra no HTML, senão o controle seria recriado enquanto arrasta
  const range = t.querySelector('.vol-range');
  if (range && document.activeElement !== range) range.value = Math.round(vol * 100);
  showStat(t, id);
}

// Mostra no quadro o que está chegando de verdade (resolução e fps recebidos).
// Obs.: com a tela parada o navegador envia menos quadros; isso é normal.
function showStat(t, id) {
  const el = t.querySelector('.live-stat');
  if (!el) return;
  if (id === S.me) { el.textContent = previewLabel(); return; }
  const en = S.pcs.get(subKey('screen', id));
  el.textContent = en && en.stat ? en.stat : (info(id).q || '');
}

// Aviso no lugar de uma tela que está ao vivo mas não está aberta
function updateNoticeTile(t, id) {
  const p = info(id);
  t.className = 'tile notice';
  setVideo(t._video, null, true);
  const who = p.me ? 'Você está' : `<b>${esc(p.nick)}</b> está`;
  setUI(t, `<div class="n-user">${avatarHTML(p.nick, 'avatar', true)}<b>${esc(p.nick)}${p.me ? ' (você)' : ''}</b><span class="live-badge">AO VIVO</span></div>
    <div class="n-body">
      <div class="n-ic"><span class="bar"></span><span class="scr"><i class="fa-solid fa-display"></i><i class="fa-solid fa-arrow-up"></i></span><span class="bar"></span></div>
      <h3>Compartilhamento de tela</h3>
      <p>${who} compartilhando a tela.<br>${p.me ? 'Seus amigos já podem assistir.' : 'Aproveite a transmissão!'}</p>
      <div class="n-btns">${noticeButtons(id)}</div>
      <span class="n-line"></span>
    </div>`);
}

function updatePersonTile(t, id) {
  const p = info(id);
  const stream = p.cam ? streamFor('cam', id) : null;
  const hasVid = !!(stream && stream.getVideoTracks().length);
  t.className = `tile cam${hasVid ? ' has-video' : ''}${p.me ? ' mirror' : ''}${p.live ? ' is-live' : ''}`;
  setVideo(t._video, hasVid ? stream : null, true);
  const showWatch = p.live && !S.watched.includes(id) && !p.me;
  setUI(t, `${avatarHTML(p.nick, 'av-big', false)}
    ${showWatch ? `<div class="t-watch"><span class="live-badge">AO VIVO</span><div class="t-watch-btns">${actionButtons(id)}</div></div>` : ''}
    <div class="t-label">${p.cam ? icon('cam') : ''}<span>${esc(p.nick)}${p.me ? ' (você)' : ''}</span>${p.live && !showWatch ? '<span class="live-badge">AO VIVO</span>' : ''}</div>`);
}

function renderStage() {
  const stage = $('#stage');
  const strip = $('#strip');
  const people = participants();
  const screens = S.watched.filter(isLive);
  const live = liveIds();

  // Plano: [container, chave, atualizar, id]
  // Com alguém ao vivo, o palco se divide em partes iguais, uma por tela:
  // aberta = vídeo; não aberta = aviso com "Assistir".
  // Os membros vão para a fileira abaixo, só se o botão de pessoas estiver ligado.
  // Tela ampliada: só vale com 2 telas abertas; ela ocupa o palco inteiro
  if (S.focus && !(screens.length > 1 && screens.includes(S.focus))) S.focus = null;
  const plan = [];
  if (live.length) {
    if (S.focus) plan.push([stage, `s:${S.focus}`, updateScreenTile, S.focus]);
    else for (const id of live) {
      if (screens.includes(id)) plan.push([stage, `s:${id}`, updateScreenTile, id]);
      else plan.push([stage, `n:${id}`, updateNoticeTile, id]);
    }
    if (S.showMembers) for (const p of people) plan.push([strip, `p:${p.id}`, updatePersonTile, p.id]);
  } else {
    for (const p of people) plan.push([stage, `p:${p.id}`, updatePersonTile, p.id]);
  }
  const used = new Set(plan.map((x) => x[1]));

  // Remove primeiro o que saiu, para não precisar mover os que ficam
  for (const [k, t] of tiles) {
    if (used.has(k)) continue;
    t._video.srcObject = null;
    t.remove();
    tiles.delete(k);
  }

  // Só mexe no DOM quando a posição muda de verdade. Tirar um elemento do lugar
  // faz o navegador sair da tela cheia, então o quadro em tela cheia nunca é movido.
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const pos = new Map();
  for (const [container, k, update, id] of plan) {
    const t = tiles.get(k) || makeTile(k);
    update(t, id);
    const i = pos.get(container) || 0;
    const at = container.children[i];
    if (at !== t) {
      if (t === fs) {
        if (t.parentNode !== container) container.appendChild(t);
      } else {
        container.insertBefore(t, at || null);
      }
    }
    pos.set(container, [...container.children].indexOf(t) + 1);
  }

  stage.className = live.length ? `stage panels n${S.focus ? 1 : Math.min(live.length, 4)}` : 'stage grid';
  strip.hidden = !(live.length && S.showMembers);
  if (!screens.includes(S.me)) dropPreview();
  fitGrid();
}

// Escolhe o número de colunas que deixa os quadros 16:9 maiores sem rolagem
function fitGrid() {
  const stage = $('#stage');
  if (!stage.classList.contains('grid')) return;
  const n = stage.childElementCount;
  if (!n) return;
  const GAP = 10;
  const W = stage.clientWidth - 24;
  const H = stage.clientHeight - 24;
  let best = { cols: 1, tw: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min((W - (cols - 1) * GAP) / cols, ((H - (rows - 1) * GAP) / rows) * 16 / 9);
    if (tw > best.tw) best = { cols, tw };
  }
  const tw = Math.max(140, Math.min(best.tw, n === 1 ? 960 : 4000));
  stage.style.setProperty('--cols', best.cols);
  stage.style.setProperty('--tw', `${Math.floor(tw)}px`);
}
new ResizeObserver(() => fitGrid()).observe(document.getElementById('stage'));

function renderControls() {
  const cam = !!S.camStream;
  const live = !!S.screenStream;
  const bc = $('#btnCam');
  bc.classList.toggle('on', cam);
  bc.classList.toggle('off', !cam);
  bc.title = cam ? 'Desligar câmera' : 'Ligar câmera';
  bc.innerHTML = icon(cam ? 'cam' : 'camoff');
  const bs = $('#btnShare');
  bs.classList.toggle('live', live);
  bs.title = live ? 'Opções da transmissão' : 'Transmitir tela';
  $('#sideCam').classList.toggle('on', cam);
  $('#sideShare').classList.toggle('on', live);
  $('#sideShare span').textContent = live ? 'Ao vivo' : 'Tela';
  $('#btnMembers').classList.toggle('active', S.showMembers);
  $('#headMembers').classList.toggle('on', S.showMembers);
}

function toggleFullscreen(tile) {
  const cur = document.fullscreenElement || document.webkitFullscreenElement;
  if (cur) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  if (!tile) return;
  const req = tile.requestFullscreen || tile.webkitRequestFullscreen;
  if (req) {
    const r = req.call(tile);
    if (r && r.catch) r.catch(() => {});
  } else if (tile._video && tile._video.webkitEnterFullscreen) {
    tile._video.webkitEnterFullscreen(); // iPhone: só o vídeo pode ir para tela cheia
  }
}

// ------------------------------------------------------------------ chat
function setChatOpen(open) {
  S.chatOpen = open;
  $('#room').classList.toggle('chat-closed', !open);
  if (open) {
    S.unread = 0;
    const m = $('#msgs');
    m.scrollTop = m.scrollHeight;
  }
  const b = $('#unread');
  b.hidden = !S.unread;
  b.textContent = S.unread > 9 ? '9+' : S.unread;
  if (S.room) renderControls();
}

function linkify(container, text) {
  const re = /(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[0];
    a.textContent = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    container.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function appendToMsgs(node) {
  const box = $('#msgs');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.appendChild(node);
  while (box.childElementCount > 300) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function addChat(msg, history) {
  const empty = $('#chatEmpty');
  if (empty) empty.remove();
  const grouped = S.lastMsg && S.lastMsg.from === msg.from && msg.ts - S.lastMsg.ts < 5 * 60 * 1000;
  S.lastMsg = msg;
  let node;
  if (grouped) {
    node = document.createElement('div');
    node.className = 'msg-line';
    const tx = document.createElement('div');
    tx.className = 'msg-text';
    linkify(tx, msg.text);
    node.appendChild(tx);
  } else {
    node = document.createElement('div');
    node.className = 'msg';
    node.innerHTML = `${avatarHTML(msg.nick)}<div class="msg-body"><div class="msg-head"><span class="msg-nick" style="color:${colorFor(msg.nick) === '#3d3d46' ? '#c9c9d1' : colorFor(msg.nick)}">${esc(msg.nick)}</span><span class="msg-time">${fmtTime(msg.ts)}</span></div><div class="msg-text"></div></div>`;
    linkify(node.querySelector('.msg-text'), msg.text);
  }
  appendToMsgs(node);
  if (!history && !S.chatOpen && msg.from !== S.me) {
    S.unread++;
    setChatOpen(false);
  }
}

function sysMsg(html, red) {
  S.lastMsg = null;
  const d = document.createElement('div');
  d.className = `sys${red ? ' red' : ''}`;
  d.innerHTML = `<span>${html}</span>`;
  appendToMsgs(d);
}

// ---------------------------------------------------------- modal ao vivo
function openLiveModal() {
  if (!canShare) return toast('Seu navegador não permite compartilhar a tela (use Chrome, Edge ou Firefox no PC).');
  const live = !!S.screenStream;
  $('#liveTitle').textContent = live ? 'Sua transmissão' : 'Transmitir tela';
  $('#liveDesc').textContent = live
    ? `Ao vivo em ${qualityLabel()} para ${viewersOf(S.me)} ${viewersOf(S.me) === 1 ? 'pessoa' : 'pessoas'}. Ajuste a qualidade ou troque o que está sendo compartilhado.`
    : 'Escolha a qualidade. Em seguida, selecione a tela inteira, uma janela ou uma guia. Dica: "Tela inteira" e guias são as mais fluidas; uma janela coberta ou minimizada congela.';
  $('#audioRow').hidden = live;
  $('#optAudio').checked = S.quality.audio;
  syncSeg();
  $('#modalActions').innerHTML = live
    ? `<button class="btn ghost" data-act="switch-source">Trocar tela/janela</button>
       <button class="btn ghost" data-act="apply-quality">Aplicar qualidade</button>
       <button class="btn primary" data-act="stoplive">Parar transmissão</button>`
    : `<button class="btn ghost" data-act="close-modal">Cancelar</button>
       <button class="btn primary" data-act="golive">${icon('screen')} Ir ao vivo</button>`;
  $('#liveModal').hidden = false;
}

function syncSeg() {
  document.querySelectorAll('.seg').forEach((seg) => {
    const val = seg.dataset.group === 'res' ? S.quality.res : String(S.quality.fps);
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.v === val));
  });
}

function saveQuality() {
  try { localStorage.setItem('mrp-quality', JSON.stringify(S.quality)); } catch {}
}

function closeModals() {
  document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
}

// ---------------------------------------------------------------- copiar
async function copyLink() {
  const link = roomLink();
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const i = document.createElement('input');
    i.value = link;
    document.body.appendChild(i);
    i.select();
    try { document.execCommand('copy'); } catch {}
    i.remove();
  }
  toast('Link de convite copiado!');
}

// ------------------------------------------------------------------ sair
function leaveRoom() {
  S.leaving = true;
  clearTimeout(NET.timer);
  NET.attempt = 0;
  setNetBanner(false);
  S.rewatch = null;
  S.focus = null;
  S.volumes.clear();
  S.muted.clear();
  stopLive();
  if (S.camStream) { S.camStream.getTracks().forEach((t) => t.stop()); S.camStream = null; }
  for (const k of [...S.pcs.keys()]) closePc(k);
  send({ t: 'leave' }); // avisa o servidor para liberar a vaga na hora
  if (S.ws) { try { S.ws.close(); } catch {} }
  S.ws = null;
  S.me = null;
  S.peers.clear();
  S.watched = [];
  S.self = { live: false, cam: false, q: '' };
  S.sentWatching = '';
  for (const [, t] of tiles) { t._video.srcObject = null; t.remove(); }
  tiles.clear();
  S.room = '';
  closeModals();
  $('#room').hidden = true;
  $('#landing').hidden = false;
  setLandingMode('create');
  S.showMembers = false;
  history.replaceState(null, '', location.pathname);
  document.title = 'MRP Live Room';
  initLandingModeCreate();
}

function initLandingModeCreate() {
  // Depois de sair, o formulário volta a criar uma sala nova
  $('#joinForm').onsubmit = (e) => {
    e.preventDefault();
    const nick = $('#nick').value.trim().slice(0, 24);
    if (!nick) return $('#nick').focus();
    try { localStorage.setItem('mrp-nick', nick); } catch {}
    S.nick = nick;
    S.room = genRoomId();
    enterRoom(true);
  };
}

// ---------------------------------------------------------------- eventos
document.addEventListener('click', (e) => {
  const segBtn = e.target.closest('.seg button');
  if (segBtn) {
    const g = segBtn.parentElement.dataset.group;
    if (g === 'res') S.quality.res = segBtn.dataset.v;
    else S.quality.fps = Number(segBtn.dataset.v);
    saveQuality();
    syncSeg();
    return;
  }
  if (e.target.classList.contains('modal')) return closeModals();

  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'watch': watch(id, false); break;
    case 'watchadd': watch(id, true); break;
    case 'watchauto': watch(id, S.watched.length > 0); break;
    case 'toggle-members':
      S.showMembers = !S.showMembers;
      if (S.showMembers && !liveIds().length) toast('Os membros já aparecem no palco. A fileira abaixo da tela aparece quando alguém estiver transmitindo.', 4000);
      render();
      break;
    case 'unwatch': unwatch(id); break;
    case 'unwatch-all':
      for (const w of [...S.watched]) unwatch(w);
      break;
    case 'share':
      openLiveModal();
      break;
    case 'golive':
      S.quality.audio = $('#optAudio').checked;
      saveQuality();
      closeModals();
      startLive();
      break;
    case 'switch-source':
      closeModals();
      startLive();
      break;
    case 'apply-quality':
      closeModals();
      applyQuality();
      break;
    case 'stoplive':
      closeModals();
      stopLive();
      break;
    case 'cam': toggleCam(); break;
    case 'copy': copyLink(); break;
    case 'leave': leaveRoom(); break;
    case 'toggle-chat': setChatOpen(!S.chatOpen); break;
    case 'toggle-side': $('#room').classList.toggle('side-open'); break;
    case 'close-modal': closeModals(); break;
    case 'fullscreen': toggleFullscreen(b.closest('.tile')); break;
    case 'mute':
      if (S.muted.has(id) || volumeOf(id) === 0) {
        S.muted.delete(id);
        if (volumeOf(id) === 0) S.volumes.set(id, 0.5);
      } else S.muted.add(id);
      renderStage();
      break;
    case 'focus': setFocus(id); break;
    case 'unfocus': setFocus(null); break;
  }
});

// Volume: aplica direto no vídeo enquanto arrasta, sem redesenhar o quadro
document.addEventListener('input', (e) => {
  const r = e.target.closest('.vol-range');
  if (!r) return;
  const id = r.dataset.id;
  const v = Number(r.value) / 100;
  S.volumes.set(id, v);
  if (v > 0) S.muted.delete(id);
  const t = tiles.get(`s:${id}`);
  if (!t) return;
  t._video.volume = v;
  t._video.muted = v === 0 || S.muted.has(id);
  const btn = t.querySelector('.t-vol [data-act="mute"]');
  if (btn) btn.innerHTML = icon(t._video.muted ? 'mute' : 'speaker');
});
// ao soltar o controle, sincroniza o resto da interface
document.addEventListener('change', (e) => { if (e.target.closest('.vol-range')) renderStage(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModals();
});

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#chatInput');
  const text = inp.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  inp.value = '';
});

// Fechou a guia/navegador (ou trocou de página): sai da sala na hora.
// "pagehide" também dispara no celular, onde "beforeunload" muitas vezes não dispara.
function leaveOnClose() {
  if (!S.ws) return;
  S.leaving = true;
  send({ t: 'leave' });
  try { S.ws.close(); } catch {}
  for (const k of [...S.pcs.keys()]) closePc(k);
}
window.addEventListener('pagehide', leaveOnClose);
window.addEventListener('beforeunload', leaveOnClose);

// Voltou para a guia pelo botão "voltar" do navegador: entra de novo na sala
window.addEventListener('pageshow', (e) => {
  if (!e.persisted || !S.room) return;
  resetConnections();
  S.leaving = false;
  connect();
});

initLanding();
