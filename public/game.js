'use strict';

/* ═══════════════════════════════════════════════════════════════
   Dungeon Escape — game.js
   Phaser 3.60 클라이언트 / Socket.IO 통신 / 역할별 뷰 렌더링
═══════════════════════════════════════════════════════════════ */

// ─── 타일 상수 (서버 server.js 와 동일) ──────────────────────
const TILE = Object.freeze({
  WALL: 0, FLOOR: 1, TRAP: 2,
  DOOR_LOCKED: 3, DOOR_OPEN: 4,
  KEY: 5, EXIT: 6, FUSION: 7
});

const TILE_SIZE = 48;     // px
const MAP_COLS  = 17;
const MAP_ROWS  = 13;
const FOG_RADIUS = 3;     // Chebyshev 거리

// GDD §7 팔레트 (Phaser 0xRRGGBB)
const C = Object.freeze({
  BG:            0x0a0a0a,
  WALL:          0x2a1f3d,
  FLOOR:         0x1a2a1a,
  FLOOR_VISITED: 0x243024,
  TRAP:          0x8b0000,
  DOOR_LOCKED:   0x4a3800,
  DOOR_OPEN:     0x1a5c1a,
  EXIT:          0x00aaff,
  FUSION:        0x6600cc,
  KEY:           0xffd700,
  EXPLORER:      0x00ff88,
});

// ─── 클라이언트 상태 ──────────────────────────────────────────
let myRole      = null;         // 'explorer' | 'oracle'
let myRoomId    = null;
let gameMap     = null;         // 2D array (BASE_MAP from server)
let explorerPos = { x: 1, y: 1 };
let hp          = 3;
let levers      = { A: false, B: false, C: false, D: false };
let doors       = {};           // A/B/C/D → { x, y, open }
let collectedKeys = [];         // ['x,y', ...]
let visitedTiles  = new Set();  // 'x,y'
let gameStatus    = 'WAITING';
let phaserGame    = null;
let gameScene     = null;       // Phaser Scene 인스턴스

// ── 오디오 상태 ──────────────────────────────────────────────
let _audioCtx     = null;
let _prevHp       = 3;
let _prevKeyCount = 0;

// ── 인게임 타이머 ─────────────────────────────────────────────
let _startTimestamp = 0;
let _timerInterval  = null;

/* ═══════════════════════════════════════════════════════════════
   Web Audio API 절차적 사운드
═══════════════════════════════════════════════════════════════ */
function _getAudioCtx() {
  if (!_audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) _audioCtx = new Ctx();
  }
  return _audioCtx;
}

