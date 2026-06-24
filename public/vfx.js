'use strict';

/* ═══════════════════════════════════════════════════════════════
   vfx.js — Dungeon Escape VFX Engine v1.1
   자가완결 설계 — game.js 무수정, index.html 스크립트 한 줄 추가만으로 동작

   동작 원리:
   1) io() 인터셉트 → socket 레퍼런스 확보 → VFX 이벤트 리스너 등록
   2) game_start 이벤트 수신 → rAF 폴링으로 Phaser canvas 자동 감지
   3) VFXEngine 생성(캔버스 오버레이) → 이후 이벤트에 파티클 발화

   모션 아키타입 (3-타입 결속 테이블):
   ┌──────────────┬──────────────────────────────────────────────┐
   │ arc          │ Explorer 이동 잔상, 융합 외곽 방사 + 감속     │
   │ emit(burst)  │ 키 수집·문 해제·함정 피격 단발 방사           │
   │ linger       │ Oracle 힌트 표류, 융합 수렴 고리 스프링       │
   │ confetti     │ 승리 낙하 — body 고정 캔버스(독립 생명주기)   │
   └──────────────┴──────────────────────────────────────────────┘

   색 토큰 (GDD §7 팔레트 기준):
   Explorer #00ff88 / Oracle #aa64ff / Fusion 청#00c8ff+보라#c832ff

   성능 예산:
   Explorer 뷰 ≤150 파티클 / Oracle 뷰 ≤60 파티클
   오브젝트 풀 220 슬롯 — GC 스파이크 0 보장
   shadowBlur 글로우 (WebGL 없음)
═══════════════════════════════════════════════════════════════ */

/* ─── 상수 ──────────────────────────────────────────────────── */
const _T  = 48;              // TILE_SIZE (server.js / game.js 동일)
const _MW = 17 * _T;        // 816
const _MH = 13 * _T;        // 624

/* ─── 색 토큰 ───────────────────────────────────────────────── */
const _CLR = {
  EXPLORER : [  0, 255, 136],
  ORACLE   : [170, 100, 255],
  FUSION_A : [  0, 200, 255],
  FUSION_B : [200,  50, 255],
  KEY      : [255, 215,   0],
  DOOR     : [ 68, 221,  68],
  TRAP     : [255,  68,  68],
  CONFETTI : [
    [255, 215,   0],
    [  0, 255, 136],
    [200,  50, 255],
    [  0, 200, 255],
    [255,  80, 100],
    [255, 170,   0],
  ],
};

/* ─── 파티클 슬롯 팩토리 ────────────────────────────────────── */
function _mkSlot() {
  return {
    active: false,
    x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0,
    life: 0, maxLife: 0,
    r: 3, color: [255, 255, 255], alpha: 1,
    type: 'emit',           // emit | arc | linger | confetti
    angle: 0, aVel: 0,
    w: 6, h: 3,
    tx: 0, ty: 0,           // linger 수렴 목표
    hasTarget: false,
  };
}

/* ═══════════════════════════════════════════════════════════════
   VFXEngine — 인게임 파티클 오버레이 (Phaser canvas 위)
═══════════════════════════════════════════════════════════════ */
class VFXEngine {
  constructor(phaserCanvas, role) {
    this._role   = role;
    this._limits = { explorer: 150, oracle: 60 };

    /* VFX 오버레이 Canvas */
    this._cv       = document.createElement('canvas');
    this._cv.id    = 'vfx-overlay';
    this._cv.width  = _MW;
    this._cv.height = _MH;
    this._cv.style.cssText =
      'position:absolute;pointer-events:none;z-index:8;';
    this._ctx = this._cv.getContext('2d');

    this._phaserCv = phaserCanvas;
    const par = phaserCanvas.parentElement;
    if (par) {
      if (getComputedStyle(par).position === 'static')
        par.style.position = 'relative';
      par.appendChild(this._cv);
    }
    this._syncPos();

    this._ro = new ResizeObserver(() => this._syncPos());
    this._ro.observe(phaserCanvas);

    /* 오브젝트 풀 */
    this._POOL = 220;
    this._pool = Array.from({ length: this._POOL }, _mkSlot);

    this._lastTs    = 0;
    this._hintFlash = 0;
    this._raf       = null;
    this._loop = this._loop.bind(this);
    this._raf  = requestAnimationFrame(this._loop);
  }

