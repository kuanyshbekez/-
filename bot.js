const bedrock = require('bedrock-protocol');
const Vec3 = require('vec3');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

let bot = null;
let players = {}; // name -> { position: {x,y,z}, yaw, pitch }
let lastOwnPosition = null;
let followInterval = null;

function makeClient() {
  bot = bedrock.createClient({
    host: config.host,
    port: config.port,
    username: config.username
    // no xbox token (offline/no-auth)
  });

  console.log(`Создаём клиента для ${config.username} -> ${config.host}:${config.port}`);

  bot.on('connect', () => console.log('Соединение...'));
  bot.on('start_game', (packet) => {
    console.log('Подключились к миру. gamemode:', packet.playerGameType);
    // периодические задачи
    setInterval(sendKeepAlive, 10000);
  });

  // Получаем данные о других игроках (event name may vary by server; bedrock-protocol emits player_list/packet events)
  bot.on('player_add', (packet) => {
    try {
      packet.entries.forEach(e => {
        if (!e.name) return;
        players[e.name] = players[e.name] || { position: null, yaw: 0, pitch: 0 };
      });
    } catch (e) {}
  });

  bot.on('player_remove', (packet) => {
    try {
      packet.entries.forEach(e => {
        if (players[e.name]) delete players[e.name];
      });
    } catch (e) {}
  });

  // Некоторые сервера отсылают chat/text в JSON — парсим и обрабатываем команды
  bot.on('text', (packet) => {
    let raw = packet.message || '';
    try {
      const obj = JSON.parse(raw);
      if (obj.extra && Array.isArray(obj.extra)) {
        raw = obj.extra.map(x => x.text || '').join('');
      } else if (obj.text) {
        raw = obj.text;
      }
    } catch (e) {
      // оставляем raw как есть
    }
    handleChatLine(raw);
  });

  // Получаем обновления собственного положения (ack)
  bot.on('move', (packet) => {
    lastOwnPosition = {
      x: packet.x,
      y: packet.y,
      z: packet.z,
      yaw: packet.yaw,
      pitch: packet.headYaw
    };
  });

  // Некоторые серверы шлют имена и позиции других игроков через custom packet types.
  // Попытаемся ловить 'actor_relative_move' и 'move_entity' и т.п., но реализация сервер-зависима.
  bot.on('entity_teleport', (p) => {
    // эта информация содержит entityRuntimeId и координаты; без полной мапы нельзя связать имя->id
  });

  // Простейшая подсказка: если сервер пишет в чат в формате "<name> message", парсим это.
  function handleChatLine(line) {
    if (!line) return;
    line = line.trim();
    console.log('[chat]', line);
    // вытаскиваем сообщение после '>' если есть
    if (line.startsWith('<')) {
      const idx = line.indexOf('>');
      if (idx !== -1) line = line.slice(idx + 1).trim();
    }
    if (!line.startsWith('!')) return;
    const parts = line.split(' ');
    const cmd = parts[0];
    if (cmd === '!follow' && parts[1]) {
      startFollowing(parts[1]);
      sendChat(`Буду следовать за ${parts[1]}`);
    } else if (cmd === '!stop') {
      stopFollowing();
      sendChat('Остановился.');
    } else if (cmd === '!collect' && parts[1]) {
      collectBlock(parts[1]);
    }
  }

  function sendChat(msg) {
    // отправляем простой текст (формат сервер-зависим)
    try {
      bot.queue('text', { message: JSON.stringify({ text: msg }), type: 1 });
    } catch (e) {
      try { bot.queue('text', { message: msg, type: 1 }); } catch (e2) { console.log('chat send failed', e2); }
    }
  }

  function sendKeepAlive() {
    // отправка пустого ввода для поддержания соединения (server may expect)
    if (!lastOwnPosition) return;
    sendMove(lastOwnPosition);
  }

  function sendMove(posObj) {
    if (!posObj) return;
    try {
      bot.queue('player_input', {
        // player_input fields vary by protocol version; bedrock-protocol will adapt where possible
        // используем basic player position/rotation пакеты если доступны
      });
    } catch (e) {
      // fallback: многие серверы принимают 'move_player' только от сервера, а клиент пересылает 'move'
      try {
        bot.queue('move_player', {
          runtimeEntityId: 1, // may be ignored by server if incorrect
          position: { x: posObj.x, y: posObj.y, z: posObj.z },
          pitch: posObj.pitch || 0,
          yaw: posObj.yaw || 0
        });
      } catch (e2) {
        // ничего
      }
    }
  }

  // Простая функция: попытаться "сдвинуть" бота ближе к цели (на уровне приложения — без гарантии, что сервер примет)
  function moveTowardsTarget(targetPos) {
    if (!lastOwnPosition || !targetPos) return;
    const dx = targetPos.x - lastOwnPosition.x;
    const dy = targetPos.y - lastOwnPosition.y;
    const dz = targetPos.z - lastOwnPosition.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist <= config.behaviour.followDistance) return;
    const dirX = dx / dist;
    const dirY = dy / dist;
    const dirZ = dz / dist;
    const step = config.behaviour.followSpeed;
    const newPos = {
      x: lastOwnPosition.x + dirX * step,
      y: lastOwnPosition.y + dirY * step,
      z: lastOwnPosition.z + dirZ * step,
      yaw: Math.atan2(-dx, -dz) * (180/Math.PI),
      pitch: 0
    };
    sendMove(newPos);
  }

  // Follow logic: периодически пытаемся взять позицию игрока из players[name].position и двигаться к ней
  function startFollowing(name) {
    if (followInterval) clearInterval(followInterval);
    followInterval = setInterval(() => {
      const info = players[name];
      if (!info || !info.position) return;
      moveTowardsTarget(info.position);
    }, 200);
    console.log('Начали следовать за', name);
  }
  function stopFollowing() {
    if (followInterval) { clearInterval(followInterval); followInterval = null; }
    console.log('Остановили следование');
  }

  // Простейшая попытка "добыть" блок: отправляем dig start/stop пакеты (поведение сервер-зависимо)
  async function collectBlock(blockName) {
    sendChat('Попытаюсь собрать ' + blockName);
    // В bedrock протоколе нет удобной высокой-уровневой функции — нужно знать позицию блока.
    // Здесь — демонстрация: ищем ближайший стоящий игрок/позицию и "копаем" точку под ним.
    if (!lastOwnPosition) return;
    const target = { x: Math.round(lastOwnPosition.x), y: Math.round(lastOwnPosition.y - 1), z: Math.round(lastOwnPosition.z) };
    try {
      // dig start
      bot.queue('player_action', {
        runtimeEntityId: 0,
        action: 0, // start break
        blockPosition: { x: target.x, y: target.y, z: target.z },
        face: 1
      });
      // Wait a bit then stop
      await new Promise(r => setTimeout(r, 800));
      bot.queue('player_action', {
        runtimeEntityId: 0,
        action: 1, // abort finish/dig stop (server-dependent)
        blockPosition: { x: target.x, y: target.y, z: target.z },
        face: 1
      });
      sendChat('Попытка добычи завершена (демонстрационно).');
    } catch (e) {
      console.log('collect error', e);
      sendChat('Не смог собрать (ошибка).');
    }
  }

  // Попытка восстановиться при закрытии
  bot.on('close', (reason) => {
    console.log('Закрытие соединения:', reason);
    if (followInterval) { clearInterval(followInterval); followInterval = null; }
    setTimeout(makeClient, 5000);
  });

  bot.on('error', (err) => {
    console.log('Ошибка:', err);
  });
}

makeClient();