function playSound(type) {
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;

    switch (type) {
      case 'move': {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(220, now);
        g.gain.setValueAtTime(0.05, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        o.connect(g); g.connect(ctx.destination);
        o.start(now); o.stop(now + 0.06);
        break;
      }
      case 'trap': {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(180, now);
        o.frequency.exponentialRampToValueAtTime(60, now + 0.3);
        g.gain.setValueAtTime(0.3, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        o.connect(g); g.connect(ctx.destination);
        o.start(now); o.stop(now + 0.3);
        break;
      }
      case 'key': {
        [523, 659, 784].forEach((freq, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          const t = now + i * 0.1;
          o.type = 'triangle';
          o.frequency.setValueAtTime(freq, t);
          g.gain.setValueAtTime(0.18, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
          o.connect(g); g.connect(ctx.destination);
          o.start(t); o.stop(t + 0.15);
        });
        break;
      }
      case 'door': {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(300, now);
        o.frequency.exponentialRampToValueAtTime(150, now + 0.2);
        g.gain.setValueAtTime(0.15, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        o.connect(g); g.connect(ctx.destination);
        o.start(now); o.stop(now + 0.2);
        break;
      }
      case 'fusion': {
        [261, 329, 392, 523].forEach((freq, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          const t = now + i * 0.08;
          o.type = 'triangle';
          o.frequency.setValueAtTime(freq, t);
          g.gain.setValueAtTime(0.22, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
          o.connect(g); g.connect(ctx.destination);
          o.start(t); o.stop(t + 0.2);
        });
        break;
      }
      case 'clear': {
        [523, 659, 784, 1047].forEach((freq, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          const t = now + i * 0.15;
          o.type = 'triangle';
          o.frequency.setValueAtTime(freq, t);
          g.gain.setValueAtTime(0.22, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
          o.connect(g); g.connect(ctx.destination);
          o.start(t); o.stop(t + 0.3);
        });
        break;
      }
      case 'gameover': {
        [200, 150, 100].forEach((freq, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          const t = now + i * 0.2;
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(freq, t);
          g.gain.setValueAtTime(0.25, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
          o.connect(g); g.connect(ctx.destination);
          o.start(t); o.stop(t + 0.2);
        });
        break;
      }
      case 'lever': {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(440, now);
        o.frequency.exponentialRampToValueAtTime(880, now + 0.05);
        g.gain.setValueAtTime(0.12, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        o.connect(g); g.connect(ctx.destination);
        o.start(now); o.stop(now + 0.08);
        break;
      }
      default: break;
    }
  } catch (_e) { /* 미지원 브라우저 무시 */ }
}

// ─── Socket.IO ────────────────────────────────────────────────
const socket = io();

/* ═══════════════════════════════════════════════════════════════
   유틸리티
═══════════════════════════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}
function showOverlay(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}
function hideOverlay(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function isInputActive() {
  const t = document.activeElement && document.activeElement.tagName;
  return t === 'INPUT' || t === 'TEXTAREA';
}
function generateRoomCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += ch[Math.floor(Math.random() * ch.length)];
  return c;
}

// Oracle HUD 갱신 (Explorer HP·열쇠 상태를 Oracle 뷰에 표시)
function updateOracleHud() {
  const hpEl = document.getElementById('oracle-hp');
  if (hpEl) {
    hpEl.innerHTML = [0, 1, 2].map(i =>
      `<span class="${i < hp ? 'hp-full' : 'hp-empty'}">♥</span>`
    ).join('');
  }
  const keyEl = document.getElementById('oracle-keys');
  if (keyEl) keyEl.textContent = `🗝 ${collectedKeys.length}`;
}

// HP 하트 갱신
function updateHpDisplay() {
  const el = document.getElementById('hp-display');
  if (!el) return;
  el.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const s = document.createElement('span');
    s.className = 'hp-heart ' + (i < hp ? 'hp-full' : 'hp-empty');
    s.textContent = '♥';
    el.appendChild(s);
  }
}

// 열쇠 카운트 갱신
function updateKeyDisplay() {
  const el = document.getElementById('key-count');
  if (el) el.textContent = `🗝 ${collectedKeys.length}`;
}

// 채팅 메시지 추가
function addChatMessage(logId, from, text, role) {
  const log = document.getElementById(logId);
  if (!log) return;
  const d = document.createElement('div');
  d.className = 'chat-message ' + (role === 'explorer' ? 'msg-explorer' : 'msg-oracle');
  d.innerHTML =
    `<span class="chat-from">${escapeHtml(from)}</span>` +
    `<span class="chat-text">${escapeHtml(text)}</span>`;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

// 채팅 입력 설정
function setupChat(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn   = document.getElementById(btnId);
  if (!input || !btn) return;

  function send() {
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat_msg', { text });
    input.value = '';
  }
  btn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

/* ═══════════════════════════════════════════════════════════════
   로비 초기화
═══════════════════════════════════════════════════════════════ */
(function initLobby() {
  // URL ?roomId=XXXX 또는 ?room=XXXX 자동 채우기
  const p = new URLSearchParams(window.location.search);
  const r = p.get('roomId') || p.get('room');
  if (r) document.getElementById('input-room').value = r.toUpperCase();
})();

document.getElementById('btn-join').addEventListener('click', doJoin);
document.getElementById('input-nickname').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('input-room').focus();
});
document.getElementById('input-room').addEventListener('keydown', e => {
  if (e.key === 'Enter') doJoin();
});

function doJoin() {
  const nick = document.getElementById('input-nickname').value.trim() || 'Player';
  let room   = document.getElementById('input-room').value.trim().toUpperCase();
  if (!room) room = generateRoomCode();
  myRoomId = room;
  socket.emit('join_room', { roomId: room, nickname: nick });
}

/* ═══════════════════════════════════════════════════════════════
   Socket 이벤트 핸들러
═══════════════════════════════════════════════════════════════ */
socket.on('room_joined', ({ role, roomId }) => {
  myRole   = role;
  myRoomId = roomId;

  showScreen('screen-waiting');
  document.getElementById('display-room-code').textContent = roomId;
  const url = `${location.origin}${location.pathname}?room=${roomId}`;
  document.getElementById('display-invite-link').value = url;
});

socket.on('room_full', () => {
  alert('방이 꽉 찼습니다. 다른 방 코드를 입력하세요.');
  showScreen('screen-lobby');
});

socket.on('countdown', ({ count }) => {
  showScreen('screen-countdown');
  const el = document.getElementById('countdown-number');
  el.textContent = count;
  // 애니메이션 재트리거
  el.style.animation = 'none';
  void el.offsetHeight;
  el.style.animation = '';
});

socket.on('game_start', (data) => {
  gameMap      = data.map;
  explorerPos  = data.explorerPos;
  hp           = data.hp;
  gameStatus   = 'PLAYING';
  doors        = {};  // 서버 state_update 가 채움

  // 시작 위치 방문 기록
  visitedTiles.add(`${explorerPos.x},${explorerPos.y}`);

  showScreen('screen-game');

  // 인게임 타이머 시작
  _startTimestamp = Date.now();
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  _timerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - _startTimestamp) / 1000);
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    const txt = `${m}:${s}`;
    const el1 = document.getElementById('timer-display');
    const el2 = document.getElementById('timer-display-oracle');
    if (el1) el1.textContent = txt;
    if (el2) el2.textContent = txt;
  }, 500);

  // 역할 인트로 오버레이
  const introOverlay = document.getElementById('role-intro-overlay');
  const introIcon    = document.getElementById('role-intro-icon');
  const introName    = document.getElementById('role-intro-name');
  const introDesc    = document.getElementById('role-intro-desc');
  if (introOverlay) {
    if (myRole === 'explorer') {
      introIcon.textContent = '🗡️';
      introName.textContent = 'Explorer (탐험가)';
      introDesc.textContent = '던전을 탐험하며 열쇠를 모으고 함정을 피해 출구로 탈출하세요!';
    } else {
      introIcon.textContent = '🔮';
      introName.textContent = 'Oracle (예언자)';
      introDesc.textContent = '전체 지도를 보며 탐험가를 안내하고 레버로 문을 제어하세요!';
    }
    introOverlay.classList.remove('hidden');
    setTimeout(() => introOverlay.classList.add('hidden'), 2500);
  }

  if (myRole === 'explorer') {
    document.getElementById('explorer-view').classList.remove('hidden');
    updateHpDisplay();
    updateKeyDisplay();
    initPhaserGame('phaser-container-explorer', 'explorer');
  } else {
    document.getElementById('oracle-view').classList.remove('hidden');
    updateLeverButtons();
    updateOracleHud();
    initPhaserGame('phaser-container-oracle', 'oracle');
  }
});

socket.on('state_update', (data) => {
  explorerPos   = data.explorerPos;
  hp            = data.hp;
  levers        = data.levers;
  doors         = data.doors;
  collectedKeys = data.collectedKeys;
  gameStatus    = data.status;

  visitedTiles.add(`${explorerPos.x},${explorerPos.y}`);

  // 사운드: HP 감소 → trap, 키 증가 → key
  if (data.hp < _prevHp) playSound('trap');
  if (data.collectedKeys.length > _prevKeyCount) playSound('key');
  _prevHp       = data.hp;
  _prevKeyCount = data.collectedKeys.length;

  if (myRole === 'explorer') {
    updateHpDisplay();
    updateKeyDisplay();
  } else {
    updateLeverButtons();
    updateOracleHud();
  }

  renderScene();
});

socket.on('fusion_event', () => {
  playSound('fusion');
  const ovId = myRole === 'explorer'
    ? 'fusion-overlay'
    : 'fusion-overlay-oracle';
  const el = document.getElementById(ovId);
  if (el) {
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2000);
  }
});