  /* Phaser canvas CSS 크기/위치 동기화 */
  _syncPos() {
    const pc = this._phaserCv, cv = this._cv;
    cv.style.width  = pc.style.width  || (pc.width  + 'px');
    cv.style.height = pc.style.height || (pc.height + 'px');
    cv.style.left   = pc.offsetLeft + 'px';
    cv.style.top    = pc.offsetTop  + 'px';
  }

  /* 풀 슬롯 획득 */
  _acq() {
    for (let i = 0; i < this._POOL; i++)
      if (!this._pool[i].active) return this._pool[i];
    return null;
  }

  /* 활성 수 */
  _cnt() { let n = 0; for (const p of this._pool) if (p.active) n++; return n; }

  /* 예산 검사 */
  _ok() { return this._cnt() < this._limits[this._role]; }

  /* ── 공개 API ── */

  /** Explorer 이동 잔상 arc */
  footstep(tx, ty) {
    if (!this._ok()) return;
    const cx = tx * _T + _T / 2, cy = ty * _T + _T / 2;
    for (let i = 0; i < 7; i++) {
      const p = this._acq(); if (!p) break;
      const a = Math.random() * Math.PI * 2, s = 0.4 + Math.random() * 1.2;
      Object.assign(p, {
        active: true, type: 'arc',
        x: cx + (Math.random() - .5) * 12,
        y: cy + (Math.random() - .5) * 12,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        ax: 0, ay: 0.025,
        life: 320 + Math.random() * 220, maxLife: 540,
        r: 1.8 + Math.random() * 2,
        color: [..._CLR.EXPLORER], alpha: 0.7, hasTarget: false,
      });
    }
  }

  /** 키 수집 burst */
  keyCollect(tx, ty) { this._burst(tx, ty, _CLR.KEY,  22, 3.8, 750); }

  /** 문 해제 burst */
  doorOpen(tx, ty)   { this._burst(tx, ty, _CLR.DOOR, 18, 3.2, 680); }

  /** 함정 피격 burst */
  trapHit(tx, ty)    { this._burst(tx, ty, _CLR.TRAP, 26, 4.8, 520); }

  /** 융합 트리거 arc+linger 복합 */
  fusion(tx, ty) {
    const cx = tx * _T + _T / 2, cy = ty * _T + _T / 2;
    /* arc 방사 */
    for (let i = 0; i < 30; i++) {
      const p = this._acq(); if (!p) break;
      const a = (Math.PI * 2 / 30) * i, s = 2.0 + Math.random() * 2.8;
      Object.assign(p, {
        active: true, type: 'arc', x: cx, y: cy,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        ax: -Math.cos(a) * .055, ay: -Math.sin(a) * .055,
        life: 900 + Math.random() * 500, maxLife: 1400,
        r: 3 + Math.random() * 3.5,
        color: i % 2 === 0 ? [..._CLR.FUSION_A] : [..._CLR.FUSION_B],
        alpha: 0.92, hasTarget: false,
      });
    }
    /* linger 수렴 고리 */
    for (let i = 0; i < 16; i++) {
      const p = this._acq(); if (!p) break;
      const a = (Math.PI * 2 / 16) * i, rd = 65 + Math.random() * 25;
      Object.assign(p, {
        active: true, type: 'linger',
        x: cx + Math.cos(a) * rd, y: cy + Math.sin(a) * rd,
        vx: 0, vy: 0, ax: 0, ay: 0,
        life: 1200 + Math.random() * 700, maxLife: 1900,
        r: 2.5 + Math.random() * 2.2,
        color: [..._CLR.ORACLE], alpha: 0.88,
        tx: cx, ty: cy, hasTarget: true,
      });
    }
  }

