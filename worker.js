const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function reply(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...JSON_HEADERS, ...corsHeaders(env) }
  });
}

function fail(message, status, env, extra = {}) {
  return reply({ ok: false, error: message, ...extra }, status || 400, env);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function randomId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

function cleanNickname(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 12);
}

function parseGameData(raw) {
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

async function getRoom(env, code) {
  return env.DB.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first();
}

async function getPlayerByToken(env, code, request, playerId) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !playerId) return null;
  return env.DB.prepare(
    "SELECT * FROM players WHERE id = ? AND room_code = ? AND token = ? AND active = 1"
  ).bind(playerId, code, token).first();
}

async function insertResult(env, room, player, score, detail) {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO game_results
     (room_code, round, player_id, score, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(room.code, room.round, player.id, Math.max(0, Math.round(score)), JSON.stringify(detail || {}), Date.now()).run();

  if (result.meta && result.meta.changes > 0) {
    await env.DB.prepare("UPDATE players SET score = score + ? WHERE id = ? AND room_code = ?")
      .bind(Math.max(0, Math.round(score)), player.id, room.code).run();
  }
}

async function maybeFinish(env, room) {
  if (!room || room.status !== "playing") return room;

  const now = Date.now();
  const data = parseGameData(room.game_data);
  const playersResult = await env.DB.prepare(
    "SELECT * FROM players WHERE room_code = ? AND active = 1 ORDER BY joined_at ASC"
  ).bind(room.code).all();
  const players = playersResult.results || [];

  const resultCountRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM game_results WHERE room_code = ? AND round = ?"
  ).bind(room.code, room.round).first();
  const resultCount = Number(resultCountRow?.n || 0);
  const allDone = players.length > 0 && resultCount >= players.length;
  const timedOut = Number(data.endsAt || 0) > 0 && now >= Number(data.endsAt);
  if (!allDone && !timedOut) return room;

  for (const player of players) {
    const existing = await env.DB.prepare(
      "SELECT player_id FROM game_results WHERE room_code = ? AND round = ? AND player_id = ?"
    ).bind(room.code, room.round, player.id).first();
    if (existing) continue;

    if (room.game_id === "accuracy") {
      const progress = await env.DB.prepare(
        "SELECT progress, hits, started_at FROM game_progress WHERE room_code = ? AND round = ? AND player_id = ?"
      ).bind(room.code, room.round, player.id).first();
      const hits = Number(progress?.hits || 0);
      const elapsed = Math.max(0, now - Number(progress?.started_at || data.startedAt || now));
      const speedBonus = Math.max(0, Math.round(500 - elapsed / 40));
      const score = hits * 100 + speedBonus;
      await insertResult(env, room, player, score, {
        hits,
        attempts: Number(progress?.progress || 0),
        timedOut: true
      });
    } else {
      await insertResult(env, room, player, 0, { timedOut: true });
    }
  }

  await env.DB.prepare("UPDATE rooms SET status = 'results', updated_at = ? WHERE code = ? AND round = ?")
    .bind(now, room.code, room.round).run();
  return await getRoom(env, room.code);
}