socket.on('chat_msg', ({ from, text, role }) => {
  const logId = myRole === 'explorer'
    ? 'chat-log-explorer'
    : 'chat-log-oracle';
  addChatMessage(logId, from, text, role);
});

socket.on('game_clear', ({ time }) => {
  playSound('clear');
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  document.getElementById('clear-time').textContent = time;
  showScreen('screen-clear');
  destroyPhaser();
});

socket.on('game_over', () => {
  playSound('gameover');
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  showScreen('screen-gameover');
  destroyPhaser();
});

socket.on('partner_disconnected', () => {
  showOverlay('overlay-disconnected');
});

/* ═══════════════════════════════════════════════════════════════
   재시작
═══════════════════════════════════════════════════════════════ */
function resetState() {
  destroyPhaser();
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  _startTimestamp = 0;
  myRole        = null;
  gameMap       = null;
  explorerPos   = { x: 1, y: 1 };
  hp            = 3;
  levers        = { A: false, B: false, C: false, D: false };
  doors         = {};
  collectedKeys = [];
  gameStatus    = 'WAITING';
  visitedTiles.clear();
  document.getElementById('explorer-view').classList.add('hidden');
  document.getElementById('oracle-view').classList.add('hidden');
  updateOracleHud();
  hideOverlay('overlay-disconnected');
  showScreen('screen-lobby');
}

