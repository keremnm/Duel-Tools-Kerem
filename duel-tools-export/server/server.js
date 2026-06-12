/**
 * Duel Tools — Server (Railway-ready)
 * Stores data in PostgreSQL when DATABASE_URL is set, falls back to local JSON file.
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT    = process.env.PORT || 8000;
const DB_FILE = path.join(__dirname, 'duel-tools.db.json');
const PUB_DIR = path.join(__dirname, '..', 'public');

// ── Database abstraction ──────────────────────────────────────────────────────
// Supports both PostgreSQL (Railway) and local JSON file (local dev)

let pgClient = null;
let db = { batches: {}, players: {} };

async function initDB() {
  if (process.env.DATABASE_URL) {
    try {
      const { Client } = require('pg');
      pgClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pgClient.connect();
      // Create table if it doesn't exist
      await pgClient.query(`
        CREATE TABLE IF NOT EXISTS duel_tools_data (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Load existing data
      const res = await pgClient.query("SELECT key, value FROM duel_tools_data WHERE key IN ('batches','players')");
      for (const row of res.rows) {
        db[row.key] = row.value;
      }
      if (!db.batches) db.batches = {};
      if (!db.players) db.players = {};
      console.log('Connected to PostgreSQL');
    } catch(e) {
      console.error('PostgreSQL connection failed, falling back to file DB:', e.message);
      pgClient = null;
      loadFileDB();
    }
  } else {
    loadFileDB();
    console.log('Using local file database');
  }
}

function loadFileDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = loaded;
      if (!db.batches) db.batches = {};
      if (!db.players) db.players = {};
    }
  } catch(e) { console.error('File DB load error:', e.message); }
}

async function saveDB() {
  if (pgClient) {
    try {
      await pgClient.query(`
        INSERT INTO duel_tools_data (key, value, updated_at)
        VALUES ('batches', $1, NOW()), ('players', $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [JSON.stringify(db.batches), JSON.stringify(db.players)]);
    } catch(e) { console.error('PG save error:', e.message); }
  } else {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
    catch(e) { console.error('File DB save error:', e.message); }
  }
}

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.json':'application/json','.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml'
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify(data));
}
function readBody(req, cb) {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => { try { cb(JSON.parse(raw||'{}')); } catch(e) { cb({}); } });
}

// Player registry helpers
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
  batch.replays.push({ replayId: replayData.replayId, plays: replayData.plays||[], allPlays: replayData.allPlays||[], timedOut: !!replayData.timedOut, eventLabel: replayData.eventLabel||'', crossLinked: true, savedAt: Date.now() });
  batch.status = 'ready';
  return { linked: true, duplicate: false, batchId: batch.id, player: opponentEntry.name };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;
  const parts  = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  if (url.pathname.startsWith('/api/')) {

    // GET /api/players
    if (parts[0]==='players' && !parts[1] && method==='GET') {
      return json(res, 200, Object.values(db.players));
    }

    // POST /api/players
    if (parts[0]==='players' && !parts[1] && method==='POST') {
      return readBody(req, async data => {
        if (!data.name) return json(res, 400, { error:'name required' });
        const key = data.name.toLowerCase();
        if (!db.players[key]) db.players[key] = { name: data.name, aliases: [] };
        if (data.aliases) db.players[key].aliases = data.aliases;
        await saveDB();
        json(res, 200, db.players[key]);
      });
    }

    // PATCH /api/players/:name/aliases
    if (parts[0]==='players' && parts[1] && parts[2]==='aliases' && method==='PATCH') {
      return readBody(req, async data => {
        const key = decodeURIComponent(parts[1]).toLowerCase();
        const entry = db.players[key];
        if (!entry) return json(res, 404, { error:'Player not found' });

        const oldAliases = (entry.aliases||[]).map(a => a.toLowerCase());
        if (data.aliases   !== undefined) entry.aliases   = data.aliases;
        if (data.topPlayer !== undefined) entry.topPlayer = data.topPlayer;
        if (data.teams     !== undefined) entry.teams     = data.teams;
        const newAliases = entry.aliases.map(a => a.toLowerCase()).filter(a => !oldAliases.includes(a));

        let rescanned = 0;
        if (data.rescan && newAliases.length) {
          for (const batch of Object.values(db.batches)) {
            if (playerNames(entry).includes((batch.player||'').toLowerCase())) continue;
            for (const replay of (batch.replays||[])) {
              const allPlays = replay.allPlays || replay.plays || [];
              const usernamesInReplay = new Set();
              for (const p of allPlays) {
                if (p.owner)    usernamesInReplay.add(p.owner.toLowerCase());
                if (p.username) usernamesInReplay.add(p.username.toLowerCase());
                if (Array.isArray(p.log)) for (const l of p.log) {
                  if (l.owner)    usernamesInReplay.add(l.owner.toLowerCase());
                  if (l.username) usernamesInReplay.add(l.username.toLowerCase());
                }
              }
              if (newAliases.some(a => usernamesInReplay.has(a))) {
                const targetBatch = findOrCreateBatchForPlayer(entry);
                if (!(targetBatch.replays||[]).find(r => r.replayId === replay.replayId)) {
                  if (!targetBatch.replays) targetBatch.replays = [];
                  targetBatch.replays.push({ ...replay, crossLinked: true, savedAt: Date.now() });
                  targetBatch.status = 'ready';
                  rescanned++;
                }
              }
            }
          }
        }

        await saveDB();
        json(res, 200, { ok: true, player: entry, rescanned });
      });
    }

    // GET /api/batches
    if (parts[0]==='batches' && !parts[1] && method==='GET') {
      const list = Object.values(db.batches)
        .sort((a,b) => b.createdAt - a.createdAt)
        .map(b => ({ id:b.id, name:b.name, player:b.player, replayCount:(b.replays||[]).length, createdAt:b.createdAt, status:b.status }));
      return json(res, 200, list);
    }

    // POST /api/batches
    if (parts[0]==='batches' && !parts[1] && method==='POST') {
      return readBody(req, async data => {
        const id = crypto.randomUUID();
        const player = data.player || '';
        const batch = { id, name: player||data.name||'Untitled', player, replays:[], createdAt:Date.now(), status:'pending' };
        db.batches[id] = batch;
        if (player) {
          const key = player.toLowerCase();
          if (!db.players[key]) db.players[key] = { name: player, aliases: data.aliases||[] };
          else if (data.aliases && data.aliases.length) {
            const existing = new Set(db.players[key].aliases.map(a=>a.toLowerCase()));
            for (const a of data.aliases) if (!existing.has(a.toLowerCase())) db.players[key].aliases.push(a);
          }
        }
        await saveDB();
        json(res, 201, batch);
      });
    }

    // GET /api/batches/:id
    if (parts[0]==='batches' && parts[1] && !parts[2] && method==='GET') {
      const b = db.batches[parts[1]];
      if (!b) return json(res, 404, { error:'Not found' });
      const playerEntry = b.player ? db.players[b.player.toLowerCase()] : null;
      return json(res, 200, { ...b, aliases: playerEntry ? (playerEntry.aliases||[]) : [] });
    }

    // PATCH /api/batches/:id
    if (parts[0]==='batches' && parts[1] && !parts[2] && method==='PATCH') {
      const b = db.batches[parts[1]];
      if (!b) return json(res, 404, { error:'Not found' });
      return readBody(req, async data => {
        if (data.name   !== undefined) b.name   = data.name;
        if (data.player !== undefined) b.player = data.player;
        if (data.eventDecklists !== undefined) b.eventDecklists = data.eventDecklists;
        if (data.player) {
          const key = data.player.toLowerCase();
          if (!db.players[key]) db.players[key] = { name: data.player, aliases: [] };
        }
        await saveDB();
        json(res, 200, { ok:true, batch:b });
      });
    }

    // DELETE /api/batches/:id
    if (parts[0]==='batches' && parts[1] && !parts[2] && method==='DELETE') {
      if (!db.batches[parts[1]]) return json(res, 404, { error:'Not found' });
      delete db.batches[parts[1]];
      saveDB();
      return json(res, 200, { ok:true });
    }

    // POST /api/batches/:id/replay
    if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && method==='POST') {
      const b = db.batches[parts[1]];
      if (!b) return json(res, 404, { error:'Not found' });
      return readBody(req, async data => {
        const alreadyExists = (b.replays||[]).find(r => r.replayId === data.replayId);
        const duplicateWarnings = [];
        if (alreadyExists) {
          duplicateWarnings.push({ player:b.player, batchId:b.id, replayId:data.replayId });
        } else {
          if (!b.replays) b.replays = [];
          b.replays.push({ replayId:data.replayId, plays:data.plays||[], allPlays:data.allPlays||[], timedOut:!!data.timedOut, eventLabel:data.eventLabel||'', savedAt:Date.now() });
          b.status = 'ready';
        }
        const crossLinks = [];
        if (data.oppName) {
          const result = crossLinkReplay(data, data.oppName);
          if (result) {
            crossLinks.push(result);
            if (result.duplicate) duplicateWarnings.push({ player:result.player, batchId:result.batchId, replayId:data.replayId });
          }
        }
        await saveDB();
        json(res, 200, { ok:true, duplicate:!!alreadyExists, duplicateWarnings, crossLinks });
      });
    }

    // PATCH /api/batches/:id/replay/:replayId/label
    if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && parts[3] && parts[4]==='label' && method==='PATCH') {
      const b = db.batches[parts[1]];
      if (!b) return json(res, 404, { error:'Not found' });
      return readBody(req, async data => {
        const r = (b.replays||[]).find(r => r.replayId === parts[3]);
        if (r) { r.eventLabel = data.eventLabel||''; await saveDB(); }
        json(res, 200, { ok:true });
      });
    }

    // GET /api/health
    if (parts[0]==='health' && method==='GET') {
      return json(res, 200, { ok:true, db: pgClient ? 'postgres' : 'file', batches: Object.keys(db.batches).length, players: Object.keys(db.players).length });
    }

    return json(res, 404, { error:'Unknown endpoint' });
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let fp = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!path.extname(fp)) fp = '/index.html';
  const full = path.join(PUB_DIR, fp);

  fs.readFile(full, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUB_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type':'text/html', 'Cache-Control':'no-cache,no-store,must-revalidate' });
        res.end(d2);
      });
      return;
    }
    const mime = MIME[path.extname(full)] || 'application/octet-stream';
    const noCache = path.extname(full) === '.html' ? { 'Cache-Control':'no-cache,no-store', 'Pragma':'no-cache', 'Expires':'0' } : {};
    res.writeHead(200, { 'Content-Type':mime, ...noCache });
    res.end(data);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🃏 Duel Tools  →  http://0.0.0.0:${PORT}\n`);
    // Only auto-open browser in local dev
    if (!process.env.RAILWAY_ENVIRONMENT && !process.env.DATABASE_URL) {
      const { exec } = require('child_process');
      const url = `http://localhost:${PORT}`;
      const open = process.platform==='win32' ? `start "" "${url}"` :
                   process.platform==='darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(open);
    }
  });
});

process.on('SIGINT',  () => { saveDB().then(() => process.exit(0)); });
process.on('SIGTERM', () => { saveDB().then(() => process.exit(0)); });