async function roomPayload(env, room, request) {
  room = await maybeFinish(env, room);
  const url = new URL(request.url);
  const playerId = url.searchParams.get("playerId");
  const me = await getPlayerByToken(env, room.code, request, playerId);
  if (me) {
    await env.DB.prepare("UPDATE players SET last_seen = ? WHERE id = ?").bind(Date.now(), me.id).run();
  }

  const playersResult = await env.DB.prepare(
    "SELECT id, nickname, score, is_host, active, last_seen, joined_at FROM players WHERE room_code = ? AND active = 1 ORDER BY score DESC, joined_at ASC"
  ).bind(room.code).all();
  const players = (playersResult.results || []).map(p => ({
    id: p.id,
    nickname: p.nickname,
    score: p.score,
    isHost: !!p.is_host,
    online: Date.now() - Number(p.last_seen || 0) < 7000
  }));

  const data = parseGameData(room.game_data);
  let game = null;
  let myProgress = null;
  if (room.game_id) {
    game = { id: room.game_id };
    if (room.game_id === "reaction") {
      game.fireAt = data.fireAt;
      game.endsAt = data.endsAt;
    } else if (room.game_id === "quiz") {
      game.question = data.question;
      game.options = data.options;
      game.startedAt = data.startedAt;
      game.endsAt = data.endsAt;
      if (room.status === "results") game.correctIndex = data.correctIndex;
    } else if (room.game_id === "accuracy") {
      game.startedAt = data.startedAt;
      game.endsAt = data.endsAt;
      game.total = data.total || 10;
      if (me) {
        const progress = await env.DB.prepare(
          "SELECT progress, hits, started_at FROM game_progress WHERE room_code = ? AND round = ? AND player_id = ?"
        ).bind(room.code, room.round, me.id).first();
        const index = Number(progress?.progress || 0);
        myProgress = {
          progress: index,
          hits: Number(progress?.hits || 0),
          targetCell: index < (data.targets || []).length ? data.targets[index] : null
        };
      }
    }
  }

  const resultsResult = await env.DB.prepare(
    `SELECT gr.player_id AS playerId, p.nickname, gr.score, gr.detail_json AS detailJson
     FROM game_results gr JOIN players p ON p.id = gr.player_id
     WHERE gr.room_code = ? AND gr.round = ?
     ORDER BY gr.score DESC, gr.created_at ASC`
  ).bind(room.code, room.round).all();
  const results = (resultsResult.results || []).map(r => ({
    playerId: r.playerId,
    nickname: r.nickname,
    score: r.score,
    detail: parseGameData(r.detailJson)
  }));

  return {
    ok: true,
    room: {
      code: room.code,
      status: room.status,
      gameId: room.game_id,
      round: room.round,
      createdAt: room.created_at,
      game,
      players,
      results,
      myPlayerId: me?.id || null,
      myProgress
    }
  };
}

const QUIZ_BANK = [
  { question: "1분은 몇 초일까요?", options: ["30초", "60초", "90초", "100초"], answer: 1 },
  { question: "다음 중 가장 큰 수는?", options: ["0.8", "0.75", "0.9", "0.81"], answer: 2 },
  { question: "대한민국의 수도는?", options: ["부산", "인천", "서울", "대전"], answer: 2 },
  { question: "삼각형의 변은 몇 개일까요?", options: ["2개", "3개", "4개", "5개"], answer: 1 },
  { question: "9 × 7의 답은?", options: ["56", "63", "72", "79"], answer: 1 },
  { question: "물의 화학식은?", options: ["CO₂", "O₂", "H₂O", "NaCl"], answer: 2 },
  { question: "하루는 몇 시간일까요?", options: ["12시간", "18시간", "24시간", "36시간"], answer: 2 }
];

async function createRoom(env, body) {
  const nickname = cleanNickname(body?.nickname);
  if (nickname.length < 2) return fail("닉네임은 2~12자로 입력해 주세요.", 400, env);

  let code = randomCode();
  for (let i = 0; i < 5; i++) {
    if (!(await getRoom(env, code))) break;
    code = randomCode();
  }

  const now = Date.now();
  const playerId = randomId();
  const token = randomId() + randomId();
  await env.DB.prepare(
    "INSERT INTO rooms (code, host_id, status, game_id, round, game_data, created_at, updated_at) VALUES (?, ?, 'lobby', NULL, 0, NULL, ?, ?)"
  ).bind(code, playerId, now, now).run();
  await env.DB.prepare(
    "INSERT INTO players (id, room_code, nickname, token, score, is_host, active, last_seen, joined_at) VALUES (?, ?, ?, ?, 0, 1, 1, ?, ?)"
  ).bind(playerId, code, nickname, token, now, now).run();

  return reply({ ok: true, code, playerId, token }, 201, env);
}

async function joinRoom(env, code, body) {
  const nickname = cleanNickname(body?.nickname);
  if (nickname.length < 2) return fail("닉네임은 2~12자로 입력해 주세요.", 400, env);
  const room = await getRoom(env, code);
  if (!room) return fail("방을 찾을 수 없습니다. 방 코드를 확인해 주세요.", 404, env);
  if (room.status !== "lobby") return fail("이미 게임이 시작된 방에는 참가할 수 없습니다.", 409, env);

  const now = Date.now();
  const playerId = randomId();
  const token = randomId() + randomId();
  try {
    await env.DB.prepare(
      "INSERT INTO players (id, room_code, nickname, token, score, is_host, active, last_seen, joined_at) VALUES (?, ?, ?, ?, 0, 0, 1, ?, ?)"
    ).bind(playerId, code, nickname, token, now, now).run();
  } catch (error) {
    const existing = await env.DB.prepare(
      "SELECT id FROM players WHERE room_code = ? AND nickname = ? AND active = 1"
    ).bind(code, nickname).first();
    if (existing) return fail("이미 사용 중인 닉네임입니다. 다른 닉네임을 사용해 주세요.", 409, env);
    throw error;
  }
  return reply({ ok: true, code, playerId, token }, 201, env);
}