function destroyPhaser() {
  if (phaserGame) { phaserGame.destroy(true); phaserGame = null; gameScene = null; }
}

document.getElementById('btn-restart-clear').addEventListener('click',    resetState);
document.getElementById('btn-restart-gameover').addEventListener('click', resetState);
document.getElementById('btn-restart-disc').addEventListener('click',     resetState);

/* ═══════════════════════════════════════════════════════════════
   링크 복사
═══════════════════════════════════════════════════════════════ */
document.getElementById('btn-copy-link').addEventListener('click', () => {
  const link = document.getElementById('display-invite-link').value;
  navigator.clipboard.writeText(link).then(() => {
    const fb = document.getElementById('copy-feedback');
    fb.classList.remove('hidden');
    setTimeout(() => fb.classList.add('hidden'), 2200);
  }).catch(() => {
    document.getElementById('display-invite-link').select();
    document.execCommand('copy');
  });
});

/* ═══════════════════════════════════════════════════════════════
   레버 버튼 (Oracle)
═══════════════════════════════════════════════════════════════ */
document.querySelectorAll('.lever-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    playSound('lever');
    socket.emit('lever_toggle', { lever: btn.dataset.lever });
  });
});

function updateLeverButtons() {
  document.querySelectorAll('.lever-btn').forEach(btn => {
    const on = levers[btn.dataset.lever];
    btn.classList.toggle('lever-on', !!on);
  });
}

/* ═══════════════════════════════════════════════════════════════
   채팅
═══════════════════════════════════════════════════════════════ */
setupChat('chat-input-explorer', 'chat-send-explorer');
setupChat('chat-input-oracle',   'chat-send-oracle');

