(() => {
  const screens = {};
  document.querySelectorAll('.screen').forEach(el => screens[el.id] = el);

  function showScreen(id) {
    Object.values(screens).forEach(el => el.classList.remove('active'));
    screens[id].classList.add('active');
  }

  // ---------- State ----------
  let ws = null;
  let myId = null;
  let myHostId = null;
  let myCode = null;
  let myName = '';
  let votedFor = null;

  // ---------- Elements ----------
  const homeName = document.getElementById('home-name');
  const homeError = document.getElementById('home-error');
  const btnShowCreate = document.getElementById('btn-show-create');
  const btnShowJoin = document.getElementById('btn-show-join');
  const joinBox = document.getElementById('join-box');
  const joinCode = document.getElementById('join-code');
  const btnJoin = document.getElementById('btn-join');

  const lobbyCode = document.getElementById('lobby-code');
  const lobbyPlayers = document.getElementById('lobby-players');
  const btnStart = document.getElementById('btn-start');
  const lobbyWait = document.getElementById('lobby-wait');
  const lobbyMinHint = document.getElementById('lobby-min-hint');

  const roleLocation = document.getElementById('role-location');
  const roleCharacter = document.getElementById('role-character');
  const btnReady = document.getElementById('btn-ready');
  const readyProgress = document.getElementById('ready-progress');

  const discussionTimer = document.getElementById('discussion-timer');
  const btnEndDiscussion = document.getElementById('btn-end-discussion');

  const votingPlayers = document.getElementById('voting-players');
  const voteProgress = document.getElementById('vote-progress');

  const resultsHeadline = document.getElementById('results-headline');
  const resultImposterName = document.getElementById('result-imposter-name');
  const resultRealLocation = document.getElementById('result-real-location');
  const resultImposterLocation = document.getElementById('result-imposter-location');
  const resultsTally = document.getElementById('results-tally');
  const btnPlayAgain = document.getElementById('btn-play-again');
  const resultsWait = document.getElementById('results-wait');

  function showHomeError(message) {
    homeError.textContent = message;
    homeError.classList.remove('hidden');
  }
  function clearHomeError() {
    homeError.classList.add('hidden');
  }

  function connect(onOpen) {
    if (ws && ws.readyState === WebSocket.OPEN) { onOpen(); return; }
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}`);
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', handleMessage);
    ws.addEventListener('close', () => {
      showHomeError('Connection lost. Please refresh to rejoin.');
    });
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ---------- Home actions ----------
  btnShowCreate.addEventListener('click', () => {
    clearHomeError();
    myName = homeName.value.trim() || 'Player';
    connect(() => send({ type: 'create_room', name: myName }));
  });

  btnShowJoin.addEventListener('click', () => {
    clearHomeError();
    joinBox.classList.toggle('hidden');
  });

  btnJoin.addEventListener('click', () => {
    clearHomeError();
    myName = homeName.value.trim() || 'Player';
    const code = joinCode.value.trim().toUpperCase();
    if (code.length !== 4) {
      showHomeError('Enter the 4-letter room code.');
      return;
    }
    connect(() => send({ type: 'join_room', code, name: myName }));
  });

  // ---------- Lobby ----------
  btnStart.addEventListener('click', () => send({ type: 'start_game' }));

  // ---------- Role ----------
  btnReady.addEventListener('click', () => {
    btnReady.disabled = true;
    btnReady.textContent = 'Waiting for everyone…';
    send({ type: 'ready' });
  });

  // ---------- Discussion ----------
  btnEndDiscussion.addEventListener('click', () => send({ type: 'end_discussion' }));

  function formatTime(totalSeconds) {
    const m = Math.max(0, Math.floor(totalSeconds / 60));
    const s = Math.max(0, totalSeconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ---------- Voting ----------
  function renderVotingPlayers(players) {
    votingPlayers.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = p.name + (p.id === myId ? ' (you)' : '');
      btn.addEventListener('click', () => {
        votedFor = p.id;
        Array.from(votingPlayers.querySelectorAll('button')).forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        send({ type: 'cast_vote', targetId: p.id });
      });
      li.appendChild(btn);
      votingPlayers.appendChild(li);
    });
  }

  // ---------- Play again ----------
  btnPlayAgain.addEventListener('click', () => send({ type: 'play_again' }));

  // ---------- Message handling ----------
  function handleMessage(event) {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'room_created':
      case 'room_joined': {
        myId = msg.playerId;
        myCode = msg.code;
        lobbyCode.textContent = myCode;
        showScreen('screen-lobby');
        break;
      }

      case 'room_state': {
        myHostId = msg.hostId;
        const isHost = myId === myHostId;

        if (msg.phase === 'lobby') {
          lobbyPlayers.innerHTML = '';
          msg.players.forEach(p => {
            const li = document.createElement('li');
            li.textContent = p.name + (p.id === myHostId ? '' : '');
            if (p.id === myHostId) {
              const crown = document.createElement('span');
              crown.className = 'crown';
              crown.textContent = '👑';
              li.appendChild(crown);
            }
            lobbyPlayers.appendChild(li);
          });

          const enoughPlayers = msg.players.length >= 3;
          if (isHost) {
            btnStart.classList.remove('hidden');
            btnStart.disabled = !enoughPlayers;
            btnStart.textContent = enoughPlayers ? '▶️ Start Game' : `▶️ Start Game (need ${3 - msg.players.length} more)`;
            lobbyWait.classList.add('hidden');
          } else {
            btnStart.classList.add('hidden');
            lobbyWait.classList.remove('hidden');
          }
          lobbyMinHint.classList.toggle('hidden', enoughPlayers);
          showScreen('screen-lobby');
        }

        if (msg.phase === 'voting') {
          renderVotingPlayers(msg.players);
        }

        // refresh host-only controls visibility in other phases
        btnEndDiscussion.classList.toggle('hidden', !isHost);
        btnPlayAgain.classList.toggle('hidden', !isHost);
        resultsWait.classList.toggle('hidden', isHost);
        break;
      }

      case 'error': {
        showHomeError(msg.message);
        break;
      }

      case 'role': {
        roleLocation.textContent = msg.location;
        roleCharacter.textContent = msg.character;
        btnReady.disabled = false;
        btnReady.textContent = "✅ I've Got It — Start Discussion";
        readyProgress.textContent = '';
        showScreen('screen-role');
        break;
      }

      case 'ready_progress': {
        readyProgress.textContent = `${msg.ready}/${msg.total} ready`;
        break;
      }

      case 'discussion_start': {
        discussionTimer.textContent = formatTime(msg.duration);
        btnEndDiscussion.classList.toggle('hidden', myId !== myHostId);
        showScreen('screen-discussion');
        break;
      }

      case 'timer': {
        discussionTimer.textContent = formatTime(msg.remaining);
        break;
      }

      case 'voting_start': {
        votedFor = null;
        renderVotingPlayers(msg.players);
        voteProgress.textContent = `0/${msg.players.length} voted`;
        showScreen('screen-voting');
        break;
      }

      case 'vote_progress': {
        voteProgress.textContent = `${msg.voted}/${msg.total} voted`;
        break;
      }

      case 'results': {
        const isHost = myId === myHostId;
        if (msg.caught) {
          resultsHeadline.textContent = '🎉 The Imposter Was Caught!';
          resultsHeadline.className = 'caught';
        } else {
          resultsHeadline.textContent = '😈 The Imposter Got Away!';
          resultsHeadline.className = 'escaped';
        }
        resultImposterName.textContent = msg.imposterName + (msg.imposterId === myId ? ' (you!)' : '');
        resultRealLocation.textContent = msg.realLocation;
        resultImposterLocation.textContent = `${msg.imposterLocation} (${msg.imposterCharacter})`;

        resultsTally.innerHTML = '';
        msg.tally.forEach(t => {
          const li = document.createElement('li');
          const label = document.createElement('span');
          label.textContent = t.name + (t.id === msg.imposterId ? ' 🕵️' : '');
          const count = document.createElement('strong');
          count.textContent = `${t.count} vote${t.count === 1 ? '' : 's'}`;
          li.appendChild(label);
          li.appendChild(count);
          resultsTally.appendChild(li);
        });

        btnPlayAgain.classList.toggle('hidden', !isHost);
        resultsWait.classList.toggle('hidden', isHost);
        showScreen('screen-results');
        break;
      }
    }
  }
})();
