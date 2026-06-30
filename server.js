const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const locations = require('./words.json');

const PORT = process.env.PORT || 3000;
const DISCUSSION_SECONDS = 240; // 4 minutes
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json'
};

// ---------- Static file server ----------
const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);

  // Prevent path traversal outside the public dir
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// ---------- Game state ----------
// rooms: code -> { code, hostId, players: [{id,name,ws,role,isImposter}], phase, votes, realLocation, imposterLocationName, imposterId, timer, readyIds }
const rooms = new Map();

function generateRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, avoids confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg, exceptId = null) {
  for (const p of room.players) {
    if (p.id !== exceptId) send(p.ws, msg);
  }
}

function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name }));
}

function sendRoomState(room) {
  broadcast(room, {
    type: 'room_state',
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room),
    phase: room.phase
  });
}

function clearTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function startRound(room) {
  clearTimer(room);

  const mainLoc = locations[Math.floor(Math.random() * locations.length)];
  let impLoc;
  do {
    impLoc = locations[Math.floor(Math.random() * locations.length)];
  } while (impLoc.location === mainLoc.location);

  const imposterIndex = Math.floor(Math.random() * room.players.length);
  const shuffledChars = [...mainLoc.characters].sort(() => Math.random() - 0.5);

  room.players.forEach((p, i) => {
    if (i === imposterIndex) {
      const impChar = impLoc.characters[Math.floor(Math.random() * impLoc.characters.length)];
      p.role = { location: impLoc.location, character: impChar };
      p.isImposter = true;
    } else {
      p.role = { location: mainLoc.location, character: shuffledChars[i % shuffledChars.length] };
      p.isImposter = false;
    }
  });

  room.realLocation = mainLoc.location;
  room.imposterLocationName = impLoc.location;
  room.imposterId = room.players[imposterIndex].id;
  room.votes = {};
  room.readyIds = new Set();
  room.phase = 'role';

  room.players.forEach(p => {
    send(p.ws, { type: 'role', location: p.role.location, character: p.role.character });
  });

  sendRoomState(room);
}

function startDiscussion(room) {
  room.phase = 'discussion';
  let remaining = DISCUSSION_SECONDS;
  broadcast(room, { type: 'discussion_start', duration: remaining });
  sendRoomState(room);

  clearTimer(room);
  room.timerInterval = setInterval(() => {
    remaining -= 1;
    broadcast(room, { type: 'timer', remaining });
    if (remaining <= 0) {
      clearTimer(room);
      startVoting(room);
    }
  }, 1000);
}

function startVoting(room) {
  clearTimer(room);
  room.phase = 'voting';
  room.votes = {};
  broadcast(room, { type: 'voting_start', players: publicPlayers(room) });
  sendRoomState(room);
}

function maybeFinishVoting(room) {
  const votedCount = Object.keys(room.votes).length;
  broadcast(room, { type: 'vote_progress', voted: votedCount, total: room.players.length });
  if (votedCount >= room.players.length) {
    finishVoting(room);
  }
}

function finishVoting(room) {
  clearTimer(room);
  room.phase = 'results';

  const tallyMap = new Map();
  for (const p of room.players) tallyMap.set(p.id, 0);
  for (const targetId of Object.values(room.votes)) {
    if (tallyMap.has(targetId)) tallyMap.set(targetId, tallyMap.get(targetId) + 1);
  }

  const tally = room.players
    .map(p => ({ id: p.id, name: p.name, count: tallyMap.get(p.id) || 0 }))
    .sort((a, b) => b.count - a.count);

  const topCount = tally.length ? tally[0].count : 0;
  const topPlayers = tally.filter(t => t.count === topCount && topCount > 0);
  const caught = topPlayers.length === 1 && topPlayers[0].id === room.imposterId;

  const imposter = room.players.find(p => p.id === room.imposterId);

  broadcast(room, {
    type: 'results',
    votes: room.votes,
    tally,
    imposterId: room.imposterId,
    imposterName: imposter ? imposter.name : '???',
    realLocation: room.realLocation,
    imposterLocation: room.imposterLocationName,
    imposterCharacter: imposter && imposter.role ? imposter.role.character : '???',
    caught
  });

  sendRoomState(room);
}

function removePlayer(room, playerId) {
  room.players = room.players.filter(p => p.id !== playerId);
  if (room.players.length === 0) {
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
  }
  sendRoomState(room);
}

wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'create_room') {
      const name = (msg.name || 'Player').toString().slice(0, 20).trim() || 'Player';
      const code = generateRoomCode();
      playerId = generateId();
      roomCode = code;

      const room = {
        code,
        hostId: playerId,
        players: [{ id: playerId, name, ws, role: null, isImposter: false }],
        phase: 'lobby',
        votes: {},
        timerInterval: null,
        readyIds: new Set()
      };
      rooms.set(code, room);

      send(ws, { type: 'room_created', code, playerId });
      sendRoomState(room);
      return;
    }

    if (msg.type === 'join_room') {
      const code = (msg.code || '').toString().toUpperCase().trim();
      const name = (msg.name || 'Player').toString().slice(0, 20).trim() || 'Player';
      const room = rooms.get(code);

      if (!room) {
        send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
        return;
      }
      if (room.phase !== 'lobby') {
        send(ws, { type: 'error', message: 'This game already started. Ask the host to start a new round once it ends.' });
        return;
      }

      playerId = generateId();
      roomCode = code;
      room.players.push({ id: playerId, name, ws, role: null, isImposter: false });

      send(ws, { type: 'room_joined', code, playerId });
      sendRoomState(room);
      return;
    }

    // Everything below requires an existing room/player
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room || !playerId) return;

    if (msg.type === 'start_game') {
      if (playerId !== room.hostId) return;
      if (room.players.length < 3) {
        send(ws, { type: 'error', message: 'Need at least 3 players to start.' });
        return;
      }
      startRound(room);
      return;
    }

    if (msg.type === 'ready') {
      if (room.phase !== 'role') return;
      room.readyIds.add(playerId);
      broadcast(room, { type: 'ready_progress', ready: room.readyIds.size, total: room.players.length });
      if (room.readyIds.size >= room.players.length) {
        startDiscussion(room);
      }
      return;
    }

    if (msg.type === 'end_discussion') {
      if (playerId !== room.hostId) return;
      if (room.phase !== 'discussion') return;
      startVoting(room);
      return;
    }

    if (msg.type === 'cast_vote') {
      if (room.phase !== 'voting') return;
      const targetId = msg.targetId;
      if (!room.players.find(p => p.id === targetId)) return;
      room.votes[playerId] = targetId;
      maybeFinishVoting(room);
      return;
    }

    if (msg.type === 'play_again') {
      if (playerId !== room.hostId) return;
      if (room.players.length < 3) {
        send(ws, { type: 'error', message: 'Need at least 3 players to start.' });
        return;
      }
      startRound(room);
      return;
    }
  });

  ws.on('close', () => {
    if (roomCode && playerId) {
      const room = rooms.get(roomCode);
      if (room) removePlayer(room, playerId);
    }
  });
});

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }

  console.log('\n🎭  Imposter Party is running!\n');
  console.log(`   On this computer:  http://localhost:${PORT}`);
  if (addresses.length) {
    addresses.forEach(addr => {
      console.log(`   For friends on your WiFi:  http://${addr}:${PORT}`);
    });
  } else {
    console.log('   Could not detect your local network IP. Run `ifconfig` / `ipconfig` to find it.');
  }
  console.log('\nShare that WiFi link with your friends. Press Ctrl+C to stop the server.\n');
});