async function startGame(env, room, request, body) {
  const player = await getPlayerByToken(env, room.code, request, body?.playerId);
  if (!player || !player.is_host) return fail("방장만 게임을 시작할 수 있습니다.", 403, env);
  if (room.status !== "lobby") return fail("현재 게임을 시작할 수 없는 상태입니다.", 409, env);

  const gameId = String(body?.gameId || "reaction");
  if (!["reaction", "quiz", "accuracy"].includes(gameId)) return fail("지원하지 않는 게임입니다.", 400, env);

  const now = Date.now();
  let data;
  if (gameId === "reaction") {
    const fireAt = now + 2200 + Math.floor(Math.random() * 2400);
    data = { fireAt, endsAt: fireAt + 12000 };
  } else if (gameId === "quiz") {
    const q = QUIZ_BANK[Math.floor(Math.random() * QUIZ_BANK.length)];
    data = {
      question: q.question,
      options: q.options,
      correctIndex: q.answer,
      startedAt: now,
      endsAt: now + 15000
    };
  } else {
    const targets = Array.from({ length: 10 }, () => Math.floor(Math.random() * 25));
    data = { targets, total: 10, startedAt: now, endsAt: now + 20000 };
  }

  const newRound = Number(room.round || 0) + 1;
  await env.DB.prepare(
    "UPDATE rooms SET status = 'playing', game_id = ?, round = ?, game_data = ?, updated_at = ? WHERE code = ?"
  ).bind(gameId, newRound, JSON.stringify(data), now, room.code).run();

  if (gameId === "accuracy") {
    const players = await env.DB.prepare("SELECT id FROM players WHERE room_code = ? AND active = 1").bind(room.code).all();
    for (const p of (players.results || [])) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO game_progress (room_code, round, player_id, progress, hits, started_at) VALUES (?, ?, ?, 0, 0, ?)"
      ).bind(room.code, newRound, p.id, now).run();
    }
  }
  const updated = await getRoom(env, room.code);
  return reply(await roomPayload(env, updated, request), 200, env);
}

