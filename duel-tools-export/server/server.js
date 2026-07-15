/**
 * Duel Tools — Server with built-in auth
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT    = process.env.PORT || 8000;
const DB_FILE = path.join(__dirname, 'duel-tools.db.json');
const PUB_DIR = path.join(__dirname, '..', 'public');

// Secret for signing session tokens — generated once at startup
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// Bootstrap admin — set via env vars on Railway
const BOOTSTRAP_EMAIL    = process.env.ADMIN_EMAIL    || 'admin@dueltools.com';
const BOOTSTRAP_PASSWORD = process.env.ADMIN_PASSWORD || 'ilovesui';

// ── DB ────────────────────────────────────────────────────────────────────────
let pgClient = null;
let db = { batches: {}, players: {}, users: {}, gfwl: {}, eventDates: {} };

async function connectPostgres() {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS duel_tools_data (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Batches get their own table — one row per batch — because storing all
  // batches as a single JSONB blob under one key hits row size limits as
  // the dataset grows (each row blob was capped at 8MB and silently skipped
  // once batches exceeded that, causing replays to never reach Postgres).
  await client.query(`
    CREATE TABLE IF NOT EXISTS duel_tools_batches (
      id TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const res = await client.query("SELECT key, value FROM duel_tools_data WHERE key IN ('players','users','gfwl','eventDates')");
  for (const row of res.rows) { db[row.key] = row.value; }
  const batchRes = await client.query('SELECT id, value FROM duel_tools_batches');
  db.batches = {};
  for (const row of batchRes.rows) { db.batches[row.id] = row.value; }
  // Migrate any legacy batches still stored under the old single-blob key
  const legacyRes = await client.query("SELECT value FROM duel_tools_data WHERE key='batches'");
  if (legacyRes.rows.length && legacyRes.rows[0].value && Object.keys(legacyRes.rows[0].value).length) {
    console.log('[PG] Migrating', Object.keys(legacyRes.rows[0].value).length, 'legacy batches to per-row storage...');
    for (const [id, batch] of Object.entries(legacyRes.rows[0].value)) {
      if (!db.batches[id]) db.batches[id] = batch; // don't overwrite if already split
    }
    pgClient = client; // needed before saveAllBatchesToPostgres can run
    await saveAllBatchesToPostgres();
    await client.query("DELETE FROM duel_tools_data WHERE key='batches'");
    console.log('[PG] Legacy batch migration complete — old blob removed.');
  }
  if (!db.batches) db.batches = {};
  if (!db.players) db.players = {};
  if (!db.users)   db.users   = {};
  if (!db.gfwl)    db.gfwl    = {};
  if (!db.eventDates) db.eventDates = {};
  pgClient = client;
  // Handle PG client-level errors (e.g. connection dropped by server)
  // Without this, 'error' events on the pg client crash Node
  client.on('error', (err) => {
    console.error('[PG] Client error event:', err.message);
    pgClient = null;
    setTimeout(async () => {
      try { await connectPostgres(); console.log('[PG] Reconnected after error'); }
      catch(e) { console.error('[PG] Reconnect failed:', e.message); }
    }, 3000);
  });
  client.on('end', () => {
    console.warn('[PG] Client connection ended');
    pgClient = null;
    setTimeout(async () => {
      try { await connectPostgres(); console.log('[PG] Reconnected after end'); }
      catch(e) { console.error('[PG] Reconnect after end failed:', e.message); }
    }, 1000);
  });
  console.log('Connected to PostgreSQL, batches:', Object.keys(db.batches).length);
  // Build event date catalog from hardcoded anchors (instant, no network)
  // Only runs if catalog is empty — avoids redundant work on reconnects
  const knownDates = Object.keys(db.eventDates).filter(k=>!k.startsWith('_')).length;
  if (knownDates < 10) {
    const added = buildEventCatalog();
    if (added > 0) {
      await saveDB('eventDates');
      console.log('[EventDates] Built catalog with', Object.keys(db.eventDates).filter(k=>!k.startsWith('_')).length, 'entries');
    }
  }
  // Flush any data that was buffered while Postgres was down
  if (_pendingFlushKeys && _pendingFlushKeys.size > 0) {
    console.log('[PG] Reconnected — flushing', _pendingFlushKeys.size, 'buffered keys...');
    flushPendingToPostgres().catch(e => console.error('[PG] Post-reconnect flush failed:', e.message));
  }
}

async function initDB() {
  if (process.env.DATABASE_URL) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try { await connectPostgres(); break; }
      catch(e) {
        console.error(`PG attempt ${attempt}/5 failed: ${e.message}`);
        if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 2000));
        else { pgClient = null; loadFileDB(); }
      }
    }
  } else {
    loadFileDB();
  }
  // Bootstrap admin — always ensure admin account exists and password matches env
  const existingAdmin = Object.values(db.users).find(u => u.email === BOOTSTRAP_EMAIL);
  if (!existingAdmin) {
    const id = crypto.randomUUID();
    db.users[id] = {
      id, email: BOOTSTRAP_EMAIL,
      password: hashPassword(BOOTSTRAP_PASSWORD),
      role: 'admin', approved: true, createdAt: Date.now()
    };
    await saveDB();
    console.log(`Bootstrap admin created: ${BOOTSTRAP_EMAIL}`);
  } else {
    // Always sync password from env (handles secret rotation)
    const correctHash = hashPassword(BOOTSTRAP_PASSWORD);
    if (existingAdmin.password !== correctHash) {
      existingAdmin.password = correctHash;
      existingAdmin.approved = true;
      existingAdmin.role = 'admin';
      await saveDB();
      console.log(`Bootstrap admin password synced: ${BOOTSTRAP_EMAIL}`);
    }
  }
}

function loadFileDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = loaded;
      if (!db.batches) db.batches = {};
      if (!db.players) db.players = {};
      if (!db.users)   db.users   = {};
      if (!db.gfwl)    db.gfwl    = {};
      if (!db.eventDates) db.eventDates = {};
    }
  } catch(e) { console.error('File DB load error:', e.message); }
}

// Keys saved via the generic single-row-per-key table. None of these ever
// approach the 8MB JSONB cap (only 'batches' historically did, which is why
// batches now has its own per-row table — see saveBatchToPostgres).
//
// IMPORTANT: this is a fixed list, always saved in full on every bare
// saveDB() call — NOT a "dirty" tracking set. An earlier version tried to
// only save keys that were explicitly marked dirty via markDirty(), but
// most mutation call sites never called markDirty(), so once a key like
// 'players' was saved once and removed from the dirty set, every later
// change to player aliases/teams was silently never persisted again.
// Always-save-everything is simpler and can't silently drop data — these
// four keys are small enough that resaving all of them every time is cheap.
const _ALWAYS_SAVE_KEYS = ['players','users','gfwl','eventDates'];
const _dirtyKeys = new Set(_ALWAYS_SAVE_KEYS);

// ── Write-ahead buffer — holds pending saves when Postgres is temporarily down ─
// Keys accumulate here; flushed automatically when connection is restored.
const _pendingFlushKeys = new Set();
let _flushRetryTimer = null;

async function flushPendingToPostgres() {
  if (!_pendingFlushKeys.size) return;
  if (!pgClient) return; // still down, will retry
  const keys = [..._pendingFlushKeys];
  console.log('[saveDB] Flushing', keys.length, 'pending keys to Postgres after reconnect:', keys);

  const batchIds = keys.filter(k => k.startsWith('batches:')).map(k => k.slice('batches:'.length));
  const plainKeys = keys.filter(k => !k.startsWith('batches:'));

  let anyFailed = false;

  // Flush individual batch rows
  for (const bid of batchIds) {
    if (!db.batches[bid]) { _pendingFlushKeys.delete('batches:'+bid); continue; }
    try {
      await saveBatchToPostgres(bid);
    } catch(e) { anyFailed = true; }
  }

  // Flush plain top-level keys (players, users, gfwl, eventDates)
  if (plainKeys.length) {
    try {
      const values = [], params = [];
      let idx = 1;
      for (const key of plainKeys) {
        if (!db[key]) continue;
        let serialized;
        try { serialized = JSON.stringify(db[key]); } catch(e) { continue; }
        if (serialized.length > 8*1024*1024) { console.warn('[flush] Key', key, 'too large, skipping'); continue; }
        values.push(`($${idx++},$${idx++},NOW())`);
        params.push(key, serialized);
      }
      if (values.length) {
        await pgClient.query(
          'INSERT INTO duel_tools_data (key, value, updated_at) VALUES '+values.join(',')+
          ' ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()',
          params
        );
      }
      plainKeys.forEach(k => _pendingFlushKeys.delete(k));
    } catch(e) {
      console.error('[saveDB] Flush of plain keys failed:', e.message);
      anyFailed = true;
    }
  }

  if (!anyFailed) {
    if (_flushRetryTimer) { clearTimeout(_flushRetryTimer); _flushRetryTimer = null; }
    console.log('[saveDB] Pending flush complete — all data saved to Postgres.');
  } else {
    console.error('[saveDB] Some keys still failed to flush — will retry in 10s');
    scheduleFlushRetry();
  }
}

function scheduleFlushRetry() {
  if (_flushRetryTimer) return;
  _flushRetryTimer = setTimeout(async () => {
    _flushRetryTimer = null;
    if (!pgClient) {
      try { await connectPostgres(); } catch(e) {}
    }
    await flushPendingToPostgres();
  }, 10000);
}
let _saveQueued = false;
let _saveTimeout = null;

function markDirty(key) {
  _dirtyKeys.add(key);
}

// Save a single batch as its own row — used for per-replay immediate saves.
// This avoids ever needing to serialize the entire batches collection.
async function saveBatchToPostgres(batchId) {
  if (!pgClient) { _pendingFlushKeys.add('batches:'+batchId); scheduleFlushRetry(); return; }
  const batch = db.batches[batchId];
  if (!batch) return;
  try {
    const serialized = JSON.stringify(batch);
    if (serialized.length > 50*1024*1024) {
      console.error('[saveBatch] Batch', batchId, 'is', Math.round(serialized.length/1024/1024)+'MB — exceeds safe limit, NOT saved!');
      return;
    }
    await pgClient.query(
      'INSERT INTO duel_tools_batches (id, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()',
      [batchId, serialized]
    );
    _pendingFlushKeys.delete('batches:'+batchId);
  } catch(e) {
    console.error('[saveBatch] Failed for', batchId, ':', e.message);
    _pendingFlushKeys.add('batches:'+batchId);
    if (e.message.includes('connect') || e.message.includes('Connection') || e.code === 'ECONNRESET') {
      pgClient = null;
      setTimeout(async () => { try { await connectPostgres(); } catch(e2) {} }, 2000);
    }
    scheduleFlushRetry();
    throw e; // let the caller (e.g. the HTTP handler) know the save failed
  }
}

// Save every batch currently in memory — used by manual Save button and migration.
async function saveAllBatchesToPostgres() {
  if (!pgClient) { Object.keys(db.batches).forEach(id => _pendingFlushKeys.add('batches:'+id)); scheduleFlushRetry(); return; }
  const ids = Object.keys(db.batches);
  let failed = 0;
  for (const id of ids) {
    try { await saveBatchToPostgres(id); } catch(e) { failed++; }
  }
  console.log('[saveAllBatches]', ids.length-failed, '/', ids.length, 'batches saved to Postgres.');
  return { total: ids.length, failed };
}

async function deleteBatchFromPostgres(batchId) {
  if (!pgClient) return;
  try { await pgClient.query('DELETE FROM duel_tools_batches WHERE id=$1', [batchId]); }
  catch(e) { console.error('[deleteBatch] Failed for', batchId, ':', e.message); }
}

async function saveDB(keys) {
  // If specific keys passed, use those; otherwise save all dirty keys
  const toSave = keys ? (Array.isArray(keys) ? keys : [keys]) : [..._ALWAYS_SAVE_KEYS];
  if (!toSave.length) return;

  // 'batches' is handled separately via the per-row table — never serialize
  // the whole collection into one JSONB blob (that's what caused replays to
  // silently stop saving once the dataset passed 8MB).
  const wantsBatches = toSave.includes('batches');
  const otherKeys = toSave.filter(k => k !== 'batches');

  if (wantsBatches) {
    if (pgClient) {
      await saveAllBatchesToPostgres();
      _dirtyKeys.delete('batches');
    } else if (process.env.DATABASE_URL) {
      Object.keys(db.batches).forEach(id => _pendingFlushKeys.add('batches:'+id));
      console.error('[saveDB] Postgres down — buffered all batch ids for flush on reconnect');
      scheduleFlushRetry();
    } else {
      try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
      catch(e) { console.error('File DB save error:', e.message); }
    }
  }

  if (!otherKeys.length) return;

  try {
    if (pgClient && pgClient._connected !== false) {
      try {
        // Build parameterized query for only dirty keys
        const values = [];
        const params = [];
        let idx = 1;
        for (const key of otherKeys) {
          if (!db[key]) continue;
          let serialized;
          try { serialized = JSON.stringify(db[key]); }
          catch(e) { console.error('[saveDB] Serialize error for', key, ':', e.message); continue; }
          // Skip if too large (>8MB per key — PG JSONB limit)
          if (serialized.length > 8*1024*1024) {
            console.warn('[saveDB] Key', key, 'too large:', Math.round(serialized.length/1024)+'KB — skipping');
            continue;
          }
          values.push(`($${idx++},$${idx++},NOW())`);
          params.push(key, serialized);
        }
        if (!values.length) return;
        await pgClient.query(
          'INSERT INTO duel_tools_data (key, value, updated_at) VALUES '+values.join(',')+
          ' ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()',
          params
        );
        // (no dirty-flag bookkeeping needed — _ALWAYS_SAVE_KEYS is fixed, see comment above)
      } catch(e) {
        console.error('PG save error:', e.message);
        if (e.message.includes('connect') || e.message.includes('Connection') || e.code === 'ECONNRESET') {
          pgClient = null;
          setTimeout(async () => {
            try { await connectPostgres(); } catch(e2) {}
          }, 2000);
        }
      }
    } else {
      if (process.env.DATABASE_URL) {
        // Postgres is configured but disconnected — buffer the dirty keys in memory.
        // They will be flushed to Postgres as soon as the connection is restored.
        // Do NOT write to local file — Railway wipes it on every redeploy.
        otherKeys.forEach(k => _pendingFlushKeys.add(k));
        console.error('[saveDB] Postgres down — buffered keys:', [..._pendingFlushKeys], '— will flush on reconnect');
        scheduleFlushRetry();
      } else {
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
        catch(e) { console.error('File DB save error:', e.message); }
      }
    }
  } catch(e) {
    console.error('[saveDB] Unexpected error:', e.message);
  }
}

// Debounced save — coalesces rapid saves into one
function saveDBDebounced(key) {
  if (key) markDirty(key);
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    _saveTimeout = null;
    saveDB().catch(e => console.error('[saveDB debounced]', e.message));
  }, 2000); // Wait 2s for more changes before saving
}

// ── stripPlay: remove bloat from play objects before storing ─────────────────
function stripPlay(p) {
  return {
    play:p.play, owner:p.owner, username:p.username, player1:p.player1, player2:p.player2,
    player1_choice:p.player1_choice||p.p1pick||undefined,
    player2_choice:p.player2_choice||p.p2pick||undefined,
    cards:p.cards?p.cards.map(c=>({name:c.name,owner:c.owner,id:c.id,serial_number:c.serial_number,card_type:c.card_type})):undefined,
    card:p.card?{name:p.card.name,owner:p.card.owner,id:p.card.id,serial_number:p.card.serial_number,card_type:p.card.card_type}:undefined,
    winner:p.winner, loser:p.loser, game:p.game, pick:p.pick, p1pick:p.p1pick, p2pick:p.p2pick,
    log:Array.isArray(p.log)?p.log.map(l=>({type:l.type,owner:l.owner,username:l.username,card:l.card?{name:l.card.name,id:l.card.id,serial_number:l.card.serial_number}:undefined,game:l.game,public_log:l.public_log,private_log:l.private_log})):(p.log&&typeof p.log==='object'?{type:p.log.type,owner:p.log.owner,username:p.log.username,public_log:p.log.public_log,private_log:p.log.private_log}:undefined)
  };
}

// ── stripAllPlays: strip allPlays on all batches in DB (run on startup) ───────
// stripAllPlaysInDB kept for admin endpoint only — not called on startup
function stripAllPlaysInDB() {
  let count = 0;
  for (const batch of Object.values(db.batches)) {
    for (const replay of (batch.replays||[])) {
      if (replay.allPlays && replay.allPlays.length) {
        replay.allPlays = replay.allPlays.map(stripPlay);
        count++;
      }
    }
  }
  return count;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Password hashing uses a FIXED salt — never changes regardless of JWT_SECRET
const PW_SALT = 'dueltools-pw-salt-v1';
function hashPassword(pw) {
  return crypto.createHmac('sha256', PW_SALT).update(pw).digest('hex');
}

function makeToken(userId, sessionId) {
  const payload = Buffer.from(JSON.stringify({ userId, sessionId, ts: Date.now() })).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  if (expected !== sig) return null;
  try {
    const { userId, sessionId } = JSON.parse(Buffer.from(payload, 'base64').toString());
    const user = db.users[userId];
    if (!user) return null;
    // If user has an activeSessionId, the token's sessionId must match.
    // A mismatch means someone logged in elsewhere and kicked this session.
    if (user.activeSessionId && sessionId && user.activeSessionId !== sessionId) {
      return null; // session was superseded — treat as logged out
    }
    return user;
  } catch(e) { return null; }
}

function getRole(req) {
  const user = getUser(req);
  if (!user || !user.approved) return null;
  return user.role || 'user';
}
function isAdmin(req) {
  const r = getRole(req);
  return r === 'admin' || r === 'head_admin';
}
function isHeadAdmin(req) {
  return getRole(req) === 'head_admin';
}
function isMiner(req) {
  const r = getRole(req);
  return r === 'admin' || r === 'head_admin' || r === 'miner';
}
function isAuthenticated(req) {
  return getRole(req) !== null;
}

function getUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return verifyToken(token);
}

// ── MIME / helpers ────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.json':'application/json','.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml'
};
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify(data));
}
function readBody(req, cb) {
  let raw = '';
  req.on('data', d => { raw += d; if (raw.length > 50*1024*1024) { raw = '{}'; } });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(raw||'{}'); } catch(e) { console.warn('[readBody] JSON parse error:', e.message); }
    // Wrap callback in promise catch to prevent unhandled rejections
    try {
      const result = cb(parsed);
      if (result && typeof result.catch === 'function') {
        result.catch(e => console.error('[readBody] Async callback error:', e.message));
      }
    } catch(e) { console.error('[readBody] Callback error:', e.message); }
  });
  req.on('error', e => { console.error('[readBody] Request error:', e.message); });
}

function playerNames(entry) {
  return [entry.name, ...(entry.aliases||[])].map(n => n.toLowerCase());
}
function findPlayerByUsername(username) {
  const ul = username.toLowerCase().trim();
  for (const entry of Object.values(db.players)) {
    const names = playerNames(entry);
    // Exact match only — no substring fuzzy matching to avoid false cross-links
    if (names.includes(ul)) return entry;
  }
  return null;
}
function findOrCreateBatchForPlayer(playerEntry) {
  const pBatches = Object.values(db.batches).filter(b =>
    b.player && playerNames(playerEntry).includes(b.player.toLowerCase())
  );
  if (pBatches.length) return pBatches.sort((a,b) => b.createdAt - a.createdAt)[0];
  const id = crypto.randomUUID();
  const batch = { id, name: playerEntry.name, player: playerEntry.name, replays: [], createdAt: Date.now(), status: 'pending' };
  db.batches[id] = batch;
  return batch;
}
function crossLinkReplay(replayData, opponentUsername, originalBatchPlayer) {
  const opponentEntry = findPlayerByUsername(opponentUsername);
  if (!opponentEntry) return null;
  // Prevent cross-linking back to the original batch player
  const originalPlayerLower = (originalBatchPlayer||'').toLowerCase();
  if (originalPlayerLower && opponentEntry.name.toLowerCase() === originalPlayerLower) return null;
  for (const alias of (opponentEntry.aliases||[])) {
    if (alias.toLowerCase() === originalPlayerLower) return null;
  }

  // Check ALL of player B's batches for this replay — not just the most recent
  const allOppBatches = Object.values(db.batches).filter(b =>
    b.player && playerNames(opponentEntry).includes(b.player.toLowerCase())
  );
  for (const ob of allOppBatches) {
    const existing = (ob.replays||[]).find(r => r.replayId === replayData.replayId);
    if (existing) {
      if (existing.timedOut && !replayData.timedOut) {
        // Player B has a failed import — upgrade it with the crosslinked parsed data
        // (their perspective: result/decks are mirrored from Player A's data)
        const origParsed2 = replayData.parsed || null;
        const mirrored2 = origParsed2 ? {
          oppName:  originalBatchPlayer || null,
          result:   origParsed2.result === 'w' ? 'l' : origParsed2.result === 'l' ? 'w' : origParsed2.result,
          score:    origParsed2.score ? origParsed2.score.split('-').reverse().join('-') : null,
          myW: origParsed2.oppW, oppW: origParsed2.myW, draws: origParsed2.draws,
          myDeck:  origParsed2.oppDeck  || 'Unknown',
          oppDeck: origParsed2.myDeck   || 'Unknown',
          games: origParsed2.games, allMine: origParsed2.allOpp||[], allOpp: origParsed2.allMine||[],
        } : null;
        Object.assign(existing, {
          plays: replayData.plays||[], parsed: mirrored2, timedOut: false,
          oppName: originalBatchPlayer || replayData.oppName || '',
          myDeckOverride: replayData.oppDeckOverride||null,
          oppDeckOverride: replayData.myDeckOverride||null,
          eventLabel: existing.eventLabel || replayData.eventLabel || '',
          crossLinked: true, updatedAt: Date.now()
        });
        return { linked: true, upgraded: true, batchId: ob.id, player: opponentEntry.name };
      }
      // Player B already has real data for this replay — don't overwrite
      return { linked: false, duplicate: true, batchId: ob.id, player: opponentEntry.name };
    }
  }

  const batch = findOrCreateBatchForPlayer(opponentEntry);
  const batchPlayerLower = (batch.player||'').toLowerCase();
  if (originalPlayerLower && batchPlayerLower === originalPlayerLower) return null;
  if (!batch.replays) batch.replays = [];
  // Build a mirrored parsed record for Player B:
  // their perspective is the opponent's perspective from Player A's replay
  const origParsed = replayData.parsed || null;
  const mirroredParsed = origParsed ? {
    oppName:  origParsed.oppName ? originalBatchPlayer : null, // B's opponent is A
    result:   origParsed.result === 'w' ? 'l' : origParsed.result === 'l' ? 'w' : origParsed.result,
    score:    origParsed.score ? origParsed.score.split('-').reverse().join('-') : null,
    myW:      origParsed.oppW, oppW: origParsed.myW, draws: origParsed.draws,
    myDeck:   origParsed.oppDeck   || 'Unknown',
    oppDeck:  origParsed.myDeck    || 'Unknown',
    games:    origParsed.games,
    allMine:  origParsed.allOpp  || [],
    allOpp:   origParsed.allMine || [],
  } : null;
  batch.replays.push({
    replayId:    replayData.replayId,
    plays:       replayData.plays || [],
    allPlays:    mirroredParsed ? [] : (replayData.allPlays||[]).map(stripPlay),
    parsed:      mirroredParsed,
    timedOut:    !!replayData.timedOut,
    eventLabel:  replayData.eventLabel || '',
    oppName:     originalBatchPlayer || replayData.oppName || '',
    myDeckOverride:  replayData.oppDeckOverride || null,  // A's opp deck = B's my deck
    oppDeckOverride: replayData.myDeckOverride  || null,
    crossLinked: true,
    savedAt:     Date.now()
  });
  batch.status = 'ready';
  return { linked: true, duplicate: false, batchId: batch.id, player: opponentEntry.name };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;
  const parts  = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);

  // ── Static files ────────────────────────────────────────────────────────────
  if (!url.pathname.startsWith('/api/')) {
    let filePath = path.join(PUB_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(PUB_DIR)) { res.writeHead(403); res.end(); return; }
    try {
      const data = fs.readFileSync(filePath);
      const ext  = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    } catch(e) {
      try {
        const data = fs.readFileSync(path.join(PUB_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      } catch(e2) { res.writeHead(404); res.end('Not found'); }
    }
    return;
  }


  // ── POST /api/gfwl/dedup — one-time fix: merge case-duplicate team names ────
  // e.g. merges "Birdcage" (from schedule import) into "birdcage" (from roster)
  if (parts[0]==='gfwl' && parts[1]==='dedup' && method==='POST') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    let merged = 0;
    for (const season of Object.keys(db.gfwl)) {
      const teams = db.gfwl[season].teams || {};
      const seen = {}; // lowercase → first canonical key
      const toDelete = [];
      for (const name of Object.keys(teams)) {
        const lower = name.toLowerCase();
        if (seen[lower]) {
          // Duplicate — merge into the first-seen canonical entry
          const canonical = seen[lower];
          const src = teams[name];
          const dst = teams[canonical];
          if (!dst.conference && src.conference) dst.conference = src.conference;
          if ((!dst.schedule || !dst.schedule.length) && src.schedule && src.schedule.length) dst.schedule = src.schedule;
          if (src.roster && src.roster.length) dst.roster = [...new Set([...(dst.roster||[]), ...src.roster])];
          if (src.aliases && src.aliases.length) dst.aliases = [...new Set([...(dst.aliases||[]), ...src.aliases])];
          toDelete.push(name);
          merged++;
          console.log(`[dedup] ${season}: merged "${name}" into "${canonical}"`);
        } else {
          seen[lower] = name;
        }
      }
      for (const name of toDelete) delete teams[name];
    }
    if (merged > 0) await saveDB('gfwl');
    return json(res, 200, { ok:true, merged });
  }

  // ── POST /api/crosslink/scan — retroactively apply crosslinks to existing replays ──
  // Scans ALL replays in ALL batches and cross-links any where the opponent name
  // matches a known player profile (by username or alias) that doesn't yet have
  // that replay in their batch.
  if (parts[0]==='crosslink' && parts[1]==='scan' && method==='POST') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    let linked = 0, skipped = 0, errors = 0;
    const batchIds = new Set(); // batches that got new replays — need saving

    for (const batch of Object.values(db.batches)) {
      for (const replay of (batch.replays||[])) {
        if (replay.crossLinked) continue; // already a crosslink itself — skip to avoid chains
        const oppName = replay.oppName || (replay.parsed&&replay.parsed.oppName) || '';
        if (!oppName) { skipped++; continue; }
        try {
          const cl = crossLinkReplay(replay, oppName, batch.player);
          if (cl && cl.linked) {
            linked++;
            batchIds.add(cl.batchId);
            console.log('[crosslink/scan]', cl.upgraded ? 'Upgraded timedOut' : 'Linked', replay.replayId, 'to', cl.player);
          } else {
            skipped++;
          }
        } catch(e) {
          console.error('[crosslink/scan] Error on', replay.replayId, e.message);
          errors++;
        }
      }
    }

    // Save all batches that received new crosslinks
    for (const bid of batchIds) {
      await saveBatchToPostgres(bid).catch(e => console.error('[crosslink/scan] save error:', e.message));
    }

    console.log('[crosslink/scan] Done:', linked, 'linked,', skipped, 'skipped,', errors, 'errors');
    return json(res, 200, { ok: true, linked, skipped, errors, batchesUpdated: batchIds.size });
  }

  // ── GET /api/changelog — head admin audit log ──────────────────────────────
  if (parts[0]==='changelog' && method==='GET') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const limit = parseInt(url.searchParams.get('limit')||'100');
    const log = (db._changeLog||[]).slice(-limit).reverse();
    return json(res, 200, { log });
  }

  // ── DELETE /api/changelog/revert/:replayId — head admin revert ───────────
  if (parts[0]==='changelog' && parts[1]==='revert' && parts[2] && method==='DELETE') {
    if (!isHeadAdmin(req)) return json(res, 403, { error:'Head Admin only' });
    const replayId = decodeURIComponent(parts[2]);
    let reverted = 0;
    for (const batch of Object.values(db.batches)) {
      const before = (batch.replays||[]).length;
      batch.replays = (batch.replays||[]).filter(r => r.replayId !== replayId);
      if (batch.replays.length < before) {
        await saveBatchToPostgres(batch.id);
        reverted++;
      }
    }
    if (reverted > 0) {
      db._changeLog = (db._changeLog||[]).filter(l => l.replayId !== replayId);
      console.log('[HeadAdmin] Reverted replay', replayId, 'from', reverted, 'batches');
    }
    return json(res, 200, { ok: true, reverted });
  }

  // ── POST /api/save — manual save all data to Postgres immediately ────────────
  if (parts[0]==='save' && method==='POST') {
    try {
      const batchResult = await saveAllBatchesToPostgres();
      await saveDB(); // saves players/users/gfwl/eventDates
      // Also flush any pending buffered keys
      if (_pendingFlushKeys && _pendingFlushKeys.size > 0) {
        await flushPendingToPostgres();
      }
      const failedCount = (batchResult && batchResult.failed) || 0;
      if (failedCount > 0) {
        return json(res, 207, { ok: false, message: `${failedCount} batch(es) failed to save — check server logs`, batches: Object.keys(db.batches).length, players: Object.keys(db.players).length, failed: failedCount });
      }
      return json(res, 200, { ok: true, message: 'All data saved to Postgres successfully', batches: Object.keys(db.batches).length, players: Object.keys(db.players).length });
    } catch(e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // ── GET /api/health ─────────────────────────────────────────────────────────
  if (parts[0]==='health' && method==='GET') {
    const totalBatchSize = Object.values(db.batches).reduce((sum,b) => { try { return sum + JSON.stringify(b).length; } catch(e) { return sum; } }, 0);
    return json(res, 200, { ok:true, db: pgClient?'postgres':'file', batches: Object.keys(db.batches).length, batchStorageMB: Math.round(totalBatchSize/1024/1024*10)/10, players: Object.keys(db.players).length, users: Object.keys(db.users).length, capsolver: !!process.env.CAPSOLVER_API_KEY, dbSessionCookie: !!process.env.DUELINGBOOK_SESSION_COOKIE, pendingFlush: [..._pendingFlushKeys] });
  }

  // ── POST /api/auth/login ────────────────────────────────────────────────────
  if (parts[0]==='auth' && parts[1]==='login' && method==='POST') {
    return readBody(req, async data => {
      const email = (data.email||'').toLowerCase().trim();
      const pw    = (data.password||'').trim();
      if (!email || !pw) return json(res, 400, { error: 'Email and password required' });
      const user = Object.values(db.users).find(u => u.email === email);
      if (!user || user.password !== hashPassword(pw)) return json(res, 401, { error: 'Invalid email or password' });
      if (!user.approved) return json(res, 403, { error: 'Account pending approval. Contact the admin.' });
      const sessionId = crypto.randomUUID();
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
      const ua = (req.headers['user-agent']||'').slice(0,120);
      // Invalidate any previous session — new login kicks old one
      const prevSession = user.activeSessionId;
      user.activeSessionId = sessionId;
      // Session history for Head Admin audit
      if (!user.sessionLog) user.sessionLog = [];
      user.sessionLog.push({ sessionId, ip, ua, loginAt: Date.now(), active: true });
      // Keep last 20 sessions per user
      if (user.sessionLog.length > 20) user.sessionLog = user.sessionLog.slice(-20);
      // Mark previous session as kicked in log
      if (prevSession) {
        const prev = user.sessionLog.find(s => s.sessionId === prevSession);
        if (prev) { prev.active = false; prev.kickedAt = Date.now(); }
      }
      await saveDB('users');
      const token = makeToken(user.id, sessionId);
      console.log('[Auth] Login:', user.email, 'from', ip, prevSession ? '(kicked previous session)' : '(fresh login)');
      return json(res, 200, { token, role: user.role, email: user.email, name: user.name||email.split('@')[0] });
    });
  }

  // ── POST /api/auth/logout ──────────────────────────────────────────────────
  if (parts[0]==='auth' && parts[1]==='logout' && method==='POST') {
    const user = getUser(req);
    if (user) {
      // Mark session as logged out in the log
      if (user.sessionLog) {
        const sess = user.sessionLog.find(s => s.sessionId === user.activeSessionId);
        if (sess) { sess.active = false; sess.loggedOutAt = Date.now(); }
      }
      user.activeSessionId = null;
      await saveDB('users');
    }
    return json(res, 200, { ok: true });
  }

  // ── GET /api/auth/sessions — head admin: view all active sessions ───────────
  if (parts[0]==='auth' && parts[1]==='sessions' && method==='GET') {
    if (!isAdmin(req)) return json(res, 403, { error: 'Admin only' });
    const sessions = [];
    for (const u of Object.values(db.users)) {
      if (!u.sessionLog) continue;
      for (const sess of u.sessionLog) {
        sessions.push({
          userId: u.id, name: u.name||u.email, email: u.email, role: u.role,
          sessionId: sess.sessionId, ip: sess.ip, ua: sess.ua,
          loginAt: sess.loginAt, active: sess.active,
          kickedAt: sess.kickedAt||null, loggedOutAt: sess.loggedOutAt||null,
          isCurrent: u.activeSessionId === sess.sessionId
        });
      }
    }
    sessions.sort((a,b) => b.loginAt - a.loginAt);
    return json(res, 200, { sessions });
  }

  // ── DELETE /api/auth/sessions/:userId — admin: force-logout a user ──────────
  if (parts[0]==='auth' && parts[1]==='sessions' && parts[2] && method==='DELETE') {
    if (!isAdmin(req)) return json(res, 403, { error: 'Admin only' });
    const targetUser = db.users[parts[2]];
    if (!targetUser) return json(res, 404, { error: 'User not found' });
    // Head admin can force-logout anyone; admin cannot force-logout other admins/head admins
    const myRole = getRole(req);
    if (!isHeadAdmin(req) && isAdminRole(targetUser.role)) {
      return json(res, 403, { error: 'Only Head Admin can force-logout other admins' });
    }
    if (targetUser.sessionLog) {
      const sess = targetUser.sessionLog.find(s => s.sessionId === targetUser.activeSessionId);
      if (sess) { sess.active = false; sess.kickedAt = Date.now(); sess.kickedBy = getUser(req)?.name||'admin'; }
    }
    targetUser.activeSessionId = null;
    await saveDB('users');
    console.log('[Auth] Force-logout:', targetUser.email, 'by', getUser(req)?.email||'admin');
    return json(res, 200, { ok: true });
  }

  // ── POST /api/auth/signup ───────────────────────────────────────────────────
  if (parts[0]==='auth' && parts[1]==='signup' && method==='POST') {
    return readBody(req, async data => {
      const email = (data.email||'').toLowerCase().trim();
      const pw    = (data.password||'').trim();
      const name  = (data.name||'').trim();
      if (!email || !pw) return json(res, 400, { error: 'Email and password required' });
      if (pw.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
      const exists = Object.values(db.users).find(u => u.email === email);
      if (exists) return json(res, 409, { error: 'Email already registered' });
      const id = crypto.randomUUID();
      db.users[id] = { id, email, name: name||email.split('@')[0], password: hashPassword(pw), role: 'user', approved: false, createdAt: Date.now() };
      await saveDB();
      return json(res, 201, { ok: true, message: 'Account created. Waiting for admin approval.' });
    });
  }

  // ── GET /api/auth/me ────────────────────────────────────────────────────────
  if (parts[0]==='auth' && parts[1]==='me' && method==='GET') {
    const user = getUser(req);
    if (!user) return json(res, 401, { error: 'Not authenticated' });
    return json(res, 200, { id: user.id, email: user.email, name: user.name||user.email.split('@')[0], role: user.role, approved: user.approved });
  }

  // ── Admin: GET /api/admin/users ─────────────────────────────────────────────
  if (parts[0]==='admin' && parts[1]==='users' && method==='GET') {
    const user = getUser(req);
    if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    const users = Object.values(db.users).map(u => ({ id:u.id, email:u.email, name:u.name||'', role:u.role, approved:u.approved, createdAt:u.createdAt }));
    return json(res, 200, users);
  }

  // ── Admin: POST /api/admin/users ────────────────────────────────────────────
  if (parts[0]==='admin' && parts[1]==='users' && method==='POST') {
    const user = getUser(req);
    if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    return readBody(req, async data => {
      const email = (data.email||'').toLowerCase().trim();
      const pw    = (data.password||'ilovesui').trim();
      const role  = ['admin','head_admin','miner','user'].includes(data.role) ? data.role : 'user';
      if (!email) return json(res, 400, { error: 'Email required' });
      if (Object.values(db.users).find(u => u.email === email)) return json(res, 409, { error: 'Already exists' });
      const id = crypto.randomUUID();
      db.users[id] = { id, email, name: data.name||email.split('@')[0], password: hashPassword(pw), role, approved: true, createdAt: Date.now() };
      await saveDB();
      return json(res, 201, { ok: true, id });
    });
  }

  // ── Admin: PATCH /api/admin/users/:id ──────────────────────────────────────
  if (parts[0]==='admin' && parts[1]==='users' && parts[2] && method==='PATCH') {
    const user = getUser(req);
    if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    return readBody(req, async data => {
      const u = db.users[parts[2]];
      if (!u) return json(res, 404, { error: 'Not found' });
      if (data.approved  !== undefined) u.approved = !!data.approved;
      if (data.role !== undefined) u.role = ['admin','head_admin','miner','user'].includes(data.role) ? data.role : 'user';
      if (data.password  !== undefined) u.password = hashPassword(data.password);
      if (data.name      !== undefined) u.name = data.name;
      await saveDB();
      return json(res, 200, { ok: true });
    });
  }

  // ── Admin: DELETE /api/admin/users/:id ─────────────────────────────────────
  if (parts[0]==='admin' && parts[1]==='users' && parts[2] && method==='DELETE') {
    const user = getUser(req);
    if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    if (!db.users[parts[2]]) return json(res, 404, { error: 'Not found' });
    delete db.users[parts[2]];
    await saveDB();
    return json(res, 200, { ok: true });
  }

  // ── Admin: POST /api/admin/cleanup ──────────────────────────────────────────
  if (parts[0]==='admin' && parts[1]==='cleanup' && method==='POST') {
    const user = getUser(req);
    if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
    let totalReplays = 0, totalBatches = 0;
    const stripPlay = p => ({
      play:p.play,owner:p.owner,username:p.username,player1:p.player1,player2:p.player2,
      player1_choice:p.player1_choice||p.p1pick||undefined,
      player2_choice:p.player2_choice||p.p2pick||undefined,
      cards:p.cards?p.cards.map(c=>({name:c.name,owner:c.owner,id:c.id,serial_number:c.serial_number,card_type:c.card_type})):undefined,
      card:p.card?{name:p.card.name,owner:p.card.owner,id:p.card.id,serial_number:p.card.serial_number,card_type:p.card.card_type}:undefined,
      winner:p.winner,loser:p.loser,game:p.game,pick:p.pick,p1pick:p.p1pick,p2pick:p.p2pick,
      log:Array.isArray(p.log)?p.log.map(l=>({type:l.type,owner:l.owner,username:l.username,card:l.card?{name:l.card.name,id:l.card.id,serial_number:l.card.serial_number}:undefined,game:l.game,public_log:l.public_log,private_log:l.private_log})):(p.log&&typeof p.log==='object'?{type:p.log.type,owner:p.log.owner,username:p.log.username,public_log:p.log.public_log,private_log:p.log.private_log}:undefined)
    });
    for (const batch of Object.values(db.batches)) {
      let changed = false;
      for (const replay of (batch.replays||[])) {
        if (replay.allPlays && replay.allPlays.length) {
          replay.allPlays = replay.allPlays.map(stripPlay);
          changed = true; totalReplays++;
        }
      }
      if (changed) totalBatches++;
    }
    await saveAllBatchesToPostgres();
    return json(res, 200, { ok:true, cleanedBatches:totalBatches, cleanedReplays:totalReplays });
  }

  // ── GET /api/players ────────────────────────────────────────────────────────
  if (parts[0]==='players' && !parts[1] && method==='GET') {
    return json(res, 200, Object.values(db.players));
  }
  // ── POST /api/players ───────────────────────────────────────────────────────
  if (parts[0]==='players' && !parts[1] && method==='POST') {
    return readBody(req, async data => {
      const name = (data.name||'').trim();
      if (!name) return json(res, 400, { error:'Name required' });
      const key = name.toLowerCase();
      if (!db.players[key]) {
        db.players[key] = { name, aliases: data.aliases||[], topPlayer: false, gfwlTeams: [], eventDecklists: [], tags: [] };
        await saveDB('players');
      }
      return json(res, 200, db.players[key]);
    });
  }
  // ── PATCH /api/players/:name/aliases ────────────────────────────────────────
  if (parts[0]==='players' && parts[1] && parts[2]==='aliases' && method==='PATCH') {
    return readBody(req, async data => {
      const key = decodeURIComponent(parts[1]).toLowerCase();
      if (!db.players[key]) db.players[key] = { name: decodeURIComponent(parts[1]), aliases:[], topPlayer:false, gfwlTeams:[], eventDecklists:[] };
      const p = db.players[key];
      if (data.aliases    !== undefined) p.aliases    = data.aliases;
      if (data.topPlayer  !== undefined) p.topPlayer  = !!data.topPlayer;
      if (data.gfwlTeams  !== undefined) p.gfwlTeams  = data.gfwlTeams;
      if (data.eventDecklists !== undefined) p.eventDecklists = data.eventDecklists;
      if (data.tags       !== undefined) p.tags       = data.tags;
      await saveDB('players'); // explicit key — bare saveDB() can silently skip 'players'
                                 // once it's fallen out of the dirty-key tracking set
      return json(res, 200, p);
    });
  }

  // ── GET /api/batches ────────────────────────────────────────────────────────
  if (parts[0]==='batches' && !parts[1] && method==='GET') {
    const list = Object.values(db.batches).map(b => ({ id:b.id, name:b.name, player:b.player, replayCount:(b.replays||[]).length, createdAt:b.createdAt }));
    return json(res, 200, list.sort((a,b)=>b.createdAt-a.createdAt));
  }
  // ── POST /api/batches ───────────────────────────────────────────────────────
  if (parts[0]==='batches' && !parts[1] && method==='POST') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above can create batches' });
    return readBody(req, async data => {
      const id = crypto.randomUUID();
      const batch = { id, name: data.name||data.player||'Batch', player: data.player||'', aliases: data.aliases||[], replays: [], createdAt: Date.now(), status: 'pending' };
      db.batches[id] = batch;
      await saveBatchToPostgres(id);
      return json(res, 200, batch);
    });
  }
  // ── GET /api/batches/:id ────────────────────────────────────────────────────
  if (parts[0]==='batches' && parts[1] && !parts[2] && method==='GET') {
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    return json(res, 200, b);
  }
  // ── PATCH /api/batches/:id ──────────────────────────────────────────────────
  if (parts[0]==='batches' && parts[1] && !parts[2] && method==='PATCH') {
    return readBody(req, async data => {
      const b = db.batches[parts[1]];
      if (!b) return json(res, 404, { error:'Not found' });
      if (data.name           !== undefined) b.name           = data.name;
      if (data.aliases        !== undefined) b.aliases        = data.aliases;
      if (data.eventDecklists !== undefined) b.eventDecklists = data.eventDecklists;
      await saveBatchToPostgres(b.id);
      return json(res, 200, b);
    });
  }
  // ── DELETE /api/batches/:id ─────────────────────────────────────────────────
  if (parts[0]==='batches' && parts[1] && !parts[2] && method==='DELETE') {
    if (!db.batches[parts[1]]) return json(res, 404, { error:'Not found' });
    const role = getRole(req);
    if (!role) return json(res, 403, { error:'Not authenticated' });
    const batch = db.batches[parts[1]];
    const ageHours = (Date.now() - (batch.createdAt||0)) / 3600000;
    // Miners cannot delete batches older than 24 hours
    if (role === 'miner' && ageHours > 24) {
      return json(res, 403, { error: 'Miners cannot delete batches older than 24 hours' });
    }
    // Users cannot delete any batches
    if (role === 'user') {
      return json(res, 403, { error: 'Users cannot delete batches' });
    }
    delete db.batches[parts[1]];
    await deleteBatchFromPostgres(parts[1]);
    return json(res, 200, { ok:true });
  }

  // ── DELETE /api/batches/:id/replay/:replayId ────────────────────────────────
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && parts[3] && !parts[4] && method==='DELETE') {
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    const replayId = decodeURIComponent(parts[3]);
    const before = (b.replays||[]).length;
    b.replays = (b.replays||[]).filter(r => r.replayId !== replayId);
    await saveBatchToPostgres(b.id);
    return json(res, 200, { ok:true, removed: before - b.replays.length });
  }

  // ── PATCH /api/batches/:id/replay/:replayId/parsed — store parsed result, clear allPlays ──
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && parts[3] && parts[4]==='parsed' && method==='PATCH') {
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    return readBody(req, async data => {
      const r = (b.replays||[]).find(r => r.replayId === decodeURIComponent(parts[3]));
      if (r) {
        if (data.parsed) r.parsed = data.parsed;
        if (data.plays)  r.plays  = data.plays;
        r.allPlays = []; // clear raw plays once parsed
        await saveBatchToPostgres(b.id);
        console.log(`[parsed] Migrated replay ${r.replayId} — allPlays cleared`);
      }
      return json(res, 200, { ok:true });
    });
  }

  // ── PATCH /api/batches/:id/replay/:replayId/override ───────────────────────
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && parts[3] && parts[4]==='override' && method==='PATCH') {
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    return readBody(req, async data => {
      const r = (b.replays||[]).find(r => r.replayId === parts[3]);
      if (r) {
        if (data.myDeckOverride  !== undefined) r.myDeckOverride  = data.myDeckOverride;
        if (data.oppDeckOverride !== undefined) r.oppDeckOverride = data.oppDeckOverride;
        // Also update parsed if available
        if (r.parsed) {
          if (data.myDeckOverride)  r.parsed.myDeck  = data.myDeckOverride;
          if (data.oppDeckOverride) r.parsed.oppDeck = data.oppDeckOverride;
        }
        await saveBatchToPostgres(b.id);
        return json(res, 200, { ok:true, found:true });
      }
      return json(res, 200, { ok:true, found:false });
    });
  }

  // ── PATCH /api/batches/:id/replay/:replayId/label ──────────────────────────
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && parts[3] && parts[4]==='label' && method==='PATCH') {
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    return readBody(req, async data => {
      const r = (b.replays||[]).find(r => r.replayId === parts[3]);
      if (r) { r.eventLabel = data.eventLabel||''; await saveBatchToPostgres(b.id); }
      return json(res, 200, { ok:true });
    });
  }

  // ── POST /api/batches/:id/replay ────────────────────────────────────────────
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && method==='POST') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above can add replays' });
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    return readBody(req, async data => {
      const dupIdx = (b.replays||[]).findIndex(r => r.replayId === data.replayId);
      const dup = dupIdx >= 0 ? b.replays[dupIdx] : null;
      const crossLinks = [];

      const minPlays = (data.allPlays||[]).map(p => ({
          play:p.play,owner:p.owner,username:p.username,player1:p.player1,player2:p.player2,
          player1_choice:p.player1_choice||p.p1pick||undefined,
          player2_choice:p.player2_choice||p.p2pick||undefined,
          cards:p.cards?p.cards.map(c=>({name:c.name,owner:c.owner,id:c.id,serial_number:c.serial_number,card_type:c.card_type})):undefined,
          card:p.card?{name:p.card.name,owner:p.card.owner,id:p.card.id,serial_number:p.card.serial_number,card_type:p.card.card_type}:undefined,
          winner:p.winner,loser:p.loser,game:p.game,pick:p.pick,p1pick:p.p1pick,p2pick:p.p2pick,
          log:Array.isArray(p.log)?p.log.map(l=>({type:l.type,owner:l.owner,username:l.username,card:l.card?{name:l.card.name,id:l.card.id,serial_number:l.card.serial_number}:undefined,game:l.game,public_log:l.public_log,private_log:l.private_log})):(p.log&&typeof p.log==='object'?{type:p.log.type,owner:p.log.owner,username:p.log.username,public_log:p.log.public_log,private_log:p.log.private_log}:undefined)
      }));

      if (!dup) {
        // New replay — insert
        if (!b.replays) b.replays = [];
        try {
        // Store parsed result if provided; strip allPlays either way
        const strippedPlays = (minPlays||[]).map(stripPlay);
        const parsedData = data.parsed || null;
        b.replays.push({ replayId:data.replayId, plays:data.plays||[], allPlays:parsedData?[]:strippedPlays, parsed:parsedData, timedOut:!!data.timedOut, eventLabel:data.eventLabel||'', oppName:data.oppName||'', player1:data.player1||null, player2:data.player2||null, savedAt:Date.now() });
        b.status = 'ready';
        // Log for Head Admin revert
        if (!db._changeLog) db._changeLog = [];
        db._changeLog.push({ t:Date.now(), action:'add_replay', batchId:b.id, batchPlayer:b.player, replayId:data.replayId, user:getUser(req)?.name||'unknown' });
        if (db._changeLog.length > 5000) db._changeLog = db._changeLog.slice(-5000);
        // Only cross-link when explicitly allowed (new batch creation, not manual add-to-batch)
        if (data.oppName && !data.noCrossLink) {
          const cl = crossLinkReplay(data, data.oppName, b.player);
          if (cl) crossLinks.push(cl);
          if (cl && cl.batchId) await saveBatchToPostgres(cl.batchId).catch(e=>console.error('[crosslink save]',e.message));
        }
        await saveBatchToPostgres(b.id);
        } catch(saveErr) { console.error('[replay POST] Save error:', saveErr.message); throw saveErr; }
      } else if (dup.timedOut && !data.timedOut) {
        // Existing timed-out entry being updated with real data — overwrite it
        const parsedData2 = data.parsed || null;
        b.replays[dupIdx] = { replayId:data.replayId, plays:data.plays||[], allPlays:parsedData2?[]:(minPlays||[]).map(stripPlay), parsed:parsedData2, timedOut:false, eventLabel:dup.eventLabel||data.eventLabel||'', oppName:data.oppName||dup.oppName||'', player1:data.player1||dup.player1||null, player2:data.player2||dup.player2||null, savedAt:Date.now() };
        b.status = 'ready';
        console.log(`[replay] Updated timed-out replay ${data.replayId} with real data`);
        await saveBatchToPostgres(b.id);
      }
      return json(res, 200, { ok:true, duplicate:!!dup, crossLinks });
    });
  }

  // ── POST /api/batches/:id/cleanup — remove replays where player doesn't appear ──
  if (parts[0]==='batches' && parts[2]==='cleanup' && method==='POST') {
    const bId = parts[1];
    const b = db.batches[bId];
    if (!b) return json(res, 404, { error:'Batch not found' });
    const player = (b.player||'').toLowerCase();
    const aliases = (b.aliases||[]).map(a=>a.toLowerCase());
    const isPlayer = u => {
      if (!u) return false;
      const ul = String(u).toLowerCase().trim();
      return ul === player || aliases.includes(ul);
    };
    const before = b.replays.length;
    b.replays = b.replays.filter(r => {
      if (r.timedOut) return true;
      if (!r.player1 && !r.player2) return true;
      return isPlayer(r.player1) || isPlayer(r.player2);
    });
    const removed = before - b.replays.length;
    if (removed > 0) await saveBatchToPostgres(b.id);
    console.log(`[cleanup] Batch ${bId} (${b.name}): removed ${removed} invalid replays`);
    return json(res, 200, { ok:true, removed, kept:b.replays.length });
  }

  // ── GET /api/admin/error-log — view recent server errors ────────────────────
  if (parts[0]==='admin' && parts[1]==='error-log' && method==='GET') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    return json(res, 200, { errors: _errorLog, uptime: process.uptime(), memory: process.memoryUsage() });
  }

  // ── GET /api/event-dates — get cached event dates ───────────────────────────
  if (parts[0]==='event-dates' && method==='GET') {
    return json(res, 200, db.eventDates || {});
  }

  // ── POST /api/event-dates/refresh — scrape formatlibrary.com ─────────────
  if (parts[0]==='event-dates' && parts[1]==='refresh' && method==='POST') {
    // Run in background, return immediately
    res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({ ok:true, message:'Refresh started in background' }));
    scrapeFormatLibraryEvents().catch(e => console.error('[EventDates] Scrape error:', e.message));
    return;
  }

  // ── POST /api/gfwl/:season/bulk-import — import full season teams+schedule ──
  if (parts[0]==='gfwl' && parts[1] && parts[2]==='bulk-import' && method==='POST') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const season = normalizeSeason(parts[1]);
    return readBody(req, async data => {
      if (!db.gfwl[season]) db.gfwl[season] = { season, numWeeks:9, teams:{} };
      const incoming = data.teams || {};
      let added=0, updated=0;
      // Build a lowercase → canonical name map of existing teams for dedup
      const existingLower = {};
      for (const name of Object.keys(db.gfwl[season].teams)) {
        existingLower[name.toLowerCase()] = name;
      }
      for (const [teamName, teamData] of Object.entries(incoming)) {
        // Find existing team case-insensitively to prevent duplicates like
        // "Birdcage" vs "birdcage" appearing as separate teams
        const existingKey = existingLower[teamName.toLowerCase()];
        if (!existingKey) {
          // New team — use the incoming name as canonical
          db.gfwl[season].teams[teamName] = {
            conference: teamData.conference || '',
            aliases: teamData.aliases || [],
            roster: teamData.roster || [],
            addDrops: teamData.addDrops || [],
            schedule: teamData.schedule || [],
            notes: teamData.notes || ''
          };
          existingLower[teamName.toLowerCase()] = teamName;
          added++;
        } else {
          // Existing team — only update conference and schedule, preserve roster/addDrops
          const t = db.gfwl[season].teams[existingKey];
          if (teamData.conference) t.conference = teamData.conference;
          if (teamData.schedule && teamData.schedule.length) t.schedule = teamData.schedule;
          if (teamData.aliases && teamData.aliases.length) t.aliases = teamData.aliases;
          updated++;
        }
      }
      if (data.numWeeks) db.gfwl[season].numWeeks = data.numWeeks;
      await saveDB('gfwl');
      console.log('[BulkImport] S'+season+': '+added+' added, '+updated+' updated');
      return json(res, 200, { ok:true, added, updated, total:Object.keys(db.gfwl[season].teams).length });
    });
  }

  // ── GET /api/gfwl — get all GFWL season data ─────────────────────────────────
  if (parts[0]==='gfwl' && !parts[1] && method==='GET') {
    return json(res, 200, db.gfwl);
  }

  // ── GET /api/gfwl/:season — get one season ────────────────────────────────
  if (parts[0]==='gfwl' && parts[1] && !parts[2] && method==='GET') {
    return json(res, 200, db.gfwl[normalizeSeason(parts[1])] || {});
  }

  // ── PATCH /api/gfwl/:season — update season data (admin only) ────────────
  if (parts[0]==='gfwl' && parts[1] && !parts[2] && method==='PATCH') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    return readBody(req, async data => {
      const sKey = normalizeSeason(parts[1]);
      if (!db.gfwl[sKey]) db.gfwl[sKey] = { teams: {} };
      // reassign parts[1] to normalized key
      parts[1] = sKey;
      if (!db.gfwl[parts[1]]) db.gfwl[parts[1]] = { teams: {} };
      // Deep merge
      if (data.teams) {
        for (const [teamName, teamData] of Object.entries(data.teams)) {
          if (!db.gfwl[parts[1]].teams[teamName]) {
            db.gfwl[parts[1]].teams[teamName] = { conference:'', roster:[], addDrops:[], schedule:[], notes:'' };
          }
          Object.assign(db.gfwl[parts[1]].teams[teamName], teamData);
        }
      }
      if (data.numWeeks !== undefined) db.gfwl[parts[1]].numWeeks = data.numWeeks;
      if (data.season   !== undefined) db.gfwl[parts[1]].season   = data.season;
      await saveDB();
      return json(res, 200, { ok:true, season: db.gfwl[parts[1]] });
    });
  }

  // ── PATCH /api/gfwl/:season/team/:teamName — update one team ─────────────
  if (parts[0]==='gfwl' && parts[1] && parts[2]==='team' && parts[3] && method==='PATCH') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const season   = normalizeSeason(parts[1]);
    const teamName = decodeURIComponent(parts[3]);
    return readBody(req, async data => {
      if (!db.gfwl[season]) db.gfwl[season] = { teams: {} };
      if (!db.gfwl[season].teams[teamName]) {
        db.gfwl[season].teams[teamName] = { conference:'', roster:[], addDrops:[], schedule:[], notes:'' };
      }
      Object.assign(db.gfwl[season].teams[teamName], data);
      await saveDB();
      return json(res, 200, { ok:true, team: db.gfwl[season].teams[teamName] });
    });
  }

  // ── DELETE /api/gfwl/:season/team/:teamName — remove a team ──────────────
  if (parts[0]==='gfwl' && parts[1] && parts[2]==='team' && parts[3] && method==='DELETE') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const season   = normalizeSeason(parts[1]);
    const teamName = decodeURIComponent(parts[3]);
    if (db.gfwl[season] && db.gfwl[season].teams) {
      delete db.gfwl[season].teams[teamName];
      await saveDB();
    }
    return json(res, 200, { ok:true });
  }

  // ── GET /api/proxy/deck-ydk?id=:deckId ──────────────────────────────────────
  if (parts[0]==='proxy' && parts[1]==='deck-ydk' && method==='GET') {
    const deckId = new URL('http://x'+req.url).searchParams.get('id');
    if (!deckId) return json(res, 400, { error:'Missing id' });
    try {
      const https = require('https');
      const ydkText = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'www.duelingbook.com',
          path: `/deck-ydk?id=${deckId}`,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        };
        const req2 = https.get(options, res2 => {
          let data = '';
          res2.on('data', c => data += c);
          res2.on('end', () => resolve(data));
        });
        req2.on('error', reject);
        req2.setTimeout(10000, () => { req2.destroy(); reject(new Error('timeout')); });
      });
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${deckId}.ydk"` });
      res.end(ydkText);
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/proxy/replay?id=:replayId ──────────────────────────────────────
  // Solves Cloudflare Turnstile via CapSolver, then POSTs to duelingbook view-replay
  if (parts[0]==='proxy' && parts[1]==='replay' && method==='GET') {
    const replayId = url.searchParams.get('id');
    if (!replayId) return json(res, 400, { error: 'id required' });

    const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY;
    const TURNSTILE_SITE_KEY = '0x4AAAAAAC17T9xSOtcacJq5';
    const DUELINGBOOK_URL = 'https://www.duelingbook.com';

    if (!CAPSOLVER_API_KEY) return json(res, 500, { error: 'CAPSOLVER_API_KEY not set in environment' });
    if (!process.env.DUELINGBOOK_SESSION_COOKIE) {
      console.warn('[proxy/replay] WARNING: DUELINGBOOK_SESSION_COOKIE not set — replays may intermittently fail with "must be logged in" errors');
    }

    try {
      const https = require('https');

      // Step 1: Ask CapSolver to solve the Turnstile
      function httpsPost(hostname, path, body) {
        return new Promise((resolve, reject) => {
          const data = JSON.stringify(body);
          const req2 = https.request({ hostname, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r2) => {
            let buf = '';
            r2.on('data', d => buf += d);
            r2.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { reject(new Error('Bad JSON: ' + buf.slice(0, 100))); } });
          });
          req2.on('error', reject);
          req2.setTimeout(25000, () => { req2.destroy(); reject(new Error('CapSolver request timeout')); });
          req2.write(data);
          req2.end();
        });
      }

      // Create task
      const taskRes = await httpsPost('api.capsolver.com', '/createTask', {
        clientKey: CAPSOLVER_API_KEY,
        task: {
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: DUELINGBOOK_URL,
          websiteKey: TURNSTILE_SITE_KEY,
        }
      });

      if (taskRes.errorId) throw new Error('CapSolver createTask error: ' + taskRes.errorDescription);
      const taskId = taskRes.taskId;
      console.log(`[proxy/replay] CapSolver taskId=${taskId} for replay ${replayId}`);

      // Poll for solution (max 90s — Turnstile solves can take 40-60s+ under load)
      let token = null;
      let userAgent = null;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const resultRes = await httpsPost('api.capsolver.com', '/getTaskResult', { clientKey: CAPSOLVER_API_KEY, taskId });
        if (resultRes.status === 'ready') {
          token = resultRes.solution?.token;
          userAgent = resultRes.solution?.userAgent;
          break;
        }
        if (resultRes.errorId) throw new Error('CapSolver poll error: ' + resultRes.errorDescription);
      }
      if (!token) throw new Error('CapSolver timed out waiting for token (90s)');
      console.log(`[proxy/replay] Got Turnstile token for ${replayId}`);

      // Step 2: POST to duelingbook view-replay with the token as multipart form data
      const replayData = await new Promise((resolve, reject) => {
        const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
        function field(name, value) {
          return `--${boundary}
Content-Disposition: form-data; name="${name}"

${value}
`;
        }
        const body = field('token', token) + field('turnstile', 'true') + field('master', 'false') + `--${boundary}--
`;
        const bodyBuf = Buffer.from(body);

        const req2 = https.request({
          hostname: 'www.duelingbook.com',
          path: `/view-replay?id=${encodeURIComponent(replayId)}`,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': bodyBuf.length,
            'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': DUELINGBOOK_URL + '/',
            'Origin': DUELINGBOOK_URL,
            ...(process.env.DUELINGBOOK_SESSION_COOKIE ? { 'Cookie': `PHPSESSID=${process.env.DUELINGBOOK_SESSION_COOKIE}` } : {}),
          }
        }, (r2) => {
          let buf = '';
          r2.on('data', d => buf += d);
          r2.on('end', () => {
            try { resolve(JSON.parse(buf)); }
            catch(e) { reject(new Error('Duelingbook returned non-JSON: ' + buf.slice(0, 200))); }
          });
        });
        req2.on('error', reject);
        req2.setTimeout(30000, () => { req2.destroy(); reject(new Error('duelingbook timeout (30s)')); });
        req2.write(bodyBuf);
        req2.end();
      });

      if (replayData.action === 'Error') {
        // Retry once after a short delay — some replays fail transiently
        console.warn(`[proxy/replay] Duelingbook error for ${replayId}: ${replayData.message} — retrying in 3s`);
        await new Promise(r => setTimeout(r, 3000));
        // Re-solve the Turnstile token and retry the request
        const taskId2 = await httpsPost('api.capsolver.com', '/createTask', { clientKey: CAPSOLVER_API_KEY, task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: DUELINGBOOK_URL, websiteKey: TURNSTILE_SITE_KEY } }).then(r => { if (r.errorId) throw new Error('CapSolver retry error: ' + r.errorDescription); return r.taskId; });
        let token2 = null;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1500));
          const r2 = await httpsPost('api.capsolver.com', '/getTaskResult', { clientKey: CAPSOLVER_API_KEY, taskId: taskId2 });
          if (r2.status === 'ready') { token2 = r2.solution?.token; break; }
          if (r2.errorId) throw new Error('CapSolver retry poll error: ' + r2.errorDescription);
        }
        if (!token2) throw new Error('Retry: CapSolver timed out');
        const retryData = await new Promise((resolve, reject) => {
          const boundary2 = '----FormBoundary' + Math.random().toString(36).slice(2);
          function field2(name, value) { return `--${boundary2}\nContent-Disposition: form-data; name="${name}"\n\n${value}\n`; }
          const body2 = field2('token', token2) + field2('turnstile', 'true') + field2('master', 'false') + `--${boundary2}--\n`;
          const buf2 = Buffer.from(body2);
          const req3 = require('https').request({ hostname: 'www.duelingbook.com', path: `/view-replay?id=${encodeURIComponent(replayId)}`, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary2}`, 'Content-Length': buf2.length, 'User-Agent': 'Mozilla/5.0', 'Referer': DUELINGBOOK_URL+'/', 'Origin': DUELINGBOOK_URL, ...(process.env.DUELINGBOOK_SESSION_COOKIE ? { 'Cookie': `PHPSESSID=${process.env.DUELINGBOOK_SESSION_COOKIE}` } : {}) } }, (r3) => { let b3=''; r3.on('data',d=>b3+=d); r3.on('end',()=>{ try{resolve(JSON.parse(b3));}catch(e){reject(new Error('Retry non-JSON: '+b3.slice(0,100)));} }); });
          req3.on('error', reject); req3.setTimeout(30000, () => { req3.destroy(); reject(new Error('Retry timeout')); });
          req3.write(buf2); req3.end();
        });
        if (retryData.action === 'Error') throw new Error('Duelingbook error (after retry): ' + retryData.message);
        if (!retryData.plays && !retryData.action) throw new Error('Duelingbook returned unexpected response on retry');
        console.log(`[proxy/replay] Retry succeeded for ${replayId}`);
        return json(res, 200, { ok: true, replay: retryData });
      }

      console.log(`[proxy/replay] Got replay data for ${replayId} — ${(replayData.plays||[]).length} plays`);

      // If 0 plays returned, retry with master=true — some duelingbook replays
      // are stored as "master" replays and only return play data with that flag set
      if (!(replayData.plays||[]).length && !replayData.action) {
        console.warn(`[proxy/replay] ${replayId} returned 0 plays — retrying with master=true. Response keys:`, Object.keys(replayData));
        const masterData = await new Promise((resolve, reject) => {
          const boundary3 = '----FormBoundary' + Math.random().toString(36).slice(2);
          function field3(name, value) {
            return `--${boundary3}\nContent-Disposition: form-data; name="${name}"\n\n${value}\n`;
          }
          const body3 = field3('token', token) + field3('turnstile', 'true') + field3('master', 'true') + `--${boundary3}--\n`;
          const buf3 = Buffer.from(body3);
          const req3 = https.request({
            hostname: 'www.duelingbook.com',
            path: `/view-replay?id=${encodeURIComponent(replayId)}`,
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary3}`,
              'Content-Length': buf3.length,
              'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': DUELINGBOOK_URL + '/',
              'Origin': DUELINGBOOK_URL,
              ...(process.env.DUELINGBOOK_SESSION_COOKIE ? { 'Cookie': `PHPSESSID=${process.env.DUELINGBOOK_SESSION_COOKIE}` } : {}),
            }
          }, (r3) => {
            let buf = ''; r3.on('data', d => buf += d);
            r3.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { reject(new Error('master retry non-JSON: ' + buf.slice(0,100))); } });
          });
          req3.on('error', reject);
          req3.setTimeout(30000, () => { req3.destroy(); reject(new Error('master retry timeout')); });
          req3.write(buf3); req3.end();
        });
        console.log(`[proxy/replay] master=true retry for ${replayId} — ${(masterData.plays||[]).length} plays. Keys:`, Object.keys(masterData));
        if ((masterData.plays||[]).length > 0) {
          return json(res, 200, { ok: true, replay: masterData });
        }
        // Still 0 plays — return what we have (may have other useful fields)
        console.warn(`[proxy/replay] ${replayId} still 0 plays after master=true retry. Full:`, JSON.stringify(replayData).slice(0, 300));
        return json(res, 200, { ok: true, replay: replayData });
      }

      return json(res, 200, { ok: true, replay: replayData });

    } catch(e) {
      console.error(`[proxy/replay] Failed for ${replayId}:`, e.message);
      return json(res, 502, { error: e.message });
    }
  }

  return json(res, 404, { error:'Not found' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🃏 Duel Tools  →  http://0.0.0.0:${PORT}\n`);
  if (!process.env.RAILWAY_ENVIRONMENT && !process.env.DATABASE_URL) {
    const { exec } = require('child_process');
    const url = `http://localhost:${PORT}`;
    const open = process.platform==='win32' ? `start "" "${url}"` :
                 process.platform==='darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(open);
  }
  initDB().catch(e => console.error('DB init error:', e.message));
});

process.on('SIGINT',  () => { saveDB().then(() => process.exit(0)).catch(() => process.exit(1)); });
process.on('SIGTERM', () => { saveDB().then(() => process.exit(0)).catch(() => process.exit(1)); });

// ── In-memory error log (last 100 errors) ────────────────────────────────────
const _errorLog = [];
function logError(type, msg, stack) {
  _errorLog.push({ time: new Date().toISOString(), type, msg, stack: stack||'' });
  if (_errorLog.length > 100) _errorLog.shift();
  console.error('['+type+']', msg);
}

// ── Global crash prevention ────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err.message, err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('unhandledRejection', reason?.message || String(reason), reason?.stack||'');
});


// ── GFWL season key normalizer: "Season 9", "s9" → "S9" ─────────────────────
function normalizeSeason(s) {
  if (!s) return '';
  const str = String(s).trim();
  const mSeason = str.match(/^season\s*(\d+)$/i);
  if (mSeason) return 'S'+mSeason[1];
  const mS = str.match(/^[Ss](\d+)$/);
  if (mS) return 'S'+mS[1];
  return str.toUpperCase();
}

// ── Format Library event date scraper ───────────────────────────────────────
const EVENT_DATE_CATALOG = {
  'GFCEU26': '2026',
  'SESB18': '2026',
  'PWCQ88': '2026',
  'FLC40': '2026',
  'CLASH26': '2026',
  'GWW02': '2026',
  'PWCQ87': '2026',
  'GFC25': '2026',
  'PWCQ86': '2026',
  'GSLP26A': '2026',
  'PWCQ85': '2026',
  'PWCQ84': '2026',
  'FLC39': '2026',
  'PWCQ83': '2026',
  'SESB13': '2026',
  'GBOAT02': '2025',
  'PWCQ82': '2025',
  'PWCQ81': '2025',
  'GFWC25': '2025',
  'GLCQ25C': '2025',
  'GLCQ25B': '2025',
  'GLCQ25A': '2025',
  'PWCQ80': '2025',
  'PWCQ79': '2025',
  'GFC24': '2025',
  'FLC38': '2025',
  'GSLP25': '2025',
  'PWCQ78': '2025',
  'PWCQ77': '2025',
  'GFCEU25': '2025',
  'CLASH25': '2025',
  'PWCQ76': '2025',
  'DSGNQ04': '2025',
  'FLC37': '2025',
  'DSGNQ03': '2025',
  'TGFC06': '2025',
  'PWCQ75': '2025',
  'PWCQ74': '2025',
  'PWCQ73': '2025',
  'DSGNQ02': '2025',
  'FLC36': '2025',
  'PWCQ72': '2025',
  'GFC23': '2025',
  'DSGNQ01': '2025',
  'PWCQ71': '2025',
  'GBOAT01': '2024',
  'PWCQ70': '2024',
  'PWCQ69': '2024',
  'PBR33': '2024',
  'PBR35': '2024',
  'GFWC24': '2024',
  'GLCQ24C': '2024',
  'GLCQ24B': '2024',
  'GLCQ24A': '2024',
  'GGI03': '2024',
  'PBR31': '2024',
  'FLC35': '2024',
  'PWCQ68': '2024',
  'PWCQ67': '2024',
  'PWCQ66': '2024',
  'PWCQ65': '2024',
  'FLC34': '2024',
  'PBR29': '2024',
  'PWCQ63': '2024',
  'PWCQ64': '2024',
  'PBR27': '2024',
  'GFCEU24': '2024',
  'PWCQ62': '2024',
  'PWCQ61': '2024',
  'GFSMT01': '2024',
  'PBR25': '2024',
  'PWCQ60': '2024',
  'FLC33': '2024',
  'CLASH24': '2024',
  'PWCQ59': '2024',
  'PBR23': '2024',
  'TGFC07': '2024',
  'PWCQ58': '2024',
  'PBR21': '2024',
  'PWCQ57': '2024',
  'GFC22': '2024',
  'PBR19': '2024',
  'PWCQ56': '2024',
  'FLC32': '2024',
  'PBR17': '2024',
  'PWCQ55': '2024',
  'PWCQ54': '2024',
  'BDB02': '2024',
  'GWW01': '2024',
  'PWCQ53': '2024',
  'PBR15': '2024',
  'PWCQ52': '2024',
  'GFC21': '2024',
  'PWCQ51': '2024',
  'HOBA01': '2023',
  'PBR13': '2023',
  'PBR11': '2023',
  'PWCQ48': '2023',
  'PBR09': '2023',
  'GFWC23': '2023',
  'GCICS11': '2023',
  'PBR07': '2023',
  'FLC31': '2023',
  'PBR05': '2023',
  'PWCQ42': '2023',
  'PWCQ41': '2023',
  'PBR03': '2023',
  'PWCQ40': '2023',
  'GGPCHI23': '2023',
  'OBEL27': '2023',
  'GFCEU23': '2023',
  'OBEL26': '2023',
  'SDGIC23': '2023',
  'FCI02': '2023',
  'FLC30': '2023',
  'PWCQ39': '2023',
  'GFC20': '2023',
  'PBR01': '2023',
  'PWCQ38': '2023',
  'FCI01': '2023',
  'GCICS10': '2023',
  'PWCQ37': '2023',
  'CLASH23': '2023',
  'OBEL25': '2023',
  'FLC29': '2023',
  'PWCQ36': '2023',
  'PWCQ35': '2023',
  'OBEL24': '2023',
  'PWCQ34': '2023',
  'TGFC05': '2023',
  'PWCQ33': '2023',
  'OBEL23': '2023',
  'PWCQ32': '2023',
  'FLC28': '2023',
  'PWCQ31': '2023',
  'OBEL22': '2023',
  'GFC19': '2023',
  'GCICS09': '2023',
  'PWCQ30': '2023',
  'BIRD02': '2022',
  'PWCQ29': '2022',
  'PWCQ28': '2022',
  'GCICS08': '2022',
  'PWCQ27': '2022',
  'PWCQ26': '2022',
  'BIRD01': '2022',
  'GFWC22': '2022',
  'GGI01': '2022',
  'GLCQ22B': '2022',
  'FLC27': '2022',
  'GLCQ22A': '2022',
  'OBEL21': '2022',
  'PWCQ25': '2022',
  'GGPNE22': '2022',
  'PWCQ24': '2022',
  'PWCQ23': '2022',
  'GCICS07': '2022',
  'CLASH22': '2022',
  'GGPIL22': '2022',
  'OBEL20': '2022',
  'PWCQ22': '2022',
  'FLC26': '2022',
  'PWCQ21': '2022',
  'PWCQ20': '2022',
  'TGFC04': '2022',
  'FLC25': '2022',
  'OBEL19': '2022',
  'GFC18': '2022',
  'PWCQ19': '2022',
  'PWCQ18': '2022',
  'OBEL18': '2022',
  'DDS05': '2022',
  'PWCQ17': '2022',
  'LADQ01': '2022',
  'ITNC22': '2022',
  'PWCQ16': '2022',
  'FLC24': '2022',
  'OBEL17': '2022',
  'PWCQ15': '2022',
  'OBEL16': '2022',
  'PEWCQ': '2022',
  'PAPL02': '2022',
  'GCICS06': '2022',
  'GFC17': '2022',
  'PWCQ14': '2022',
  'OBEL15': '2022',
  'PWCQ13': '2022',
  'FLC23': '2022',
  'TGFC03': '2022',
  'PWCQ12': '2022',
  'OBEL14': '2022',
  'GFC16': '2022',
  'FLC22': '2022',
  'OBEL13': '2022',
  'PWCQ11': '2022',
  'OBEL12': '2022',
  'PWCQ10': '2021',
  'GCICS05': '2021',
  'PWCQ09': '2021',
  'GFWC21': '2021',
  'GLCQ21': '2021',
  'OBEL10': '2021',
  'FLC21': '2021',
  'OBEL11': '2021',
  'PWCQ08': '2021',
  'GFC15': '2021',
  'GCICS04': '2021',
  'PWCQ07': '2021',
  'FLC20': '2021',
  'OBEL09': '2021',
  'GFC14': '2021',
  'PWCQ06': '2021',
  'GFC13': '2021',
  'OBEL08': '2021',
  'TGFC02': '2021',
  'PWCQ05': '2021',
  'FLC19': '2021',
  'PWCQ04': '2021',
  'OBEL07': '2021',
  'PWCQ03': '2021',
  'OBEL06': '2021',
  'FLC18': '2021',
  'GFC12': '2021',
  'OBEL05': '2021',
  'PWCQ02': '2021',
  'FLC17': '2021',
  'PWCQ01': '2021',
  'OBEL04': '2021',
  'TGFC01': '2021',
  'OBEL03': '2021',
  'FLC16': '2021',
  'OBEL02': '2021',
  'GFC11': '2021',
  'OBEL01': '2020',
  'FLC15': '2020',
  'GCICS03': '2020',
  'GFC10': '2020',
  'FLC14': '2020',
  'GFC09': '2020',
  'FLC13': '2020',
  'GFCEU20': '2020',
  'FLC12': '2020',
  'GFC08': '2020',
  'GFC07': '2020',
  'GFC06': '2020',
  'GFC05': '2020',
  'FLC11': '2020',
  'GFC04': '2020',
  'GFC03': '2020',
  'GFC02': '2020',
  'GFC01': '2020',
  'GCICS02': '2019',
  'FLC10': '2019',
  'GCICS01': '2019',
  'SWAG': '2019',
  'FLC09': '2019',
  'FLC08': '2019',
  'FLC07': '2019',
  'FLC06': '2018',
  'FLC05': '2018',
  'FLC04': '2018',
  'FLC03': '2018',
  'FLC02': '2018',
  'FLC01': '2018',
  'SJCIND05': '2005',
  'SJCSEA05': '2005',
  'USNC05': '2005',
  'SJCCHA05': '2005',
  'SJCNJ05': '2005',
  'UKNC05': '2005',
  'SJCHOU05': '2005',
  'SJCPOM05': '2005',
};

// Build the event date catalog from CSV-sourced data into db.eventDates
function buildEventCatalog() {
  let added = 0;
  for (const [code, yr] of Object.entries(EVENT_DATE_CATALOG)) {
    if (!db.eventDates[code]) {
      db.eventDates[code] = { date: yr + '-01-01', source: 'catalog' };
      added++;
    }
  }
  return added;
}

async function scrapeFormatLibraryEvents(specificCode) {
  if (_scrapeRunning) { console.log('[EventDates] Scrape already running, skipping'); return; }
  _scrapeRunning = true;
  const https = require('https');
  console.log('[EventDates] Building event date catalog...');

  // First: fill from our anchor-based catalog (instant, no network)
  const catalogAdded = buildEventCatalog();
  console.log('[EventDates] Catalog: added', catalogAdded, 'entries, total:', Object.keys(db.eventDates).filter(k=>!k.startsWith('_')).length);

  // Second: try to fetch additional events from Format Library's tournaments API
  // Try multiple known API endpoints since they change
  const apiUrls = [
    'https://formatlibrary.com/api/tournaments?size=200&page=0&format=goat',
    'https://formatlibrary.com/api/events?format=goat&size=200',
    'https://formatlibrary.com/api/events?format=goat&limit=200&offset=0',
  ];

  let apiSuccess = false;
  for (const url of apiUrls) {
    try {
      const data = await new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        }, res2 => {
          let body = '';
          res2.on('data', c => body += c);
          res2.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch(e) { reject(new Error('Not JSON')); }
          });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
      });

      const events = Array.isArray(data) ? data
        : (data.rows || data.events || data.data || data.results || data.tournaments || []);

      if (!events.length) continue;

      let liveAdded = 0;
      for (const evt of events) {
        const name = evt.name || evt.event_name || evt.title || '';
        const date = evt.date || evt.start_date || evt.startDate || evt.created_at || evt.updatedAt || '';
        if (!name || !date) continue;
        const code = extractEventCode(name);
        if (code && !db.eventDates[code]) {
          db.eventDates[code] = { date: date.slice(0,10), name, source:'formatlibrary-live' };
          liveAdded++;
        } else if (code && db.eventDates[code] && db.eventDates[code].source === 'catalog') {
          // Upgrade catalog estimate with real date
          db.eventDates[code] = { date: date.slice(0,10), name, source:'formatlibrary-live' };
        }
      }
      console.log('[EventDates] Live API added/upgraded', liveAdded, 'entries from', url);
      apiSuccess = true;
      break;
    } catch(e) {
      console.warn('[EventDates] API attempt failed:', url, e.message);
    }
  }

  if (!apiSuccess) {
    console.log('[EventDates] All API attempts failed — using catalog only');
  }

  await saveDB('eventDates');
  console.log('[EventDates] Final catalog size:', Object.keys(db.eventDates).filter(k=>!k.startsWith('_')).length);
  _scrapeRunning = false;
}

async function scrapeFormatLibraryHTML() {
  const https = require('https');
  try {
    // Scrape the events page for Goat format
    const pages = [1,2,3,4,5];
    for (const p of pages) {
      const url = `https://formatlibrary.com/events?format=goat&page=${p}&sort=date&order=desc&per_page=100`;
      const html = await new Promise((resolve,reject) => {
        const req = https.get(url, {headers:{'User-Agent':'Mozilla/5.0'}}, res2 => {
          let body=''; res2.on('data',c=>body+=c); res2.on('end',()=>resolve(body));
        });
        req.on('error',reject);
        req.setTimeout(15000,()=>{req.destroy();reject(new Error('timeout'));});
      });

      // Parse event names and dates from HTML
      // Look for patterns like "FLC40" or "PWCQ87" near dates
      const datePattern = /(\d{4}-\d{2}-\d{2})/g;
      const namePattern = /(Format Library Championship|Premium World Championship Qualifier|Goat Format Championship|Goat World War|Format Library Cup|Goat Format League Championship|Goat League Championship|Clash of Champions|Format Library Club|Goat Format Club)\s*(\d+[A-Z]?)/gi;

      let match;
      const dates = [];
      while ((match=datePattern.exec(html))!==null) dates.push(match[1]);

      let ni=0;
      namePattern.lastIndex=0;
      while ((match=namePattern.exec(html))!==null) {
        const fullName = match[0];
        const code = extractEventCode(fullName);
        if (code && !db.eventDates[code] && dates[ni]) {
          db.eventDates[code] = { date:dates[ni], name:fullName, source:'html' };
        }
        ni++;
      }
    }
    await saveDB();
    console.log('[EventDates] HTML scrape done, total:', Object.keys(db.eventDates).length);
  } catch(e) {
    console.error('[EventDates] HTML scrape failed:', e.message);
  }
}

// Extract a short event code from a full event name
function extractEventCode(name) {
  const n = name.trim();
  // Direct abbreviation map
  const abbrevMap = [
    [/Format Library Championship[\s#]*(\.?\d+[A-Z]?)/i,     'FLC'],
    [/Premium World Championship Qualifier[\s#]*(\d+)/i,       'PWCQ'],
    [/Goat Format Championship[\s#]*(\d+)/i,                   'GFC'],
    [/Goat World War[\s#]*(\d+)/i,                             'GWW'],
    [/Format Library Cup[\s#]*(\d+[A-Z]?)/i,                   'FLC'],
    [/Goat League Championship Qualifier[\s#]*(\d+[A-Z]?)/i,   'GLCQ'],
    [/Goat Format League Championship[\s#]*(\d+)/i,             'GFLC'],
    [/Goat Format War Championship[\s#]*(\d+)/i,                'GFWC'],
    [/Clash of Champions[\s#]*(\d+)/i,                          'CLASH'],
    [/Format Library Club[\s#]*(\d+)/i,                         'FLC'],
    [/Goat Format Club[\s#]*(\d+)/i,                            'GFC'],
    [/Goat World War Champions[\s#]*(\d+)/i,                    'GWW'],
    [/Goat Format War League[\s#]*(\d+)/i,                      'GFWL'],
    [/Tisis Cup[\s#]*(\d+)/i,                                   'TISIS'],
    [/Seven Eras[\s\w]*(\d+)/i,                                'SEERA'],
  ];
  for (const [re, prefix] of abbrevMap) {
    const m = n.match(re);
    if (m) return prefix + m[1].replace(/\./, '');
  }
  return null;
}

// No per-request scraping — event dates are built as a permanent catalog on startup.
// Use POST /api/event-dates/refresh to manually re-scrape Format Library.
function silentRefreshEventCode(code) {
  // No-op: per-request scraping caused thundering herd (40+ parallel scrapes on startup).
  // The catalog is populated once by scrapeFormatLibraryEvents() and persists in Postgres.
}

// ── PostgreSQL connection keep-alive ─────────────────────────────────────────
setInterval(async () => {
  if (pgClient) {
    try {
      await pgClient.query('SELECT 1');
    } catch(e) {
      console.warn('[PG] Keep-alive failed:', e.message);
      pgClient = null;
      try { await connectPostgres(); console.log('[PG] Reconnected via keep-alive'); }
      catch(e2) { console.error('[PG] Keep-alive reconnect failed:', e2.message); }
    }
  } else if (process.env.DATABASE_URL) {
    // pgClient is null — try to reconnect
    try { await connectPostgres(); console.log('[PG] Reconnected (was null)'); }
    catch(e) {}
  }
}, 30000); // Every 30 seconds

// ── Keep-alive ping — prevents Railway cold starts ───────────────────────────
const APP_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : null;
if (APP_URL) {
  setInterval(() => {
    const https = require('https');
    https.get(APP_URL + '/api/batches', res => {
      console.log('[keepalive] ping', res.statusCode);
    }).on('error', e => {
      console.warn('[keepalive] ping failed:', e.message);
    });
  }, 4 * 60 * 1000); // every 4 minutes
  console.log('[keepalive] enabled for', APP_URL);
}