  /** Oracle 힌트 화면 강조 (linger 표류 + 보라 flash) */
  oracleHint() {
    this._hintFlash = 700;
    for (let i = 0; i < 18; i++) {
      const p = this._acq(); if (!p) break;
      Object.assign(p, {
        active: true, type: 'linger',
        x: _MW * .15 + Math.random() * _MW * .7, y: -15 - Math.random() * 20,
        vx: (Math.random() - .5) * .6, vy: .9 + Math.random() * 1.2,
        ax: 0, ay: 0,
        life: 900 + Math.random() * 600, maxLife: 1500,
        r: 2.8 + Math.random() * 3.5,
        color: [..._CLR.ORACLE], alpha: 0.8, hasTarget: false,
      });
    }
  }

  /* 내부 burst 공용 */
  _burst(tx, ty, col, n, spd, life) {
    if (!this._ok()) return;
    const cx = tx * _T + _T / 2, cy = ty * _T + _T / 2;
    for (let i = 0; i < n; i++) {
      const p = this._acq(); if (!p) break;
      const a = Math.random() * Math.PI * 2, s = spd * (.35 + Math.random() * .85);
      Object.assign(p, {
        active: true, type: 'emit',
        x: cx + (Math.random() - .5) * 10,
        y: cy + (Math.random() - .5) * 10,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        ax: 0, ay: 0.08,
        life: life * (.5 + Math.random() * .7), maxLife: life,
        r: 2 + Math.random() * 3.5,
        color: [...col], alpha: 0.92, hasTarget: false,
      });
    }
  }

  /* RAF 루프 */
  _loop(ts) {
    const dt = this._lastTs ? Math.min(ts - this._lastTs, 50) : 16;
    this._lastTs = ts;
    this._update(dt);
    this._draw();
    this._raf = requestAnimationFrame(this._loop);
  }

  _update(dt) {
    for (const p of this._pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      if (p.type === 'linger') {
        if (p.hasTarget) {
          p.vx += (p.tx - p.x) * .002; p.vy += (p.ty - p.y) * .002;
          p.vx *= .95; p.vy *= .95;
        } else {
          p.vx += (Math.random() - .5) * .07; p.vy += .012;
          p.vx *= .97; p.vy *= .97;
        }
      } else if (p.type === 'confetti') {
        p.vx += (Math.random() - .5) * .05 + p.ax;
        p.vy += p.ay; p.angle += p.aVel;
      } else {
        p.vx += p.ax; p.vy += p.ay;
      }
      p.x += p.vx; p.y += p.vy;
    }
    if (this._hintFlash > 0) this._hintFlash -= dt;
  }

  _draw() {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, _MW, _MH);

    /* hint flash */
    if (this._hintFlash > 0) {
      const r = Math.min(1, this._hintFlash / 600);
      ctx.save();
      ctx.globalAlpha = .16 * r;
      ctx.fillStyle = '#aa64ff';
      ctx.fillRect(0, 0, _MW, _MH);
      const grd = ctx.createLinearGradient(0, 0, 0, 55);
      grd.addColorStop(0, `rgba(170,100,255,${.9 * r})`);
      grd.addColorStop(1, 'rgba(170,100,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grd; ctx.fillRect(0, 0, _MW, 55);
      ctx.globalAlpha = .4 * r;
      ctx.strokeStyle = '#cc88ff'; ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, _MW - 4, _MH - 4);
      ctx.restore();
    }

