'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const fs        = require('fs');

// ─────────────────────────────────────────────────────────────
//  HTTP + Socket.IO 초기화
// ─────────────────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
//  타일 ID 상수
// ─────────────────────────────────────────────────────────────
const TILE = Object.freeze({
  WALL:        0,
  FLOOR:       1,
  TRAP:        2,
  DOOR_LOCKED: 3,
  DOOR_OPEN:   4,
  KEY:         5,
  EXIT:        6,
  FUSION:      7
});

// ─────────────────────────────────────────────────────────────
//  맵 데이터 — 17×13 고정 (BASE_MAP은 불변, 동적 상태는 roomState)
// ─────────────────────────────────────────────────────────────
const BASE_MAP = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,1,1,1,0,1,1,1,1,1,0,1,1,1,1,1,0],
  [0,1,0,1,0,1,0,1,0,1,0,1,0,0,0,1,0], // (7,2): WALL→FLOOR — 중간방→(7,3)TRAP 연결
  [0,1,0,1,3,1,0,2,0,1,3,1,0,2,0,1,0],
  [0,1,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0], // (3,4)(7,4)(11,4): WALL→FLOOR — KEY·FUSION 연결
  [0,1,0,5,0,2,0,7,0,2,0,5,0,0,0,1,0],
  [0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0],
  [0,1,0,2,0,1,0,2,0,1,0,2,0,2,0,1,0],
  [0,1,0,0,0,1,3,1,3,1,0,0,0,0,0,1,0],
  [0,1,1,1,0,1,0,0,0,1,0,1,1,1,1,1,0],
  [0,0,0,1,0,0,0,2,0,0,0,1,0,0,0,0,0],
  [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,6,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
];

const MAP_ROWS = BASE_MAP.length;     // 13
const MAP_COLS = BASE_MAP[0].length;  // 17

// FUSION 타일 좌표 (x,y)
const FUSION_TILE = Object.freeze({ x: 7, y: 5 });

// ─────────────────────────────────────────────────────────────
//  룸 팩토리
// ─────────────────────────────────────────────────────────────
function createRoom() {
  return {
    players:       {},            // socketId → { role:'explorer'|'oracle', nickname }
    explorerPos:   { x: 1, y: 1 },
    hp:            3,
    levers:        { A: false, B: false, C: false, D: false },
    doors: {
      A: { x: 4,  y: 3, open: false },
      B: { x: 10, y: 3, open: false },
      C: { x: 6,  y: 8, open: false },
      D: { x: 8,  y: 8, open: false }
    },
    collectedKeys: [],            // ['x,y', ...]
    fusionDone:    false,
    status:        'WAITING',     // WAITING|COUNTDOWN|PLAYING|FUSION_EVENT|CLEAR|GAME_OVER
    startTime:     null,          // Date.now() at game_start
    _cdTimer:      null           // setInterval handle for countdown
  };
}

// ─────────────────────────────────────────────────────────────
//  state_update 페이로드 생성 (deep-copy)
// ─────────────────────────────────────────────────────────────
function stateSnapshot(room) {
  return {
    explorerPos:   { ...room.explorerPos },
    hp:            room.hp,
    levers:        { ...room.levers },
    doors: {
      A: { ...room.doors.A },
      B: { ...room.doors.B },
      C: { ...room.doors.C },
      D: { ...room.doors.D }
    },
    collectedKeys: [...room.collectedKeys],
    status:        room.status
  };
}

// ─────────────────────────────────────────────────────────────
//  타일 조회 — 동적 상태(문·열쇠) 반영
// ─────────────────────────────────────────────────────────────
function tileAt(x, y, room) {
  if (x < 0 || x >= MAP_COLS || y < 0 || y >= MAP_ROWS) return TILE.WALL;

  // 동적 문 상태 우선
  for (const door of Object.values(room.doors)) {
    if (door.x === x && door.y === y) {
      return door.open ? TILE.DOOR_OPEN : TILE.DOOR_LOCKED;
    }
  }

  // 이미 수집된 열쇠 → 바닥
  if (room.collectedKeys.includes(`${x},${y}`)) return TILE.FLOOR;

  return BASE_MAP[y][x];
}

// ─────────────────────────────────────────────────────────────
//  융합 트리거 체크 (이벤트 after move/lever)
// ─────────────────────────────────────────────────────────────
function checkFusion(roomId, room) {
  if (room.fusionDone)            return false;
  if (room.status !== 'PLAYING')  return false;
  if (!room.levers.D)             return false;

  // Chebyshev 거리 ≤ 1 검사
  const dx = Math.abs(room.explorerPos.x - FUSION_TILE.x);
  const dy = Math.abs(room.explorerPos.y - FUSION_TILE.y);
  if (Math.max(dx, dy) > 1)      return false;

  // 융합 발동
  room.status      = 'FUSION_EVENT';
  room.fusionDone  = true;
  room.doors.C.open = true;
  room.doors.D.open = true;

  io.to(roomId).emit('fusion_event', { pos: { ...FUSION_TILE } });

  setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r) return;
    r.status = 'PLAYING';
    io.to(roomId).emit('state_update', stateSnapshot(r));
  }, 2000);

  return true;
}

// ─────────────────────────────────────────────────────────────
//  룸 저장소
// ─────────────────────────────────────────────────────────────
const rooms = new Map();   // roomId → roomState

// ─────────────────────────────────────────────────────────────
//  HTTP 라우트
// ─────────────────────────────────────────────────────────────

// 헬스체크 — static 보다 먼저 등록해 정적 파일 우회 차단
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// 정적 파일 서빙 (프론트엔드 팀 산출물)
app.use(express.static(path.join(__dirname, 'public')));

