-- THUNDER PARTY MVP - Cloudflare D1 schema
-- Create a new D1 database for this project. Do not reuse the THUNDER ROYALE database.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby', -- lobby | playing | results
  game_id TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  game_data TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  nickname TEXT NOT NULL,
  token TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  is_host INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  last_seen INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE,
  UNIQUE (room_code, nickname)
);

CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_code, active, joined_at);

CREATE TABLE IF NOT EXISTS game_results (
  room_code TEXT NOT NULL,
  round INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, round, player_id),
  FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_progress (
  room_code TEXT NOT NULL,
  round INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, round, player_id),
  FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);