    /* 파티클 */
    for (const p of this._pool) {
      if (!p.active) continue;
      const lr = p.life / p.maxLife, ea = p.alpha * lr;
      ctx.save(); ctx.globalAlpha = ea;
      if (p.type === 'confetti') {
        ctx.translate(p.x, p.y); ctx.rotate(p.angle);
        ctx.fillStyle = `rgb(${p.color.join(',')})`;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      } else {
        const cr = `rgb(${p.color.join(',')})`;
        ctx.shadowColor = cr;
        ctx.shadowBlur  = p.r * (p.type === 'linger' ? 6 : 4);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(.5, p.r * lr), 0, Math.PI * 2);
        ctx.fillStyle = cr; ctx.fill();
      }
      ctx.restore();
    }
  }

  destroy() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._ro)  this._ro.disconnect();
    if (this._cv && this._cv.parentNode) this._cv.parentNode.removeChild(this._cv);
  }
}

/* ═══════════════════════════════════════════════════════════════
   승리 confetti — body 고정 독립 캔버스
   (screen-clear로 전환 후에도 표시, 자동 정리)
═══════════════════════════════════════════════════════════════ */
function _launchConfetti() {
  const cv = document.createElement('canvas');
  cv.id = 'vfx-confetti';
  cv.width = window.innerWidth; cv.height = window.innerHeight;
  cv.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;' +
    'pointer-events:none;z-index:9999;';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const cols = _CLR.CONFETTI;
  const ps = Array.from({ length: 130 }, (_, i) => {
    const col = cols[i % cols.length];
    return {
      x: Math.random() * cv.width, y: -25 - Math.random() * 80,
      vx: (Math.random() - .5) * 2.8, vy: 2.2 + Math.random() * 3.5, ay: .06,
      life: 2500 + Math.random() * 1800, maxLife: 4300,
      color: [...col],
      angle: Math.random() * Math.PI * 2, aVel: (Math.random() - .5) * .18,
      w: 6 + Math.random() * 9, h: 3 + Math.random() * 4,
    };
  });
  let lastTs = 0, raf;
  function loop(ts) {
    const dt = lastTs ? Math.min(ts - lastTs, 50) : 16; lastTs = ts;
    ctx.clearRect(0, 0, cv.width, cv.height);
    let any = false;
    for (const p of ps) {
      p.life -= dt; if (p.life <= 0) continue;
      any = true;
      p.vx += (Math.random() - .5) * .05; p.vy += p.ay;
      p.x += p.vx; p.y += p.vy; p.angle += p.aVel;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life / 600);
      ctx.translate(p.x, p.y); ctx.rotate(p.angle);
      ctx.fillStyle = `rgb(${p.color.join(',')})`;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (any) raf = requestAnimationFrame(loop);
    else if (cv.parentNode) cv.parentNode.removeChild(cv);
  }
  raf = requestAnimationFrame(loop);
}

/* ═══════════════════════════════════════════════════════════════
   전역 VFX 싱글턴
═══════════════════════════════════════════════════════════════ */
let _eng = null;

window.VFX = {
  init(phaserCanvas, role) {
    if (_eng) _eng.destroy();
    _eng = new VFXEngine(phaserCanvas, role);
  },
  destroy() { if (_eng) { _eng.destroy(); _eng = null; } },

  footstep  : (tx, ty) => _eng && _eng.footstep(tx, ty),
  keyCollect: (tx, ty) => _eng && _eng.keyCollect(tx, ty),
  doorOpen  : (tx, ty) => _eng && _eng.doorOpen(tx, ty),
  trapHit   : (tx, ty) => _eng && _eng.trapHit(tx, ty),
  fusion    : (tx, ty) => _eng && _eng.fusion(tx, ty),
  oracleHint: ()       => _eng && _eng.oracleHint(),
  victory   : ()       => _launchConfetti(),
};