/* ═══════════════════════════════════════════════════════════════
   키보드 이동 (Explorer) — Phaser 외부 vanillaJS로 처리
   → 채팅 인풋 포커스 시 무시
═══════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  // Oracle: 숫자 1~4로 레버 A~D 토글
  if (myRole === 'oracle' && gameStatus === 'PLAYING' && !isInputActive()) {
    const LEVER_MAP = { '1': 'A', '2': 'B', '3': 'C', '4': 'D' };
    if (LEVER_MAP[e.key]) {
      e.preventDefault();
      playSound('lever');
      socket.emit('lever_toggle', { lever: LEVER_MAP[e.key] });
      return;
    }
  }

  if (myRole !== 'explorer') return;
  if (isInputActive()) return;

  let dx = 0, dy = 0;
  switch (e.key) {
    case 'w': case 'W': case 'ArrowUp':    dy = -1; break;
    case 's': case 'S': case 'ArrowDown':  dy =  1; break;
    case 'a': case 'A': case 'ArrowLeft':  dx = -1; break;
    case 'd': case 'D': case 'ArrowRight': dx =  1; break;
    default: return;
  }
  e.preventDefault();
  if (gameStatus !== 'PLAYING') return;
  playSound('move');
  socket.emit('player_move', { dx, dy });
});

/* ═══════════════════════════════════════════════════════════════
   D-패드 터치/클릭 이동 (Explorer, 모바일)
   touchstart + click 양쪽 처리, gameStatus 조건 동일 적용
═══════════════════════════════════════════════════════════════ */
document.querySelectorAll('.dpad-btn').forEach(btn => {
  function handleDpad(e) {
    e.preventDefault();
    if (myRole !== 'explorer') return;
    if (gameStatus !== 'PLAYING') return;
    const dx = parseInt(btn.dataset.dx, 10);
    const dy = parseInt(btn.dataset.dy, 10);
    playSound('move');
    socket.emit('player_move', { dx, dy });
  }
  btn.addEventListener('touchstart', handleDpad, { passive: false });
  btn.addEventListener('click', handleDpad);
});

/* ═══════════════════════════════════════════════════════════════
   Phaser 3 게임 초기화
═══════════════════════════════════════════════════════════════ */
function initPhaserGame(containerId, role) {
  const W = MAP_COLS * TILE_SIZE;
  const H = MAP_ROWS * TILE_SIZE;

  const config = {
    type: Phaser.AUTO,
    width: W,
    height: H,
    parent: containerId,
    backgroundColor: '#0a0a0a',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      parent: containerId,
      width: W,
      height: H,
    },
    // Phaser 키보드 캡처 비활성 — vanillaJS로 직접 처리
    input: { keyboard: { capture: [] } },
    scene: {
      create() {
        gameScene            = this;
        this._gfx            = this.add.graphics();
        this._textLayer      = this.add.graphics().setDepth(5);
        this._lastRenderTime = 0;
        // 초기 그리기
        drawScene(role);
      },
      update(time) {
        // EXIT 깜빡임·Oracle 마커 펄스를 위한 ~30fps 지속 재드로우
        if (gameMap && gameStatus === 'PLAYING' &&
            time - this._lastRenderTime > 33) {
          this._lastRenderTime = time;
          drawScene(role);
        }
      }
    }
  };

  phaserGame = new Phaser.Game(config);
}

/* ═══════════════════════════════════════════════════════════════
   렌더링 진입점
═══════════════════════════════════════════════════════════════ */
function renderScene() {
  if (!gameScene || !gameMap) return;
  drawScene(myRole);
}

/* ─── 맵 타일 동적 조회 (서버 tileAt 로직 미러) ─────────────── */
function currentTile(x, y) {
  if (!gameMap) return TILE.WALL;
  if (x < 0 || x >= MAP_COLS || y < 0 || y >= MAP_ROWS) return TILE.WALL;

  // 동적 문 상태 우선
  for (const d of Object.values(doors)) {
    if (d.x === x && d.y === y) return d.open ? TILE.DOOR_OPEN : TILE.DOOR_LOCKED;
  }
  // 수집된 키 → 바닥
  if (collectedKeys.includes(`${x},${y}`)) return TILE.FLOOR;

  return gameMap[y][x];
}

/* ─── 메인 드로우 ─────────────────────────────────────────────── */
function drawScene(role) {
  if (!gameScene) return;
  const g = gameScene._gfx;
  g.clear();

  if (role === 'explorer') {
    drawExplorerView(g);
  } else {
    drawOracleView(g);
  }
}