async function performAction(env, room, request, body) {
  const player = await getPlayerByToken(env, room.code, request, body?.playerId);
  if (!player) return fail("참가자 인증에 실패했습니다. 방에 다시 입장해 주세요.", 401, env);
  room = await maybeFinish(env, room);
  if (room.status !== "playing") return fail("현재 입력할 수 있는 게임이 없습니다.", 409, env);

  const data = parseGameData(room.game_data);
  const now = Date.now();

  if (room.game_id === "reaction") {
    const existing = await env.DB.prepare(
      "SELECT player_id FROM game_results WHERE room_code = ? AND round = ? AND player_id = ?"
    ).bind(room.code, room.round, player.id).first();
    if (existing) return fail("이미 기록이 등록되었습니다.", 409, env);
    if (now >= Number(data.endsAt)) return fail("입력 시간이 끝났습니다.", 409, env);

    if (now < Number(data.fireAt)) {
      await insertResult(env, room, player, 0, { falseStart: true, reactionMs: null });
    } else {
      const reactionMs = now - Number(data.fireAt);
      const score = Math.max(0, Math.round(1000 - reactionMs * 1.15));
      await insertResult(env, room, player, score, { falseStart: false, reactionMs });
    }
  } else if (room.game_id === "quiz") {
    const existing = await env.DB.prepare(
      "SELECT player_id FROM game_results WHERE room_code = ? AND round = ? AND player_id = ?"
    ).bind(room.code, room.round, player.id).first();
    if (existing) return fail("이미 답을 제출했습니다.", 409, env);
    if (now >= Number(data.endsAt)) return fail("답변 시간이 끝났습니다.", 409, env);
    const answer = Number(body?.answerIndex);
    if (!Number.isInteger(answer) || answer < 0 || answer >= data.options.length) return fail("답변을 확인해 주세요.", 400, env);
    const correct = answer === Number(data.correctIndex);
    const speedBonus = correct ? Math.max(0, Math.round((Number(data.endsAt) - now) / 50)) : 0;
    const score = correct ? 1000 + speedBonus : 0;
    await insertResult(env, room, player, score, { correct, answerIndex: answer, speedBonus });
  } else if (room.game_id === "accuracy") {
    if (now >= Number(data.endsAt)) return fail("도전 시간이 끝났습니다.", 409, env);
    const cell = Number(body?.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell > 24) return fail("잘못된 타깃 위치입니다.", 400, env);
    const progress = await env.DB.prepare(
      "SELECT progress, hits, started_at FROM game_progress WHERE room_code = ? AND round = ? AND player_id = ?"
    ).bind(room.code, room.round, player.id).first();
    if (!progress || Number(progress.progress) >= Number(data.total || 10)) return fail("도전이 이미 끝났습니다.", 409, env);

    const index = Number(progress.progress);
    const correct = cell === Number(data.targets[index]);
    const nextProgress = index + 1;
    const nextHits = Number(progress.hits) + (correct ? 1 : 0);
    await env.DB.prepare(
      "UPDATE game_progress SET progress = ?, hits = ? WHERE room_code = ? AND round = ? AND player_id = ?"
    ).bind(nextProgress, nextHits, room.code, room.round, player.id).run();

    if (nextProgress >= Number(data.total || 10)) {
      const elapsed = Math.max(0, now - Number(progress.started_at));
      const speedBonus = Math.max(0, Math.round(500 - elapsed / 40));
      const score = nextHits * 100 + speedBonus;
      await insertResult(env, room, player, score, { hits: nextHits, attempts: nextProgress, speedBonus });
    }
  }

  const updated = await getRoom(env, room.code);
  await maybeFinish(env, updated);
  return reply(await roomPayload(env, await getRoom(env, room.code), request), 200, env);
}

async function nextRound(env, room, request, body) {
  const player = await getPlayerByToken(env, room.code, request, body?.playerId);
  if (!player || !player.is_host) return fail("방장만 다음 라운드를 준비할 수 있습니다.", 403, env);
  if (room.status !== "results") return fail("현재 라운드가 아직 끝나지 않았습니다.", 409, env);
  await env.DB.prepare("UPDATE rooms SET status = 'lobby', game_id = NULL, game_data = NULL, updated_at = ? WHERE code = ?")
    .bind(Date.now(), room.code).run();
  return reply(await roomPayload(env, await getRoom(env, room.code), request), 200, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/health" && request.method === "GET") {
        await env.DB.prepare("SELECT 1 AS ok").first();
        return reply({ ok: true, service: "thunder-party-api", database: "connected", version: "mvp-1" }, 200, env);
      }

      if (path === "/api/rooms" && request.method === "POST") {
        return await createRoom(env, await readBody(request));
      }

      const match = path.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/(join|start|action|next|leave))?$/i);
      if (!match) return fail("요청한 주소를 찾을 수 없습니다.", 404, env);
      const code = match[1].toUpperCase();
      const action = match[2] || "state";
      let room = await getRoom(env, code);
      if (!room) return fail("방을 찾을 수 없습니다.", 404, env);

      if (action === "join" && request.method === "POST") return await joinRoom(env, code, await readBody(request));
      if (action === "state" && request.method === "GET") return reply(await roomPayload(env, room, request), 200, env);

      const body = await readBody(request);
      if (action === "start" && request.method === "POST") return await startGame(env, room, request, body);
      if (action === "action" && request.method === "POST") return await performAction(env, room, request, body);
      if (action === "next" && request.method === "POST") return await nextRound(env, room, request, body);
      if (action === "leave" && request.method === "POST") {
        const player = await getPlayerByToken(env, room.code, request, body?.playerId);
        if (!player) return fail("참가자 인증에 실패했습니다.", 401, env);
        await env.DB.prepare("UPDATE players SET active = 0 WHERE id = ?").bind(player.id).run();
        return reply({ ok: true }, 200, env);
      }
      return fail("지원하지 않는 요청입니다.", 405, env);
    } catch (error) {
      return reply({ ok: false, error: "서버 내부 오류가 발생했습니다.", detail: String(error?.message || error) }, 500, env);
    }
  }
};
