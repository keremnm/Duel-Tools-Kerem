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
  const res = await client.query("SELECT key, value FROM duel_tools_data WHERE key IN ('batches','players','users','gfwl','eventDates')");
  for (const row of res.rows) { db[row.key] = row.value; }
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

// Track which keys have changed since last save
const _dirtyKeys = new Set(['batches','players','users','gfwl','eventDates']);
let _saveQueued = false;
let _saveTimeout = null;

function markDirty(key) {
  _dirtyKeys.add(key);
}

async function saveDB(keys) {
  // If specific keys passed, use those; otherwise save all dirty keys
  const toSave = keys ? (Array.isArray(keys) ? keys : [keys]) : [..._dirtyKeys];
  if (!toSave.length) return;

  try {
    if (pgClient && pgClient._connected !== false) {
      try {
        // Build parameterized query for only dirty keys
        const values = [];
        const params = [];
        let idx = 1;
        for (const key of toSave) {
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
        // Clear dirty flags for saved keys
        toSave.forEach(k => _dirtyKeys.delete(k));
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
      try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
      catch(e) { console.error('File DB save error:', e.message); }
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

function makeToken(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString('base64');
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
    const { userId } = JSON.parse(Buffer.from(payload, 'base64').toString());
    return db.users[userId] || null;
  } catch(e) { return null; }
}

function isAdmin(req) {
  const user = getUser(req);
  return user && user.role === 'admin' && user.approved;
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
function crossLinkReplay(replayData, opponentUsername) {
  const opponentEntry = findPlayerByUsername(opponentUsername);
  if (!opponentEntry) return null;
  const batch = findOrCreateBatchForPlayer(opponentEntry);
  const exists = (batch.replays||[]).find(r => r.replayId === replayData.replayId);
  if (exists) return { linked: false, duplicate: true, batchId: batch.id, player: opponentEntry.name };
  if (!batch.replays) batch.replays = [];
  const clParsed = replayData.parsed || null;
  batch.replays.push({ replayId: replayData.replayId, plays: replayData.plays||[], allPlays: clParsed?[]:(replayData.allPlays||[]).map(stripPlay), parsed: clParsed, timedOut: !!replayData.timedOut, eventLabel: replayData.eventLabel||'', oppName: replayData.oppName||'', crossLinked: true, savedAt: Date.now() });
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

  // ── GET /api/health ─────────────────────────────────────────────────────────
  if (parts[0]==='health' && method==='GET') {
    return json(res, 200, { ok:true, db: pgClient?'postgres':'file', batches: Object.keys(db.batches).length, players: Object.keys(db.players).length, users: Object.keys(db.users).length });
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
      const token = makeToken(user.id);
      return json(res, 200, { token, role: user.role, email: user.email, name: user.name||email.split('@')[0] });
    });
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
      const role  = data.role === 'admin' ? 'admin' : 'user';
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
      if (data.role      !== undefined) u.role = data.role === 'admin' ? 'admin' : 'user';
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
    await saveDB();
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
        db.players[key] = { name, aliases: data.aliases||[], topPlayer: false, gfwlTeams: [], eventDecklists: [] };
        await saveDB();
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
      await saveDB();
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
    return readBody(req, async data => {
      const id = crypto.randomUUID();
      const batch = { id, name: data.name||data.player||'Batch', player: data.player||'', aliases: data.aliases||[], replays: [], createdAt: Date.now(), status: 'pending' };
      db.batches[id] = batch;
      await saveDB();
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
      if (data.name) b.name = data.name;
      await saveDB();
      return json(res, 200, b);
    });
  }
  // ── DELETE /api/batches/:id ─────────────────────────────────────────────────
  if (parts[0]==='batches' && parts[1] && !parts[2] && method==='DELETE') {
    if (!db.batches[parts[1]]) return json(res, 404, { error:'Not found' });
    delete db.batches[parts[1]];
    await saveDB();
    return json(res, 200, { ok:true });
  }

  // ── DELETE /api/batches/:id/replay/:replayId ────────────────────────────────
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && parts[3] && !parts[4] && method==='DELETE') {
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    const replayId = decodeURIComponent(parts[3]);
    const before = (b.replays||[]).length;
    b.replays = (b.replays||[]).filter(r => r.replayId !== replayId);
    await saveDB();
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
        await saveDB();
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
        await saveDB('batches');
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
      if (r) { r.eventLabel = data.eventLabel||''; await saveDB(); }
      return json(res, 200, { ok:true });
    });
  }

  // ── POST /api/batches/:id/replay ────────────────────────────────────────────
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && method==='POST') {
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
        // Only cross-link when explicitly allowed (new batch creation, not manual add-to-batch)
        if (data.oppName && !data.noCrossLink) {
          const cl = crossLinkReplay(data, data.oppName);
          if (cl) crossLinks.push(cl);
        }
        saveDBDebounced('batches');
        } catch(saveErr) { console.error('[replay POST] Save error:', saveErr.message); }
      } else if (dup.timedOut && !data.timedOut) {
        // Existing timed-out entry being updated with real data — overwrite it
        const parsedData2 = data.parsed || null;
        b.replays[dupIdx] = { replayId:data.replayId, plays:data.plays||[], allPlays:parsedData2?[]:(minPlays||[]).map(stripPlay), parsed:parsedData2, timedOut:false, eventLabel:dup.eventLabel||data.eventLabel||'', oppName:data.oppName||dup.oppName||'', player1:data.player1||dup.player1||null, player2:data.player2||dup.player2||null, savedAt:Date.now() };
        b.status = 'ready';
        console.log(`[replay] Updated timed-out replay ${data.replayId} with real data`);
        await saveDB();
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
    if (removed > 0) await saveDB();
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
      for (const [teamName, teamData] of Object.entries(incoming)) {
        if (!db.gfwl[season].teams[teamName]) {
          // New team
          db.gfwl[season].teams[teamName] = {
            conference: teamData.conference || '',
            aliases: teamData.aliases || [],
            roster: teamData.roster || [],
            addDrops: teamData.addDrops || [],
            schedule: teamData.schedule || [],
            notes: teamData.notes || ''
          };
          added++;
        } else {
          // Existing team — only update conference and schedule, preserve roster/addDrops
          const t = db.gfwl[season].teams[teamName];
          if (teamData.conference) t.conference = teamData.conference;
          if (teamData.schedule && teamData.schedule.length) t.schedule = teamData.schedule;
          if (teamData.aliases && teamData.aliases.length) t.aliases = teamData.aliases;
          updated++;
        }
      }
      if (data.numWeeks) db.gfwl[season].numWeeks = data.numWeeks;
      await saveDB();
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
          req2.setTimeout(30000, () => { req2.destroy(); reject(new Error('timeout')); });
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

      // Poll for solution (max 30s)
      let token = null;
      let userAgent = null;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const resultRes = await httpsPost('api.capsolver.com', '/getTaskResult', { clientKey: CAPSOLVER_API_KEY, taskId });
        if (resultRes.status === 'ready') {
          token = resultRes.solution?.token;
          userAgent = resultRes.solution?.userAgent;
          break;
        }
        if (resultRes.errorId) throw new Error('CapSolver poll error: ' + resultRes.errorDescription);
      }
      if (!token) throw new Error('CapSolver timed out waiting for token');
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
        req2.setTimeout(20000, () => { req2.destroy(); reject(new Error('duelingbook timeout')); });
        req2.write(bodyBuf);
        req2.end();
      });

      if (replayData.action === 'Error') throw new Error('Duelingbook error: ' + replayData.message);

      console.log(`[proxy/replay] Got replay data for ${replayId} — ${(replayData.plays||[]).length} plays`);
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
async function scrapeFormatLibraryEvents(specificCode) {
  const https = require('https');
  let allEvents = [];
  let page = 0;
  const perPage = 100;

  console.log('[EventDates] Starting Format Library scrape...');
  try {
    while (true) {
      const url = `https://formatlibrary.com/api/events?format=goat&limit=${perPage}&offset=${page*perPage}`;
      const data = await new Promise((resolve, reject) => {
        const req = https.get(url, { headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'} }, res2 => {
          let body='';
          res2.on('data', c=>body+=c);
          res2.on('end', ()=>{
            try { resolve(JSON.parse(body)); }
            catch(e) { reject(new Error('Parse error: '+body.slice(0,100))); }
          });
        });
        req.on('error', reject);
        req.setTimeout(15000, ()=>{ req.destroy(); reject(new Error('timeout')); });
      });

      const events = Array.isArray(data) ? data : (data.events || data.data || data.results || []);
      if (!events.length) break;

      for (const evt of events) {
        const name = evt.name || evt.event_name || evt.title || '';
        const date = evt.date || evt.start_date || evt.startDate || evt.created_at || '';
        if (!name || !date) continue;

        // Extract event code from name
        const code = extractEventCode(name);
        if (code && !db.eventDates[code]) {
          db.eventDates[code] = { date: date.slice(0,10), name, source:'formatlibrary' };
        }
      }

      if (events.length < perPage) break;
      page++;
      if (page > 30) break; // safety limit
    }

    await saveDB();
    console.log('[EventDates] Scraped '+Object.keys(db.eventDates).length+' event codes');
  } catch(e) {
    console.error('[EventDates] Scrape failed:', e.message);
    try { await scrapeFormatLibraryHTML(); } catch(e2) { console.error('[EventDates] HTML fallback also failed:', e2.message); }
  }
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

// Silently refresh event dates when an unknown code is seen
async function silentRefreshEventCode(code) {
  if (!code || db.eventDates[code]) return; // already known
  const skip = /^(S\d+|LADDER|ACAD|ACADEMY)/i;
  if (skip.test(code)) return;
  // Throttle: don't re-scrape more than once per hour
  const lastScrape = db.eventDates['_lastScrape'];
  const now = Date.now();
  if (lastScrape && (now - lastScrape) < 3600000) return;
  db.eventDates['_lastScrape'] = now;
  console.log('[EventDates] Unknown code', code, '— triggering background refresh');
  scrapeFormatLibraryEvents(code).catch(()=>{});
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