/* ─── Explorer: Fog-of-War 뷰 ────────────────────────────────── */
function drawExplorerView(g) {
  for (let y = 0; y < MAP_ROWS; y++) {
    for (let x = 0; x < MAP_COLS; x++) {
      const px  = x * TILE_SIZE;
      const py  = y * TILE_SIZE;
      const key = `${x},${y}`;
      const dist = Math.max(
        Math.abs(x - explorerPos.x),
        Math.abs(y - explorerPos.y)
      );
      const visible = dist <= FOG_RADIUS;
      const visited = visitedTiles.has(key);

      if (visible) {
        // 트랩은 Explorer에게 안 보임 → FLOOR 로 표시
        let tile = currentTile(x, y);
        if (tile === TILE.TRAP) tile = TILE.FLOOR;
        drawTile(g, px, py, tile, false);
      } else if (visited) {
        // 방문했지만 시야 밖 → 희미하게
        g.fillStyle(0x1a2a1a, 0.35);
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      } else {
        // 완전 안개
        g.fillStyle(0x000000, 1);
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  drawExplorerSprite(g, false);
}

/* ─── Oracle: 전체 맵 뷰 ─────────────────────────────────────── */
function drawOracleView(g) {
  for (let y = 0; y < MAP_ROWS; y++) {
    for (let x = 0; x < MAP_COLS; x++) {
      const px = x * TILE_SIZE;
      const py = y * TILE_SIZE;
      drawTile(g, px, py, currentTile(x, y), true);
    }
  }

  // FUSION 타일 강조 테두리
  g.lineStyle(3, 0xcc88ff, 0.85);
  g.strokeRect(7 * TILE_SIZE + 2, 5 * TILE_SIZE + 2, TILE_SIZE - 4, TILE_SIZE - 4);

  // Explorer 위치 표시 (글로우 + 원)
  drawExplorerSprite(g, true);

  // Oracle: Explorer 위치 좌표 오버레이
  drawCoordLabel();
}

/* ─── 타일 하나 그리기 ──────────────────────────────────────────
   isOracle=false 면 TRAP 은 FLOOR 색으로 그려짐 (실제 호출 전 변환됨)
─────────────────────────────────────────────────────────────── */
function drawTile(g, px, py, tile, isOracle) {
  // 배경색
  let bg;
  switch (tile) {
    case TILE.WALL:        bg = C.WALL;        break;
    case TILE.FLOOR:       bg = C.FLOOR;       break;
    case TILE.TRAP:        bg = isOracle ? C.TRAP : C.FLOOR; break;
    case TILE.DOOR_LOCKED: bg = C.DOOR_LOCKED; break;
    case TILE.DOOR_OPEN:   bg = C.DOOR_OPEN;   break;
    case TILE.EXIT:        bg = C.EXIT;        break;
    case TILE.FUSION:      bg = C.FUSION;      break;
    case TILE.KEY:         bg = C.FLOOR;       break;
    default:               bg = C.FLOOR;
  }
  g.fillStyle(bg, 1);
  g.fillRect(px, py, TILE_SIZE, TILE_SIZE);

  // 격자 선 (미세)
  g.lineStyle(1, 0x000000, 0.18);
  g.strokeRect(px, py, TILE_SIZE, TILE_SIZE);

  // ── 타일별 마커 ──
  const half = TILE_SIZE / 2;
  const cx   = px + half;
  const cy   = py + half;

  switch (tile) {
    case TILE.WALL: {
      // 3D 베벨: 상단/좌측 하이라이트 + 하단/우측 그림자
      g.fillStyle(0xffffff, 0.08);
      g.fillRect(px, py, TILE_SIZE, 2);
      g.fillRect(px, py + 2, 2, TILE_SIZE - 2);
      g.fillStyle(0x000000, 0.28);
      g.fillRect(px, py + TILE_SIZE - 2, TILE_SIZE, 2);
      g.fillRect(px + TILE_SIZE - 2, py, 2, TILE_SIZE - 2);
      break;
    }

    case TILE.FLOOR: {
      // 미세 도트 패턴으로 바닥 질감 표현
      g.fillStyle(0x1f3a1f, 0.7);
      for (let _dy = 10; _dy < TILE_SIZE; _dy += 12) {
        for (let _dx = 10; _dx < TILE_SIZE; _dx += 12) {
          g.fillRect(px + _dx, py + _dy, 1, 1);
        }
      }
      break;
    }

    case TILE.KEY:
      // 황금색 원 + 십자
      g.fillStyle(C.KEY, 1);
      g.fillCircle(cx, cy - 4, TILE_SIZE * 0.16);
      g.fillRect(cx - 2, cy - 2, 4, TILE_SIZE * 0.22);
      g.fillRect(cx - 5, cy + 2, 10, 3);
      break;

    case TILE.TRAP:
      if (isOracle) {
        // X 마커 (Oracle 전용)
        g.lineStyle(2.5, 0xff4444, 0.9);
        g.lineBetween(px + 9, py + 9, px + TILE_SIZE - 9, py + TILE_SIZE - 9);
        g.lineBetween(px + TILE_SIZE - 9, py + 9, px + 9, py + TILE_SIZE - 9);
      }
      break;

    case TILE.DOOR_LOCKED: {
      // 자물쇠 아이콘 (작은 사각+호)
      const lw = TILE_SIZE * 0.28, lh = TILE_SIZE * 0.24;
      const lx = cx - lw / 2, ly = cy - lh * 0.1;
      g.fillStyle(0xffcc00, 0.85);
      g.fillRoundedRect(lx, ly, lw, lh, 2);
      g.lineStyle(2.5, 0xffcc00, 0.9);
      g.strokeCircle(cx, cy - lh * 0.4, lw * 0.32);
      break;
    }

    case TILE.DOOR_OPEN: {
      // 열린 문: 수직 선
      g.lineStyle(2, 0x44dd44, 0.6);
      g.lineBetween(cx, py + 6, cx, py + TILE_SIZE - 6);
      break;
    }

    case TILE.EXIT: {
      // 깜빡이는 빛 효과 (Phaser scene 시간 기반)
      const _t = (gameScene && gameScene.time) ? gameScene.time.now : 0;
      const _b = 0.5 + 0.5 * Math.sin(_t * 0.003);
      // 내부 글로우 펄스
      g.fillStyle(0x44ccff, 0.1 + 0.28 * _b);
      g.fillRect(px + 3, py + 3, TILE_SIZE - 6, TILE_SIZE - 6);
      // 방사 링 펄스
      g.lineStyle(2, 0x88ddff, 0.25 + 0.55 * _b);
      g.strokeCircle(cx, cy, TILE_SIZE * (0.26 + 0.07 * _b));
      // 화살표 밝기 펄스
      g.lineStyle(3, 0xffffff, 0.5 + 0.45 * _b);
      g.lineBetween(cx - 8, cy, cx + 8, cy);
      g.lineBetween(cx + 2, cy - 6, cx + 8, cy);
      g.lineBetween(cx + 2, cy + 6, cx + 8, cy);
      break;
    }

    case TILE.FUSION: {
      // 내부 보라 글로우
      g.fillStyle(0x8800ff, 0.4);
      g.fillCircle(cx, cy, TILE_SIZE * 0.30);
      // 번개 볼트 상단 세그먼트
      g.fillStyle(0xee88ff, 0.95);
      g.fillTriangle(
        cx + 7, py + 7,
        cx - 3, cy,
        cx + 3, cy
      );
      // 번개 볼트 하단 세그먼트
      g.fillTriangle(
        cx - 3, cy,
        cx + 3, cy,
        cx - 7, py + TILE_SIZE - 7
      );
      // 볼트 하이라이트
      g.lineStyle(1.5, 0xffffff, 0.55);
      g.lineBetween(cx + 6, py + 8, cx, cy - 1);
      g.lineBetween(cx, cy + 1, cx - 6, py + TILE_SIZE - 8);
      // 테두리 글로우
      g.lineStyle(2, 0xcc88ff, 0.7);
      g.strokeRect(px + 2, py + 2, TILE_SIZE - 4, TILE_SIZE - 4);
      break;
    }

    default: break;
  }
}

/* ─── Explorer 캐릭터 스프라이트 ─────────────────────────────── */
function drawExplorerSprite(g, isOracle) {
  const px = explorerPos.x * TILE_SIZE;
  const py = explorerPos.y * TILE_SIZE;
  const cx = px + TILE_SIZE / 2;
  const cy = py + TILE_SIZE / 2;

  if (isOracle) {
    // Oracle 뷰: 펄스 원 + 십자 마커
    const t     = (gameScene && gameScene.time) ? gameScene.time.now : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.004);
    const pRad  = TILE_SIZE * 0.38 + pulse * 5;

    // 외곽 펄스 링
    g.lineStyle(2.5, 0x00ff88, 0.25 + 0.5 * pulse);
    g.strokeCircle(cx, cy, pRad);

    // 채워진 마커 원
    g.fillStyle(0x00ff88, 0.82);
    g.fillCircle(cx, cy, TILE_SIZE * 0.20);
    g.lineStyle(2, 0x00cc66, 1);
    g.strokeCircle(cx, cy, TILE_SIZE * 0.20);

    // 십자 오버레이
    const cLen = TILE_SIZE * 0.30;
    g.lineStyle(2.5, 0xffffff, 0.88);
    g.lineBetween(cx - cLen, cy, cx + cLen, cy);
    g.lineBetween(cx, cy - cLen, cx, cy + cLen);

    // 중심 점
    g.fillStyle(0xffffff, 1);
    g.fillCircle(cx, cy, 3);

  } else {
    // Explorer 뷰: 인체 실루엣 (머리 + 몸통)
    const headR  = TILE_SIZE * 0.11;
    const bodyR  = TILE_SIZE * 0.18;
    const headCY = cy - TILE_SIZE * 0.13;
    const bodyCY = cy + TILE_SIZE * 0.08;

    // 외곽 글로우
    g.fillStyle(0x00ff88, 0.14);
    g.fillCircle(cx, cy, TILE_SIZE * 0.38);
    g.fillStyle(0x00ff88, 0.07);
    g.fillCircle(cx, cy, TILE_SIZE * 0.47);

    // 몸통
    g.fillStyle(C.EXPLORER, 0.88);
    g.fillCircle(cx, bodyCY, bodyR);
    g.lineStyle(1.5, 0x00cc66, 0.85);
    g.strokeCircle(cx, bodyCY, bodyR);

    // 머리
    g.fillStyle(C.EXPLORER, 1);
    g.fillCircle(cx, headCY, headR);
    g.lineStyle(1.5, 0x00cc66, 1);
    g.strokeCircle(cx, headCY, headR);

    // 눈
    g.fillStyle(0x001a0d, 1);
    g.fillCircle(cx - 3, headCY, 1.8);
    g.fillCircle(cx + 3, headCY, 1.8);
  }
}

/* ─── Oracle 전용: Explorer 좌표 레이블 ─────────────────────── */
function drawCoordLabel() {
  // Phaser Text 대신 Graphics로 간단 오버레이 배경
  const g = gameScene._textLayer;
  g.clear();

  // 텍스트는 Scene.add.text() 로 만들어야 하므로 초기 1회만 생성
  if (!gameScene._coordText) {
    gameScene._coordText = gameScene.add.text(
      MAP_COLS * TILE_SIZE - 6, MAP_ROWS * TILE_SIZE - 6,
      '',
      {
        font: '13px monospace',
        fill: '#00ff88',
        backgroundColor: 'rgba(0,0,0,0.55)',
        padding: { x: 4, y: 2 }
      }
    ).setOrigin(1, 1).setDepth(30);
  }

  gameScene._coordText.setText(
    `Explorer (${explorerPos.x}, ${explorerPos.y})`
  );
}
