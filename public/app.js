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
  chatOpen: window.innerWidth > 1200,
  showMembers: false, // fileira de membros abaixo da tela (botão de pessoas)
  unread: 0,
  leaving: false,
  rtc: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
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

  fetch('/config.json').then((r) => r.json()).then((c) => { if (c && c.iceServers) S.rtc = c; }).catch(() => {});
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
  connect();
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

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => send({ t: 'join', room: S.room, nick: S.nick, device: DEVICE_ID });
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handle(m).catch((err) => console.warn(err));
  };
  ws.onclose = () => {
    if (S.ws !== ws || S.leaving) return;
    resetConnections();
    toast('Conexão perdida. Reconectando…');
    setTimeout(() => { if (!S.leaving && S.ws === ws) connect(); }, 1500);
  };
}

function resetConnections() {
  for (const key of [...S.pcs.keys()]) closePc(key);
  S.peers.clear();
  S.watched = S.watched.filter((id) => id === S.me);
  render();
}

async function handle(m) {
  switch (m.t) {
    case 'joined': {
      const wasWatchingSelf = S.watched.includes(S.me);
      S.me = m.id;
      S.watched = wasWatchingSelf ? [S.me] : [];
      S.peers.clear();
      for (const p of m.peers) S.peers.set(p.id, p);
      if (!$('#msgs').childElementCount) for (const msg of m.chat) addChat(msg, true);
      sysMsg(`Você entrou na sala <b>${esc(S.room)}</b>`);
      pushState();
      for (const p of S.peers.values()) if (p.cam) subscribe('cam', p.id);
      render();
      break;
    }
    case 'error':
      toast(m.msg || 'Erro');
      if (m.fatal) leaveRoom();
      break;
    case 'peer-join':
      S.peers.set(m.peer.id, m.peer);
      if (!m.rejoin) sysMsg(`<b>${esc(m.peer.nick)}</b> entrou na sala`);
      if (m.peer.cam) subscribe('cam', m.peer.id);
      render();
      break;
    case 'peer-state': {
      const p = m.peer;
      const prev = S.peers.get(p.id);
      if (!prev) return;
      S.peers.set(p.id, p);
      if (!prev.cam && p.cam) subscribe('cam', p.id);
      if (prev.cam && !p.cam) dropSub('cam', p.id, false);
      if (!prev.live && p.live) sysMsg(`<b>${esc(p.nick)}</b> começou a transmitir`, true);
      if (prev.live && !p.live) {
        dropSub('screen', p.id, false);
        S.watched = S.watched.filter((id) => id !== p.id);
        sysMsg(`<b>${esc(p.nick)}</b> parou de transmitir`);
      }
      render();
      break;
    }
    case 'peer-leave': {
      const p = S.peers.get(m.id);
      S.peers.delete(m.id);
      S.watched = S.watched.filter((id) => id !== m.id);
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
// Indica ao Chrome uma taxa inicial alta para a transmissão já começar nítida;
// se a internet não aguentar, ele reduz sozinho em seguida.
function fastStart(sdp, maxBps) {
  const kbps = Math.round(maxBps / 1000);
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
  return kind === 'screen' ? p.live && S.watched.includes(o) : p.cam;
}

// Lado de quem ASSISTE: pede a transmissão de `o` (direto ou via um retransmissor)
function subscribe(kind, o, via = o) {
  const k = subKey(kind, o);
  if (S.pcs.has(k)) return;
  const pc = new RTCPeerConnection(S.rtc);
  const sid = rid();
  const en = { pc, kind, o, peer: via, role: 'sub', sid, stream: null, q: [], waiters: [] };
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
    if (S.pcs.get(k) === en && pc.connectionState === 'failed') resubscribe(kind, o, 1000);
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
      systemAudio: 'include',
      monitorTypeSurfaces: 'include',
    });
  } catch (err) {
    if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast('Não foi possível compartilhar a tela.');
    return;
  }
  const old = S.screenStream;
  S.screenStream = stream;
  setupScreenTrack(stream);

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

function unwatch(id) {
  S.watched = S.watched.filter((x) => x !== id);
  if (id !== S.me) dropSub('screen', id, true);
  render();
}

// ---------------------------------------------------------------- render
function render() {
  if (!S.room) return;
  S.watched = S.watched.filter(isLive);
  if (S.ws && S.watched.filter((id) => id !== S.me).join(',') !== S.sentWatching) pushState();
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

// ------------------------------------------------------------ diagnóstico
// A cada 5s, durante uma transmissão, envia ao servidor números técnicos (nada
// da imagem): fps, resolução, taxa, perdas, atraso e tipo de conexão de cada
// envio/recepção. Servem para descobrir onde engasga numa chamada real.
// Consulta: /diag?sala=<código da sala>
const diagPrev = new WeakMap();

async function pcDiag(en) {
  const r = await en.pc.getStats();
  let rtp = null;
  let src = null;
  let pair = null;
  r.forEach((x) => {
    if (x.kind === 'video' && (x.type === 'outbound-rtp' || x.type === 'inbound-rtp')) rtp = x;
    if (x.type === 'media-source' && x.kind === 'video') src = x;
    if (x.type === 'transport' && x.selectedCandidatePairId) pair = r.get(x.selectedCandidatePairId);
  });
  const o = {};
  if (pair) {
    const l = r.get(pair.localCandidateId);
    const rm = r.get(pair.remoteCandidateId);
    o.conexao = `${l ? l.candidateType : '?'}/${rm ? rm.candidateType : '?'}`; // relay = passou por TURN
    if (pair.currentRoundTripTime != null) o.rtt_ms = Math.round(pair.currentRoundTripTime * 1000);
  }
  if (!rtp) return o;
  const out = rtp.type === 'outbound-rtp';
  const now = { t: performance.now(), bytes: out ? rtp.bytesSent : rtp.bytesReceived, frz: rtp.freezeCount || 0, lost: rtp.packetsLost || 0, rcv: rtp.packetsReceived || 0 };
  const p = diagPrev.get(en.pc);
  diagPrev.set(en.pc, now);
  o.fps = rtp.framesPerSecond != null ? Math.round(rtp.framesPerSecond) : 0;
  o.res = rtp.frameHeight ? `${rtp.frameHeight}p` : '-';
  o.codec = (r.get(rtp.codecId) || {}).mimeType;
  if (p) o.kbps = Math.round(((now.bytes - p.bytes) * 8) / (now.t - p.t));
  if (out) {
    o.limite = rtp.qualityLimitationReason; // bandwidth = internet, cpu = processador
    if (rtp.framesEncoded) o.ms_por_quadro = +((rtp.totalEncodeTime / rtp.framesEncoded) * 1000).toFixed(1);
    if (pair && pair.availableOutgoingBitrate) o.banda_disponivel_kbps = Math.round(pair.availableOutgoingBitrate / 1000);
    if (src && src.framesPerSecond != null) o.captura_fps = Math.round(src.framesPerSecond);
  } else {
    if (p) {
      o.travadas_5s = now.frz - p.frz;
      const lost = now.lost - p.lost;
      const got = now.rcv - p.rcv;
      o.perda_pct = lost + got > 0 ? +((lost * 100) / (lost + got)).toFixed(1) : 0;
    }
    if (rtp.jitter != null) o.jitter_ms = Math.round(rtp.jitter * 1000);
    if (rtp.jitterBufferEmittedCount) o.buffer_ms = Math.round((rtp.jitterBufferDelay / rtp.jitterBufferEmittedCount) * 1000);
  }
  return o;
}

setInterval(async () => {
  if (!S.ws || !S.me) return;
  const nickOf = (id) => (id === S.me ? S.nick : (S.peers.get(id) || {}).nick || id);
  const envia = [];
  const recebe = [];
  for (const en of [...S.pcs.values()]) {
    if (en.kind !== 'screen') continue;
    try {
      const o = await pcDiag(en);
      if (en.role === 'pub') envia.push({ para: nickOf(en.peer), tela: en.o === S.me ? 'minha' : `${nickOf(en.o)} (repasse)`, ...o });
      else recebe.push({ tela_de: nickOf(en.o), via: nickOf(en.peer), ...o });
    } catch {}
  }
  if (!envia.length && !recebe.length && !S.self.live) return;
  const v = S.screenStream && S.screenStream.getVideoTracks()[0];
  send({
    t: 'diag',
    d: {
      celular: IS_MOBILE,
      nucleos: navigator.hardwareConcurrency,
      transmitindo: S.self.live ? `${qualityLabel()} · ${v ? v.getSettings().displaySurface : '?'} · captura ${liveHealth.capture}fps` : undefined,
      envia,
      recebe,
    },
  });
}, 5000);

// ------------------------------------------------ saúde da minha transmissão
// Mede quantos quadros por segundo a captura está entregando. Testado: ao
// transmitir uma JANELA que fica coberta ou minimizada, o Windows/o próprio
// programa para de desenhá-la e a captura cai para ~1fps (parece congelado).
const liveHealth = { capture: null, low: 0, warnedAt: 0, last: null };

setInterval(async () => {
  const v = S.screenStream && S.screenStream.getVideoTracks()[0];
  if (!v) { liveHealth.capture = null; liveHealth.low = 0; liveHealth.last = null; return; }
  let fps = null;
  const en = children('screen', S.me)[0];
  if (en) {
    try {
      const s = en.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
      (await s.getStats()).forEach((r) => { if (r.type === 'media-source' && r.framesPerSecond != null) fps = r.framesPerSecond; });
    } catch {}
  }
  if (fps == null && v.stats && typeof v.stats.totalFrames === 'number') {
    // ninguém assistindo: usa o contador do próprio track (Chrome)
    const now = { t: performance.now(), n: v.stats.totalFrames };
    if (liveHealth.last) fps = Math.round(((now.n - liveHealth.last.n) * 1000) / (now.t - liveHealth.last.t));
    liveHealth.last = now;
  }
  if (fps == null) return;
  liveHealth.capture = Math.round(fps);

  const surface = (v.getSettings && v.getSettings().displaySurface) || '';
  liveHealth.low = surface === 'window' && fps < 4 ? liveHealth.low + 1 : 0;
  if (liveHealth.low >= 3 && Date.now() - liveHealth.warnedAt > 60000) {
    liveHealth.warnedAt = Date.now();
    toast('A janela que você está transmitindo parou de ser desenhada (está coberta ou minimizada) e a transmissão congela. Deixe-a visível na tela ou transmita a "Tela inteira".', 9000);
  }
  renderMembers();
}, 2000);

// Tiles são reaproveitados entre renders (vídeos não são recriados)
const tiles = new Map();

// Prévia local: cópia da faixa no mesmo fps da transmissão (fluida), mas em
// 540p para pesar pouco. A transmissão enviada aos amigos continua na qualidade escolhida.
function selfPreview() {
  if (!S.screenStream) return null;
  if (!S.previewStream) {
    const v = S.screenStream.getVideoTracks()[0];
    if (!v) return null;
    const c = v.clone();
    c.applyConstraints({ width: { max: 960 }, height: { max: 540 }, frameRate: { max: S.quality.fps } }).catch(() => {});
    S.previewStream = new MediaStream([c]);
  }
  return S.previewStream;
}

function dropPreview() {
  if (!S.previewStream) return;
  S.previewStream.getTracks().forEach((t) => t.stop());
  S.previewStream = null;
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
  v.addEventListener('playing', () => t.classList.remove('loading'));
  v.addEventListener('dblclick', () => toggleFullscreen(t));
  tiles.set(k, t);
  return t;
}

function setUI(t, html) {
  if (t._ui._html !== html) { t._ui.innerHTML = html; t._ui._html = html; }
}

function updateScreenTile(t, id) {
  const p = info(id);
  const stream = streamFor('screen', id);
  const muted = p.me || S.muted.has(id);
  t.className = 'tile screen is-live';
  const hasAudio = !!(stream && stream.getAudioTracks().length);
  if (!stream || !stream.getVideoTracks().some((tr) => tr.readyState === 'live') || t._video.readyState < 2) t.classList.add('loading');
  setVideo(t._video, stream, muted);
  setUI(t, `<div class="t-spinner"></div>
    <div class="t-top">
      ${hasAudio && !p.me ? `<button class="t-btn" data-act="mute" data-id="${id}" title="${muted ? 'Ativar som' : 'Silenciar'}">${icon(muted ? 'mute' : 'speaker')}</button>` : ''}
      <button class="t-btn" data-act="fullscreen" title="Tela cheia">${icon('full')}</button>
      <button class="t-btn stop" data-act="unwatch" data-id="${id}" title="Parar de assistir">${icon('x')} Parar de assistir</button>
    </div>
    <div class="t-label">${icon('screen')}<span>${esc(p.nick)}${p.me ? ' (você)' : ''}</span><span class="live-badge">AO VIVO</span>${p.me ? `<span class="q">sua prévia · 540p ${S.quality.fps}fps</span>` : '<span class="q live-stat"></span>'}</div>`);
  if (!p.me) showStat(t, id);
}

// Mostra no quadro o que está chegando de verdade (resolução e fps recebidos).
// Obs.: com a tela parada o navegador envia menos quadros; isso é normal.
function showStat(t, id) {
  const el = t.querySelector('.live-stat');
  if (!el) return;
  const en = S.pcs.get(subKey('screen', id));
  el.textContent = en && en.stat ? en.stat : (info(id).q || '');
}

setInterval(async () => {
  for (const en of [...S.pcs.values()]) {
    if (en.role !== 'sub' || en.kind !== 'screen') continue;
    try {
      const report = await en.pc.getStats();
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameHeight) {
          en.stat = `${r.frameHeight}p · ${Math.round(r.framesPerSecond || 0)}fps`;
        }
      });
      const t = tiles.get(`s:${en.o}`);
      if (t) showStat(t, en.o);
    } catch {}
  }
}, 2000);

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
  const plan = [];
  if (live.length) {
    for (const id of live) {
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

  stage.className = live.length ? `stage panels n${Math.min(live.length, 4)}` : 'stage grid';
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
      if (S.muted.has(id)) S.muted.delete(id);
      else S.muted.add(id);
      renderStage();
      break;
  }
});

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