// 폴백: public/index.html 미생성 시 200 OK 텍스트 반환
app.get('/', (_req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) {
    res.sendFile(idx);
  } else {
    res.send('OK');
  }
});

// ─────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentRole   = null;

  // ── join_room ──────────────────────────────────────────────
  socket.on('join_room', (data = {}) => {
    const { roomId, nickname } = data;
    if (!roomId || typeof roomId !== 'string') return;

    const cleanNick = String(nickname || 'Player').trim().slice(0, 20) || 'Player';

    let room = rooms.get(roomId);
    if (!room) {
      room = createRoom();
      rooms.set(roomId, room);
    }

    const count = Object.keys(room.players).length;

    if (count >= 2) {
      socket.emit('room_full', { roomId });
      return;
    }

    // 역할 배정: 첫 입장=explorer, 두 번째=oracle
    const role = count === 0 ? 'explorer' : 'oracle';

    room.players[socket.id] = { role, nickname: cleanNick };
    currentRoomId = roomId;
    currentRole   = role;

    socket.join(roomId);
    socket.emit('room_joined', { role, roomId });

    // 2인 모두 입장 시 카운트다운 → 게임 시작
    if (Object.keys(room.players).length === 2) {
      room.status = 'COUNTDOWN';
      let tick = 3;
      io.to(roomId).emit('countdown', { count: tick });

      room._cdTimer = setInterval(() => {
        tick--;
        if (tick > 0) {
          io.to(roomId).emit('countdown', { count: tick });
        } else {
          clearInterval(room._cdTimer);
          room._cdTimer = null;
          room.status    = 'PLAYING';
          room.startTime = Date.now();

          io.to(roomId).emit('game_start', {
            map:         BASE_MAP,
            explorerPos: { ...room.explorerPos },
            hp:          room.hp,
            players:     Object.fromEntries(
              Object.entries(room.players).map(([id, p]) => [
                id, { role: p.role, nickname: p.nickname }
              ])
            )
          });
        }
      }, 1000);
    }
  });

  // ── player_move ────────────────────────────────────────────
  socket.on('player_move', (data = {}) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (currentRole !== 'explorer')  return;
    if (room.status !== 'PLAYING')   return;

    // 입력 검증: 정확히 한 축 ±1
    const ndx = Math.sign(Number(data.dx) || 0);
    const ndy = Math.sign(Number(data.dy) || 0);
    if (Math.abs(ndx) + Math.abs(ndy) !== 1) return;

    const nx = room.explorerPos.x + ndx;
    const ny = room.explorerPos.y + ndy;
    const tile = tileAt(nx, ny, room);

    // 이동 불가 — 벽·잠긴 문
    if (tile === TILE.WALL || tile === TILE.DOOR_LOCKED) return;

    // 이동 확정
    room.explorerPos = { x: nx, y: ny };

    // ── 타일 효과 ──
    if (tile === TILE.TRAP) {
      room.hp -= 1;
      if (room.hp <= 0) {
        room.hp     = 0;
        room.status = 'GAME_OVER';
        io.to(currentRoomId).emit('state_update', stateSnapshot(room));
        io.to(currentRoomId).emit('game_over', {});
        return;
      }
    } else if (tile === TILE.KEY) {
      const keyStr = `${nx},${ny}`;
      if (!room.collectedKeys.includes(keyStr)) {
        room.collectedKeys.push(keyStr);
      }
    } else if (tile === TILE.EXIT) {
      room.status   = 'CLEAR';
      const elapsed = room.startTime
        ? Math.floor((Date.now() - room.startTime) / 1000)
        : 0;
      io.to(currentRoomId).emit('state_update', stateSnapshot(room));
      io.to(currentRoomId).emit('game_clear', { time: elapsed });
      return;
    }

    // 융합 체크
    if (!checkFusion(currentRoomId, room)) {
      io.to(currentRoomId).emit('state_update', stateSnapshot(room));
    }
  });

  // ── lever_toggle ───────────────────────────────────────────
  socket.on('lever_toggle', (data = {}) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (currentRole !== 'oracle')   return;
    if (room.status !== 'PLAYING')  return;

    const { lever } = data;
    if (!['A', 'B', 'C', 'D'].includes(lever)) return;

    room.levers[lever] = !room.levers[lever];

    // 레버 A/B/C → 해당 문 즉시 제어
    // 레버 D → 문 직접 제어 안 함 (융합 조건에만 사용)
    if (lever !== 'D') {
      room.doors[lever].open = room.levers[lever];
    }

    // 융합 체크 (레버 D ON + Explorer 근접 시 트리거)
    if (!checkFusion(currentRoomId, room)) {
      io.to(currentRoomId).emit('state_update', stateSnapshot(room));
    }
  });

  // ── chat_msg ───────────────────────────────────────────────
  socket.on('chat_msg', (data = {}) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    const cleanText = String(data.text || '').slice(0, 200).trim();
    if (!cleanText) return;

    io.to(currentRoomId).emit('chat_msg', {
      from: player.nickname,
      text: cleanText,
      role: player.role
    });
  });

  // ── disconnect ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    delete room.players[socket.id];

    // 카운트다운 진행 중이라면 정리
    if (room._cdTimer) {
      clearInterval(room._cdTimer);
      room._cdTimer = null;
    }

    // 남은 플레이어에게 알림
    socket.to(currentRoomId).emit('partner_disconnected', {});

    // 빈 방 삭제
    if (Object.keys(room.players).length === 0) {
      rooms.delete(currentRoomId);
    }
  });
});

// ─────────────────────────────────────────────────────────────
//  서버 시작
// ─────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[Dungeon Escape] Server listening on port ${PORT}`);
});
