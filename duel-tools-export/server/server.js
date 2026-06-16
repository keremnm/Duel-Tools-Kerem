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
let db = { batches: {}, players: {}, users: {} };

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
  const res = await client.query("SELECT key, value FROM duel_tools_data WHERE key IN ('batches','players','users')");
  for (const row of res.rows) { db[row.key] = row.value; }
  if (!db.batches) db.batches = {};
  if (!db.players) db.players = {};
  if (!db.users)   db.users   = {};
  pgClient = client;
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
    }
  } catch(e) { console.error('File DB load error:', e.message); }
}

async function saveDB() {
  if (pgClient) {
    try {
      await pgClient.query(`
        INSERT INTO duel_tools_data (key, value, updated_at)
        VALUES ('batches',$1,NOW()),('players',$2,NOW()),('users',$3,NOW())
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
      `, [JSON.stringify(db.batches), JSON.stringify(db.players), JSON.stringify(db.users)]);
    } catch(e) { console.error('PG save error:', e.message); }
  } else {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
    catch(e) { console.error('File DB save error:', e.message); }
  }
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
  req.on('data', d => raw += d);
  req.on('end', () => { try { cb(JSON.parse(raw||'{}')); } catch(e) { cb({}); } });
}

function playerNames(entry) {
  return [entry.name, ...(entry.aliases||[])].map(n => n.toLowerCase());
}
function findPlayerByUsername(username) {
  const ul = username.toLowerCase().trim();
  for (const entry of Object.values(db.players)) {
    const names = playerNames(entry);
    if (names.includes(ul)) return entry;
    if (names.some(n => n.includes(ul) || ul.includes(n))) return entry;
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
  batch.replays.push({ replayId: replayData.replayId, plays: replayData.plays||[], allPlays: replayData.allPlays||[], timedOut: !!replayData.timedOut, eventLabel: replayData.eventLabel||'', oppName: replayData.oppName||'', crossLinked: true, savedAt: Date.now() });
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
      cards:p.cards?p.cards.map(c=>({name:c.name,owner:c.owner})):undefined,
      winner:p.winner,loser:p.loser,game:p.game,pick:p.pick,p1pick:p.p1pick,p2pick:p.p2pick,
      log:p.log?p.log.map(l=>({type:l.type,owner:l.owner,username:l.username,card:l.card?{name:l.card.name}:undefined,game:l.game})):undefined
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

  // ── PATCH /api/batches/:id/replay/:replayId/override ───────────────────────
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && parts[3] && parts[4]==='override' && method==='PATCH') {
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    return readBody(req, async data => {
      const r = (b.replays||[]).find(r => r.replayId === parts[3]);
      if (r) {
        if (data.myDeckOverride  !== undefined) r.myDeckOverride  = data.myDeckOverride;
        if (data.oppDeckOverride !== undefined) r.oppDeckOverride = data.oppDeckOverride;
        await saveDB();
      }
      return json(res, 200, { ok:true });
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
      const dup = (b.replays||[]).find(r => r.replayId === data.replayId);
      const crossLinks = [];
      if (!dup) {
        if (!b.replays) b.replays = [];
        const minPlays = (data.allPlays||[]).map(p => ({
          play:p.play,owner:p.owner,username:p.username,player1:p.player1,player2:p.player2,
          cards:p.cards?p.cards.map(c=>({name:c.name,owner:c.owner})):undefined,
          winner:p.winner,loser:p.loser,game:p.game,pick:p.pick,p1pick:p.p1pick,p2pick:p.p2pick,
          log:p.log?p.log.map(l=>({type:l.type,owner:l.owner,username:l.username,card:l.card?{name:l.card.name}:undefined,game:l.game})):undefined
        }));
        b.replays.push({ replayId:data.replayId, plays:data.plays||[], allPlays:minPlays, timedOut:!!data.timedOut, eventLabel:data.eventLabel||'', oppName:data.oppName||'', savedAt:Date.now() });
        b.status = 'ready';
        if (data.oppName) {
          const cl = crossLinkReplay(data, data.oppName);
          if (cl) crossLinks.push(cl);
        }
        await saveDB();
      }
      return json(res, 200, { ok:true, duplicate:!!dup, crossLinks });
    });
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

process.on('SIGINT',  () => { saveDB().then(() => process.exit(0)); });
process.on('SIGTERM', () => { saveDB().then(() => process.exit(0)); });