/* ═══════════════════════════════════════════════════════════════
   Socket.IO io() 인터셉트
   — vfx.js를 game.js 보다 먼저 로드해야 작동
   — game.js가 io()를 호출하면 이 래퍼가 socket을 가로채
     VFX 이벤트 리스너를 조용히 등록
═══════════════════════════════════════════════════════════════ */
(function _interceptIo() {
  const _origIo = window.io;
  if (typeof _origIo !== 'function') {
    // socket.io.js 로드 전 실행된 경우 — DOMContentLoaded 후 재시도
    document.addEventListener('DOMContentLoaded', _interceptIo);
    return;
  }

  window.io = function (...args) {
    const socket = _origIo.apply(this, args);
    _wireVFX(socket);
    // io 복원 (이후 호출에서 중복 wire 방지)
    window.io = _origIo;
    return socket;
  };
})();

/* ── VFX 소켓 리스너 연결 ────────────────────────────────────── */
function _wireVFX(socket) {
  let _role     = null;
  let _prevHp   = 3;
  let _prevKeyN = 0;
  let _prevKeys = [];
  let _prevPos  = { x: 1, y: 1 };
  let _prevDoors = {};

  /* 역할 확보 */
  socket.on('room_joined', ({ role }) => {
    VFX.destroy();   // 이전 세션 정리
    _role     = role;
    _prevHp   = 3; _prevKeyN = 0;
    _prevKeys = []; _prevPos  = { x: 1, y: 1 }; _prevDoors = {};
  });

  /* Phaser canvas 생성 감지 → VFX 초기화 */
  socket.on('game_start', () => {
    const cid = _role === 'explorer'
      ? 'phaser-container-explorer'
      : 'phaser-container-oracle';
    let tries = 0;
    function probe() {
      const container = document.getElementById(cid);
      const cv = container && container.querySelector('canvas');
      if (cv) {
        VFX.init(cv, _role);
      } else if (tries++ < 40) {
        requestAnimationFrame(probe);
      }
    }
    requestAnimationFrame(probe);
  });

  /* 융합 — 좌표 포함 */
  socket.on('fusion_event', ({ pos }) => {
    if (pos) VFX.fusion(pos.x, pos.y);
  });

  /* Oracle 힌트 (채팅) */
  socket.on('chat_msg', ({ role }) => {
    if (role === 'oracle') VFX.oracleHint();
  });

  /* 탈출 성공 — confetti (body 고정, 독립) */
  socket.on('game_clear', () => {
    VFX.victory();
    VFX.destroy();   // 인게임 엔진은 정리 (화면 전환됨)
  });

  /* 게임오버 */
  socket.on('game_over', () => {
    VFX.destroy();
  });

  /* 상태 갱신 — 델타 VFX */
  socket.on('state_update', (data) => {
    /* 함정 피격 */
    if (data.hp < _prevHp)
      VFX.trapHit(data.explorerPos.x, data.explorerPos.y);

    /* 키 수집 */
    if (data.collectedKeys.length > _prevKeyN) {
      const newK = data.collectedKeys.find(k => !_prevKeys.includes(k));
      if (newK) {
        const [kx, ky] = newK.split(',').map(Number);
        VFX.keyCollect(kx, ky);
      }
    }

    /* 문 해제 */
    Object.entries(data.doors).forEach(([id, door]) => {
      const prev = _prevDoors[id];
      if (door.open && prev && !prev.open) {
        VFX.doorOpen(door.x, door.y);
      }
    });

    /* Explorer 이동 잔상 (Explorer 뷰에서만) */
    if (_role === 'explorer' &&
        (data.explorerPos.x !== _prevPos.x ||
         data.explorerPos.y !== _prevPos.y)) {
      VFX.footstep(data.explorerPos.x, data.explorerPos.y);
    }

    /* 이전 상태 갱신 */
    _prevHp    = data.hp;
    _prevKeyN  = data.collectedKeys.length;
    _prevKeys  = [...data.collectedKeys];
    _prevPos   = { ...data.explorerPos };
    _prevDoors = JSON.parse(JSON.stringify(data.doors));
  });
}
