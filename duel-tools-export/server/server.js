/**
 * Duel Tools — Server with built-in auth
 */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const zlib   = require('zlib');

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
// True once the full players/users/gfwl/eventDates/overrides/_changeLog/
// events blob AND every row of duel_tools_batches have been pulled into
// memory at least once this process's lifetime. See the reconnect-reload
// comment in connectPostgres() below — this is what lets a RECONNECT (vs.
// the true first boot) skip re-pulling all of it.
let _pgEverLoaded = false;
// db.overrides: a SEPARATE, independent registry of result/score/deck
// corrections, keyed ONLY by replayId — not by batch, not by player. Every
// propagation bug chased in this file so far (cross-linked twins, unmerged
// alias batches, duplicate scrapes, flip-direction mistakes) came from the
// same root shape: the override lived as a copy INSIDE each batch's own
// replay record, so "does this correction survive" depended on which
// specific batch/copy a view happened to load. This table is the fix for
// that whole class of bug: one record per replay, storing the ABSOLUTE
// outcome ("Bobby Bodega won 2-0"), not a "my score vs. their score"
// relative to whichever batch set it. Every batch that ever asks about this
// replayId gets the SAME answer, re-derived from this one place, regardless
// of how many copies of the replay exist or which one a page happens to
// load. See applyGlobalOverrideToReplay() below.
// db._changeLog: an admin-visible audit trail of mutating actions — who did
// what, to which player's data, when. Kept as a capped array (newest last,
// trimmed to the most recent 5000 entries) rather than a separate table,
// since it's read as a whole list, not queried by key. See logChange().
// db.events: self-contained event metadata for the Events tab, keyed by
// event code (e.g. "LCQ32026"). Only ever populated for events that at
// least one Duel-Tools-tracked player has a decklist/replay for — this is
// NOT a mirror of Format Library's whole event history. Shape:
//   { code, name, date, size, winner, decks: [ { deckId, builderName,
//     placement, deckTypeName, ydkData?, updatedAt } ], updatedAt }
// 'decks' holds the FULL bracket top-decks list learned from Format
// Library the first time any tracked player's event touches this code
// (see captureEventTopDecks) — including players Duel Tools doesn't
// otherwise track — so the event page can show a complete gallery and an
// accurate winner, not just "whatever we happened to import". 'size' is
// best-effort (Format Library's own entrant count when we can find one on
// the response, else the number of decks we know about).
// Format Library bracket import for a player with no Duel Tools profile
// yet: rather than stash the data somewhere invisible until an admin
// manually creates a matching profile later (the original design), the
// importer creates a REAL batch immediately — flagged `hidden: true` — with
// that player's parsed replays/YDK already attached, exactly like a normal
// profile in every other respect. GET /api/batches (the Profiles grid's own
// list) filters hidden batches out by default so they don't clutter
// browsing, but everything that reads db.batches directly (Format Data,
// Check & Fix Data, the Events tab Status column, alias/name matching)
// still sees them, since the data is real and should count. The moment a
// REAL profile is created (or edited) with a name/alias that matches a
// hidden batch, autoMergeHiddenBatches() below folds the hidden batch's
// data into it and deletes the hidden one — "promoting" it — using the same
// merge engine (mergeBatchesInternal) the admin-facing Merge Profiles tool
// uses for the general "two profiles turned out to be the same player"
// case. See POST /api/fl-import/pending (creates/updates the hidden batch),
// autoMergeHiddenBatches (auto-promotion), and POST /api/batches/merge
// (admin-triggered merge) further down.
let db = { batches: {}, players: {}, users: {}, gfwl: {}, eventDates: {}, replayCache: {}, overrides: {}, _changeLog: [], events: {} };

async function connectPostgres() {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  await client.connect();
  // Fail any single query cleanly after 20s instead of hanging indefinitely.
  // See the 2026-11 incident below (duel_tools_replay_cache) for exactly
  // what an unbounded query with no timeout did to this app's availability
  // once a table grew large enough.
  try { await client.query('SET statement_timeout = 20000'); } catch(e) { console.warn('[PG] Could not set statement_timeout:', e.message); }
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
  // Caches the result of GET /api/proxy/replay (the CapSolver/Turnstile-solved
  // DuelingBook fetch) by replay id, so re-analyzing or re-importing the same
  // replay — by the same user or a different one — never has to pay the
  // 5-90s CapSolver solve+poll dance twice. Best-effort only: see cacheReplay.
  await client.query(`
    CREATE TABLE IF NOT EXISTS duel_tools_replay_cache (
      id TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Make the client usable for writes as soon as the tables exist, rather
  // than only after every data load below succeeds. Previously `pgClient`
  // was assigned at the very end of this function, so if ANY of the loads
  // below threw (see the replay-cache note just below), connectPostgres()
  // rejected before ever setting it — leaving pgClient null and every write
  // in the whole app (new batches, replays, YDKs, GFWL, event data) silently
  // queuing/failing until some unrelated retry happened to reconnect
  // successfully. Setting it here means a failure loading one piece of data
  // no longer takes down the ability to write anything at all.
  pgClient = client;

  // ── Full data load: ONLY on true first boot, never on a reconnect ──────
  // Everything in this block (players/users/gfwl/etc, and especially the
  // full duel_tools_batches table — potentially tens of thousands of
  // replays) used to re-run on EVERY reconnect, not just cold start:
  // connectPostgres() is also what the 'error'/'end' handlers below and the
  // keep-alive interval (bottom of this file) call after any transient
  // disconnect. A full-table batch reload blocks the event loop while it
  // JSON-parses and re-keys every row, and this process is the ONLY writer
  // to Postgres (a single-instance app — see GET /api/batches/:id's own
  // comment on why IT still does a live per-request read instead of relying
  // on this cache), so nothing else could have changed this data out from
  // under us while disconnected. Skipping the reload on reconnect — keeping
  // whatever's already in memory, which already reflects every write this
  // same process has made — removes that entire class of
  // reconnect-triggered stall with no loss of correctness.
  if (!_pgEverLoaded) {
    try {
      const res = await client.query("SELECT key, value FROM duel_tools_data WHERE key IN ('players','users','gfwl','eventDates','overrides','_changeLog','events')");
      for (const row of res.rows) { db[row.key] = row.value; }
    } catch(e) { console.error('[PG] Failed to load players/users/gfwl/etc — starting with whatever was already in memory:', e.message); }

    try {
      const batchRes = await client.query('SELECT id, value FROM duel_tools_batches');
      db.batches = {};
      for (const row of batchRes.rows) { db.batches[row.id] = row.value; }
    } catch(e) { console.error('[PG] Failed to load batches — app may start with incomplete batch data until the next successful reconnect:', e.message); }

    // ── duel_tools_replay_cache: NOT bulk-loaded anymore ──────────────────
    // This table is a best-effort cache of full DuelingBook replay
    // play-by-play JSON (see cacheReplay() below), written for every replay
    // ANYONE ever fetches, with no size cap or eviction. Once it grew large
    // enough, pulling the WHOLE table over the wire on every single
    // connect/reconnect started failing outright — Postgres logs showed
    // repeated "could not send data to client: Connection reset by peer" /
    // "FATAL: connection to client lost" on exactly this SELECT, over and
    // over, for days, almost certainly from this process running out of
    // memory (or being killed by the platform) while buffering the result.
    // Each failure threw out of this function (before pgClient was being set
    // early, as it now is above), which nulled pgClient and triggered ANOTHER
    // reconnect attempt that retried the exact same oversized load — an
    // infinite crash/reconnect loop. That is the root cause of the 2026-11
    // incident where new batches, replay saves, YDKs, and everything else
    // intermittently hung or silently failed to persist: the app was spending
    // nearly all its time crash-looping on this one query instead of being
    // available to serve ordinary requests.
    // Replay cache entries are only ever looked up ONE AT A TIME by replayId
    // (see the GET /api/proxy/replay route), so there was never a need to
    // hold the whole table in memory — getCachedReplay() below does a single
    // cheap indexed lookup per id instead, falling back to the normal slow
    // CapSolver fetch path on a miss, exactly like it always has.
    db.replayCache = {};

    // Migrate any legacy batches still stored under the old single-blob key
    try {
      const legacyRes = await client.query("SELECT value FROM duel_tools_data WHERE key='batches'");
      if (legacyRes.rows.length && legacyRes.rows[0].value && Object.keys(legacyRes.rows[0].value).length) {
        console.log('[PG] Migrating', Object.keys(legacyRes.rows[0].value).length, 'legacy batches to per-row storage...');
        for (const [id, batch] of Object.entries(legacyRes.rows[0].value)) {
          if (!db.batches[id]) db.batches[id] = batch; // don't overwrite if already split
        }
        await saveAllBatchesToPostgres();
        await client.query("DELETE FROM duel_tools_data WHERE key='batches'");
        console.log('[PG] Legacy batch migration complete — old blob removed.');
      }
    } catch(e) { console.error('[PG] Legacy batch migration check failed (non-fatal):', e.message); }

    _pgEverLoaded = true;
  } else {
    console.log('[PG] Reconnected — reusing existing in-memory data (not re-pulling the full dataset; see _pgEverLoaded).');
  }

  if (!db.batches) db.batches = {};
  if (!db.players) db.players = {};
  if (!db.users)   db.users   = {};
  if (!db.gfwl)    db.gfwl    = {};
  if (!db.eventDates) db.eventDates = {};
  if (!db.replayCache) db.replayCache = {};
  if (!db.overrides) db.overrides = {};
  if (!db._changeLog) db._changeLog = [];
  if (!db.events) db.events = {};
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
  // Merge the hardcoded event-date catalog into db.eventDates on every startup
  // (instant, no network — buildEventCatalog() only adds brand-new codes or
  // upgrades a coarse year-only 'catalog' entry with a more precise date, and
  // never touches a 'formatlibrary-live' entry). This used to only run once
  // ever (guarded by "fewer than 10 known dates"), which meant a code deploy
  // that added new event codes or corrected a date in EVENT_DATE_CATALOG had
  // no effect on an already-seeded production database — the only way to
  // apply it was a manual POST /api/event-dates/refresh. Running it
  // unconditionally (it's pure local lookups, not a network scrape) means new
  // events and date corrections just take effect on the next deploy.
  const added = buildEventCatalog();
  if (added > 0) {
    await saveDB('eventDates');
    console.log('[EventDates] Catalog merge: added/upgraded', added, 'entries, total:', Object.keys(db.eventDates).filter(k=>!k.startsWith('_')).length);
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
  // Self-heal every batch's in-memory replay copies from the global
  // override registry right now, at startup — before any request is ever
  // served — so a redeploy/restart can never show a stale pre-override
  // value even for a split second. See applyAllGlobalOverridesAtStartup().
  const healedCount = applyAllGlobalOverridesAtStartup();
  if (healedCount > 0) {
    console.log(`[overrides] Startup: re-applied ${Object.keys(db.overrides||{}).length} global override(s) to ${healedCount} replay cop${healedCount===1?'y':'ies'} across all batches.`);
  }
  // Trim the audit log to its 7-day retention window right away too, in
  // case the server was down (or just never restarted) long enough for
  // entries logged before this deploy to have aged out.
  const beforePrune = (db._changeLog||[]).length;
  pruneChangeLog();
  if (beforePrune !== (db._changeLog||[]).length) {
    console.log(`[changelog] Startup: pruned ${beforePrune - db._changeLog.length} entr${beforePrune - db._changeLog.length === 1 ? 'y' : 'ies'} older than 7 days.`);
    // pruneChangeLog() only mutates the in-memory copy — without an explicit
    // save here, the trimmed-out entries would still sit in Postgres and
    // silently reappear on the NEXT restart if no other action happens in
    // between to trigger logChange()'s own debounced save. Synchronous and
    // awaited since this runs before the server starts accepting requests.
    await saveDB('_changeLog');
  }
  // Bootstrap admin — always ensure admin account exists and password matches env
  // Ensure secondary admin exists
  const SECONDARY_ADMIN = 'arinakkent@gmail.com';
  if (!Object.values(db.users).find(u => u.email === SECONDARY_ADMIN)) {
    const sid = crypto.randomUUID();
    db.users[sid] = { id:sid, email:SECONDARY_ADMIN, name:'Arin', password:hashPassword('changeme'), role:'admin', approved:true, createdAt:Date.now() };
    console.log('Secondary admin created:', SECONDARY_ADMIN, '(default password: changeme — change immediately)');
  } else {
    // Only ensure the account is approved (so it never gets stuck pending) —
    // do NOT force role back to 'admin' here. This used to stomp any role
    // change made via the admin panel (e.g. setting this account to
    // 'limited' for testing) every time the server restarted/redeployed.
    const sa = Object.values(db.users).find(u => u.email === SECONDARY_ADMIN);
    if (sa) { sa.approved = true; }
  }

  // Migrate any legacy head_admin roles to admin in the DB. This used to only
  // mutate the in-memory copy, so a Postgres reconnect (which re-SELECTs
  // db.users fresh from the table) could silently bring a legacy
  // 'head_admin' value right back — and a few /api/admin/users routes used
  // to check u.role==='admin' directly instead of the isAdmin() helper (which
  // does treat head_admin as admin), so that account would see "Admin only"
  // errors on the Admin page despite otherwise looking fully admin. Saving
  // here makes the migration stick in Postgres so it can't come back.
  let _migratedHeadAdmin = false;
  for (const u of Object.values(db.users)) {
    if (u.role === 'head_admin') { u.role = 'admin'; _migratedHeadAdmin = true; }
  }
  if (_migratedHeadAdmin) {
    await saveDB('users');
    console.log('[migration] Persisted head_admin → admin role migration.');
  }

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
      if (!db.replayCache) db.replayCache = {};
      if (!db.overrides) db.overrides = {};
      if (!db._changeLog) db._changeLog = [];
      if (!db.events) db.events = {};
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
const _ALWAYS_SAVE_KEYS = ['players','users','gfwl','eventDates','overrides','_changeLog','events'];
const _dirtyKeys = new Set(_ALWAYS_SAVE_KEYS);

// Guards POST /api/events/backfill against being kicked off twice at once.
let _eventsBackfillRunning = false;

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
// Debounce queue — collects batch IDs to save and flushes them together
const _batchSaveQueue = new Set();
let _batchSaveTimer = null;
const BATCH_SAVE_DEBOUNCE_MS = 1500; // flush after 1.5s of inactivity

// Dirty tracking — which batches have been modified since last full save
const _dirtyBatches = new Set();
function markBatchDirty(batchId) { _dirtyBatches.add(batchId); }

// Cached, pre-serialized GET /api/batches/all-full response (see that
// route further down). JSON.stringify-ing every saved replay system-wide
// — full card/play-by-play data included — is real, synchronous,
// single-threaded CPU work; redoing it from scratch on every single page
// view (Format Data, every GFWL Archive page, Events, each Profile open)
// is what was making the app feel broken/slow again even after batch
// LOADING stopped doing N live Postgres reads: the data source was
// already fast, but re-serializing the same large response over and over
// wasn't. Invalidated by saveBatchToPostgres() — the one choke point
// every batch-changing write in this file already goes through — so a
// save is never more than one write away from showing up here.
let _allFullCache = null; // { json: Buffer, gzip: Buffer|null } | null

async function _flushBatchSaveQueue() {
  _batchSaveTimer = null;
  if (!_batchSaveQueue.size) return;
  const ids = [..._batchSaveQueue];
  _batchSaveQueue.clear();
  if (!pgClient) {
    ids.forEach(id => _pendingFlushKeys.add('batches:'+id));
    scheduleFlushRetry();
    return;
  }
  // Each batch is written as its own independent INSERT ... ON CONFLICT —
  // deliberately NOT wrapped in a single BEGIN/COMMIT transaction anymore.
  // This app uses ONE raw Postgres connection (pgClient, a plain `Client`,
  // not a connection Pool) shared across EVERY concurrent request this
  // Node process handles. A Postgres transaction is a property of the
  // SESSION/connection, not of "which logical function issued it" — so any
  // OTHER query any OTHER concurrent request happened to issue on this same
  // pgClient while a BEGIN...COMMIT block here was still open (e.g. the
  // plain, non-transactional INSERT in flushBatchNow, or the SELECT in
  // GET /api/batches/:id's fresh-reread) got swept into THIS transaction —
  // and a ROLLBACK here, triggered by a failure in just one of THIS flush's
  // own batches, would then silently undo that completely unrelated write
  // too, even though its own request handler had already returned
  // {ok:true} to its own caller with no idea any of this happened. That
  // exactly matches a real reported bug: the admin log showed "Added
  // replay" (logChange() writes straight to the in-memory _changeLog,
  // independent of any of this) for the same replays, days apart, while
  // the actual batch row never durably landed in Postgres — the in-memory
  // copy had the replay (so the SAME server process looked fine right
  // after import), but the next time anything re-read that batch from
  // Postgres (a restart, a reconnect, another instance) it came back
  // without it, and the next import run saw nothing to dedupe against and
  // silently "re-added" it. Writing each row independently, with no shared
  // transaction state, removes this hazard entirely — one batch's failure
  // can no longer have any way to affect another's, whether concurrently
  // issued by this same function or by anything else in the app.
  let failed = 0;
  for (const batchId of ids) {
    const batch = db.batches[batchId];
    if (!batch) continue;
    try {
      const serialized = JSON.stringify(batch);
      if (serialized.length > 50*1024*1024) {
        console.error('[saveBatch] Batch', batchId, 'exceeds 50MB — skipped');
        continue;
      }
      await pgClient.query(
        'INSERT INTO duel_tools_batches (id, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()',
        [batchId, serialized]
      );
      _pendingFlushKeys.delete('batches:'+batchId);
      _dirtyBatches.delete(batchId);
    } catch(e) {
      failed++;
      console.error('[saveBatch] Flush failed for', batchId, ':', e.message);
      _pendingFlushKeys.add('batches:'+batchId);
      if (e.message.includes('connect') || e.message.includes('Connection') || e.code === 'ECONNRESET') {
        pgClient = null;
        setTimeout(async () => { try { await connectPostgres(); } catch(e2) {} }, 2000);
        break; // connection is gone — no point trying the rest on it right now
      }
    }
  }
  if (ids.length > 1) console.log('[saveBatch] Flushed', ids.length - failed, '/', ids.length, 'batches (independently, no shared transaction)');
  if (failed) scheduleFlushRetry();
}

async function saveBatchToPostgres(batchId) {
  // Any batch write invalidates the cached /batches/all-full response (see
  // that route below). NOTE: this is NOT the only choke point — flushBatchNow
  // below is the other one, used by every route that needs a CONFIRMED
  // synchronous save (overrides, manual matches, merges) rather than this
  // function's debounced one, and it invalidates the same cache itself for
  // exactly that reason. Between the two, every batch-changing code path in
  // this file is covered without having to chase down and touch each call
  // site individually — but a NEW synchronous-save helper added later must
  // invalidate _allFullCache too, or its writes will silently never show up
  // in Format Data/Check & Fix Data/anything else reading /batches/all-full
  // until some unrelated write happens to invalidate the cache for it.
  _allFullCache = null;
  if (!pgClient) { _pendingFlushKeys.add('batches:'+batchId); scheduleFlushRetry(); return; }
  const batch = db.batches[batchId];
  if (!batch) return;
  markBatchDirty(batchId);
  // Add to debounce queue — if multiple saves arrive within the window, flush together
  _batchSaveQueue.add(batchId);
  if (_batchSaveTimer) clearTimeout(_batchSaveTimer);
  _batchSaveTimer = setTimeout(_flushBatchSaveQueue, BATCH_SAVE_DEBOUNCE_MS);
}

// Write ONE batch to persistent storage RIGHT NOW and report whether it
// actually landed — unlike saveBatchToPostgres/markBatchDirty above, which
// only ever schedule a debounced write 1.5s in the future and return
// immediately no matter what happens to it. That fire-and-forget design is
// fine for routine scrape saves, but it is exactly why a manual correction
// (a result override, a merge) could come back from the API as `{ok:true}`
// while the actual write to Postgres silently failed or simply hadn't
// happened yet — every GET in the SAME server process still reads the
// correct value straight out of the in-memory `db.batches`, which is why it
// looked saved right up until something reloaded that data from scratch
// (a redeploy, a crash, a dyno restart) and came back with whatever was last
// actually committed, i.e. the pre-override value. Call this — and check its
// result — from any route where "the client was told this saved" needs to
// be true, not just "a save was scheduled."
async function flushBatchNow(batchId) {
  // Same reasoning as the top of saveBatchToPostgres — this is the OTHER
  // choke point every confirmed-synchronous batch write goes through
  // (overrides, manual matches, merges, twin-propagation), and until this
  // line was added it was the one that DIDN'T invalidate the cache: a bug
  // found via overrides applied through "Select All to Match YDK" on Check
  // & Fix Data appearing to do nothing — the writes landed fine (every
  // individual override succeeded), but /batches/all-full kept serving its
  // pre-override snapshot forever after, since nothing on this path ever
  // cleared it, so every page that reads global records through that route
  // (Format Data, Check & Fix Data's own conflict re-scan, GFWL) looked
  // completely unchanged no matter how many corrections were saved.
  _allFullCache = null;
  const batch = db.batches[batchId];
  if (!batch) return { ok: false, error: 'Batch not found' };
  markBatchDirty(batchId);
  if (!pgClient) {
    if (process.env.DATABASE_URL) {
      // Postgres is configured but currently disconnected — there is
      // nowhere safe to write this synchronously. Buffer it for the
      // reconnect-triggered flush, but tell the CALLER this did not durably
      // save yet, instead of silently claiming success.
      _pendingFlushKeys.add('batches:'+batchId);
      scheduleFlushRetry();
      return { ok: false, error: 'Database is temporarily unreachable — change is held in memory and will sync once it reconnects, but is not safely saved yet. Try again in a moment.' };
    }
    // File-DB mode (local dev only — Railway always sets DATABASE_URL)
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); return { ok: true }; }
    catch(e) { return { ok: false, error: e.message }; }
  }
  try {
    const serialized = JSON.stringify(batch);
    if (serialized.length > 50*1024*1024) {
      return { ok: false, error: 'This batch is too large to save (over 50MB) — the change was NOT persisted.' };
    }
    await pgClient.query(
      'INSERT INTO duel_tools_batches (id, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()',
      [batchId, serialized]
    );
    _pendingFlushKeys.delete('batches:'+batchId);
    _dirtyBatches.delete(batchId);
    _batchSaveQueue.delete(batchId); // already durably saved — no need for the debounced flush to redo it
    return { ok: true };
  } catch(e) {
    console.error('[flushBatchNow] Failed for', batchId, ':', e.message);
    _pendingFlushKeys.add('batches:'+batchId);
    if (e.message.includes('connect') || e.message.includes('Connection') || e.code === 'ECONNRESET') {
      pgClient = null;
      setTimeout(async () => { try { await connectPostgres(); } catch(e2) {} }, 2000);
    }
    scheduleFlushRetry();
    return { ok: false, error: e.message };
  }
}

// Save every batch currently in memory — used by manual Save button and migration.
async function saveAllBatchesToPostgres(forceAll = false) {
  if (!pgClient) { Object.keys(db.batches).forEach(id => _pendingFlushKeys.add('batches:'+id)); scheduleFlushRetry(); return; }
  // Only write dirty batches unless forceAll is set (used for migration/manual save)
  const ids = forceAll
    ? Object.keys(db.batches)
    : [..._dirtyBatches].filter(id => db.batches[id]);
  if (!ids.length) { console.log('[saveAllBatches] No dirty batches — skipping'); return { saved:0, failed:0 }; }
  console.log('[saveAllBatches] Writing', ids.length, forceAll ? '(forced)' : '(dirty only)', 'batches');
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

// ── Replay cache — avoids re-running the CapSolver/Turnstile dance (often
// 5-90s) for a replay id we've already fetched once, for ANY user. A cache
// miss just falls back to the normal slow path, so this is best-effort: it
// never blocks a response, and a failed write here is not a data-loss risk
// the way a failed batch save would be — so it deliberately does NOT use the
// heavier pending-flush/retry machinery batches use.
async function cacheReplay(replayId, replayData) {
  db.replayCache[replayId] = replayData;
  if (pgClient) {
    try {
      const serialized = JSON.stringify(replayData);
      if (serialized.length > 8*1024*1024) {
        console.warn('[replayCache] Replay', replayId, 'too large to cache:', Math.round(serialized.length/1024)+'KB — skipped');
        return;
      }
      await pgClient.query(
        'INSERT INTO duel_tools_replay_cache (id, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()',
        [replayId, serialized]
      );
    } catch(e) { console.warn('[replayCache] Failed to persist', replayId, ':', e.message); }
  }
  // File-DB mode (local dev only — Railway always sets DATABASE_URL): no
  // separate write needed. db.replayCache rides along inside the full `db`
  // object the next time anything calls saveDB() and writes the json file.
}

// Per-replay-id cache lookup — see the "NOT bulk-loaded anymore" note on
// connectPostgres() above for why this exists instead of a plain
// `db.replayCache[replayId]` read. Checks the in-memory cache first
// (anything this process has already fetched or written via cacheReplay()
// above), then falls back to a single small indexed Postgres read on a
// miss. A failure here is exactly as safe to ignore as a cache miss always
// was — the caller (GET /api/proxy/replay) just falls through to the normal
// slow CapSolver fetch path.
async function getCachedReplay(replayId) {
  if (db.replayCache[replayId]) return db.replayCache[replayId];
  if (!pgClient) return null;
  try {
    const r = await pgClient.query('SELECT value FROM duel_tools_replay_cache WHERE id=$1', [replayId]);
    if (r.rows.length) { db.replayCache[replayId] = r.rows[0].value; return r.rows[0].value; }
  } catch(e) { console.warn('[replayCache] Lookup failed for', replayId, ':', e.message); }
  return null;
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

// ── Admin audit log ──────────────────────────────────────────────────────────
// Records who did what to whose data — batches created, replays added (with
// event label), decklists added, overrides set/cleared, merges, deletions —
// so admins have one place to see exactly what every user has been doing on
// KDT. Read back via GET /api/changelog and rendered by the "Edit Log" tab
// (admin-only) in the client. `details` is spread directly onto the log
// entry: each action naturally carries different fields (batchId, replayId,
// eventLabel, deckType, note, ...) so there's no fixed schema — the client
// renders whatever's present generically.
// Entries older than this are dropped from the log — "the last actions for
// a week, for everyone." Pruned opportunistically (every time something new
// is logged — see below) rather than on a timer, and GET /api/changelog
// applies the same window by default, so the two can never disagree about
// what counts as "the last week" even if a prune happens to lag behind.
const CHANGE_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
function pruneChangeLog() {
  if (!db._changeLog || !db._changeLog.length) return;
  const cutoff = Date.now() - CHANGE_LOG_RETENTION_MS;
  db._changeLog = db._changeLog.filter(l => l.t >= cutoff);
}
function logChange(req, action, details) {
  if (!db._changeLog) db._changeLog = [];
  const user = getUser(req);
  db._changeLog.push({
    t: Date.now(),
    action,
    user: (user && (user.name || user.email)) || 'unknown',
    ...details,
  });
  pruneChangeLog();
  // Belt-and-suspenders cap, independent of the time-based prune above — a
  // burst of activity inside the 7-day window (a big bulk import, say)
  // shouldn't be able to grow this without bound.
  if (db._changeLog.length > 5000) db._changeLog = db._changeLog.slice(-5000);
  // Debounced, not synchronous — this is an audit trail, not data whose loss
  // would corrupt anything. The actual data each entry describes is already
  // durably saved by its own route-specific flush before or alongside this
  // call; at worst a crash in the ~2s debounce window loses the few most
  // recent log lines, never the data itself.
  saveDBDebounced();
}

// eventDecklists is always saved as a whole-array replace (the client
// recomputes the full list and PATCHes it), not an incremental add/remove —
// so to log "a decklist was added for event X" with the actual event code,
// this diffs the old and new arrays by eventCode and logs one entry per
// addition/removal, instead of one vague "list changed" entry.
function logDecklistDiff(req, before, after, context) {
  const beforeCodes = new Set((before||[]).map(d => d && d.eventCode).filter(Boolean));
  const afterCodes  = new Set((after ||[]).map(d => d && d.eventCode).filter(Boolean));
  for (const d of (after||[])) {
    if (d && d.eventCode && !beforeCodes.has(d.eventCode)) {
      logChange(req, 'add_decklist', { ...context, eventCode: d.eventCode, deckUrl: d.deckUrl || null });
    }
  }
  for (const code of beforeCodes) {
    if (!afterCodes.has(code)) {
      logChange(req, 'remove_decklist', { ...context, eventCode: code });
    }
  }
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
  const r = user.role || 'user';
  return r === 'head_admin' ? 'admin' : r; // migrate legacy head_admin → admin
}
function isAdmin(req) {
  const r = getRole(req);
  return r === 'admin' || r === 'head_admin';
}
function isHeadAdmin(req) {
  return false; // head_admin role removed — use admin instead
}
function isMiner(req) {
  const r = getRole(req);
  return r === 'admin' || r === 'head_admin' || r === 'miner';
}
function isAuthenticated(req) {
  return getRole(req) !== null;
}
// LIMITED accounts can only build Temporary Batches — Profiles, Deck Data,
// GFWL Archive, and browsing/reading other players' saved batches are all
// off-limits to them, both in the UI and here at the API.
function isLimited(req) {
  return getRole(req) === 'limited';
}

function getUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return verifyToken(token);
}

// ── MIME / helpers ────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.json':'application/json','.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml','.gif':'image/gif'
};
// Response bodies here can run from a few bytes ({ok:true}) up to several
// MB (a full batch with many un-migrated legacy replays). Gzip cuts JSON
// text by roughly 70-85%, which matters most on exactly the big payloads
// that were making pages feel slow — so compress whenever the client
// supports it, skipping only trivially small bodies where gzip's own
// overhead isn't worth it.
function acceptsGzip(res) {
  try { return /gzip/.test((res.req && res.req.headers['accept-encoding']) || ''); }
  catch(e) { return false; }
}
function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  // Every API response is dynamic data that can change from one moment to
  // the next (an override, a merge, a retry) — none of it is safe for a
  // browser (or anything sitting between the browser and this server) to
  // cache and reuse. Without an explicit no-store, a GET response here has
  // no Cache-Control or Last-Modified header at all, which does not mean
  // "never cached" — browsers are allowed to cache a response like that
  // heuristically and reuse it for a later identical GET on an ordinary
  // page refresh (not just a hard reload), depending on browser and
  // history-navigation behavior. That reuse happens entirely in the
  // browser, before the request ever reaches this server, which is exactly
  // why a save could be fully correct and durable here and still look like
  // it "reset on refresh": the refresh may never have asked again in the
  // first place. This header removes that possibility outright.
  const headers = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*', 'Cache-Control':'no-store, no-cache, must-revalidate', 'Pragma':'no-cache' };
  if (body.length > 800 && acceptsGzip(res)) {
    zlib.gzip(body, (err, compressed) => {
      if (err) { res.writeHead(status, headers); res.end(body); return; }
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(status, headers);
      res.end(compressed);
    });
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
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
// Finds the actual db.players registry row (and its object key) backing a
// given name, or null. Unlike findPlayerByUsername, this NEVER synthesizes a
// fallback object from batch data — callers that need to mutate or delete
// the real registry entry (e.g. mergeBatchesInternal's registry reconciliation
// below) need to know definitively whether one exists.
// Standard iterative Levenshtein edit distance (single-row DP, O(n*m) time,
// O(min(n,m)) space) — used only by GET /api/admin/registry-check below to
// flag likely typo-twin registry entries for manual review. Small inputs
// (player names), so no need for anything fancier.
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curRow = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curRow.push(Math.min(
        curRow[j] + 1,        // insertion
        prevRow[j + 1] + 1,   // deletion
        prevRow[j] + cost,    // substitution
      ));
    }
    prevRow = curRow;
  }
  return prevRow[b.length];
}
function findRegistryEntryForName(name) {
  const nl = (name||'').toLowerCase().trim();
  if (!nl) return null;
  for (const key of Object.keys(db.players)) {
    const entry = db.players[key];
    if (playerNames(entry).includes(nl)) return { key, entry };
  }
  return null;
}
// Resolves a Format Library event bracket's builderName to a tracked
// player. builderName is usually the player's literal username as typed —
// which can itself legitimately contain an underscore (e.g. "goat_lothy")
// — so that exact spelling is tried FIRST. Only when there's no exact match
// do we fall back to treating the underscore as FL's older space-placeholder
// convention (seen on some other FL fields). Matching only the normalized
// form, as earlier code here did, broke tracked-player detection for any
// real player whose own username contains an underscore.
function findPlayerByBuilderName(builderName) {
  const raw = (builderName || '').trim();
  if (!raw) return null;
  return findPlayerByUsername(raw) || findPlayerByUsername(raw.replace(/_/g, ' '));
}
// Same builderName resolution as findPlayerByBuilderName, but returns the
// actual BATCH object — "has a profile" for import-attach purposes means a
// batch exists, same distinction buildProfileNameIndex/findBatchForBuilderName-
// equivalent logic draws for the Events tab Status column (a bare db.players
// registry stub with no batch must not be treated as an attach target). Used
// by the "Import Events from Format Library" bracket-preview endpoint, which
// is called once per admin click (not once per list-render), so a direct
// alias-aware scan here — rather than building the full index used for the
// Status column's bulk computation — is the right tradeoff: simpler, and
// fast enough at this call frequency.
function findBatchForBuilderName(builderName) {
  const raw = (builderName || '').trim();
  if (!raw) return null;
  for (const variant of [raw, raw.replace(/_/g, ' ')]) {
    for (const batch of Object.values(db.batches)) {
      if (isSameNameOrAlias(variant, batch.player)) return batch;
    }
  }
  return null;
}
function findPlayerByUsername(username) {
  const ul = username.toLowerCase().trim();
  if (!ul) return null;
  // First: check db.players (has full aliases from registry)
  for (const entry of Object.values(db.players)) {
    const names = playerNames(entry);
    if (names.includes(ul)) return entry;
  }
  // Second: check db.batches directly — player may have a batch but no registry entry
  // Collect all aliases from ALL batches for this player
  for (const batch of Object.values(db.batches)) {
    const batchNameLower = (batch.player||'').toLowerCase();
    const batchAliases = (batch.aliases||[]).map(a=>a.toLowerCase());
    if (batchNameLower === ul || batchAliases.includes(ul)) {
      // Merge aliases from ALL batches for this player
      const allBatchAliases = Object.values(db.batches)
        .filter(b => (b.player||'').toLowerCase() === batchNameLower)
        .flatMap(b => b.aliases||[]);
      const mergedAliases = [...new Set(allBatchAliases)];
      return { name: batch.player, aliases: mergedAliases, _fromBatch: true };
    }
  }
  return null;
}
// Whenever a replayId is found in some OTHER batch while propagating an
// override or a merge, that other batch has always been assumed to be the
// OPPONENT's cross-linked mirror — which is why the propagation flips the
// result/score/decks onto it. That assumption breaks the moment a player has
// more than one batch of their OWN (two aliases that were never merged into
// a single batch record, e.g. a duelingbook username vs. a GFWL roster name,
// or simply two separate scrape sessions that each created their own batch
// for the same person): the "other batch" holding the same replayId is then
// a second copy of the SAME player's OWN perspective, not the opponent's,
// and flipping onto it silently writes the opposite result into it. Once
// that happens, whichever of the two batches Deck Viewer/Profile/GFWL
// happens to load next shows the override as if it had "reverted" — it
// didn't; a sibling batch for the same player just got the mirror-image
// value instead of the real one. This checks player identity (via the
// shared player registry, so known aliases count) before deciding whether
// a found batch is really the opponent (flip) or another batch for the same
// person (copy as-is, no flip).
// Alias-aware name comparison, pulled out of isSamePlayerAsBatch so the new
// global override registry (db.overrides, see applyGlobalOverrideToReplay
// below) can reuse the exact same "is this the same person under a
// different username" logic without going through a batch object.
function isSameNameOrAlias(nameA, nameB) {
  const a = (nameA||'').toLowerCase().trim();
  const b = (nameB||'').toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const entryA = findPlayerByUsername(nameA);
  if (entryA && playerNames(entryA).includes(b)) return true;
  const entryB = findPlayerByUsername(nameB);
  if (entryB && playerNames(entryB).includes(a)) return true;
  return false;
}
function isSamePlayerAsBatch(batchA, batchB) {
  if (!batchA || !batchB) return false;
  return isSameNameOrAlias(batchA.player, batchB.player);
}

// For the Events tab's Status column: "has a profile" specifically means a
// BATCH exists for this player — that's what the Profiles tab is actually
// built from (renderProfileGrid iterates db.batches, not db.players). A bare
// db.players registry stub (aliases recorded with no batch ever created)
// must NOT count as "has a profile" here, or the column would wrongly report
// an event as Complete for a builder who has a known alias on file but no
// actual profile/replay data yet — exactly the case this column exists to
// surface.
//
// Built as a flat lowercased-name index, computed ONCE per GET /api/events
// call rather than re-scanning db.batches/db.players per deck per event —
// with ~100+ events × dozens of decks each, a naive per-deck
// isSameNameOrAlias/findPlayerByUsername scan (itself O(batches+players))
// would be O(events × decks × batches × players), the same class of
// accidentally-quadratic cost that made /batches/all-full block the server
// for ~2.4s per request before it got cached (see _allFullCache above).
// This is O(batches + players) to build, then O(1) per deck lookup.
function buildProfileNameIndex() {
  const index = new Set();
  for (const batch of Object.values(db.batches)) {
    if (!batch.player) continue;
    const key = batch.player.toLowerCase();
    index.add(key);
    (batch.aliases||[]).forEach(a => index.add(a.toLowerCase()));
    const reg = db.players[key];
    if (reg) playerNames(reg).forEach(n => index.add(n));
  }
  // A players-registry entry's OWN alias list can link two names together
  // even when neither is a batch's own `aliases` field (e.g. registry key
  // "oldname" lists alias "newname", and the only batch that exists is under
  // "newname"). One transitive-closure pass over the (small) registry catches
  // that without a full graph walk per lookup.
  let changed = true;
  while (changed) {
    changed = false;
    for (const reg of Object.values(db.players)) {
      const names = playerNames(reg);
      if (names.some(n => index.has(n))) {
        for (const n of names) if (!index.has(n)) { index.add(n); changed = true; }
      }
    }
  }
  return index;
}

// Index used by both the Events-list Status column (computeEventStatus
// below) and the per-event Players-tab Replays ✓/✗ column (GET
// /api/events/:code): for every event code, the set of lowercased
// player/alias names that have at least one SAVED REPLAY tagged with that
// event. Built once per request by scanning every batch's replays a single
// time — O(batches × avg replays per batch) total — rather than, as both
// call sites used to do independently, rescanning every batch's replays
// per deck or per event (O(events × decks × batches) for the list, which is
// exactly the accidentally-quadratic shape that made /batches/all-full slow
// before it got cached; see the _allFullCache comment above).
// Each code maps to { hasReplay: Set, needsReview: Set, aliasError: Set } —
// hasReplay is the original "at least one saved replay" set; needsReview is
// a second set, built in this same pass, of names that have at least one
// replay tagged to that event which was saved WITHOUT a resolved
// winner/loser because none of this player's known aliases matched either
// side's actual DuelingBook name in it (the same `!r.timedOut && !r.parsed`
// shape editAliases()'s own re-parse sweep already uses to find these). Per
// the explicit instruction this was built for: Format Library's own
// participant names are usually the correct ones, so a gap like this is
// "flag it for a human to check the alias/profile", never a silent guess —
// this is what lets the Events tab's Replays column distinguish "no replay
// found at all" from "a replay IS here, but it doesn't match this profile's
// aliases" instead of only ever showing those two very different situations
// as the same ✓.
// aliasError is a third set, built the same way: names with at least one
// replay tagged to that event whose resolved game score has either side
// reaching 3 or more games won. GOAT bracket matches here are always best
// of 3 (2 games needed to win), so a "3-0", "0-3", "3-1", "1-3", "3-2" or
// "2-3" score is never a real result — it means two separate matches' games
// got folded into one replay record, which is exactly what happens when an
// alias collision makes the parser attribute a different round's games to
// this player. Same philosophy as needsReview: this is surfaced as "go fix
// the alias", not silently guessed past. A manually corrected scoreOverride
// takes precedence over the raw parsed score, so fixing the alias (which
// triggers a re-parse) or applying a correct manual override both clear
// this flag.
function buildEventReplayCoverageIndex() {
  const index = {};
  for (const batch of Object.values(db.batches)) {
    const names = [(batch.player||'').toLowerCase(), ...(batch.aliases||[]).map(a=>a.toLowerCase())].filter(Boolean);
    if (!names.length) continue;
    for (const r of (batch.replays||[])) {
      const code = (r.eventLabel||r.eventId||'').toUpperCase().trim();
      if (!code) continue;
      if (!index[code]) index[code] = { hasReplay: new Set(), needsReview: new Set(), aliasError: new Set() };
      const needsReview = !r.timedOut && !r.parsed;
      const effMyW  = r.scoreOverride ? r.scoreOverride.my  : (r.parsed && typeof r.parsed.myW  === 'number' ? r.parsed.myW  : null);
      const effOppW = r.scoreOverride ? r.scoreOverride.opp : (r.parsed && typeof r.parsed.oppW === 'number' ? r.parsed.oppW : null);
      const aliasError = (typeof effMyW === 'number' && effMyW >= 3) || (typeof effOppW === 'number' && effOppW >= 3);
      for (const n of names) {
        index[code].hasReplay.add(n);
        if (needsReview) index[code].needsReview.add(n);
        if (aliasError) index[code].aliasError.add(n);
      }
    }
  }
  return index;
}

// Drives the Events tab's Status column. Four states:
//  - 'error' (red, "Missing Data"): the event record has no decks captured
//    at all — effectively an empty/broken entry.
//  - 'missing_players' (amber, "Missing Player Profiles"): at least one
//    deck's builder has no matching profile/batch in our system at all yet.
//    Lists those names so the column can show exactly who's missing.
//  - 'incomplete_data' (amber, "Missing Replays/Decklists"): every builder
//    has a profile, but at least one of them is still missing their
//    decklist (d.ydkData) and/or a replay actually tagged with this event —
//    i.e. the profile exists but the DATA behind it doesn't. This is the
//    state that used to be reported as 'complete' once hidden auto-created
//    profiles (see the db.batches `hidden` comment near the top of this
//    file) started giving literally every bracket entrant a profile the
//    instant an FL import ran, even when that import failed to actually
//    find/attach their replays — making the old profile-only check almost
//    always pass regardless of whether any real data had landed.
//  - 'complete' (green): every tracked deck's builder has a profile AND has
//    both a decklist and at least one replay on file for this event.
// A blank/missing builderName on an individual deck slot is skipped rather
// than counted as missing — there's no name to show or match on, and that's
// a data-quality issue distinct from either of the above. Same
// underscore-as-space fallback convention as findPlayerByBuilderName, since
// FL builderNames need it too.
function computeEventStatus(ev, profileIndex, replayCoverageIndex) {
  const decks = ev.decks || [];
  if (!decks.length) return { status: 'error', missingPlayers: [], incompleteData: [] };
  const missingPlayers = [];
  const incompleteData = [];
  const seenMissing = new Set();
  const seenIncomplete = new Set();
  const coverage = (replayCoverageIndex && replayCoverageIndex[ev.code]) || { hasReplay: new Set(), needsReview: new Set(), aliasError: new Set() };
  for (const d of decks) {
    const name = (d.builderName || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const keyAlt = key.replace(/_/g, ' ');
    if (!profileIndex.has(key) && !profileIndex.has(keyAlt)) {
      if (!seenMissing.has(key)) { seenMissing.add(key); missingPlayers.push(name); }
      continue;
    }
    const hasCards = !!d.ydkData;
    // Expand through this player's FULL alias network (registry aliases
    // included, not just whatever's mirrored onto the batch's own .aliases
    // array — those two lists can legitimately diverge; see openProfile's
    // own alias-union fix) before checking replay coverage, exactly like
    // GET /api/events/:code already does via findPlayerByBuilderName +
    // playerNames. Checking only the raw/exact builderName string here (as
    // this used to) under-reported "Missing Replays/Decklists" for any
    // player whose FL bracket spelling differs from their tracked batch
    // name and is linked ONLY through a registry alias — their replays are
    // really on file under the matching alias, this just wasn't looking
    // for it, so the Status column disagreed with (was more pessimistic
    // than) the event detail page and the Player Issues modal for the
    // exact same player.
    const playerEntry = findPlayerByBuilderName(name);
    const hasReplay = playerEntry
      ? playerNames(playerEntry).some(n => coverage.hasReplay.has(n))
      : (coverage.hasReplay.has(key) || coverage.hasReplay.has(keyAlt));
    if (!hasCards || !hasReplay) {
      if (!seenIncomplete.has(key)) { seenIncomplete.add(key); incompleteData.push(name); }
    }
  }
  if (missingPlayers.length) return { status: 'missing_players', missingPlayers, incompleteData };
  if (incompleteData.length) return { status: 'incomplete_data', missingPlayers: [], incompleteData };
  return { status: 'complete', missingPlayers: [], incompleteData: [] };
}

// Extracted from POST /api/batches/:id/replay (which now just calls this and
// wraps the result in a response) so the Format-Library-import pending-attach
// hook (see POST /api/batches below) can add an already-parsed replay to a
// batch through the exact same dedup/timed-out-update/cross-link path a live
// go() import uses — rather than a second, divergent copy of this logic that
// would inevitably drift (miss a future fix to dedup or cross-linking, like
// the stale-cache bug this app already hit once from two save paths that
// looked equivalent but weren't). `data` is the same shape go() POSTs:
// {replayId, plays, allPlays, parsed, timedOut, eventLabel, round, oppName,
// player1, player2, noCrossLink?}. `req` is passed through for logChange's
// attribution — a pending-import attach still passes the ORIGINAL importer's
// req (captured at import time), not whatever request happens to create the
// profile later, so the audit log correctly credits who actually pulled the
// data in, not an unrelated future action.
async function addReplayToBatchData(b, data, req) {
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
    b.replays.push({ replayId:data.replayId, plays:data.plays||[], allPlays:parsedData?[]:strippedPlays, parsed:parsedData, timedOut:!!data.timedOut, eventLabel:data.eventLabel||'', round:data.round||'', oppName:data.oppName||'', player1:data.player1||null, player2:data.player2||null, savedAt:Date.now() });
    b.status = 'ready';
    markBatchDirty(b.id);
    logChange(req, 'add_replay', { batchId: b.id, batchPlayer: b.player, replayId: data.replayId, eventLabel: data.eventLabel || '', oppName: data.oppName || '' });
    // Only cross-link when explicitly allowed (new batch creation, not manual add-to-batch)
    if (data.oppName && !data.noCrossLink) {
      const cl = crossLinkReplay(data, data.oppName, b.player);
      if (cl) crossLinks.push(cl);
      if (cl && cl.batchId) await saveBatchToPostgres(cl.batchId).catch(e=>console.error('[crosslink save]',e.message));
    }
    await saveBatchToPostgres(b.id);
    } catch(saveErr) { console.error('[replay POST] Save error:', saveErr.message); throw saveErr; }
  } else if (dup.timedOut && !data.timedOut) {
    // Existing timed-out entry being updated with real data — overwrite it.
    // Preserve any override that was already set directly on this
    // placeholder (result/score/deck correction made while it was still
    // pending) — replacing the object wholesale must not silently drop
    // it, and it must also be re-baked into the fresh `parsed` block so
    // it still wins over the newly-arrived raw parse.
    const parsedData2 = data.parsed || null;
    const preservedResultOverride  = dup.resultOverride  || null;
    const preservedScoreOverride   = dup.scoreOverride   || null;
    const preservedMyDeckOverride  = dup.myDeckOverride  || null;
    const preservedOppDeckOverride = dup.oppDeckOverride || null;
    const preservedOverrideNote    = dup.overrideNote    || '';
    if (parsedData2) {
      if (preservedMyDeckOverride)  parsedData2.myDeck  = preservedMyDeckOverride;
      if (preservedOppDeckOverride) parsedData2.oppDeck = preservedOppDeckOverride;
      if (preservedResultOverride)  { parsedData2.resultOverride = preservedResultOverride; parsedData2.resultEffective = preservedResultOverride; }
      if (preservedScoreOverride)   parsedData2.scoreOverride = preservedScoreOverride;
      if (preservedOverrideNote)    parsedData2.overrideNote = preservedOverrideNote;
    }
    b.replays[dupIdx] = { replayId:data.replayId, plays:data.plays||[], allPlays:parsedData2?[]:(minPlays||[]).map(stripPlay), parsed:parsedData2, timedOut:false, eventLabel:dup.eventLabel||data.eventLabel||'', round:dup.round||data.round||'', oppName:data.oppName||dup.oppName||'', player1:data.player1||dup.player1||null, player2:data.player2||dup.player2||null, savedAt:Date.now(),
      resultOverride: preservedResultOverride, scoreOverride: preservedScoreOverride,
      myDeckOverride: preservedMyDeckOverride, oppDeckOverride: preservedOppDeckOverride,
      overrideNote: preservedOverrideNote, crossLinked: dup.crossLinked||false,
      // A Round manually set while this replay was still timedOut (rare,
      // but possible — nothing stops an admin from fixing Round before the
      // real data loads) must survive this wholesale rebuild the same way
      // the overrides above do, or the very next Retry Round Data run would
      // just overwrite it right back since the flag that protects it would
      // otherwise have been silently dropped here.
      roundManual: dup.roundManual||false };
    b.status = 'ready';
    console.log(`[replay] Updated timed-out replay ${data.replayId} with real data`);
    await saveBatchToPostgres(b.id);
  }
  return { duplicate: !!dup, crossLinks };
}

// ── mergeReplaysInto / mergeDecklistsInto ────────────────────────────────────
// Low-level dedup helpers shared by mergeBatchesInternal below. A replay is
// identified purely by replayId: if `keep` doesn't have it yet, it's copied
// over as-is; if both sides have it, a real (non-timed-out) copy always wins
// over a timed-out placeholder, and otherwise `keep`'s existing copy is left
// alone (it's already at least as good as `merge`'s). A decklist is
// identified by eventId the same way, with "has ydkData" standing in for
// "is the better copy" since a decklist entry with no YDK attached is just a
// placeholder.
function mergeReplaysInto(keep, mergeBatch) {
  if (!keep.replays) keep.replays = [];
  let merged = 0;
  for (const r of (mergeBatch.replays || [])) {
    const dupIdx = keep.replays.findIndex(kr => kr.replayId === r.replayId);
    if (dupIdx < 0) { keep.replays.push(r); merged++; }
    else if (keep.replays[dupIdx].timedOut && !r.timedOut) { keep.replays[dupIdx] = r; merged++; }
  }
  return merged;
}
function mergeDecklistsInto(keep, mergeBatch) {
  if (!keep.eventDecklists) keep.eventDecklists = [];
  let merged = 0;
  for (const d of (mergeBatch.eventDecklists || [])) {
    // `.code` is the real schema (see POST /api/fl-import/pending's own
    // comment) — `.eventId` only ever shows up on a legacy entry written by
    // a since-fixed bug in that same route or in flEventImportRun. Falling
    // back to it here (both for the dedup key AND to repair the copied
    // entry itself) means a hidden batch carrying one of those old broken
    // entries gets it SELF-HEALED the moment it's promoted into a real
    // profile, instead of permanently baking the "undefined" in.
    if (!d.code && d.eventId) d.code = d.eventId;
    const dKey = (d.code||'').toUpperCase();
    const dupIdx = keep.eventDecklists.findIndex(kd => (kd.code||kd.eventId||'').toUpperCase() === dKey);
    if (dupIdx < 0) { keep.eventDecklists.push(d); merged++; }
    else if (!keep.eventDecklists[dupIdx].ydkData && d.ydkData) { keep.eventDecklists[dupIdx] = d; merged++; }
  }
  return merged;
}

// ── mergeBatchesInternal(keep, merge, req, reason) ──────────────────────────
// Shared merge engine for the two code paths that both reduce to "fold one
// batch's data into another and delete the loser": autoMergeHiddenBatches
// below (automatic promotion of a hidden FL-import batch the moment a real
// matching profile shows up) and POST /api/batches/merge (an admin
// explicitly merging two profiles that turned out to be the same player —
// e.g. a duplicate created by a typo or an unrecognized alias). `reason` is
// just a free-text tag for the audit log ('fl_import_promoted' vs
// 'admin_merge') — the actual merge logic is identical either way: union
// aliases (adding the merged-away batch's own name as an alias on the
// survivor, since anything still referring to that old name — GFWL rosters
// are matched by name, not batchId, see the db.gfwl comment elsewhere in
// this file — needs to keep resolving correctly), dedupe replays and
// eventDecklists via the helpers above, then permanently delete the
// merged-away batch. Uses flushBatchNow (not the debounced saveBatchToPostgres)
// so a caller awaiting this knows the merge is actually durable before it
// deletes the other batch for good — losing a half-saved merge would be
// worse than the duplicate-profile problem it's meant to fix.
async function mergeBatchesInternal(keep, merge, req, reason) {
  if (!keep || !merge || keep.id === merge.id) return { ok: false, error: 'Need two distinct batches to merge.' };

  const existingAliases = new Set((keep.aliases||[]).map(a => a.toLowerCase()));
  // Frozen snapshot of keep's aliases as they stood BEFORE this merge adds
  // anything to them — `existingAliases` above is mutated in place by the
  // loop just below, so it can't be reused later for "what did keep already
  // know about itself, independent of this merge" (see the registry
  // reconciliation step further down, which needs exactly that).
  const keepAliasesBeforeMerge = [...existingAliases];
  const keepNameLower = (keep.player||'').toLowerCase();
  const newAliases = [];
  for (const name of [merge.player, ...(merge.aliases||[])]) {
    if (!name) continue;
    const nl = name.toLowerCase();
    if (nl === keepNameLower || existingAliases.has(nl)) continue;
    existingAliases.add(nl);
    newAliases.push(name);
  }
  if (newAliases.length) keep.aliases = [...(keep.aliases||[]), ...newAliases];

  const mergedReplays = mergeReplaysInto(keep, merge);
  const mergedDecklists = mergeDecklistsInto(keep, merge);
  if (mergedReplays && keep.status !== 'ready') keep.status = 'ready';

  const eventIds = [...new Set([
    ...(merge.eventDecklists||[]).map(d => d.code || d.eventId).filter(Boolean),
    ...(merge.replays||[]).map(r => r.eventLabel).filter(Boolean),
  ])];

  // Reconcile the separate player registry (db.players) too. Merging two
  // batches used to only ever touch db.batches — if each side also had its
  // own db.players registry row (e.g. one created by an early alias-add,
  // the other by a typo'd "Create New Profile"), both rows survived the
  // merge forever. That's exactly how a duplicate like "Alex Zander" /
  // "Alez Zander" could show up twice in the sidebar's registry-backed
  // search (onPlayerSearch reads db.players directly) while the Profiles
  // grid — grouped by the now-merged batch.player — correctly showed one.
  // Fold the loser's registry row into the keeper's (or just re-home it
  // under the keeper's name, if the keeper had none yet) and delete the
  // loser's row so only one registry entry survives the merge.
  let playersChanged = false;
  const mergeNames = [merge.player, ...(merge.aliases||[])].filter(Boolean);
  // IMPORTANT: look up keepInfo using keepAliasesBeforeMerge (keep's aliases
  // as they stood BEFORE this merge folded merge's name/aliases into them)
  // — not the now-mutated keep.aliases, and not `existingAliases` (same
  // underlying Set, mutated by the loop above). Otherwise, since merge.player
  // always ends up folded into keep.aliases by this point (unless it was
  // already there), keepInfo would almost always resolve to the SAME
  // registry row as mergeInfo (the loser's), making the "keeper has no
  // registry row of its own yet" re-home branch below unreachable.
  let keepInfo = findRegistryEntryForName(keep.player) ||
    keepAliasesBeforeMerge.reduce((found, a) => found || findRegistryEntryForName(a), null);
  let mergeInfo = null;
  for (const n of mergeNames) { mergeInfo = findRegistryEntryForName(n); if (mergeInfo) break; }
  if (mergeInfo && (!keepInfo || keepInfo.key !== mergeInfo.key)) {
    if (!keepInfo) {
      // Keeper has no registry row of its own — cheapest correct move is to
      // re-home the loser's row under the keeper's name/aliases rather than
      // silently dropping its tags/topPlayer/gfwlTeams/eventDecklists.
      const entry = mergeInfo.entry;
      entry.name = keep.player;
      const aliasSet = new Set((entry.aliases||[]).map(a => a.toLowerCase()));
      for (const a of (keep.aliases||[])) {
        if (a && !aliasSet.has(a.toLowerCase())) { entry.aliases = [...(entry.aliases||[]), a]; aliasSet.add(a.toLowerCase()); }
      }
      delete db.players[mergeInfo.key];
      db.players[keep.player.toLowerCase()] = entry;
    } else {
      const keepEntry = keepInfo.entry, mergeEntry = mergeInfo.entry;
      const aliasSet = new Set([keepEntry.name, ...(keepEntry.aliases||[])].map(a => a.toLowerCase()));
      for (const a of [mergeEntry.name, ...(mergeEntry.aliases||[])]) {
        if (a && !aliasSet.has(a.toLowerCase())) { keepEntry.aliases = [...(keepEntry.aliases||[]), a]; aliasSet.add(a.toLowerCase()); }
      }
      if (mergeEntry.topPlayer) keepEntry.topPlayer = true;
      if (mergeEntry.tags && mergeEntry.tags.length) {
        keepEntry.tags = [...new Set([...(keepEntry.tags||[]), ...mergeEntry.tags])];
      }
      if (mergeEntry.gfwlTeams && mergeEntry.gfwlTeams.length) {
        keepEntry.gfwlTeams = keepEntry.gfwlTeams || [];
        const seasonsHave = new Set(keepEntry.gfwlTeams.map(t => (t.season||'').toUpperCase()).filter(Boolean));
        for (const t of mergeEntry.gfwlTeams) {
          if (t.season && seasonsHave.has(t.season.toUpperCase())) continue;
          keepEntry.gfwlTeams.push(t);
          if (t.season) seasonsHave.add(t.season.toUpperCase());
        }
      }
      if (mergeEntry.eventDecklists && mergeEntry.eventDecklists.length) {
        keepEntry.eventDecklists = keepEntry.eventDecklists || [];
        for (const d of mergeEntry.eventDecklists) {
          // Same self-heal as mergeDecklistsInto above — repair a legacy
          // `.eventId`-only entry's `.code` in place before it's copied, not
          // just when comparing keys, so what survives the merge is
          // actually readable by getEventDecks et al. afterward.
          if (!d.code && d.eventId) d.code = d.eventId;
          const dKey = (d.code || '').toUpperCase();
          const dupIdx = keepEntry.eventDecklists.findIndex(kd => (kd.code || kd.eventId || '').toUpperCase() === dKey);
          if (dupIdx < 0) keepEntry.eventDecklists.push(d);
          else if (!keepEntry.eventDecklists[dupIdx].ydkData && d.ydkData) keepEntry.eventDecklists[dupIdx] = d;
        }
      }
      delete db.players[mergeInfo.key];
    }
    playersChanged = true;
  }
  if (playersChanged) await saveDB('players');

  delete db.batches[merge.id];
  await deleteBatchFromPostgres(merge.id);
  const flush = await flushBatchNow(keep.id);

  logChange(req, 'merge_batches', {
    keepBatchId: keep.id, keepPlayer: keep.player,
    mergedBatchId: merge.id, mergedPlayer: merge.player,
    mergedReplays, mergedDecklists, aliasesAdded: newAliases, reason: reason || 'merge',
  });

  return { ok: flush.ok, error: flush.ok ? undefined : flush.error, mergedReplays, mergedDecklists, aliasesAdded: newAliases, eventIds };
}

// ── autoMergeHiddenBatches(newBatch, req) ────────────────────────────────────
// Called right after a batch is created or edited (see POST /api/batches and
// PATCH /api/batches/:id below) — the one place every "new/updated profile"
// path in the app funnels through (both the client's New Batch flow and
// findOrPromptPlayer's "Create New Profile" button end in a POST here; an
// admin adding an alias to an existing profile goes through the PATCH).
// Finds any HIDDEN batch (a placeholder the Format Library bracket importer
// created for a player who had no real profile yet — see the db.events
// comment near the top of this file) whose player name is an alias match —
// checked in BOTH directions, since which name the importer happened to see
// from Format Library and which name the admin happens to type aren't
// guaranteed to be the same one — for this batch's own name/aliases, and
// folds each match in via mergeBatchesInternal. This replaces the old
// attachPendingFLImports/db.pendingFLImports mechanism: the data was already
// a real batch with real replays/YDKs the whole time, so "attaching" it is
// just the normal merge path with a different reason tag.
async function autoMergeHiddenBatches(newBatch, req) {
  if (!newBatch || newBatch.hidden) return { attachedEvents: [] };
  const names = [newBatch.player, ...(newBatch.aliases||[])].filter(Boolean);
  if (!names.length) return { attachedEvents: [] };
  const matches = Object.values(db.batches).filter(b =>
    b.hidden && b.id !== newBatch.id && names.some(n => isSameNameOrAlias(n, b.player))
  );
  if (!matches.length) return { attachedEvents: [] };
  const attachedEvents = [];
  for (const hidden of matches) {
    try {
      const result = await mergeBatchesInternal(newBatch, hidden, req, 'fl_import_promoted');
      if (result.ok) attachedEvents.push(...result.eventIds);
    } catch(e) { console.error('[fl-import] autoMergeHiddenBatches failed for', hidden.id, ':', e.message); }
  }
  return { attachedEvents };
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
// Same as findOrCreateBatchForPlayer, but starts from a raw typed name
// instead of an already-resolved registry entry — used by the manual-match
// endpoint, where a player typed into a form may or may not already have a
// profile. Resolves aliases first (so typing a known alias attaches to the
// existing profile instead of spawning a near-duplicate), and only creates
// a brand-new batch when the name really is new — the same "a batch with no
// registry entry is still a profile" rule findPlayerByUsername's own second
// branch already relies on.
function findOrCreateBatchForPlayerName(name) {
  const raw = (name || '').trim();
  if (!raw) return null;
  const entry = findPlayerByUsername(raw) || { name: raw, aliases: [] };
  return findOrCreateBatchForPlayer(entry);
}
// A manually-overridden result must trump the raw parsed outcome everywhere,
// including when a replay gets mirrored into an opponent's batch via
// cross-linking — otherwise Player A's corrected result (e.g. a DQ ruling)
// never shows up on Player B's copy of the same match. flipResult() mirrors
// a W/L across the two sides of one match.
function flipResult(r) { return r === 'w' ? 'l' : r === 'l' ? 'w' : r; }

// A standard best-of-3 match can only end 2-0, 2-1, 1-2 or 0-2 — the moment
// either side reaches 2 game wins the match is over, so nothing else is a
// legal terminal score. Mirrors the client's bo3ScoreIssue() in
// public/index.html — kept in sync by hand since this runs server-side.
// Returns null for a valid score, 'under' (neither side reached 2 — could be
// a legitimate single-game forfeit, or a parsing gap) or 'over' (someone has
// 3+ wins, or both sides show 2+ — never legitimate in a real best-of-3,
// almost always a data bug: games double-counted, merged wrong, or a
// continuation replay stitched in twice).
function bo3ScoreIssue(my, opp) {
  if (typeof my !== 'number' || typeof opp !== 'number') return null;
  if ((my === 2 && opp <= 1) || (opp === 2 && my <= 1)) return null;
  if (my > 2 || opp > 2 || (my >= 2 && opp >= 2)) return 'over';
  return 'under';
}

// Apply a result/score/deck override payload to one replay record, updating
// both the top-level override fields and the cached `parsed` block's mirror
// fields so every reader (buildMatchRecord, GFWL week/round scores, the
// profile matchup tables, ...) sees the corrected outcome. `flip` mirrors
// W/L and swaps my/opp — used when applying the SAME override to a
// cross-linked twin replay sitting in the opponent's own batch, so an
// override trumps cross-linking instead of being visible only to whoever
// set it.
// Re-stamp a replay's OWN existing override fields onto its `parsed` block.
// Any code path that replaces or rebuilds `r.parsed` from a fresh parse — a
// retry, a migration, a cross-link upgrade — must call this immediately
// after, no matter why the reparse happened. Overrides live in two places at
// once (top-level r.resultOverride/r.scoreOverride/r.myDeckOverride/etc, AND
// mirrored inside r.parsed.*), and almost every reader in this app looks at
// r.parsed.* first. A fresh parse naturally has no idea an override exists,
// so if this isn't called, the top-level field survives untouched while the
// value everyone actually sees quietly reverts — which is functionally the
// same as losing the correction. This is the single point every write path
// should go through so "an override sticks until someone explicitly changes
// or clears it" holds everywhere, not just in the specific spots a bug
// report happened to surface it.
function reapplyOverridesToParsed(r) {
  if (!r || !r.parsed) return;
  if (r.myDeckOverride)  r.parsed.myDeck  = r.myDeckOverride;
  if (r.oppDeckOverride) r.parsed.oppDeck = r.oppDeckOverride;
  if (r.resultOverride) {
    r.parsed.resultOverride = r.resultOverride;
    r.parsed.resultEffective = r.resultOverride;
  } else {
    r.parsed.resultOverride = null;
    delete r.parsed.resultEffective;
  }
  r.parsed.scoreOverride = r.scoreOverride || null;
  if (r.overrideNote) r.parsed.overrideNote = r.overrideNote;
  if (r.omitted) r.parsed.omitted = true;
  if (r.omittedNote) r.parsed.omittedNote = r.omittedNote;
}

function applyOverrideToReplay(r, data, flip) {
  if (data.myDeckOverride !== undefined) {
    const v = data.myDeckOverride;
    r[flip ? 'oppDeckOverride' : 'myDeckOverride'] = v;
    if (r.parsed && v) r.parsed[flip ? 'oppDeck' : 'myDeck'] = v;
  }
  if (data.oppDeckOverride !== undefined) {
    const v = data.oppDeckOverride;
    r[flip ? 'myDeckOverride' : 'oppDeckOverride'] = v;
    if (r.parsed && v) r.parsed[flip ? 'myDeck' : 'oppDeck'] = v;
  }
  if (data.resultOverride !== undefined) {
    const ro = data.resultOverride ? (flip ? flipResult(data.resultOverride) : data.resultOverride) : null;
    r.resultOverride = ro;
    if (r.parsed) {
      r.parsed.resultOverride = ro;
      if (ro) r.parsed.resultEffective = ro;
      else delete r.parsed.resultEffective;
    }
  }
  if (data.scoreOverride !== undefined) {
    const so = data.scoreOverride ? (flip ? { my: data.scoreOverride.opp, opp: data.scoreOverride.my } : data.scoreOverride) : null;
    r.scoreOverride = so;
    if (r.parsed) r.parsed.scoreOverride = so;
  }
  if (data.overrideNote !== undefined) {
    r.overrideNote = data.overrideNote || '';
    if (r.parsed) r.parsed.overrideNote = data.overrideNote || '';
  }
  // Omission (excluded from Format Data entirely) is NOT perspective-
  // relative like W/L or score — a match being omitted is true for both
  // sides equally, so unlike everything else in this function it's never
  // flipped for the opponent's twin.
  if (data.omitted !== undefined) {
    r.omitted = !!data.omitted;
    if (r.parsed) r.parsed.omitted = !!data.omitted;
  }
  if (data.omittedNote !== undefined) {
    r.omittedNote = data.omittedNote || '';
    if (r.parsed) r.parsed.omittedNote = data.omittedNote || '';
  }
}

// Alias-aware lookup into a global override record's deckOverrides map
// (keyed by lowercase player name). A plain `deckOverrides[name.toLowerCase()]`
// lookup would miss when the caller passes a different alias of the same
// person than whichever one was on-screen at save time.
function lookupDeckOverride(deckOverrides, playerName) {
  if (!deckOverrides || !playerName) return undefined;
  const pl = playerName.toLowerCase().trim();
  if (deckOverrides[pl] !== undefined) return deckOverrides[pl];
  for (const key of Object.keys(deckOverrides)) {
    if (isSameNameOrAlias(key, playerName)) return deckOverrides[key];
  }
  return undefined;
}

// ── Global, replayId-keyed override registry ────────────────────────────────
// db.overrides[replayId] is the single source of truth for a manual
// correction to a replay's result/score/notes/decks, stored in ABSOLUTE
// terms (who actually won, by what score — not "my score vs. their score"
// relative to whichever batch happened to set it). Every previous attempt to
// fix "the override reverts after refresh" instead tried to keep every
// per-batch COPY of the override in sync with every other copy (the
// opponent's cross-linked twin, a same-player's unmerged alias batch, a
// duplicate scrape) — and each of those sync paths turned out to have its
// own edge case that could silently drop or flip the correction. This
// sidesteps that whole class of bug: there is exactly one record per replay,
// and applyGlobalOverrideToReplay() re-derives the correct relative
// (my/opp) view of it fresh, every time a batch's replay data is read,
// regardless of what (possibly stale) data sits in that batch's own copy of
// the replay. It is purely additive and a no-op when no global record
// exists for a given replayId, so replays nobody has ever overridden are
// completely unaffected.
function applyGlobalOverrideToReplay(r, batchPlayer) {
  if (!r || !r.replayId) return;
  const g = db.overrides[r.replayId];
  if (!g) return; // nothing recorded for this replay — leave existing fields exactly as they are
  const oppName = r.oppName || (r.parsed && r.parsed.oppName) || null;
  if (g.winner) {
    const amWinner = isSameNameOrAlias(batchPlayer, g.winner);
    const resultOverride = amWinner ? 'w' : 'l';
    r.resultOverride = resultOverride;
    if (r.parsed) { r.parsed.resultOverride = resultOverride; r.parsed.resultEffective = resultOverride; }
    if (g.winnerScore != null && g.loserScore != null) {
      const scoreOverride = amWinner
        ? { my: g.winnerScore, opp: g.loserScore }
        : { my: g.loserScore, opp: g.winnerScore };
      r.scoreOverride = scoreOverride;
      if (r.parsed) r.parsed.scoreOverride = scoreOverride;
    }
  }
  if (g.note) {
    r.overrideNote = g.note;
    if (r.parsed) r.parsed.overrideNote = g.note;
  }
  // Same for both sides of a cross-linked pair — no winner-relative flip.
  r.omitted = !!g.omitted;
  if (r.parsed) r.parsed.omitted = !!g.omitted;
  if (g.omittedNote) {
    r.omittedNote = g.omittedNote;
    if (r.parsed) r.parsed.omittedNote = g.omittedNote;
  }
  if (g.deckOverrides) {
    const myDeck = lookupDeckOverride(g.deckOverrides, batchPlayer);
    const oppDeck = oppName ? lookupDeckOverride(g.deckOverrides, oppName) : undefined;
    if (myDeck) { r.myDeckOverride = myDeck; if (r.parsed) r.parsed.myDeck = myDeck; }
    if (oppDeck) { r.oppDeckOverride = oppDeck; if (r.parsed) r.parsed.oppDeck = oppDeck; }
  }
}

// Build/merge the absolute global override record for a replay from a
// batch-relative override payload (the shape the PATCH .../override route
// has always accepted: resultOverride 'w'/'l' relative to the batch that
// sent it, scoreOverride {my,opp} same way). `batchPlayer` is whose
// perspective `data` is relative to; `oppName` is that batch's opponent on
// this specific replay, used so a winner can be recorded by an absolute
// name even when the override is "my side lost" (so winner = opponent).
// Returns the updated record, or null if the merge leaves it empty (no
// winner, no note, no deck overrides) — callers should delete the key
// entirely in that case so clearing an override actually removes it rather
// than leaving an empty husk that a future read mistakes for "something is
// recorded here."
function mergeGlobalOverride(replayId, data, batchPlayer, oppName) {
  const existing = db.overrides[replayId] || { replayId, winner: null, winnerScore: null, loserScore: null, note: '', deckOverrides: {} };
  const g = { ...existing, deckOverrides: { ...(existing.deckOverrides||{}) } };

  if (data.resultOverride !== undefined) {
    if (!data.resultOverride) {
      g.winner = null; g.winnerScore = null; g.loserScore = null;
    } else if (data.resultOverride === 'w') {
      g.winner = batchPlayer || g.winner;
    } else if (data.resultOverride === 'l') {
      g.winner = oppName || g.winner;
    }
  }
  if (data.scoreOverride !== undefined) {
    if (!data.scoreOverride) {
      g.winnerScore = null; g.loserScore = null;
    } else {
      // scoreOverride is {my,opp} relative to batchPlayer. Re-derive
      // winner/loser scores from whichever side g.winner now names, so a
      // result-override and a score-override sent in the same payload (the
      // normal case) always agree on who they're both describing.
      const myIsWinner = g.winner ? isSameNameOrAlias(batchPlayer, g.winner) : (data.resultOverride === 'w');
      g.winnerScore = myIsWinner ? data.scoreOverride.my : data.scoreOverride.opp;
      g.loserScore  = myIsWinner ? data.scoreOverride.opp : data.scoreOverride.my;
    }
  }
  if (data.overrideNote !== undefined) {
    g.note = data.overrideNote || '';
  }
  if (data.myDeckOverride !== undefined && batchPlayer) {
    if (data.myDeckOverride) g.deckOverrides[batchPlayer.toLowerCase()] = data.myDeckOverride;
    else delete g.deckOverrides[batchPlayer.toLowerCase()];
  }
  if (data.oppDeckOverride !== undefined && oppName) {
    if (data.oppDeckOverride) g.deckOverrides[oppName.toLowerCase()] = data.oppDeckOverride;
    else delete g.deckOverrides[oppName.toLowerCase()];
  }
  if (data.omitted !== undefined) {
    g.omitted = !!data.omitted;
    if (!g.omitted) g.omittedNote = ''; // un-omitting clears the reason along with the flag
  }
  if (data.omittedNote !== undefined) {
    g.omittedNote = data.omittedNote || '';
  }

  const isEmpty = !g.winner && !g.note && !g.omitted && Object.keys(g.deckOverrides).length === 0;
  if (isEmpty) return null;
  g.replayId = replayId;
  g.updatedAt = Date.now();
  return g;
}

// Re-derive override fields, from the global registry, on every IN-MEMORY
// copy of a given replayId across EVERY batch — not just the batches an
// alias-matching heuristic happens to find. This is what makes the global
// registry the authority for the server's OWN aggregate endpoints too
// (GFWL Archive, Format Data, Player Profiles, Player Win/Loss Records, and
// anything else that reads db.batches directly rather than going through
// GET /api/batches/:id or /all-full) — those endpoints read `r.resultOverride`
// etc. straight off the in-memory replay object, so the correction has to
// actually be written into that object, not merely computed on the fly by a
// couple of specific GET routes. Returns the ids of every batch that holds
// at least one copy of this replayId, so the caller can flush just those.
function applyGlobalOverrideToAllBatchCopies(replayId) {
  const touchedBatchIds = [];
  for (const b of Object.values(db.batches)) {
    const r = (b.replays||[]).find(rr => rr.replayId === replayId);
    if (r) { applyGlobalOverrideToReplay(r, b.player || null); touchedBatchIds.push(b.id); }
  }
  return touchedBatchIds;
}

// Sets the CANONICAL deck type for one event bracket deck, using OUR
// classifier (run client-side, see eventsRenderDeckCards / flConfirmImport
// in index.html) instead of trusting Format Library's own deckTypeName
// string. Two sources can call this: 'decklist' (classified straight from
// that deck's own card list — always correct, and always wins) and
// 'replay' (classified from cards actually seen in a player's games — a
// fallback used only when no decklist classification exists yet). A lower-
// priority source is never allowed to clobber a higher one that's already
// recorded, which is what makes "decklist overrules replay-card guesses,
// once a decklist shows up" durable rather than a race between whichever
// code path happens to run last.
//
// Once applied, the classification is propagated onto every replay this
// player has for this event code — via the SAME global, replayId-keyed
// override registry real manual corrections use (mergeGlobalOverride /
// applyGlobalOverrideToAllBatchCopies) — so it automatically takes effect
// everywhere overrides already do: profile matchup tables, GFWL
// Archive/History, Format Data, the events replays panel. No parallel
// "deck type" mechanism needed.
// 'profile' is the highest tier: a deck type already recorded on the
// player's OWN profile (db.players[x].eventDecklists[].deckTypeOverride —
// set there either by hand or via that profile's own reclassify button),
// synced into this event-bracket record by eventsRenderDeckCards above
// itself rather than independently re-derived here. Outranking 'decklist'
// means once a profile-side correction has been synced in, this event page
// re-opening and running its own classifyFromCards pass again can never
// silently revert it.
const DECK_TYPE_SOURCE_PRIORITY = { fl: 0, replay: 1, decklist: 2, profile: 3 };
async function upsertEventDeckType(code, builderName, deckTypeName, source) {
  const c = (code || '').toUpperCase().trim();
  const ev = db.events[c];
  if (!ev) return { ok: false, reason: 'no-event' };
  const deck = (ev.decks || []).find(d => (d.builderName || '').toLowerCase() === (builderName || '').toLowerCase());
  if (!deck) return { ok: false, reason: 'no-deck' };

  const curPriority = DECK_TYPE_SOURCE_PRIORITY[deck.deckTypeSource] ?? 0;
  const newPriority  = DECK_TYPE_SOURCE_PRIORITY[source] ?? 0;
  if (deck.deckTypeName && newPriority < curPriority) {
    return { ok: true, applied: false, reason: 'A higher-priority classification is already recorded.', current: deck.deckTypeName, currentSource: deck.deckTypeSource };
  }

  deck.deckTypeName = deckTypeName;
  deck.deckTypeSource = source;
  deck.updatedAt = Date.now();

  let propagated = 0;
  const touchedBatchIds = new Set();
  const playerEntry = findPlayerByBuilderName(builderName);
  if (playerEntry) {
    const names = playerNames(playerEntry);
    const batches = Object.values(db.batches).filter(b => names.includes((b.player || '').toLowerCase()));
    for (const b of batches) {
      for (const r of (b.replays || [])) {
        const evId = (r.eventLabel || '').toUpperCase().trim();
        if (evId !== c) continue;
        const oppName = r.oppName || (r.parsed && r.parsed.oppName) || null;
        const merged = mergeGlobalOverride(r.replayId, { myDeckOverride: deckTypeName }, b.player, oppName);
        if (merged) db.overrides[r.replayId] = merged; else delete db.overrides[r.replayId];
        applyGlobalOverrideToAllBatchCopies(r.replayId).forEach(id => touchedBatchIds.add(id));
        propagated++;
      }
    }
  }
  for (const bid of touchedBatchIds) {
    try { await saveBatchToPostgres(bid); } catch (e) { console.warn('[events] deck-type propagation save failed for batch', bid, ':', e.message); }
  }
  return { ok: true, applied: true, propagated, touchedBatchIds: [...touchedBatchIds] };
}

// Same as above but for every replayId that has a global override recorded
// — run once at startup (right after both db.batches and db.overrides have
// been loaded) so that a redeploy/restart immediately self-heals every
// batch's in-memory replay copies from whatever is durably recorded in the
// override registry, regardless of what (possibly stale) value was last
// written into that specific batch's own copy. This is the literal
// "replayIds that are given overridden instructions load the saved
// overridden result after it loads, silently" behavior that was asked for.
function applyAllGlobalOverridesAtStartup() {
  const replayIds = Object.keys(db.overrides || {});
  if (!replayIds.length) return 0;
  let touched = 0;
  for (const b of Object.values(db.batches)) {
    for (const r of (b.replays||[])) {
      if (db.overrides[r.replayId]) { applyGlobalOverrideToReplay(r, b.player || null); touched++; }
    }
  }
  return touched;
}

// Per-game card lists inside parsed.games ({gameNum, winner, first, mine,
// opp, mineRaw, oppRaw}) are relative to whichever player originally parsed
// the replay ("mine" = them, "opp" = their opponent). When a replay gets
// cross-linked and mirrored into the opponent's own batch, every OTHER field
// on the mirrored record (oppName, result, score, myW/oppW, myDeck/oppDeck,
// allMine/allOpp) is correctly swapped for the opponent's perspective — but
// `games` was being copied straight through unflipped, so a mirrored replay's
// G1/G2/G3 sections showed the ORIGINAL player's cards under "mine" instead
// of the mirrored player's own. This flips mine<->opp (and mineRaw<->oppRaw)
// per game while leaving gameNum/winner/first alone, since those are already
// absolute (a game number and real usernames, not "my side" vs "their side").
function flipGames(games) {
  if (!games) return games;
  return games.map(g => ({
    ...g,
    mine: g.opp || [],
    opp:  g.mine || [],
    mineRaw: g.oppRaw,
    oppRaw:  g.mineRaw,
  }));
}

// Flips a parsed match's BASE game data (games/cards/score/result) to the
// opponent's perspective — the same swap crossLinkReplay's first-time
// mirroring does below, pulled out standalone so Merge Replay propagation
// can re-apply it to an ALREADY cross-linked twin without redoing all of
// crossLinkReplay's first-time-link bookkeeping. Deliberately does NOT touch
// resultOverride/scoreOverride/overrideNote — the twin's own override, if it
// has one, is re-stamped on top afterward by reapplyOverridesToParsed(),
// same "each side's own override always wins" rule the override endpoint
// below already follows.
function flipParsedBaseForTwin(parsed, twinOppName) {
  if (!parsed) return null;
  const draws = Number(parsed.draws) || 0;
  const flippedMyW = parsed.oppW, flippedOppW = parsed.myW;
  return {
    oppName: twinOppName || parsed.oppName || null,
    myDeck:  parsed.oppDeck || 'Unknown',
    oppDeck: parsed.myDeck  || 'Unknown',
    games:   flipGames(parsed.games),
    allMine: parsed.allOpp || [],
    allOpp:  parsed.allMine || [],
    myW: flippedMyW, oppW: flippedOppW, draws,
    score: draws > 0 ? `${flippedMyW}-${flippedOppW}-${draws}` : `${flippedMyW}-${flippedOppW}`,
    result: flipResult(parsed.result),
  };
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
        // (their perspective: result/decks are mirrored from Player A's data).
        //
        // IMPORTANT: existing.* may already carry a manual override that was
        // set directly on B's own (still-timed-out) placeholder before A's
        // real data ever arrived — e.g. someone corrected the score or the
        // detected deck on B's copy while it was still pending. That
        // correction was made specifically for B's record and must WIN over
        // whatever comes mirrored from A, not get silently blanked out just
        // because A doesn't happen to have the same override. So every
        // override field here is "B's existing value first, A's mirrored
        // value only as a fallback" — never the reverse.
        const origParsed2 = replayData.parsed || null;
        const _resOvA   = replayData.resultOverride || (origParsed2 && origParsed2.resultOverride) || null;
        const _scoreOvA = replayData.scoreOverride  || (origParsed2 && origParsed2.scoreOverride)  || null;
        const finalResultOverride  = existing.resultOverride  || (_resOvA ? flipResult(_resOvA) : null);
        const finalScoreOverride   = existing.scoreOverride   || (_scoreOvA ? { my: _scoreOvA.opp, opp: _scoreOvA.my } : null);
        const finalMyDeckOverride  = existing.myDeckOverride  || (replayData.oppDeckOverride || null);
        const finalOppDeckOverride = existing.oppDeckOverride || (replayData.myDeckOverride  || null);
        const finalOverrideNote    = existing.overrideNote || replayData.overrideNote || (origParsed2 && origParsed2.overrideNote) || '';

        const effResultA = _resOvA || (origParsed2 && origParsed2.result);
        const effMyWA  = _scoreOvA ? _scoreOvA.my  : (origParsed2 && origParsed2.myW);
        const effOppWA = _scoreOvA ? _scoreOvA.opp : (origParsed2 && origParsed2.oppW);
        const mirrored2 = origParsed2 ? {
          oppName:  originalBatchPlayer || null,
          result:   finalResultOverride || flipResult(effResultA),
          score:    finalScoreOverride ? `${finalScoreOverride.my}-${finalScoreOverride.opp}` : (_scoreOvA ? `${effOppWA}-${effMyWA}` : (origParsed2.score ? origParsed2.score.split('-').reverse().join('-') : null)),
          myW: finalScoreOverride ? finalScoreOverride.my : effOppWA, oppW: finalScoreOverride ? finalScoreOverride.opp : effMyWA, draws: origParsed2.draws,
          myDeck:  finalMyDeckOverride  || origParsed2.oppDeck || 'Unknown',
          oppDeck: finalOppDeckOverride || origParsed2.myDeck  || 'Unknown',
          games: flipGames(origParsed2.games), allMine: origParsed2.allOpp||[], allOpp: origParsed2.allMine||[],
          resultOverride: finalResultOverride || null,
          scoreOverride:  finalScoreOverride  || null,
          overrideNote:   finalOverrideNote,
        } : null;
        Object.assign(existing, {
          plays: replayData.plays||[], parsed: mirrored2, timedOut: false,
          oppName: originalBatchPlayer || replayData.oppName || '',
          myDeckOverride: finalMyDeckOverride,
          oppDeckOverride: finalOppDeckOverride,
          eventLabel: existing.eventLabel || replayData.eventLabel || '',
          resultOverride: finalResultOverride,
          scoreOverride:  finalScoreOverride,
          overrideNote:   finalOverrideNote,
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
  // their perspective is the opponent's perspective from Player A's replay.
  // A manual result/score override on A's side is the source of truth for
  // the match outcome, so it must be baked into B's mirrored copy too —
  // otherwise cross-linking would silently resurrect the pre-override result.
  const origParsed = replayData.parsed || null;
  const _resOv   = replayData.resultOverride || (origParsed && origParsed.resultOverride) || null;
  const _scoreOv = replayData.scoreOverride  || (origParsed && origParsed.scoreOverride)  || null;
  const effResult = _resOv || (origParsed && origParsed.result);
  const effMyW  = _scoreOv ? _scoreOv.my  : (origParsed && origParsed.myW);
  const effOppW = _scoreOv ? _scoreOv.opp : (origParsed && origParsed.oppW);
  const mirroredParsed = origParsed ? {
    oppName:  origParsed.oppName ? originalBatchPlayer : null, // B's opponent is A
    result:   flipResult(effResult),
    score:    _scoreOv ? `${effOppW}-${effMyW}` : (origParsed.score ? origParsed.score.split('-').reverse().join('-') : null),
    myW:      effOppW, oppW: effMyW, draws: origParsed.draws,
    myDeck:   origParsed.oppDeck   || 'Unknown',
    oppDeck:  origParsed.myDeck    || 'Unknown',
    games:    flipGames(origParsed.games),
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
    // Mirror the override itself (flipped) onto B's own replay record —
    // keeps buildMatchRecord()'s "check replay.resultOverride first" logic
    // correct on B's side independently of the baked-in parsed values above.
    resultOverride: _resOv ? flipResult(_resOv) : null,
    scoreOverride:  _scoreOv ? { my: _scoreOv.opp, opp: _scoreOv.my } : null,
    overrideNote:   replayData.overrideNote || (origParsed && origParsed.overrideNote) || '',
    crossLinked: true,
    savedAt:     Date.now()
  });
  batch.status = 'ready';
  return { linked: true, duplicate: false, batchId: batch.id, player: opponentEntry.name };
}

// Tallies, for ONE stored replay copy, how many of its own parsed games its
// batch owner actually won/lost. g.winner is a literal username — either the
// player who was parsing at the time, or their opponent's name — and for a
// player with more than one known name (their DuelingBook account name vs a
// GFWL display name, or any other registered alias), that recorded winner
// name can legitimately be an ALIAS rather than their canonical batch.player
// string. The client's own parseMatch() already accounts for this via an
// alias-aware check when it derives the authoritative match result, so this
// needs the same alias set — found via findPlayerByUsername/playerNames,
// the exact same resolution crossLinkReplay etc. already use — plus the same
// substring/suffix fallback the client's matchesPlayerName() uses, so this
// never disagrees with what the client itself would compute.
function impliedGameRecord(games, batchPlayer) {
  const entry = findPlayerByUsername(batchPlayer) || { name: batchPlayer, aliases: [] };
  const names = new Set(playerNames(entry));
  let w = 0, l = 0;
  (games||[]).forEach(g => {
    if (!g.winner) return;
    const wl = g.winner.toLowerCase();
    let isMatch = names.has(wl);
    if (!isMatch) {
      for (const n of names) {
        if (n.length >= 4 && wl.length >= 4 &&
            (wl.startsWith(n+' ') || wl.startsWith(n+'_') || n.startsWith(wl+' ') || n.startsWith(wl+'_'))) {
          isMatch = true; break;
        }
      }
    }
    if (isMatch) w++; else l++;
  });
  return { w, l };
}

// Shared data-check computation — used by both GET /api/admin/data-check
// (read-only report) and POST /api/admin/data-check/autofix (the targeted
// fix) below, so both always agree on exactly which replays are missing a
// mirror. Groups every saved replay by replayId: a replayId appearing
// exactly twice is a correctly-mirrored match; appearing once is either
// auto-fixable (opponent name resolves to a known player who doesn't have
// it yet), a self-alias conflict (resolves right back to the SAME player —
// never auto-fixable, always a bad alias), or unrecognized (needs a human to
// archive/alias that player); appearing more than twice is a duplicate.
// missingMirrors entries carry _replay/_batchPlayer — references to the real
// in-memory objects, used ONLY by the autofix endpoint and stripped before
// anything is sent to the client.
//
// Separately (and independently of the mirror-pairing checks above),
// resultMismatches flags any single replay copy whose OFFICIAL recorded
// result (after any override) disagrees with what its own parsed per-game
// winners add up to — e.g. recorded as a win while the games show more
// losses than wins. This can legitimately happen (a forfeit/DQ ruling
// overriding what was actually played) or it can be a real mistake (a bad
// manual override, or stale data from before a correction) — there's no way
// to tell which from the data alone, so this is reported for a human to
// judge case by case and is never auto-fixed.
function computeDataCheck() {
  const byReplayId = {};
  const resultMismatches = [];
  const incompleteMatches = [];
  // Manually omitted (see the /override endpoint's `omitted` field — excluded
  // from Format Data entirely, permanently, until un-omitted) and overridden
  // (result/score corrected by a human, but still counted) replays. Neither
  // is an "error" — both are already-resolved/reviewed state — so they're
  // reported separately from the categories above rather than folded into
  // the issue count, purely so there's a place to see and undo them.
  const omittedMatches = [];
  const overriddenMatches = [];
  for (const batch of Object.values(db.batches)) {
    for (const r of (batch.replays||[])) {
      if (!byReplayId[r.replayId]) byReplayId[r.replayId] = [];
      byReplayId[r.replayId].push({
        batchId: batch.id,
        player: batch.player || '',
        oppName: r.oppName || (r.parsed && r.parsed.oppName) || '',
        isManual: !!r.isManual,
        eventLabel: r.eventLabel || '',
        result: r.resultOverride || (r.parsed && r.parsed.resultOverride) || (r.parsed && r.parsed.result) || r.result || '',
        score: r.scoreOverride ? `${r.scoreOverride.my}-${r.scoreOverride.opp}` : ((r.parsed && r.parsed.score) || ''),
        myDeck: r.myDeckOverride || (r.parsed && r.parsed.myDeck) || 'Unknown',
        oppDeck: r.oppDeckOverride || (r.parsed && r.parsed.oppDeck) || 'Unknown',
        savedAt: r.savedAt || null,
        _replay: r,
      });

      if (r.omitted) {
        omittedMatches.push({
          replayId: r.replayId, batchId: batch.id, player: batch.player || '',
          oppName: r.oppName || (r.parsed && r.parsed.oppName) || '',
          eventLabel: r.eventLabel || '',
          recordedResult: r.resultOverride || (r.parsed && r.parsed.resultOverride) || (r.parsed && r.parsed.result) || r.result || '',
          omittedNote: r.omittedNote || '',
          savedAt: r.savedAt || null,
        });
      }
      const hasAnyOverride = !!(r.resultOverride || (r.parsed && r.parsed.resultOverride) ||
        r.scoreOverride || (r.parsed && r.parsed.scoreOverride));
      if (hasAnyOverride && !r.isManual) {
        overriddenMatches.push({
          replayId: r.replayId, batchId: batch.id, player: batch.player || '',
          oppName: r.oppName || (r.parsed && r.parsed.oppName) || '',
          eventLabel: r.eventLabel || '',
          recordedResult: r.resultOverride || (r.parsed && r.parsed.resultOverride) || '',
          recordedScore: r.scoreOverride ? `${r.scoreOverride.my}-${r.scoreOverride.opp}` : '',
          overrideNote: r.overrideNote || (r.parsed && r.parsed.overrideNote) || '',
          savedAt: r.savedAt || null,
        });
      }

      if (!r.isManual) {
        const games = (r.parsed && r.parsed.games) || [];
        const implied = impliedGameRecord(games, batch.player);
        // A result or score override exists specifically to make the
        // OFFICIAL outcome disagree with what the raw parsed games show (a
        // forfeit/DQ ruling, a bad-alias reversal, etc.) — so an overridden
        // replay will almost always "mismatch" its own games by
        // construction, not by accident. That's not an error needing
        // review; a human already reviewed it and the override note is the
        // record of that decision. Flagging it here anyway just buries the
        // mismatches that ARE still unreviewed under ones already resolved,
        // so overridden replays are skipped entirely rather than tagged.
        const hasOverride = !!(r.resultOverride || (r.parsed && r.parsed.resultOverride) ||
          r.scoreOverride || (r.parsed && r.parsed.scoreOverride));
        // A manually-omitted replay is already resolved (it's excluded from
        // Format Data entirely and shown in its own Omitted Data section) —
        // flagging it here too would just make an already-handled match
        // keep showing up in the "needs human review" list forever.
        if (!hasOverride && !r.omitted && (implied.w || implied.l)) {
          const effResult = (r.parsed && r.parsed.result) || r.result || '';
          const impliedWin  = implied.w > implied.l;
          const impliedLoss = implied.l > implied.w;
          if ((effResult === 'w' && impliedLoss) || (effResult === 'l' && impliedWin)) {
            resultMismatches.push({
              replayId: r.replayId, batchId: batch.id, player: batch.player || '',
              oppName: r.oppName || (r.parsed && r.parsed.oppName) || '',
              eventLabel: r.eventLabel || '',
              recordedResult: effResult,
              recordedScore: (r.parsed && r.parsed.score) || '',
              impliedW: implied.w, impliedL: implied.l,
              crossLinked: !!r.crossLinked,
              savedAt: r.savedAt || null,
            });
          }
        }

        // A real match is only verified as actually decided once one side
        // has reached 2 game wins — best-of-3's normal finish line. A score
        // like 1-0, 0-1 or 1-1 (with no override saying it's final) means
        // the data stops short of that: could be a legitimate single-game
        // forfeit, or could just be a parsing gap where later games were
        // never recorded — there's no way to tell which from here. Counting
        // it as a full match feeds an unverified result into every stats
        // view (same reasoning as Format Data's own `incomplete` exclusion
        // in buildMatchRecord — this is the system-wide version of that).
        const hasResultOverride = !!(r.resultOverride || (r.parsed && r.parsed.resultOverride));
        // Same reasoning as resultMismatches above — an omitted replay is
        // already resolved, so it shouldn't also sit in this review queue.
        if (!hasResultOverride && !r.omitted) {
          const myW  = r.scoreOverride ? r.scoreOverride.my  : (r.parsed && typeof r.parsed.myW  === 'number' ? r.parsed.myW  : null);
          const oppW = r.scoreOverride ? r.scoreOverride.opp : (r.parsed && typeof r.parsed.oppW === 'number' ? r.parsed.oppW : null);
          const scoreIssue = (myW !== null && oppW !== null) ? bo3ScoreIssue(myW, oppW) : null;
          if (scoreIssue) {
            incompleteMatches.push({
              replayId: r.replayId, batchId: batch.id, player: batch.player || '',
              oppName: r.oppName || (r.parsed && r.parsed.oppName) || '',
              eventLabel: r.eventLabel || '',
              recordedResult: (r.parsed && r.parsed.result) || r.result || '',
              myW, oppW, reason: scoreIssue,
              savedAt: r.savedAt || null,
            });
          }
        }
      }
    }
  }
  const missingMirrors = [];
  const unrecognizedOpponents = [];
  const duplicates = [];
  const selfAliasConflicts = [];
  for (const [replayId, copies] of Object.entries(byReplayId)) {
    if (copies.length > 2) {
      duplicates.push({ replayId, copies: copies.map(c => ({
        player: c.player, batchId: c.batchId, oppName: c.oppName, eventLabel: c.eventLabel,
        isManual: c.isManual, result: c.result, score: c.score, myDeck: c.myDeck, oppDeck: c.oppDeck, savedAt: c.savedAt,
      })) });
      continue;
    }
    if (copies.length === 2) continue; // correctly mirrored — one row per side, counts will match
    const only = copies[0];
    if (!only.oppName) {
      unrecognizedOpponents.push({ replayId, player: only.player, oppName: '(none recorded)', batchId: only.batchId, eventLabel: only.eventLabel, isManual: only.isManual, reason: 'No opponent name recorded on this replay' });
      continue;
    }
    const resolved = findPlayerByUsername(only.oppName);
    if (!resolved) {
      unrecognizedOpponents.push({ replayId, player: only.player, oppName: only.oppName, batchId: only.batchId, eventLabel: only.eventLabel, isManual: only.isManual, reason: 'Opponent name matches no known player or alias' });
      continue;
    }
    // The resolved opponent IS this same player — almost always a bad alias
    // (someone else's name, or a garbage/placeholder string, got attached to
    // this player's own profile). Linking a replay to its own owner is
    // meaningless and crossLinkReplay correctly refuses it, so this can
    // never be auto-fixed by mirroring — it needs a human to fix the alias.
    if (resolved.name.toLowerCase() === only.player.toLowerCase()) {
      selfAliasConflicts.push({ replayId, player: only.player, oppName: only.oppName, batchId: only.batchId, eventLabel: only.eventLabel, isManual: only.isManual,
        reason: `"${only.oppName}" is recorded as an alias of ${resolved.name} — but that's this same player, so it can't be their own opponent. Check ${resolved.name}'s aliases on the Profiles tab.` });
      continue;
    }
    missingMirrors.push({ replayId, player: only.player, oppName: only.oppName, resolvedOpponent: resolved.name, batchId: only.batchId, eventLabel: only.eventLabel, isManual: only.isManual, _replay: only._replay, _batchPlayer: only.player });
  }
  return { byReplayId, missingMirrors, unrecognizedOpponents, duplicates, selfAliasConflicts, resultMismatches, incompleteMatches, omittedMatches, overriddenMatches };
}

// In-memory store for the Live Tracker relay — see the route handler below
// for why this deliberately isn't part of the persisted `db`.
const liveSessions = new Map(); // code -> { data, updatedAt, pendingSide?: { main, setAt } }
const LIVE_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6h, plenty for one sitting
const LIVE_CODE_RE = /^[A-Z0-9]{6,12}$/;
setInterval(() => {
  const now = Date.now();
  for (const [code, sess] of liveSessions) {
    if (now - sess.updatedAt > LIVE_SESSION_TTL_MS) liveSessions.delete(code);
  }
}, 30 * 60 * 1000).unref();

// ── Wilson CI formula self-check ──────────────────────────────────────────
// Format Data's confidence-interval column is computed entirely client-side
// (wilsonCI() in public/index.html) — there's no server-side copy of that
// math today, so nothing would ever notice if a future edit quietly changed
// the z-constant, flipped a +/- sign, or otherwise broke the formula; the
// numbers would just look "a little off" with no error anywhere. Rather
// than keep a second, parallel implementation here (which could itself
// drift out of sync with the real one and give false confidence), this
// pulls the ACTUAL wilsonCI() function straight out of the live
// public/index.html file, runs it, and checks the result against a small
// set of (wins, n) cases that were hand-verified against the standard
// Wilson score interval formula (z=1.96, 95%) — see the chat/commit history
// for the by-hand derivation of each expected value.
function extractClientFunctionSource(fnName) {
  let html;
  try { html = fs.readFileSync(path.join(PUB_DIR, 'index.html'), 'utf8'); }
  catch(e) { return null; }
  const marker = 'function ' + fnName + '(';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  let i = html.indexOf('{', start);
  if (i === -1) return null;
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}
function verifyWilsonCI() {
  const src = extractClientFunctionSource('wilsonCI');
  if (!src) return { ok: false, error: 'Could not find wilsonCI() in public/index.html — has it been renamed, moved, or removed?' };
  let fn;
  try { fn = new Function('return (' + src + ')')(); }
  catch(e) { return { ok: false, error: 'wilsonCI() in public/index.html no longer parses as valid JS: ' + e.message, source: src }; }
  const cases = [
    { wins: 60, n: 122, expect: { low: 40, high: 58  } }, // from the actual Chaos Turbo vs Warrior row this check was built to catch
    { wins: 0,  n: 0,   expect: { low: 0,  high: 0   } }, // no data at all
    { wins: 5,  n: 5,   expect: { low: 57, high: 100 } }, // small sample, perfect record
    { wins: 0,  n: 3,   expect: { low: 0,  high: 56  } }, // small sample, zero wins
  ];
  const mismatches = [];
  for (const c of cases) {
    let actual;
    try { actual = fn(c.wins, c.n); }
    catch(e) { mismatches.push({ wins: c.wins, n: c.n, expect: c.expect, error: e.message }); continue; }
    if (!actual || actual.low !== c.expect.low || actual.high !== c.expect.high) {
      mismatches.push({ wins: c.wins, n: c.n, expect: c.expect, actual: actual || null });
    }
  }
  return { ok: mismatches.length === 0, checked: cases.length, mismatches };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.req = req; // lets json()/static serving check this request's Accept-Encoding
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
    const sendFile = (data, contentType) => {
      // This app ships as one unversioned index.html — there's no
      // cache-busted filename (no index.abc123.html / ?v=...), so a browser
      // has no way to tell a new deploy's HTML/JS apart from an old cached
      // one except by actually asking again. Without an explicit no-store
      // here, there was NOTHING stopping a browser (or anything sitting in
      // front of this server) from serving this page out of its cache on an
      // ordinary refresh — which, if it happened, meant every client-side
      // fix in this file could be redeployed correctly and still never
      // actually run in that browser, because the browser kept re-running
      // the OLD index.html it already had instead of fetching the new one.
      // That failure mode is invisible from the server's side: the server
      // never even sees the request, so none of the server-side logging or
      // behavior changes would show anything wrong either. This header
      // removes that possibility for the page itself, the same way the API
      // responses in json() above were already hardened against it.
      const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' };
      // index.html alone is ~900KB of HTML/JS served fresh on every visit —
      // gzip shrinks text like this by 70%+, which is most of what made
      // the page feel slow to even start loading right after sign-in.
      if (data.length > 800 && acceptsGzip(res)) {
        zlib.gzip(data, (err, compressed) => {
          if (err) { res.writeHead(200, headers); res.end(data); return; }
          res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
          res.end(compressed);
        });
      } else {
        res.writeHead(200, headers);
        res.end(data);
      }
    };
    try {
      const data = fs.readFileSync(filePath);
      const ext  = path.extname(filePath);
      sendFile(data, MIME[ext] || 'application/octet-stream');
    } catch(e) {
      try {
        const data = fs.readFileSync(path.join(PUB_DIR, 'index.html'));
        sendFile(data, 'text/html');
      } catch(e2) { res.writeHead(404); res.end('Not found'); }
    }
    return;
  }


  // ── LIVE TRACKER RELAY ────────────────────────────────────────────────────
  // Lets the DuelingBook Tampermonkey tracker (dt-live-tracker.user.js) push a
  // snapshot of the CURRENT match to a short-lived, per-code slot that the
  // website's My Tracker / Opp Tracker tabs poll — this is what "Live Sync"
  // means on those tabs. Deliberately kept in memory only, not persisted to
  // db.json/Postgres: a live match snapshot is throwaway state, not archival
  // data, so a dyno restart just drops in-progress sync — the tracker keeps
  // pushing every few seconds and refills it on its own, no migration needed.
  if (parts[0] === 'live' && parts[1] && !parts[2] && method === 'POST') {
    const code = parts[1].toUpperCase();
    if (!LIVE_CODE_RE.test(code)) return json(res, 400, { error: 'Invalid pairing code' });
    readBody(req, (data) => {
      const existing = liveSessions.get(code);
      liveSessions.set(code, { data, updatedAt: Date.now(), pendingSide: existing && existing.pendingSide });
      json(res, 200, { ok: true });
    });
    return;
  }
  if (parts[0] === 'live' && parts[1] && !parts[2] && method === 'GET') {
    const code = parts[1].toUpperCase();
    const sess = liveSessions.get(code);
    if (!sess) return json(res, 404, { error: 'No live session for this code yet — start the tracker on DuelingBook first' });
    json(res, 200, { data: sess.data, updatedAt: sess.updatedAt });
    return;
  }

  // ── Side Practice → Live Tracker siding sync ──────────────────────────────
  // A one-shot slot, separate from the main tracker->site snapshot above and
  // flowing the opposite direction (site->tracker): the website's Side
  // Practice tab POSTs the post-side main-deck composition here once, the
  // Tampermonkey tracker polls GET and applies it as soon as it sees it, then
  // DELETEs it so it isn't re-applied to a later game. Kept on the same
  // in-memory liveSessions entry as the regular snapshot (created if it
  // doesn't exist yet) rather than a separate map, since it's scoped to the
  // exact same pairing code and TTL sweep.
  if (parts[0] === 'live' && parts[1] && parts[2] === 'side' && method === 'POST') {
    const code = parts[1].toUpperCase();
    if (!LIVE_CODE_RE.test(code)) return json(res, 400, { error: 'Invalid pairing code' });
    readBody(req, (body) => {
      let sess = liveSessions.get(code);
      if (!sess) { sess = { data: {}, updatedAt: Date.now() }; liveSessions.set(code, sess); }
      sess.pendingSide = { main: (body && body.main) || [], setAt: Date.now() };
      json(res, 200, { ok: true });
    });
    return;
  }
  if (parts[0] === 'live' && parts[1] && parts[2] === 'side' && method === 'GET') {
    const code = parts[1].toUpperCase();
    const sess = liveSessions.get(code);
    if (!sess || !sess.pendingSide) return json(res, 404, { error: 'No pending side-deck update for this code' });
    json(res, 200, sess.pendingSide);
    return;
  }
  if (parts[0] === 'live' && parts[1] && parts[2] === 'side' && method === 'DELETE') {
    const code = parts[1].toUpperCase();
    const sess = liveSessions.get(code);
    if (sess) delete sess.pendingSide;
    json(res, 200, { ok: true });
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

  // ── GET /api/admin/data-check — read-only integrity scan across EVERY
  // saved batch system-wide (not scoped to one GFWL season like
  // GET /api/gfwl/:season/data-health above). This is what makes Format
  // Data's matchup table go asymmetric — e.g. Chaos Turbo reports 131
  // matches vs Warrior, but Warrior only reports 122 vs Chaos Turbo —
  // because buildGlobalRecordsFromBatches (client) builds one record per
  // (batch, replay) pair, so a real match is only counted from BOTH
  // decks' perspectives when its replayId exists as a mirrored copy in
  // BOTH players' batches. A replay that only exists in one batch still
  // counts toward its owner's N but has nothing to count toward the
  // opponent's, which is exactly where the two sides stop matching up.
  // For every replayId found on exactly one side, this reports whether
  // the recorded opponent name resolves to a known player/alias (so
  // POST /api/crosslink/scan above can auto-fix it by mirroring the
  // replay into their batch) or doesn't match anyone on file at all (so
  // it needs a human — usually linking an alias on the Profiles tab
  // first). Also flags a replayId showing up more than twice anywhere,
  // which is never legitimate and would inflate N beyond what either
  // side's own matches justify.
  if (parts[0]==='admin' && parts[1]==='data-check' && method==='GET') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const dc = computeDataCheck();
    const uniqueReplayIds = Object.keys(dc.byReplayId).length;
    const stripMirrors = dc.missingMirrors.map(({_replay, _batchPlayer, ...rest}) => rest);
    return json(res, 200, {
      uniqueReplayIds,
      totalReplayRecords: Object.values(dc.byReplayId).reduce((s,c)=>s+c.length, 0),
      mirroredOk: uniqueReplayIds - dc.missingMirrors.length - dc.unrecognizedOpponents.length - dc.duplicates.length - dc.selfAliasConflicts.length,
      missingMirrors: stripMirrors,
      unrecognizedOpponents: dc.unrecognizedOpponents,
      duplicates: dc.duplicates,
      selfAliasConflicts: dc.selfAliasConflicts,
      resultMismatches: dc.resultMismatches,
      incompleteMatches: dc.incompleteMatches,
      omittedMatches: dc.omittedMatches,
      overriddenMatches: dc.overriddenMatches,
      ciCheck: verifyWilsonCI(),
    });
  }

  // ── POST /api/admin/data-check/autofix — targeted, authoritative fix for
  // exactly the replays GET /api/admin/data-check reports as missingMirrors.
  // POST /api/crosslink/scan does a blanket pass over every saved replay and
  // skips anything already flagged crossLinked:true (normally correct — it's
  // what keeps a mirror from chaining off itself). But that means a replay
  // whose crossLinked flag ended up true on the ORIGINAL side instead of just
  // the mirror (bad data from an earlier bug, a merge, etc.) gets skipped by
  // that scan forever, even though data-check's replayId grouping proves it
  // genuinely has no mirror anywhere. This recomputes that same authoritative
  // list and calls crossLinkReplay directly on each one, bypassing the flag —
  // safe specifically because the grouping already proved there's nothing to
  // collide with. Self-alias conflicts (see computeDataCheck) are excluded —
  // those can never be fixed by mirroring, only by fixing the alias itself.
  if (parts[0]==='admin' && parts[1]==='data-check' && parts[2]==='autofix' && method==='POST') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const dc = computeDataCheck();
    let linked = 0, skipped = 0, errors = 0;
    const batchIds = new Set();
    const details = [];
    for (const m of dc.missingMirrors) {
      try {
        const cl = crossLinkReplay(m._replay, m.oppName, m._batchPlayer);
        if (cl && cl.linked) {
          linked++;
          batchIds.add(cl.batchId);
          details.push({ replayId: m.replayId, player: m.player, oppName: m.oppName, status: cl.upgraded ? 'upgraded' : 'linked' });
        } else {
          skipped++;
          details.push({ replayId: m.replayId, player: m.player, oppName: m.oppName, status: (cl && cl.duplicate) ? 'duplicate' : 'refused',
            reason: (cl && cl.duplicate) ? 'Opponent already has real data for this replay' : 'Resolved opponent conflicts with the original player (self/alias match)' });
        }
      } catch(e) {
        errors++;
        details.push({ replayId: m.replayId, player: m.player, oppName: m.oppName, status: 'error', reason: e.message });
        console.error('[data-check/autofix] Error on', m.replayId, e.message);
      }
    }
    for (const bid of batchIds) {
      await saveBatchToPostgres(bid).catch(e => console.error('[data-check/autofix] save error:', e.message));
    }
    console.log('[data-check/autofix] Done:', linked, 'linked,', skipped, 'skipped,', errors, 'errors');
    return json(res, 200, { ok: true, linked, skipped, errors, batchesUpdated: batchIds.size, details });
  }

  // ── GET /api/admin/registry-check — read-only report flagging db.players
  // registry entries that are likely mess: either orphaned (no batch backs
  // them at all — a leftover from a profile that was deleted, or a stub that
  // never got a real batch) or near-duplicates of another entry's name (an
  // Alex Zander / Alez Zander typo-twin that was never merged, or whose
  // registry rows a merge happened to miss before mergeBatchesInternal
  // started reconciling db.players — see that function's comment). This is
  // deliberately report-only: unlike data-check/autofix, there's no safe
  // automatic action here (deleting a registry row is destructive, and a
  // "near-duplicate" by name alone could just be two genuinely different
  // people), so this just surfaces candidates for an admin to review and
  // merge (via the existing Merge Profile tool) or delete by hand.
  if (parts[0]==='admin' && parts[1]==='registry-check' && method==='GET') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const batchNamesLower = new Set();
    for (const b of Object.values(db.batches)) {
      const bn = (b.player||'').toLowerCase().trim();
      if (bn) batchNamesLower.add(bn);
      for (const a of (b.aliases||[])) { const al = (a||'').toLowerCase().trim(); if (al) batchNamesLower.add(al); }
    }
    const entries = Object.entries(db.players); // [key, entry][]
    const orphaned = [];
    for (const [key, entry] of entries) {
      const names = playerNames(entry);
      if (!names.some(n => batchNamesLower.has(n))) {
        orphaned.push({ key, name: entry.name, aliases: entry.aliases||[] });
      }
    }
    const nearDuplicates = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [keyA, entryA] = entries[i], [keyB, entryB] = entries[j];
        const d = levenshteinDistance(entryA.name.toLowerCase(), entryB.name.toLowerCase());
        // Short threshold (<=2 edits) and skip exact equality (that's a key
        // collision, not possible here anyway since db.players is keyed by
        // lowercased name) — tuned to catch typo-twins like "Alex Zander" /
        // "Alez Zander" (distance 1) without flooding the report with
        // genuinely different short names.
        if (d > 0 && d <= 2 && entryA.name.length > 3) {
          nearDuplicates.push({ a: { key: keyA, name: entryA.name }, b: { key: keyB, name: entryB.name }, distance: d });
        }
      }
    }
    return json(res, 200, { ok: true, totalPlayers: entries.length, orphaned, nearDuplicates });
  }

  // ── POST /api/crosslink/repair-games — fix already-mirrored replays whose
  // parsed.games was copied unflipped (a bug fixed in crossLinkReplay/flipGames
  // above: every OTHER field on a mirrored record was correctly swapped for
  // the mirrored player's perspective, but games[].mine/opp were not, so a
  // pre-existing cross-linked replay's G1/G2/G3 sections could show the
  // original player's cards instead of the mirrored player's own). For every
  // replay flagged crossLinked, finds the original (non-crosslinked) replay
  // with the same replayId in another batch and re-derives games from it via
  // flipGames — a one-time repair pass for records saved before the fix,
  // safe to run repeatedly (a replay whose games already match the flipped
  // original is simply left alone).
  if (parts[0]==='crosslink' && parts[1]==='repair-games' && method==='POST') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    let repaired = 0, checked = 0, noOriginal = 0, errors = 0;
    const batchIds = new Set();

    // Index every non-crosslinked replay by replayId so mirrored copies can
    // find their original in one pass instead of re-scanning all batches
    // per replay.
    const originalsById = new Map();
    for (const batch of Object.values(db.batches)) {
      for (const replay of (batch.replays||[])) {
        if (!replay.crossLinked && replay.replayId) originalsById.set(replay.replayId, replay);
      }
    }

    for (const batch of Object.values(db.batches)) {
      for (const replay of (batch.replays||[])) {
        if (!replay.crossLinked || !replay.parsed) continue;
        checked++;
        try {
          const original = originalsById.get(replay.replayId);
          if (!original || !original.parsed || !original.parsed.games) { noOriginal++; continue; }
          const correctGames = flipGames(original.parsed.games);
          if (JSON.stringify(correctGames) === JSON.stringify(replay.parsed.games)) continue; // already correct
          replay.parsed.games = correctGames;
          batchIds.add(batch.id);
          repaired++;
        } catch(e) {
          console.error('[crosslink/repair-games] Error on', replay.replayId, e.message);
          errors++;
        }
      }
    }

    for (const bid of batchIds) {
      await saveBatchToPostgres(bid).catch(e => console.error('[crosslink/repair-games] save error:', e.message));
    }

    console.log('[crosslink/repair-games] Done:', repaired, 'repaired,', checked, 'checked,', noOriginal, 'no original found,', errors, 'errors');
    return json(res, 200, { ok: true, repaired, checked, noOriginal, errors, batchesUpdated: batchIds.size });
  }

  // ── GET /api/changelog — admin audit log (the "Edit Log" tab) ──────────────
  // Defaults to the last 7 days — "the last actions for a week, for
  // everyone" — same window pruneChangeLog() trims storage to, so what's
  // shown here and what's actually retained never disagree. `days` widens
  // or narrows that window (e.g. ?days=1 for just today); since storage
  // itself is pruned to 7 days on every new log entry, asking for more than
  // that only finds more if the log has been completely quiet since.
  // Optional filters — player (matches batchPlayer, case-insensitive
  // substring), action (exact match, e.g. 'set_override'), user (matches the
  // acting user's name/email, case-insensitive substring) — let admins
  // narrow down "what has this person been doing" or "what happened to this
  // player's data" without scrolling the whole log client-side.
  if (parts[0]==='changelog' && method==='GET') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const limit = Math.min(parseInt(url.searchParams.get('limit')||'500'), 5000);
    const days  = Math.max(parseFloat(url.searchParams.get('days')||'7'), 0.01);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const playerFilter = (url.searchParams.get('player')||'').toLowerCase().trim();
    const actionFilter = (url.searchParams.get('action')||'').trim();
    const userFilter   = (url.searchParams.get('user')||'').toLowerCase().trim();
    let log = (db._changeLog||[]).filter(l => l.t >= cutoff).reverse();
    if (playerFilter) log = log.filter(l => (l.batchPlayer||'').toLowerCase().includes(playerFilter));
    if (actionFilter) log = log.filter(l => l.action === actionFilter);
    if (userFilter)   log = log.filter(l => (l.user||'').toLowerCase().includes(userFilter));
    return json(res, 200, { log: log.slice(0, limit), total: log.length });
  }

  // ── DELETE /api/changelog/revert/:replayId — admin revert ─────────────────
  // Wholesale undo: removes this replay entirely from every batch that holds
  // a copy of it (the original, any cross-linked twin, any duplicate scrape)
  // and clears its global override record, if any — for when a replay was
  // imported by mistake (wrong player, test data, a duplicate that slipped
  // past dedup) and needs to disappear everywhere, not just from one batch.
  // Was gated on isHeadAdmin(), a role that no longer exists (always returns
  // false — see its definition) and so was permanently unreachable; opened
  // up to any admin, same as the rest of this file's admin-only actions.
  if (parts[0]==='changelog' && parts[1]==='revert' && parts[2] && method==='DELETE') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const replayId = decodeURIComponent(parts[2]);
    let reverted = 0;
    const revertFailures = [];
    for (const batch of Object.values(db.batches)) {
      const before = (batch.replays||[]).length;
      batch.replays = (batch.replays||[]).filter(r => r.replayId !== replayId);
      if (batch.replays.length < before) {
        // A revert is a deliberate, infrequent action an admin explicitly
        // chose — same reasoning as overrides/merges elsewhere in this file:
        // it must be CONFIRMED durably saved via the synchronous flush, not
        // the normal debounced saveBatchToPostgres() (schedules a write
        // ~1.5s out and returns immediately). GET /api/batches/:id re-reads
        // straight from Postgres before responding — if the debounced write
        // hadn't landed yet, that fresh read would restore the batch's OLD
        // (pre-revert) row from Postgres, undoing the in-memory removal this
        // very endpoint just made.
        const flushRes = await flushBatchNow(batch.id);
        if (!flushRes.ok) { revertFailures.push({ batchId: batch.id, error: flushRes.error }); console.error(`[revert] FAILED to durably save batch ${batch.id}:`, flushRes.error); }
        reverted++;
      }
    }
    if (reverted === 0) return json(res, 404, { error: 'This replay was not found in any saved batch — nothing to revert.' });
    if (revertFailures.length) {
      return json(res, 500, { ok:false, error: 'Revert was applied in memory but FAILED TO DURABLY SAVE for ' + revertFailures.length + ' batch(es): ' + revertFailures.map(f=>f.error).join('; '), reverted });
    }
    // Clear any global override recorded for this replay — it would
    // otherwise sit as an orphaned record for a replay that no longer
    // exists anywhere (harmless, since applyGlobalOverrideToReplay is a
    // no-op without a matching replay to apply it to, but there's no
    // reason to keep it around).
    if (db.overrides[replayId]) {
      delete db.overrides[replayId];
      await saveDB('overrides');
    }
    // Drop this replay's prior history from the log (the add/override/merge
    // entries that are no longer meaningful once it's gone), then record the
    // revert itself as a fresh entry — logChange() is called AFTER this
    // filter so its own entry isn't immediately wiped by it.
    db._changeLog = (db._changeLog||[]).filter(l => l.replayId !== replayId);
    console.log('[Admin] Reverted replay', replayId, 'from', reverted, 'batch(es)');
    logChange(req, 'revert_replay', { replayId, revertedFromBatches: reverted });
    return json(res, 200, { ok: true, reverted });
  }

  // ── POST /api/save — manual save all data to Postgres immediately ────────────
  if (parts[0]==='save' && method==='POST') {
    try {
      const batchResult = await saveAllBatchesToPostgres(true); // force full save on manual
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
      try {
      const email = (data.email||'').toLowerCase().trim();
      const pw    = (data.password||'').trim();
      if (!email || !pw) return json(res, 400, { error: 'Email and password required' });
      const user = Object.values(db.users).find(u => u.email === email);
      if (!user || user.password !== hashPassword(pw)) return json(res, 401, { error: 'Invalid email or password' });
      if (!user.approved) return json(res, 403, { error: 'Account pending approval. Contact the admin.' });
      const sessionId = crypto.randomUUID();
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
      const ua = (req.headers['user-agent']||'').slice(0,120);
      const prevSession = user.activeSessionId;
      user.activeSessionId = sessionId;
      if (!user.sessionLog) user.sessionLog = [];
      user.sessionLog.push({ sessionId, ip, ua, loginAt: Date.now(), active: true });
      if (user.sessionLog.length > 20) user.sessionLog = user.sessionLog.slice(-20);
      if (prevSession) {
        const prev = user.sessionLog.find(s => s.sessionId === prevSession);
        if (prev) { prev.active = false; prev.kickedAt = Date.now(); }
      }
      saveDB('users').catch(e => console.error('[Auth] Session save error:', e.message));
      const token = makeToken(user.id, sessionId);
      console.log('[Auth] Login:', user.email, '('+user.role+')', 'from', ip);
      return json(res, 200, { token, role: user.role, email: user.email, name: user.name||email.split('@')[0] });
      } catch(e) {
        console.error('[Auth] Login error:', e.message, e.stack);
        return json(res, 500, { error: 'Login error: ' + e.message });
      }
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
    if (!isAdmin(req)) return json(res, 403, { error: 'Admin only' });
    const users = Object.values(db.users).map(u => ({ id:u.id, email:u.email, name:u.name||'', role:u.role, approved:u.approved, createdAt:u.createdAt }));
    return json(res, 200, users);
  }

  // ── Admin: POST /api/admin/users ────────────────────────────────────────────
  if (parts[0]==='admin' && parts[1]==='users' && method==='POST') {
    const user = getUser(req);
    if (!isAdmin(req)) return json(res, 403, { error: 'Admin only' });
    return readBody(req, async data => {
      const email = (data.email||'').toLowerCase().trim();
      const pw    = (data.password||'ilovesui').trim();
      const role  = ['admin','miner','user','limited'].includes(data.role) ? data.role : 'user';
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
    if (!isAdmin(req)) return json(res, 403, { error: 'Admin only' });
    return readBody(req, async data => {
      const u = db.users[parts[2]];
      if (!u) return json(res, 404, { error: 'Not found' });
      if (data.approved  !== undefined) u.approved = !!data.approved;
      if (data.role !== undefined) u.role = ['admin','miner','user','limited'].includes(data.role) ? data.role : 'user';
      if (data.password  !== undefined) u.password = hashPassword(data.password);
      if (data.name      !== undefined) u.name = data.name;
      await saveDB();
      return json(res, 200, { ok: true });
    });
  }

  // ── Admin: DELETE /api/admin/users/:id ─────────────────────────────────────
  if (parts[0]==='admin' && parts[1]==='users' && parts[2] && method==='DELETE') {
    const user = getUser(req);
    if (!isAdmin(req)) return json(res, 403, { error: 'Admin only' });
    if (!db.users[parts[2]]) return json(res, 404, { error: 'Not found' });
    delete db.users[parts[2]];
    await saveDB();
    return json(res, 200, { ok: true });
  }

  // ── Admin: POST /api/admin/cleanup ──────────────────────────────────────────
  if (parts[0]==='admin' && parts[1]==='cleanup' && method==='POST') {
    const user = getUser(req);
    if (!isAdmin(req)) return json(res, 403, { error: 'Admin only' });
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
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view player profiles' });
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
      if (data.eventDecklists !== undefined) {
        logDecklistDiff(req, p.eventDecklists || [], data.eventDecklists || [], { batchPlayer: p.name });
        p.eventDecklists = data.eventDecklists;
      }
      if (data.tags       !== undefined) p.tags       = data.tags;
      if (data.aliases !== undefined || data.topPlayer !== undefined || data.gfwlTeams !== undefined || data.tags !== undefined) {
        logChange(req, 'edit_player', { batchPlayer: p.name, aliases: p.aliases, topPlayer: p.topPlayer, gfwlTeams: p.gfwlTeams });
      }
      await saveDB('players'); // explicit key — bare saveDB() can silently skip 'players'
                                 // once it's fallen out of the dirty-key tracking set
      return json(res, 200, p);
    });
  }
  // ── DELETE /api/players/:name — admin-only, permanently removes a player's
  // own registry entry AND every batch/replay filed under their name or any
  // alias. Deliberately "one sided": unlike overrides/omits/merges, this
  // never propagates to anyone else — it does NOT touch another player's own
  // cross-linked copy of a shared match, only this player's own side.
  if (parts[0]==='players' && parts[1] && !parts[2] && method==='DELETE') {
    if (!isAdmin(req)) return json(res, 403, { error: 'Admins only' });
    const rawName = decodeURIComponent(parts[1]);
    const key = rawName.toLowerCase();
    const entry = db.players[key] || findPlayerByUsername(rawName);
    // Alias set this delete matches against — registry aliases plus any
    // batch-level aliases recorded under the same name (a batch can carry
    // its own .aliases even without a registry entry — see
    // findPlayerByUsername above).
    const aliasSet = new Set([key]);
    if (entry) playerNames(entry).forEach(n => aliasSet.add(n));
    for (const b of Object.values(db.batches)) {
      const bKey = (b.player||'').toLowerCase();
      if (bKey && aliasSet.has(bKey)) (b.aliases||[]).forEach(a => aliasSet.add((a||'').toLowerCase()));
    }
    const toDelete = Object.values(db.batches).filter(b => aliasSet.has((b.player||'').toLowerCase()));
    if (!entry && !toDelete.length) return json(res, 404, { error: 'No profile or batches found for that name' });
    let deletedReplays = 0;
    for (const b of toDelete) deletedReplays += (b.replays||[]).length;
    logChange(req, 'delete_profile', {
      batchPlayer: entry ? entry.name : rawName,
      deletedBatches: toDelete.length,
      deletedReplays,
    });
    for (const b of toDelete) {
      delete db.batches[b.id];
      await deleteBatchFromPostgres(b.id);
    }
    if (entry) {
      // entry may be keyed under a different lowercased key than `key` if it
      // was resolved via findPlayerByUsername's alias fallback rather than a
      // direct hit on db.players[key].
      const entryKey = Object.keys(db.players).find(k => db.players[k] === entry);
      if (entryKey) delete db.players[entryKey];
    }
    await saveDB('players');
    return json(res, 200, { ok:true, deletedBatches: toDelete.length, deletedReplays });
  }

  // ── GET /api/scout/:name — pre-match opponent scouting report ──────────────
  // Aggregates a player's known match history into deck usage % and win %
  // per deck, so pairing against someone shows what they're likely to bring
  // before the duel even starts. Two sources, deduped by replayId so a
  // crosslinked replay is never double-counted:
  //   1. The player's own batch(es) — already in their own perspective, and
  //      already includes matches OTHER people uploaded against them, since
  //      crossLinkReplay() mirrors those in automatically the moment both
  //      sides are known players (see crossLinkReplay above).
  //   2. A fallback scan of every other batch's replays where this name
  //      shows up as oppName — covers anyone never auto-recognized (no
  //      registered profile, so nothing was ever crosslinked for them),
  //      with myDeck/oppDeck/result flipped to their perspective the same
  //      way crossLinkReplay() does it.
  if (parts[0]==='scout' && parts[1] && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot scout opponents' });
    const targetRaw = decodeURIComponent(parts[1]).trim();
    if (!targetRaw) return json(res, 400, { error: 'Name required' });

    const entry = findPlayerByUsername(targetRaw);
    const seen = new Set();   // replayId -> already counted
    const decks = {};         // deck name -> { count, w, l, d }

    const bump = (deckName, effResult) => {
      const deck = deckName || 'Unknown';
      if (!decks[deck]) decks[deck] = { count: 0, w: 0, l: 0, d: 0 };
      decks[deck].count++;
      if (effResult === 'w') decks[deck].w++;
      else if (effResult === 'l') decks[deck].l++;
      else if (effResult === 'd') decks[deck].d++;
    };

    if (entry) {
      const ownBatches = Object.values(db.batches).filter(b =>
        b.player && playerNames(entry).includes(b.player.toLowerCase())
      );
      for (const batch of ownBatches) {
        for (const r of (batch.replays||[])) {
          if (seen.has(r.replayId)) continue;
          seen.add(r.replayId);
          const deck = r.myDeckOverride || (r.parsed && r.parsed.myDeck) || 'Unknown';
          const effResult = r.resultOverride || (r.parsed && r.parsed.resultOverride) || (r.parsed && r.parsed.result) || r.result || null;
          bump(deck, effResult);
        }
      }
    }

    const aliasSet = new Set([targetRaw.toLowerCase(), ...(entry ? playerNames(entry) : [])]);
    for (const batch of Object.values(db.batches)) {
      for (const r of (batch.replays||[])) {
        if (seen.has(r.replayId)) continue;
        const oppName = (r.oppName || (r.parsed && r.parsed.oppName) || '').toLowerCase();
        if (!oppName || !aliasSet.has(oppName)) continue;
        seen.add(r.replayId);
        const deck = r.oppDeckOverride || (r.parsed && r.parsed.oppDeck) || 'Unknown';
        const rawResult = r.resultOverride || (r.parsed && r.parsed.resultOverride) || (r.parsed && r.parsed.result) || r.result || null;
        bump(deck, flipResult(rawResult));
      }
    }

    const totalMatches = seen.size;
    const deckList = Object.entries(decks).map(([deck, s]) => {
      const decided = s.w + s.l; // draws excluded from the win% denominator
      return {
        deck, count: s.count, wins: s.w, losses: s.l, draws: s.d,
        usagePct: totalMatches ? Math.round((s.count/totalMatches)*1000)/10 : 0,
        winPct: decided ? Math.round((s.w/decided)*1000)/10 : null,
      };
    }).sort((a,b) => b.count - a.count);

    return json(res, 200, {
      name: entry ? entry.name : targetRaw,
      found: totalMatches > 0,
      totalMatches,
      decks: deckList,
    });
  }

  // ── GET /api/batches ────────────────────────────────────────────────────────
  // Hidden batches (Format Library bracket-import placeholders for a player
  // with no real profile yet — see the db.events comment near the top of
  // this file) USED TO be excluded from this list by default, on the theory
  // that an auto-created placeholder shouldn't clutter the Profiles grid
  // until an admin "promotes" it by creating/editing a matching real
  // profile. In practice this made real, already-imported replay data
  // (an entire player's worth, sometimes) invisible on the Profiles grid,
  // the batch/player search dropdowns, and anywhere else that reads this
  // list — with no indication anything was missing, since nothing here
  // ever told you a hidden batch existed unless you went looking for it.
  // Per explicit instruction, every batch is public now: `hidden` is kept
  // as an internal flag only (autoMergeHiddenBatches still uses it to find
  // and fold a placeholder into a real profile the moment one is created or
  // edited with a matching name/alias — that merge machinery is unaffected
  // and still the way to consolidate a duplicate), but it no longer hides
  // anything from this or any other listing. `?includeHidden=1` is now a
  // no-op (every batch is already included) and kept only so an older
  // client passing it doesn't break.
  if (parts[0]==='batches' && !parts[1] && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot browse saved batches' });
    const list = Object.values(db.batches)
      .map(b => ({ id:b.id, name:b.name, player:b.player, replayCount:(b.replays||[]).length, createdAt:b.createdAt, hidden: !!b.hidden }));
    return json(res, 200, list.sort((a,b)=>b.createdAt-a.createdAt));
  }
  // ── GET /api/batches/all-full — every saved batch WITH its full replay
  // array, in ONE response. Format Data (and anything else that needs every
  // replay system-wide) used to fetch the lightweight list above and then
  // fetch each non-empty batch individually (1 + N round trips) just to
  // build aggregate stats across every saved replay — slow once there are
  // more than a handful of batches, and purely a network-latency cost since
  // every batch is already sitting in memory (db.batches) either way. This
  // is the same data, pre-joined, in a single pass.
  if (parts[0]==='batches' && parts[1]==='all-full' && !parts[2] && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot browse saved batches' });
    // Build (and JSON-serialize, and gzip) this response at most once per
    // actual data change — see _allFullCache above. Every subsequent call
    // reuses the same already-serialized bytes instead of redoing all of
    // that work from scratch, which is what made this endpoint slow/feel
    // hung once the dataset got big: it's the exact same CPU-bound cost
    // whether one person asks for it once or Format Data, every Profile
    // open, GFWL Archive, and Events all ask for it independently within
    // the same few minutes.
    if (!_allFullCache) {
      const list = Object.values(db.batches).filter(b => (b.replays||[]).length);
      // Re-derive each replay's override fields from the global, replayId-keyed
      // registry before responding — see applyGlobalOverrideToReplay. This is
      // what makes an override visible here even on a batch copy that's gone
      // stale (a duplicate scrape, an unmerged alias batch, a cross-linked
      // twin that never got its own propagation write).
      for (const b of list) {
        for (const r of (b.replays||[])) applyGlobalOverrideToReplay(r, b.player || null);
      }
      const jsonBuf = Buffer.from(JSON.stringify(list));
      _allFullCache = { json: jsonBuf, gzip: null };
    }
    const headers = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-store, no-cache, must-revalidate', 'Pragma':'no-cache' };
    if (_allFullCache.json.length > 800 && acceptsGzip(res)) {
      if (!_allFullCache.gzip) { try { _allFullCache.gzip = zlib.gzipSync(_allFullCache.json); } catch(e) { _allFullCache.gzip = null; } }
      if (_allFullCache.gzip) {
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(_allFullCache.gzip);
        return;
      }
    }
    res.writeHead(200, headers);
    res.end(_allFullCache.json);
    return;
  }
  // ── POST /api/batches/bulk — full replay data for a specific SET of
  // batch ids, in one response. Same cheap, memory-only source as
  // /all-full above (zero live Postgres reads — just db.batches), but
  // scoped to only the ids the caller actually needs instead of every
  // batch for every player system-wide. Opening one Player Profile only
  // ever needs that one player's own batches — on a server with a lot of
  // accumulated data, pulling the entire system's batch set just to
  // render one profile is a large, slow, unnecessary transfer (and was
  // making Profiles feel like they'd stalled again, the same complaint
  // /all-full was originally brought in to fix for Format Data). This is
  // the id-scoped version of that same fix.
  if (parts[0]==='batches' && parts[1]==='bulk' && !parts[2] && method==='POST') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot browse saved batches' });
    return readBody(req, data => {
      const ids = Array.isArray(data.ids) ? data.ids.filter(Boolean) : [];
      const list = ids.map(id => db.batches[id]).filter(Boolean);
      for (const b of list) {
        for (const r of (b.replays||[])) applyGlobalOverrideToReplay(r, b.player || null);
      }
      return json(res, 200, list);
    });
  }
  // ── POST /api/batches ───────────────────────────────────────────────────────
  if (parts[0]==='batches' && !parts[1] && method==='POST') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above can create batches' });
    return readBody(req, async data => {
      const id = crypto.randomUUID();
      const batch = { id, name: data.name||data.player||'Batch', player: data.player||'', aliases: data.aliases||[], replays: [], createdAt: Date.now(), status: 'pending' };
      db.batches[id] = batch;
      await saveBatchToPostgres(id);
      logChange(req, 'create_batch', { batchId: id, batchPlayer: batch.player, batchName: batch.name });
      // A Format-Library event import run before this profile existed may
      // have created a hidden placeholder batch for this exact player name
      // — see autoMergeHiddenBatches and the db.events comment above.
      let flImport = null;
      try { flImport = await autoMergeHiddenBatches(batch, req); }
      catch(e) { console.error('[fl-import] autoMergeHiddenBatches failed for new batch', id, ':', e.message); }
      return json(res, 200, flImport && flImport.attachedEvents.length ? { ...batch, flImportAttached: flImport.attachedEvents } : batch);
    });
  }
  // ── POST /api/matches/manual — record a match with no real DuelingBook
  // replay behind it (most commonly a GFWL forfeit: a ruling assigned a
  // win/loss but no game was actually played, so there's nothing to import).
  // Creates one synthetic replay-shaped record in EACH player's batch —
  // mirrored result/score, exactly like a real cross-linked replay — so it
  // shows up identically on both profiles, in Deck Matchups, GFWL History,
  // etc. Flagged isManual (and manualForfeit when applicable) so the client
  // can label it and skip anything that assumes a real replay exists.
  if (parts[0]==='matches' && parts[1]==='manual' && !parts[2] && method==='POST') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above can add manual matches' });
    return readBody(req, async data => {
      const playerA = (data.playerA || '').trim();
      const playerB = (data.playerB || '').trim();
      if (!playerA || !playerB) return json(res, 400, { error: 'Both player names are required.' });
      if (playerA.toLowerCase() === playerB.toLowerCase()) return json(res, 400, { error: 'Players must be different.' });
      // "Match did not occur" — record-keeping only (e.g. a scheduled GFWL
      // match that never actually got played). Forces 0-0 server-side too
      // (never trust the client's score fields for this — if didNotOccur is
      // set, 0-0 is the only score that makes sense) and skips the tie
      // check, since 0-0 is explicitly what this case wants to save.
      const didNotOccur = !!data.didNotOccur;
      const scoreA = didNotOccur ? 0 : Number(data.scoreA);
      const scoreB = didNotOccur ? 0 : Number(data.scoreB);
      if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
        return json(res, 400, { error: 'Enter a valid score for both players.' });
      }
      if (scoreA === scoreB && !didNotOccur) return json(res, 400, { error: "Scores can't be tied — pick an actual winner." });
      const eventId = (data.eventId || '').trim();
      const deckA = (data.deckA || '').trim();
      const deckB = (data.deckB || '').trim();
      const manualForfeit = !!data.manualForfeit && !didNotOccur;
      const note = (data.note || '').trim();
      // Default reason text when the user left Notes blank — "omitted" with
      // no explanation at all is a worse record than a generic one.
      const omittedNote = note || 'Match did not occur.';
      // Optional documentation link — most manual entries are forfeits with
      // no real replay, but occasionally one does exist (e.g. a match that
      // WAS played but needs its result corrected/recorded this way for some
      // other reason) and is worth keeping attached. Only accepted as an
      // actual duelingbook.com replay link, not the bare prefix the client
      // pre-fills the field with — anything else is silently ignored rather
      // than stored as a broken link.
      const rawReplayUrl = (data.replayUrl || '').trim();
      const manualReplayUrl = /^https?:\/\/(www\.)?duelingbook\.com\/replay\?id=\S+/i.test(rawReplayUrl) ? rawReplayUrl : '';

      const batchA = findOrCreateBatchForPlayerName(playerA);
      const batchB = findOrCreateBatchForPlayerName(playerB);
      if (!batchA || !batchB) return json(res, 500, { error: 'Could not create or find a profile for one of these players.' });
      if (batchA.id === batchB.id) return json(res, 400, { error: 'Those two names resolve to the same existing profile.' });

      // A didNotOccur match has no winner — 'n' (neither), matching the
      // convention the client's record-builder already uses elsewhere for
      // "no result to score" (matchWon/matchLost both become false when
      // result isn't 'w' or 'l'). Computing a real w/l out of 0-0 would be
      // actively misleading, since it'd always read as a loss for both sides.
      const resultA = didNotOccur ? 'n' : (scoreA > scoreB ? 'w' : 'l');
      const resultB = didNotOccur ? 'n' : flipResult(resultA);
      const replayId = 'manual-' + crypto.randomUUID();
      const now = Date.now();

      if (!batchA.replays) batchA.replays = [];
      batchA.replays.push({
        replayId, isManual: true, manualForfeit, manualNote: note, manualReplayUrl,
        plays: [], allPlays: [],
        // omitted/omittedNote set here (rather than left to the global
        // override registry) because this record is omitted from creation —
        // see applyGlobalOverrideToReplay, which only ever touches these
        // fields when a matching db.overrides[replayId] entry exists, so a
        // baked-in true here is never silently reverted on a later read.
        omitted: didNotOccur, omittedNote: didNotOccur ? omittedNote : '',
        parsed: {
          oppName: batchB.player, result: resultA,
          score: `${scoreA}-${scoreB}`, myW: scoreA, oppW: scoreB, draws: 0,
          myDeck: deckA || 'Unknown', oppDeck: deckB || 'Unknown',
          games: [], allMine: [], allOpp: [],
          omitted: didNotOccur, omittedNote: didNotOccur ? omittedNote : '',
        },
        timedOut: false, eventLabel: eventId, oppName: batchB.player,
        crossLinked: true, savedAt: now,
      });
      batchA.status = 'ready';

      if (!batchB.replays) batchB.replays = [];
      batchB.replays.push({
        replayId, isManual: true, manualForfeit, manualNote: note, manualReplayUrl,
        plays: [], allPlays: [],
        omitted: didNotOccur, omittedNote: didNotOccur ? omittedNote : '',
        parsed: {
          oppName: batchA.player, result: resultB,
          score: `${scoreB}-${scoreA}`, myW: scoreB, oppW: scoreA, draws: 0,
          myDeck: deckB || 'Unknown', oppDeck: deckA || 'Unknown',
          games: [], allMine: [], allOpp: [],
          omitted: didNotOccur, omittedNote: didNotOccur ? omittedNote : '',
        },
        timedOut: false, eventLabel: eventId, oppName: batchA.player,
        crossLinked: true, savedAt: now,
      });
      batchB.status = 'ready';

      // This must be CONFIRMED durably saved before responding "ok" — not
      // just handed to the normal debounced save (saveBatchToPostgres),
      // which schedules a write ~1.5s out and returns immediately regardless
      // of whether it ever lands. The very next thing the client does after
      // seeing {ok:true} is re-fetch these two batches (GET /api/batches/:id
      // always re-reads straight from Postgres — see that route's own
      // comment — specifically so a stale in-memory copy on some OTHER
      // server instance can't be served after a real save). That re-read
      // was racing the debounce timer: if it landed before the 1.5s flush,
      // it read the OLD row from Postgres and overwrote this request's own
      // in-memory update with it — the match the user just added vanishing
      // immediately, even though the server had genuinely just written it to
      // memory a moment earlier. flushBatchNow() blocks until Postgres
      // actually has the new data, so that race can't happen.
      const flushA = await flushBatchNow(batchA.id);
      const flushB = await flushBatchNow(batchB.id);
      if (!flushA.ok || !flushB.ok) {
        return json(res, 500, { error: 'Match recorded in memory but failed to save durably: ' + (flushA.error || flushB.error || 'unknown error') + '. Try again — if this keeps happening, check Postgres connectivity.' });
      }
      logChange(req, 'add_manual_match', {
        replayId, playerA: batchA.player, playerB: batchB.player,
        scoreA, scoreB, eventId, manualForfeit, didNotOccur, note, manualReplayUrl,
      });
      return json(res, 200, { ok: true, replayId, batchAId: batchA.id, batchBId: batchB.id, playerA: batchA.player, playerB: batchB.player });
    });
  }
  // ── GET /api/batches/:id ────────────────────────────────────────────────────
  // This is the exact call Deck Viewer makes every time a batch is opened or
  // the page is reloaded — which is why it re-reads the row straight from
  // Postgres instead of trusting whatever this process already has sitting
  // in db.batches. The in-memory copy is only guaranteed current for THIS
  // one server process; if Railway is ever running more than one instance
  // of this app at the same time (a second replica, or the brief overlap
  // during a rolling/zero-downtime deploy, or even an old instance that
  // hasn't fully shut down yet), each instance has ALWAYS had its own
  // separate `db.batches` loaded at ITS startup and mutated only by requests
  // THAT instance happened to handle — there has never been a mechanism for
  // one instance to learn about a save another instance made. An override
  // saved via whichever instance handled that PATCH would be correctly and
  // durably written to Postgres, and then a refresh landing on a DIFFERENT
  // instance a moment later would show the old value forever, because that
  // instance's memory was never updated and never asked Postgres again —
  // which is indistinguishable, from the browser, from "it didn't save."
  // Re-reading the row here removes that blind spot regardless of how many
  // instances exist or why: this always answers with whatever was last
  // actually committed, never a stale copy.
  if (parts[0]==='batches' && parts[1] && !parts[2] && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view saved batches' });
    if (pgClient) {
      try {
        const freshRes = await pgClient.query('SELECT value FROM duel_tools_batches WHERE id=$1', [parts[1]]);
        if (freshRes.rows.length) {
          db.batches[parts[1]] = freshRes.rows[0].value;
        } else if (!db.batches[parts[1]]) {
          return json(res, 404, { error:'Not found' });
        }
        // If Postgres has no row but this process's memory does, fall
        // through and serve the in-memory copy (e.g. a brand new batch
        // whose very first save is still mid-flight) rather than 404ing.
      } catch(e) {
        console.error('[GET batch] Fresh re-read failed, falling back to in-memory copy:', e.message);
      }
    }
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    // Re-derive each replay's override fields from the global, replayId-keyed
    // registry before responding — see applyGlobalOverrideToReplay. Whatever
    // (possibly stale) override data this specific batch's own copy has, the
    // global record — if one exists for a given replayId — always wins.
    for (const r of (b.replays||[])) applyGlobalOverrideToReplay(r, b.player || null);
    return json(res, 200, b);
  }
  // ── PATCH /api/batches/:id ──────────────────────────────────────────────────
  if (parts[0]==='batches' && parts[1] && !parts[2] && method==='PATCH') {
    return readBody(req, async data => {
      const b = db.batches[parts[1]];
      if (!b) return json(res, 404, { error:'Not found' });
      if (data.name !== undefined || data.player !== undefined || data.aliases !== undefined) {
        logChange(req, 'edit_batch', { batchId: b.id, batchPlayer: data.player!==undefined?data.player:b.player, prevPlayer: b.player, name: data.name, aliases: data.aliases });
      }
      const _nameOrAliasChanged = data.player !== undefined || data.aliases !== undefined;
      if (data.name           !== undefined) b.name           = data.name;
      if (data.player         !== undefined) b.player         = data.player;
      if (data.aliases        !== undefined) b.aliases        = data.aliases;
      // Explicit un-hide/re-hide — used by the client's own "find or create
      // the batch to import into" flow (go()) when it resolves an existing
      // HIDDEN placeholder batch for a player who is now being explicitly
      // imported under a named Duel Tools profile: that's exactly what
      // "promote this to a real profile" means, and it has to be written
      // here (not just held in the client's in-memory copy) or the batch
      // stays hidden from the Profiles grid (GET /api/batches) forever,
      // even though the replays about to be saved into it are real.
      if (data.hidden !== undefined) b.hidden = !!data.hidden;
      if (data.eventDecklists !== undefined) {
        // Decklists are saved as a whole-array replace, not an incremental
        // add — diff against what was there before so the audit log can say
        // "decklist added for event X" (with the event id/code) rather than
        // just "eventDecklists changed," which is what the user actually
        // asked this log to show.
        logDecklistDiff(req, b.eventDecklists || [], data.eventDecklists || [], { batchId: b.id, batchPlayer: b.player });
        b.eventDecklists = data.eventDecklists;
      }
      await saveBatchToPostgres(b.id);
      // A name/alias edit on a real profile may now match a hidden
      // FL-import placeholder batch that was waiting for exactly this —
      // see autoMergeHiddenBatches above.
      let flImport = null;
      if (_nameOrAliasChanged) {
        try { flImport = await autoMergeHiddenBatches(b, req); }
        catch(e) { console.error('[fl-import] autoMergeHiddenBatches failed for edited batch', b.id, ':', e.message); }
      }
      return json(res, 200, flImport && flImport.attachedEvents.length ? { ...b, flImportAttached: flImport.attachedEvents } : b);
    });
  }
  // ── POST /api/batches/merge — admin-only "Merge Profiles" tool. Body:
  // { keepId, mergeId }. Folds `mergeId`'s replays/eventDecklists/aliases
  // into `keepId` (via mergeBatchesInternal — same engine autoMergeHiddenBatches
  // uses for automatic hidden-batch promotion) and permanently deletes
  // `mergeId`. Admin-only (not Miner) because, unlike every other batch
  // mutation in this file, this one is NOT reversible by re-importing —
  // the merged-away batch's id, and anything that referenced it directly
  // (rather than by player name), is gone for good once this returns ok.
  if (parts[0]==='batches' && parts[1]==='merge' && !parts[2] && method==='POST') {
    if (!isAdmin(req)) return json(res, 403, { error: 'Admins only' });
    return readBody(req, async data => {
      const keepId = (data.keepId || '').trim();
      const mergeId = (data.mergeId || '').trim();
      if (!keepId || !mergeId) return json(res, 400, { error: 'keepId and mergeId are required.' });
      if (keepId === mergeId) return json(res, 400, { error: 'Pick two different profiles to merge.' });
      const keep = db.batches[keepId];
      const merge = db.batches[mergeId];
      if (!keep) return json(res, 404, { error: 'keepId does not match any existing profile.' });
      if (!merge) return json(res, 404, { error: 'mergeId does not match any existing profile.' });
      const result = await mergeBatchesInternal(keep, merge, req, 'admin_merge');
      if (!result.ok) return json(res, 500, { error: 'Merge may not have saved durably: ' + (result.error || 'unknown error') });
      return json(res, 200, { ok: true, batch: keep, mergedReplays: result.mergedReplays, mergedDecklists: result.mergedDecklists, aliasesAdded: result.aliasesAdded });
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
    logChange(req, 'delete_batch', { batchId: batch.id, batchPlayer: batch.player, batchName: batch.name, replayCount: (batch.replays||[]).length });
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
    const removedReplay = (b.replays||[]).find(r => r.replayId === replayId);
    b.replays = (b.replays||[]).filter(r => r.replayId !== replayId);
    await saveBatchToPostgres(b.id);
    if (b.replays.length < before) {
      logChange(req, 'delete_replay', { batchId: b.id, batchPlayer: b.player, replayId, eventLabel: removedReplay?.eventLabel || '' });
    }
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
        // This migration's incoming `parsed` block is a fresh computation
        // with no idea a manual override exists — re-stamp r's own override
        // onto it so the corrected result/score/deck keeps being what's
        // actually displayed, not just what's stored at the top level.
        reapplyOverridesToParsed(r);
        await saveBatchToPostgres(b.id);
        console.log(`[parsed] Migrated replay ${r.replayId} — allPlays cleared`);
      }
      return json(res, 200, { ok:true });
    });
  }

  // ── PATCH /api/batches/:id/replay/:replayId — general replay field update ──
  // Used by the "retry parse" flow to overwrite an existing replay's raw
  // plays / parsed result / player identification with freshly re-fetched
  // data, regardless of whether the stored copy was previously timedOut.
  // (The POST .../replay endpoint above only overwrites an existing replay
  // when it was previously timedOut — a replay that already has SOME parsed
  // data, just wrong or incomplete, would silently no-op there.) Only the
  // fields present in the body are touched — manual overrides
  // (myDeckOverride, resultOverride, etc.) and anything else already on the
  // replay are left exactly as they are at the top level. But a fresh
  // `data.parsed` replaces r.parsed wholesale and has no idea an override
  // exists, so reapplyOverridesToParsed() re-stamps it afterward — otherwise
  // the override field itself survives while the value every view actually
  // reads (r.parsed.*) would silently revert to the raw re-parse. This is
  // also the save path for the Deck Viewer's "Merge Replay" feature: a
  // disconnect-continuation replay's games get folded into `data.parsed`
  // client-side, and `mergedReplays` (which replay IDs make up this match,
  // and which game number(s) each one covers) is stored alongside it so the
  // UI can list every linked replay later.
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && parts[3] && !parts[4] && method==='PATCH') {
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    return readBody(req, async data => {
      const replayId = decodeURIComponent(parts[3]);
      const r = (b.replays||[]).find(r => r.replayId === replayId);
      if (!r) return json(res, 404, { error:'Replay not found in batch' });
      // 'round' added so a backfill pass (editAliases() on the client, for
      // replays saved before round-capture existed — Format Library tags
      // every GOAT replay with a round, but that field only started being
      // read/stored here recently) can actually persist what it finds; it
      // was silently dropped by this whitelist before.
      // 'roundManual' — set by eventsEditReplayRound when an admin manually
      // corrects/fills in a replay's Round (e.g. a Format Library data error
      // where a player submitted the wrong replay link and FL never tagged
      // a round for it at all). backfillMissingRounds and
      // eventsBackfillEventReplays both check this flag and skip Round on
      // any replay that has it set, so a manual correction sticks through
      // every future "Retry Round Data" / "Sync Replays from Format
      // Library" run instead of being silently re-blanked or re-guessed.
      const fields = ['plays','allPlays','parsed','timedOut','oppName','player1','player2','eventLabel','round','roundManual','mergedReplays'];
      for (const f of fields) { if (data[f] !== undefined) r[f] = data[f]; }
      if (data.parsed) {
        r.allPlays = [];
        reapplyOverridesToParsed(r); // this replay's OWN override fields, if any, still win
        applyGlobalOverrideToReplay(r, b.player || null); // ...and the global registry (if a record exists) has final say
      }
      r.savedAt = Date.now();

      // A Merge Replay save is a deliberate, infrequent, correction a person
      // made on purpose — it must be confirmed durably saved before this
      // responds "ok", not just handed to the normal debounced save (which
      // schedules a write ~1.5s out and returns immediately regardless of
      // whether that write ever actually lands). Under the debounced path,
      // every read in THIS server process still sees the merge correctly
      // (it's reading the same in-memory object), so it looks saved right up
      // until something reloads that data from scratch — a redeploy, a
      // crash, a restart — and comes back with whatever was last actually
      // committed to Postgres, which is the pre-merge replay. That is
      // exactly what "it's not staying after refresh" looks like whenever
      // the refresh happens to land after one of those reloads. A routine
      // retry (no mergedReplays in the body) keeps the fast debounced path,
      // since it isn't the thing that was reported broken and retries can
      // happen in bulk.
      const isDeliberateMerge = data.mergedReplays !== undefined;
      let primarySave = { ok: true };
      if (isDeliberateMerge) {
        primarySave = await flushBatchNow(b.id);
        if (!primarySave.ok) console.error(`[merge] FAILED to durably save replay ${r.replayId} in batch ${b.id}:`, primarySave.error);
        logChange(req, 'merge_replay', { batchId: b.id, batchPlayer: b.player, replayId, eventLabel: r.eventLabel || '', mergedReplays: (data.mergedReplays||[]).map(x=>x.replayId||x) });
      } else {
        await saveBatchToPostgres(b.id);
      }
      console.log(`[replay retry] Updated replay ${r.replayId} in batch ${b.id}`);

      // Merge Replay must trump cross-linking too, same reasoning as the
      // override endpoint below: this same replayId may already exist as a
      // mirrored copy in the opponent's own batch (from an earlier
      // cross-link), and that twin copy would otherwise keep showing the
      // pre-merge, incomplete match forever — in ITS Deck Viewer, and in
      // every GFWL/Profile/Format-Data stat that reads it. Gated on
      // `data.mergedReplays` specifically (only the Merge Replay flow sends
      // it) so an ordinary retry — which also PATCHes `parsed` here but
      // isn't a merge — doesn't unexpectedly start mirroring itself onto
      // the opponent's copy too.
      let twinsUpdated = 0, twinsFailed = 0;
      if (data.parsed && isDeliberateMerge) {
        const twinBatchIds = [];
        for (const ob of Object.values(db.batches)) {
          if (ob.id === b.id) continue;
          const twin = (ob.replays||[]).find(tr => tr.replayId === replayId);
          if (!twin) continue;
          // Only flip when the other batch is genuinely the OPPONENT's
          // mirror — a second batch for the SAME player (an unmerged alias,
          // a duplicate scrape) gets the merged data copied as-is instead.
          // See isSamePlayerAsBatch() for why this check exists.
          if (isSamePlayerAsBatch(b, ob)) {
            twin.parsed = JSON.parse(JSON.stringify(r.parsed));
          } else {
            const flippedBase = flipParsedBaseForTwin(r.parsed, b.player || null);
            twin.parsed = { ...(twin.parsed||{}), ...flippedBase };
          }
          twin.mergedReplays = data.mergedReplays; // replay IDs/game numbers are absolute, not perspective-dependent
          twin.allPlays = [];
          reapplyOverridesToParsed(twin); // twin's OWN override (if any) still wins, same rule as everywhere else
          applyGlobalOverrideToReplay(twin, ob.player || null); // ...and the global registry has final say
          twin.savedAt = Date.now();
          twinBatchIds.push(ob.id);
        }
        for (const bid of twinBatchIds) {
          const tRes = await flushBatchNow(bid);
          if (!tRes.ok) { twinsFailed++; console.error(`[merge] FAILED to durably save twin batch ${bid}:`, tRes.error); }
        }
        twinsUpdated = twinBatchIds.length;
        if (twinsUpdated) console.log(`[merge] Propagated merged replay to ${twinsUpdated} cross-linked twin batch(es) for ${replayId}`);
      }

      // A continuation replay merged in here (e.g. after a disconnect) was
      // very often ALSO scraped/archived as its own standalone match before
      // anyone recognized it was a continuation — by whoever ran this
      // player's scraper, AND independently by whoever ran the opponent's,
      // since both sides of that same continuation replay exist on
      // DuelingBook as their own replay ID. Once its games are folded into
      // THIS match (above), that standalone copy is now a stale duplicate of
      // games already counted here — left alone, it would double-count the
      // same games as a second, separate match everywhere (Format Data,
      // duplicate detection, profile records) on BOTH players' profiles, not
      // just this one. So: delete any standalone entry for every merged-in
      // replay ID, league-wide, across every batch (this player's own,
      // including any unmerged-alias batch, AND the opponent's) — not just
      // the twin batches found above, since a standalone leftover is not a
      // cross-linked twin and wouldn't be found by that loop.
      let standaloneRemoved = 0, standaloneBatchesTouched = 0;
      if (isDeliberateMerge && Array.isArray(data.mergedReplays)) {
        const mergedIds = new Set(data.mergedReplays.map(x => x && x.replayId).filter(Boolean));
        if (mergedIds.size) {
          const touchedBatchIds = new Set();
          for (const ob of Object.values(db.batches)) {
            if (!ob.replays || !ob.replays.length) continue;
            const before = ob.replays.length;
            ob.replays = ob.replays.filter(rep => !mergedIds.has(rep.replayId));
            const removed = before - ob.replays.length;
            if (removed > 0) { standaloneRemoved += removed; touchedBatchIds.add(ob.id); }
          }
          for (const bid of touchedBatchIds) {
            const tRes = await flushBatchNow(bid);
            if (!tRes.ok) console.error(`[merge] FAILED to durably save batch ${bid} after removing absorbed standalone replay(s):`, tRes.error);
          }
          standaloneBatchesTouched = touchedBatchIds.size;
          if (standaloneRemoved) {
            console.log(`[merge] Removed ${standaloneRemoved} standalone ${[...mergedIds].join(',')} entr${standaloneRemoved!==1?'ies':'y'} across ${standaloneBatchesTouched} batch(es) now folded into ${replayId}`);
            logChange(req, 'merge_absorb_standalone', { replayId, mergedIds: [...mergedIds], removed: standaloneRemoved, batchesTouched: standaloneBatchesTouched });
          }
        }
      }

      if (!primarySave.ok) {
        return json(res, 500, { ok:false, error: 'Merge was applied but FAILED TO SAVE: ' + primarySave.error, twinsUpdated, twinsFailed });
      }
      return json(res, 200, { ok:true, twinsUpdated, twinsFailed, standaloneRemoved, standaloneBatchesTouched });
    });
  }

  // ── PATCH /api/batches/:id/replay/:replayId/override ───────────────────────
  if (parts[0]==='batches' && parts[1] && parts[2]==='replay' && parts[3] && parts[4]==='override' && method==='PATCH') {
    const b = db.batches[parts[1]];
    if (!b) return json(res, 404, { error:'Not found' });
    return readBody(req, async data => {
      const replayId = decodeURIComponent(parts[3]);
      const r = (b.replays||[]).find(r => r.replayId === replayId);
      if (r) {
        applyOverrideToReplay(r, data, false);
        if (data.resultOverride !== undefined) {
          console.log(`[override] Result override for ${r.replayId}: ${data.resultOverride||'cleared'}`);
        }
        if (data.omitted !== undefined) {
          console.log(`[override] Omit flag for ${r.replayId}: ${data.omitted ? 'omitted' : 'un-omitted'}`);
        }

        // Write-through to the global, replayId-keyed override registry —
        // the single source of truth that every GET re-projects onto every
        // batch's copy of this replay (see applyGlobalOverrideToReplay).
        // This runs IN ADDITION to the per-batch/twin-propagation logic
        // below, not instead of it: that logic stays as an additional
        // safety net, but it is no longer what makes the override durable
        // against a stale/duplicate/unmerged-alias batch copy — this is.
        const oppNameForOverride = r.oppName || (r.parsed && r.parsed.oppName) || null;
        const mergedGlobal = mergeGlobalOverride(replayId, data, b.player || null, oppNameForOverride);
        if (mergedGlobal) db.overrides[replayId] = mergedGlobal;
        else delete db.overrides[replayId];
        logChange(req, mergedGlobal ? 'set_override' : 'clear_override', {
          batchId: b.id, batchPlayer: b.player, replayId, oppName: oppNameForOverride,
          resultOverride: data.resultOverride!==undefined ? data.resultOverride : undefined,
          scoreOverride:  data.scoreOverride !==undefined ? data.scoreOverride  : undefined,
          myDeckOverride: data.myDeckOverride!==undefined ? data.myDeckOverride : undefined,
          oppDeckOverride:data.oppDeckOverride!==undefined? data.oppDeckOverride: undefined,
          note: data.overrideNote || undefined,
          omitted: data.omitted!==undefined ? data.omitted : undefined,
          omittedNote: data.omittedNote || undefined,
        });
        const globalSave = await saveDB('overrides');
        if (globalSave && globalSave.ok === false) {
          console.error(`[override] FAILED to durably save GLOBAL override for ${replayId}:`, globalSave.error);
        }
        // An override is a deliberate, infrequent, rules-correction a person
        // made on purpose — it must be CONFIRMED durably saved before this
        // responds "ok", not just handed to the normal debounced save (which
        // schedules a write ~1.5s out and returns `ok:true` immediately
        // regardless of whether that write ever actually lands in Postgres).
        // Under the debounced path, every read in THIS server process still
        // sees the override correctly — it's reading the same in-memory
        // object the write didn't finish updating storage for yet — so it
        // looks saved right up until something reloads that data from
        // scratch (a redeploy, a crash, a restart) and comes back with
        // whatever was last actually committed, i.e. the pre-override value.
        // That is exactly what "it's not staying after refresh" looks like
        // whenever the refresh happens to land after one of those reloads.
        const primarySave = await flushBatchNow(b.id);
        if (!primarySave.ok) console.error(`[override] FAILED to durably save replay ${r.replayId} in batch ${b.id}:`, primarySave.error);

        // A result override must trump cross-linking: this same replay may
        // already exist as a mirrored copy in the opponent's own batch (from
        // an earlier cross-link), and that copy would otherwise keep showing
        // the pre-override outcome forever. Propagate the override (flipped
        // to the opponent's perspective) to every other batch's copy of this
        // replayId so both sides of the match agree.
        //
        // But "every other batch holding this replayId" is NOT always the
        // opponent — a player can have more than one batch of their OWN (an
        // unmerged alias, e.g. a duelingbook username vs. a GFWL roster
        // name, or two independent scrape sessions), and that second batch
        // holds the SAME player's OWN perspective, not the opponent's. Only
        // flip for a batch that's actually a different player; a same-player
        // batch gets the override copied as-is. Skipping this check used to
        // silently write the OPPOSITE result into that sibling batch, which
        // then looked exactly like "the override doesn't stick" whenever
        // Deck Viewer/Profile/GFWL happened to load that sibling instead.
        const twinBatchIds = [];
        let twinsFailed = 0;
        for (const ob of Object.values(db.batches)) {
          if (ob.id === b.id) continue;
          const twin = (ob.replays||[]).find(tr => tr.replayId === replayId);
          if (twin) { applyOverrideToReplay(twin, data, !isSamePlayerAsBatch(b, ob)); twinBatchIds.push(ob.id); }
        }
        for (const bid of twinBatchIds) {
          const tRes = await flushBatchNow(bid);
          if (!tRes.ok) { twinsFailed++; console.error(`[override] FAILED to durably save twin batch ${bid}:`, tRes.error); }
        }
        if (twinBatchIds.length) {
          console.log(`[override] Propagated to ${twinBatchIds.length} cross-linked twin batch(es) for ${replayId}`);
        }

        // Final pass: re-derive EVERY batch's copy of this replayId straight
        // from the global registry just written above. The twin-propagation
        // loop just above only finds "other batches" via alias-matching
        // heuristics and flips based on its own best guess of same-player
        // vs. opponent — useful as a first pass, but it's exactly the kind
        // of per-copy logic that's had edge cases every round of this fix so
        // far. This pass is authoritative and covers every batch holding
        // this replayId unconditionally (including the primary batch and
        // every twin, redundantly but harmlessly), so even if the heuristic
        // above got a same-player/opponent call wrong, this corrects it.
        const globalTouchedIds = applyGlobalOverrideToAllBatchCopies(replayId);
        const alreadyFlushed = new Set([b.id, ...twinBatchIds]);
        for (const bid of globalTouchedIds) {
          if (alreadyFlushed.has(bid)) { await flushBatchNow(bid); continue; } // re-flush: global pass may have corrected it
          const tRes = await flushBatchNow(bid);
          if (!tRes.ok) { twinsFailed++; console.error(`[override] FAILED to durably save batch ${bid} after global projection:`, tRes.error); }
        }

        if (!primarySave.ok) {
          return json(res, 500, { ok:false, found:true, error: 'Override was applied but FAILED TO SAVE: ' + primarySave.error, twinsUpdated: twinBatchIds.length, twinsFailed });
        }
        return json(res, 200, { ok:true, found:true, twinsUpdated: twinBatchIds.length, twinsFailed });
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
      // Always answer the client, success or failure — addReplayToBatchData
      // intentionally re-throws on a save error (see its own comment), and
      // without a catch HERE that left the request hanging with no response
      // at all until the client eventually gave up, which is indistinguishable
      // from "stuck on Loading 1/1" (part of the 2026-11 incident — see the
      // connectPostgres() notes above for the actual root cause of why saves
      // were failing in the first place). Now a genuine save failure is
      // reported back immediately and clearly instead of hanging silently.
      try {
        const result = await addReplayToBatchData(b, data, req);
        return json(res, 200, { ok:true, duplicate: result.duplicate, crossLinks: result.crossLinks });
      } catch(e) {
        console.error('[replay POST] Failed to save replay', data && data.replayId, 'for batch', b.id, ':', e.message);
        return json(res, 500, { error: 'Failed to save this replay: ' + e.message });
      }
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

  // ══════════════════════════════════════════════════════════════════════
  // EVENTS TAB — self-contained event database built from db.events (only
  // events a Duel-Tools-tracked player has actually touched — see the
  // db.events comment near the top of this file). NOT a live mirror of
  // Format Library's whole history.
  // ══════════════════════════════════════════════════════════════════════

  // ── GET /api/events — list every event we have data for ─────────────────────
  if (parts[0]==='events' && !parts[1] && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view events' });
    const profileIndex = buildProfileNameIndex();
    const replayCoverageIndex = buildEventReplayCoverageIndex();
    const list = Object.values(db.events||{}).map(ev => {
      const fallback = db.eventDates[ev.code] || {};
      const statusInfo = computeEventStatus(ev, profileIndex, replayCoverageIndex);
      return {
        code: ev.code,
        name: ev.name || fallback.name || '',
        date: ev.date || fallback.date || '',
        size: ev.size || (ev.decks||[]).length,
        winner: ev.winner || null,
        deckCount: (ev.decks||[]).length,
        status: statusInfo.status,
        missingPlayers: statusInfo.missingPlayers,
        incompleteData: statusInfo.incompleteData,
        // Free-text admin annotation for known Format Library data problems
        // on this event (wrong replay submitted for a round, a bracket name
        // FL mangled, etc.) — see PATCH /api/events/:code/note. Surfaced on
        // the Events list row itself so this doesn't need opening the event
        // detail page to notice; kept short here, full text lives client-side.
        note: ev.note || '',
      };
    });
    return json(res, 200, { events: list, total: list.length });
  }

  // ── GET /api/events/placements-bulk — every event's size + per-builder
  // placement, all in one response. Backs the "Tops Only" filter on Format
  // Data / Top Cards (Top 8 for events under 128 entrants, Top 16 for 128+,
  // per-event cutoff decided client-side since it only needs `size`) —
  // without this, scoping thousands of match records against placement data
  // would mean one request per distinct event code. GFWL is naturally
  // excluded: GFWL "events" are never fetched from Format Library (see
  // captureEventTopDecks), so they simply never appear in db.events at all,
  // the same way they're absent from the regular /api/events list. ─────────
  if (parts[0]==='events' && parts[1]==='placements-bulk' && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view events' });
    const events = {};
    for (const ev of Object.values(db.events||{})) {
      events[ev.code] = {
        size: ev.size || (ev.decks||[]).length,
        decks: (ev.decks||[]).map(d => ({ builderName: d.builderName||'', placeNum: d.placeNum!=null?d.placeNum:null })),
      };
    }
    return json(res, 200, { events });
  }

  // ── GET /api/events/:code — one event's full decklist gallery ───────────────
  if (parts[0]==='events' && parts[1] && !parts[2] && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view events' });
    const code = decodeURIComponent(parts[1]).toUpperCase();
    const ev = db.events[code];
    if (!ev) return json(res, 404, { error: 'No data for this event yet.' });
    const fallback = db.eventDates[code] || {};
    // Built once for this one event (not per-deck) — see
    // buildEventReplayCoverageIndex's own comment for why this replaced the
    // old per-deck full-batches scan, and why the Events-list Status column
    // (computeEventStatus) now shares this exact same coverage data instead
    // of drawing its own separate, looser "does a profile exist" conclusion.
    const replayCoverage = buildEventReplayCoverageIndex()[code] || { hasReplay: new Set(), needsReview: new Set(), aliasError: new Set() };
    const decks = (ev.decks||[]).map(d => {
      const playerEntry = findPlayerByBuilderName(d.builderName);
      // hasReplays: does this player (alias-aware) have at least one saved
      // replay tagged with THIS event's code — drives the Replays ✓/✗
      // column on the event detail page's player list. Separate from
      // hasCards (the decklist ✓/✗ column, which just checks d.ydkData) —
      // a player can have one without the other, and the whole point of
      // this column is to surface exactly that gap (see Charlie MAD/PWCQ93:
      // decklist on file, but fewer replays saved here than Format Library
      // itself shows for that event).
      // needsReview: at least one replay IS tagged to this event for this
      // player, but it was saved without a resolved winner/loser because
      // none of their known aliases matched either side's actual
      // DuelingBook name in it — see buildEventReplayCoverageIndex's own
      // comment. Distinct from hasReplays itself: this player can be
      // hasReplays:true and needsReview:true at the same time (some
      // replays resolved fine, at least one didn't).
      // aliasError: at least one replay tagged to this event for this player
      // has an impossible best-of-3 score (a 3 on either side) — see
      // buildEventReplayCoverageIndex's own comment. Drives the "⚠ Check
      // Alias" flag next to the player's name.
      let hasReplays = false, needsReview = false, aliasError = false;
      const coverageHas = replayCoverage.hasReplay || new Set();
      const coverageNeedsReview = replayCoverage.needsReview || new Set();
      const coverageAliasError = replayCoverage.aliasError || new Set();
      if (playerEntry) {
        hasReplays = playerNames(playerEntry).some(n => coverageHas.has(n));
        needsReview = playerNames(playerEntry).some(n => coverageNeedsReview.has(n));
        aliasError = playerNames(playerEntry).some(n => coverageAliasError.has(n));
      } else {
        const raw = (d.builderName||'').trim().toLowerCase();
        const rawAlt = raw.replace(/_/g, ' ');
        hasReplays = coverageHas.has(raw) || coverageHas.has(rawAlt);
        needsReview = coverageNeedsReview.has(raw) || coverageNeedsReview.has(rawAlt);
        aliasError = coverageAliasError.has(raw) || coverageAliasError.has(rawAlt);
      }
      return {
        deckId: d.deckId,
        builderName: d.builderName,
        placement: d.placement,
        placeNum: d.placeNum,
        deckTypeName: d.deckTypeName,
        hasCards: !!d.ydkData,
        hasReplays,
        needsReview,
        aliasError,
        trackedPlayer: playerEntry ? playerEntry.name : null,
      };
    }).sort((a,b) => {
      const an = (a.placeNum==null) ? Infinity : a.placeNum, bn = (b.placeNum==null) ? Infinity : b.placeNum;
      return an - bn;
    });
    return json(res, 200, {
      code: ev.code,
      name: ev.name || fallback.name || '',
      date: ev.date || fallback.date || '',
      size: ev.size || decks.length,
      winner: ev.winner || null,
      note: ev.note || '',
      decks,
    });
  }

  // ── PATCH /api/events/:code/note — set/edit a free-text admin note on this
  // event, annotating known Format Library data problems (a player submitted
  // the wrong replay link, a bracket name FL mangled, missing rounds, etc.)
  // that aren't otherwise capturable anywhere else on this event. Purely
  // informational — never read by computeEventStatus or any sync/import
  // tool, so leaving one doesn't change this event's status or behavior.
  // Empty string clears it (shown as "no note" client-side, same convention
  // as every other optional override field in this file). ─────────────────
  if (parts[0]==='events' && parts[1] && parts[2]==='note' && !parts[3] && method==='PATCH') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above only' });
    const code = decodeURIComponent(parts[1]).toUpperCase();
    const ev = db.events[code];
    if (!ev) return json(res, 404, { error: 'No data for this event yet.' });
    return readBody(req, async data => {
      const note = String(data.note == null ? '' : data.note).trim();
      ev.note = note;
      await saveDB('events');
      logChange(req, 'set_event_note', { code, note });
      return json(res, 200, { ok: true, note: ev.note });
    });
  }

  // ── GET /api/events/:code/deck/:deckId — full card data + tracked-player link ─
  if (parts[0]==='events' && parts[1] && parts[2]==='deck' && parts[3] && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view event decklists' });
    const code = decodeURIComponent(parts[1]).toUpperCase();
    const deckId = decodeURIComponent(parts[3]);
    const ev = db.events[code];
    if (!ev) return json(res, 404, { error: 'No data for this event yet.' });
    const deck = (ev.decks||[]).find(d => String(d.deckId) === String(deckId));
    if (!deck) return json(res, 404, { error: 'Deck not found in this event.' });

    // Lazy-fetch + cache the YDK the first time anyone opens this specific
    // deck — mirrors the existing /api/proxy/fl-deck/:deckId behavior, but
    // only miners+ trigger the live Format Library call (anyone non-limited
    // can still view a deck once it's cached by someone else).
    if (!deck.ydkData && isMiner(req) && flToken()) {
      try {
        const { status, body } = await flApiRequest('/api/decks/download/' + encodeURIComponent(deckId));
        if (status === 200 && body) {
          deck.ydkData = Buffer.from(body, 'utf8').toString('base64');
          deck.updatedAt = Date.now();
          await saveDB('events');
        }
      } catch(e) { console.warn('[events] lazy YDK fetch failed for deck', deckId, ':', e.message); }
    }

    const playerEntry = findPlayerByBuilderName(deck.builderName);
    let trackedPlayer = null;
    if (playerEntry) {
      const names = playerNames(playerEntry);
      const batchIds = Object.values(db.batches)
        .filter(b => names.includes((b.player||'').toLowerCase()))
        .map(b => b.id);
      trackedPlayer = { name: playerEntry.name, batchIds };
    }

    return json(res, 200, {
      ok: true,
      eventCode: code,
      eventName: ev.name || (db.eventDates[code]||{}).name || '',
      eventDate: ev.date || (db.eventDates[code]||{}).date || '',
      deck,
      trackedPlayer,
    });
  }

  // ── PATCH /api/events/:code/deck/:deckId/decktype — set the canonical,
  // OUR-RULES deck type for one event bracket deck (see upsertEventDeckType
  // above for the full priority/propagation behavior). Called client-side
  // right after a decklist's cards are classified — by the Events tab when
  // a miner+ opens that deck, and by the Format Library decklist-import
  // flow when a player's eventDecklist gets classified on import.
  if (parts[0]==='events' && parts[1] && parts[2]==='deck' && parts[3] && parts[4]==='decktype' && method==='PATCH') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above only' });
    const code = decodeURIComponent(parts[1]).toUpperCase();
    const deckId = decodeURIComponent(parts[3]);
    return readBody(req, async data => {
      const deckTypeName = (data.deckTypeName || '').trim();
      const source = data.source === 'replay' ? 'replay' : 'decklist';
      if (!deckTypeName) return json(res, 400, { error: 'deckTypeName is required.' });
      const ev = db.events[code];
      if (!ev) return json(res, 404, { error: 'No data for this event yet.' });
      const deck = (ev.decks||[]).find(d => String(d.deckId) === String(deckId));
      if (!deck) return json(res, 404, { error: 'Deck not found in this event.' });

      const result = await upsertEventDeckType(code, deck.builderName, deckTypeName, source);
      if (!result.ok) return json(res, 404, { error: 'Could not apply classification.' });
      if (result.applied) {
        await saveDB('events');
        logChange(req, 'set_event_deck_type', {
          code, deckId, builderName: deck.builderName, deckTypeName, source, propagated: result.propagated,
        });
      }
      return json(res, 200, {
        ok: true, applied: result.applied, deckTypeName: deck.deckTypeName, source: deck.deckTypeSource,
        propagated: result.propagated || 0, reason: result.reason,
      });
    });
  }

  // ── GET /api/events/:code/metagame — deck representation + a matchup
  // matrix for the event detail page. Deck Representation and Top Deck
  // Representation come straight from the bracket we captured. The
  // Matchup Matrix is explicitly partial and labeled as such to the client:
  // Format Library's event API exposes the bracket's top decks but not
  // match-by-match pairings, so a full bracket matrix isn't available from
  // this data source — this one is built only from replays already on
  // record for Duel-Tools-tracked players who played in this event. ───────
  if (parts[0]==='events' && parts[1] && parts[2]==='metagame' && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view events' });
    const code = decodeURIComponent(parts[1]).toUpperCase();
    const ev = db.events[code];
    if (!ev) return json(res, 404, { error: 'No data for this event yet.' });
    const decks = ev.decks || [];

    // Deck Representation — every deck in the bracket, by type.
    const repCounts = {};
    for (const d of decks) {
      const t = d.deckTypeName || 'Unknown';
      repCounts[t] = (repCounts[t]||0) + 1;
    }
    const deckRepresentation = Object.entries(repCounts)
      .map(([deckTypeName,count]) => ({ deckTypeName, count }))
      .sort((a,b)=>b.count-a.count);

    // Top Deck Representation — our own reasonable interpretation (Top 8 by
    // placement), since Format Library doesn't document an exact definition
    // for this stat anywhere we have access to. Disclosed as such below via
    // topDeckRepresentationN, not presented as FL's own methodology.
    const TOP_N = 8;
    const topDecks = decks.filter(d => d.placeNum != null).sort((a,b)=>a.placeNum-b.placeNum).slice(0, TOP_N);
    const topRepCounts = {};
    for (const d of topDecks) {
      const t = d.deckTypeName || 'Unknown';
      topRepCounts[t] = (topRepCounts[t]||0) + 1;
    }
    const topDeckRepresentation = Object.entries(topRepCounts)
      .map(([deckTypeName,count]) => ({ deckTypeName, count }))
      .sort((a,b)=>b.count-a.count);

    // Top Main/Side Deck Cards — aggregated across whichever bracket decks
    // have cached YDK data. Coverage can be partial (a miner+ account has to
    // open a deck once for its cards to get cached) — decksWithCards/
    // totalDecks is returned so the client can disclose that honestly.
    // Optional ?deckType= narrows this one section down to just decks of a
    // single deck type (the Top Cards button's own filter, default "All" —
    // everything else on this endpoint — Deck Representation, Top Deck
    // Representation, the Matchup Matrix — is intentionally unaffected by
    // this filter, since it only makes sense for a per-deck-type card
    // breakdown).
    const cardDeckTypeFilter = (url.searchParams.get('deckType') || '').trim();
    const cardDecks = (cardDeckTypeFilter && cardDeckTypeFilter.toLowerCase() !== 'all')
      ? decks.filter(d => (d.deckTypeName || 'Unknown') === cardDeckTypeFilter)
      : decks;
    const mainCounts = {}, sideCounts = {};
    let decksWithCards = 0;
    for (const d of cardDecks) {
      if (!d.ydkData) continue;
      const parsedYdk = parseYdkPasscodes(d.ydkData);
      if (!parsedYdk) continue;
      decksWithCards++;
      for (const p of parsedYdk.main) mainCounts[p] = (mainCounts[p]||0) + 1;
      for (const p of parsedYdk.side) sideCounts[p] = (sideCounts[p]||0) + 1;
    }
    const topMainCards = Object.entries(mainCounts)
      .map(([passcode,count]) => ({ passcode:Number(passcode), count }))
      .sort((a,b)=>b.count-a.count).slice(0, 15);
    const topSideCards = Object.entries(sideCounts)
      .map(([passcode,count]) => ({ passcode:Number(passcode), count }))
      .sort((a,b)=>b.count-a.count).slice(0, 15);

    // Matchup Matrix — see function comment above the route for the honesty
    // caveat. Both sides of every counted match must be one of THIS event's
    // own bracket entries, so the matrix only ever shows deck types actually
    // entered in the event — a match whose opponent can't be matched to a
    // bracket entrant here (not a Duel Tools-tracked player, or their deck
    // couldn't be resolved) is left out rather than falling back to a guess
    // or an "Unknown" bucket.
    const cells = {}; // 'RowDeck|ColDeck' -> {wins, losses}
    let matchesCounted = 0;
    const bump = (rowDeck, colDeck, won) => {
      const key = rowDeck + '|' + colDeck;
      if (!cells[key]) cells[key] = { wins:0, losses:0 };
      if (won) cells[key].wins++; else cells[key].losses++;
    };
    for (const d of decks) {
      if (!d.builderName) continue;
      const playerEntry = findPlayerByBuilderName(d.builderName);
      if (!playerEntry) continue;
      const myDeckType = d.deckTypeName || 'Unknown';
      const names = playerNames(playerEntry);
      const batchIds = Object.values(db.batches)
        .filter(b => names.includes((b.player||'').toLowerCase()))
        .map(b => b.id);
      for (const bid of batchIds) {
        const b = db.batches[bid];
        if (!b || !b.replays) continue;
        for (const r of b.replays) {
          const evId = (r.eventLabel || r.eventId || '').toUpperCase().trim();
          if (evId !== code) continue;
          const p = r.parsed || {};
          const result = r.resultOverride || p.resultOverride || p.result || '';
          if (!/^[wl]/i.test(result)) continue; // only count decided matches
          const won = /^w/i.test(result);
          const oppName = r.oppName || p.oppName || '';
          const oppBracketDeck = decks.find(d2 => d2 !== d && oppName && isSameNameOrAlias(d2.builderName, oppName));
          if (!oppBracketDeck) continue; // opponent isn't one of this event's own bracket entries — skip rather than guess
          const oppDeckType = oppBracketDeck.deckTypeName || 'Unknown';
          bump(myDeckType, oppDeckType, won);
          matchesCounted++;
        }
      }
    }
    // Axis is restricted to the deck types actually entered in this event's
    // bracket (same set as Deck Representation above) — not whatever strings
    // happened to show up as an opponent's classified deck in a replay, which
    // can include decks/players outside this event's own entrant list.
    const deckAxis = [...new Set(decks.map(d => d.deckTypeName || 'Unknown'))]
      .sort((a,b) => (repCounts[b]||0) - (repCounts[a]||0));

    return json(res, 200, {
      code: ev.code,
      deckRepresentation,
      topDeckRepresentation,
      topDeckRepresentationN: TOP_N,
      cardStats: { main: topMainCards, side: topSideCards, decksWithCards, totalDecks: cardDecks.length, deckTypeFilter: cardDeckTypeFilter || 'All' },
      matchupMatrix: {
        decks: deckAxis,
        cells,
        matchesCounted,
        note: "Built only from replays on record for Duel Tools-tracked players in this event — not the full bracket (Format Library's event API doesn't expose match-by-match bracket pairings).",
      },
    });
  }

  // ── POST /api/events/backfill — admin: re-fetch placement/builder for
  // events we already have decklists for but imported before this feature
  // existed (so they're missing placement/builder/full-bracket data). Runs
  // in the background and reports progress via the change log; rate-limited
  // the same polite way the FL replay/decklist import already is. ─────────
  if (parts[0]==='events' && parts[1]==='backfill' && method==='POST') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    if (!flToken()) return json(res, 500, { error: 'FORMATLIBRARY_TOKEN not set in environment' });
    if (_eventsBackfillRunning) return json(res, 409, { error: 'A backfill is already running.' });

    // Every event code already in the server for a tracked player — this
    // means every code referenced by ANY replay (by far the biggest source:
    // a batch can have hundreds of replays with only a handful of actual
    // decklists saved), plus any code already attached as a decklist. Does
    // NOT pull in the full db.eventDates catalog (275+ historical codes,
    // most with zero connection to a tracked player) — that would turn this
    // into the full Format-Library-mirror option that was explicitly not
    // chosen for this feature.
    const codes = new Set();
    for (const p of Object.values(db.players)) {
      for (const d of (p.eventDecklists||[])) { if (d.code) codes.add(d.code.toUpperCase().trim()); }
    }
    for (const b of Object.values(db.batches)) {
      for (const d of (b.eventDecklists||[])) { if (d.code) codes.add(d.code.toUpperCase().trim()); }
      for (const r of (b.replays||[])) {
        const code = (r.eventLabel || r.eventId || '').toUpperCase().trim();
        if (code) codes.add(code);
      }
    }
    const codeList = [...codes].filter(Boolean);

    res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({ ok:true, message:'Backfill started for '+codeList.length+' event(s).', total: codeList.length }));

    _eventsBackfillRunning = true;
    (async () => {
      let touched = 0, failed = 0;
      for (const code of codeList) {
        try {
          const { status, body } = await flApiRequest('/api/events/subscriber/' + encodeURIComponent(code));
          if (status === 200) {
            const data = JSON.parse(body);
            const eventFormat = ((data.event && data.event.formatName) || '').toLowerCase();
            if (!eventFormat || eventFormat === 'goat') {
              if (captureEventTopDecks(code, data)) touched++;
              // Back-write place/builder onto every tracked player's own
              // eventDecklists entry for this code, now that we know it.
              const ev = db.events[code.toUpperCase()];
              if (ev) {
                for (const d of (ev.decks||[])) {
                  const playerEntry = findPlayerByBuilderName(d.builderName);
                  if (!playerEntry) continue;
                  const key = playerEntry.name.toLowerCase();
                  const reg = db.players[key];
                  if (reg && Array.isArray(reg.eventDecklists)) {
                    const entry = reg.eventDecklists.find(x => (x.code||'').toUpperCase() === code.toUpperCase());
                    if (entry) { entry.place = d.placement; entry.builder = d.builderName; }
                  }
                }
              }
            }
          } else if (status !== 404) {
            failed++;
          }
        } catch(e) { failed++; }
        await new Promise(r => setTimeout(r, 300)); // same polite pacing as the existing FL import loop
      }
      await saveDB(['events','players','eventDates']);
      console.log(`[events] Backfill complete — touched ${touched} event(s), ${failed} failed, out of ${codeList.length}.`);
      logChange(req, 'events_backfill', { totalEvents: codeList.length, touched, failed });
      _eventsBackfillRunning = false;
    })().catch(e => { console.error('[events] Backfill crashed:', e.message); _eventsBackfillRunning = false; });
    return;
  }

  // ── GET /api/events/backfill/status — poll whether a backfill is running ────
  if (parts[0]==='events' && parts[1]==='backfill' && parts[2]==='status' && method==='GET') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    return json(res, 200, { running: _eventsBackfillRunning });
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
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view the GFWL Archive' });
    return json(res, 200, db.gfwl);
  }

  // ── GET /api/gfwl/:season — get one season ────────────────────────────────
  if (parts[0]==='gfwl' && parts[1] && !parts[2] && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view the GFWL Archive' });
    return json(res, 200, db.gfwl[normalizeSeason(parts[1])] || {});
  }

  // ── GET /api/gfwl/:season/standings — precomputed per-team regular-season
  // record + highest-playoff-round-reached, computed here from batch data
  // already sitting in memory. The season overview grid used to need one
  // fetch per rostered player (200+ requests for a full season) just to
  // paint records/badges — this collapses that to a single request so the
  // grid can render instantly. See gfwlHighestPlayoffRoundSrv below for the
  // same schedule-is-source-of-truth + opponent-cross-check rules the
  // client's own team-page score computation uses, kept in sync manually.
  if (parts[0]==='gfwl' && parts[1] && parts[2]==='standings' && method==='GET') {
    if (isLimited(req)) return json(res, 403, { error: 'Limited accounts cannot view the GFWL Archive' });
    const season = normalizeSeason(parts[1]);
    const seasonData = db.gfwl[season];
    if (!seasonData) return json(res, 200, {});
    const seasonTeams = seasonData.teams || {};
    const seasonKey = season.toUpperCase();
    const allBatches = Object.values(db.batches);
    // Built once and reused for every team's round-outcome inference (see
    // gfwlInferRoundOpponentSrv) rather than per team/round.
    const playerTeamMap = gfwlSeasonPlayerTeamMapSrv(seasonTeams);
    const result = {};
    for (const [teamName, team] of Object.entries(seasonTeams)) {
      const rosterMap = gfwlRosterAliasMapSrv(team.roster||[]);
      const rosterNames = Object.keys(rosterMap);
      if (!rosterNames.length) { result[teamName] = { record:{w:0,l:0,total:0}, highestRound:null }; continue; }
      const rosterNameSet = new Set(rosterNames);
      const rosterBatches = allBatches.filter(b => rosterNameSet.has((b.player||'').toLowerCase()));
      result[teamName] = {
        record: computeTeamRegularSeasonRecordSrv(seasonKey, rosterBatches),
        highestRound: gfwlHighestPlayoffRoundSrv(seasonTeams, teamName, team, rosterBatches, playerTeamMap, seasonKey),
      };
    }
    return json(res, 200, result);
  }

  // ── GET /api/gfwl/:season/data-health — admin diagnostic for "this match
  // shows on one team's side but not the other" reports. For every
  // playoff-round replay recorded by a rostered player, this checks two
  // things: (1) does the recorded opponent resolve to ANY team's roster
  // this season (by canonical name or registered alias)? If not, that
  // opponent account isn't recognized as belonging to anyone — either it's
  // missing from a roster entirely, or it's an alt account of a real roster
  // player that was never linked as an alias via the Profiles tab. (2) when
  // the opponent DOES resolve to a real roster player, does that player's
  // own batch actually contain a mirrored copy of the same replay? If not,
  // the match was only ever recorded on one side (a cross-link gap), so the
  // OTHER team's Round Report will always come up short for it. Both are
  // exactly what makes a Wave table look "partially missing" on one side
  // while the other side shows the match fine.
  if (parts[0]==='gfwl' && parts[1] && parts[2]==='data-health' && method==='GET') {
    if (!isAdmin(req)) return json(res, 403, { error:'Admin only' });
    const season = normalizeSeason(parts[1]);
    const seasonData = db.gfwl[season];
    if (!seasonData) return json(res, 200, { unrecognizedOpponents:[], missingMirrors:[] });
    const seasonTeams = seasonData.teams || {};
    const seasonKey = season.toUpperCase();
    const playerTeamMap = gfwlSeasonPlayerTeamMapSrv(seasonTeams);
    const allBatches = Object.values(db.batches);
    // Index once by lowercased player name for the mirror-lookup below,
    // instead of re-filtering allBatches for every single replay.
    const batchesByPlayer = {};
    allBatches.forEach(b => {
      const p = (b.player||'').toLowerCase();
      if (!p) return;
      (batchesByPlayer[p] = batchesByPlayer[p] || []).push(b);
    });
    // A player can have more than one DuelingBook account (an alt linked as
    // an alias in Profiles). A replay's recorded opponent name is whichever
    // ONE account they played that specific match under — it is not
    // necessarily the same account their batch of matches happens to live
    // in. So checking for a mirror has to look across every known name for
    // that roster player (canonical + all aliases), not just the literal
    // name recorded on this one replay, or an otherwise-real mirror sitting
    // under the player's other account gets missed and wrongly flagged.
    // rosterAliasMapCache/nameGroupCache memoize this per team since the
    // same team is looked up repeatedly across many replays.
    const rosterAliasMapCache = {};
    const nameGroupCache = {}; // teamName -> Map(rosterEntry -> Set of all its names)
    function nameGroupsFor(tName) {
      if (nameGroupCache[tName]) return { rosterMap: rosterAliasMapCache[tName], groups: nameGroupCache[tName] };
      const t = seasonTeams[tName];
      const rosterMap = gfwlRosterAliasMapSrv((t && t.roster) || []);
      const groups = new Map();
      for (const [name, entry] of Object.entries(rosterMap)) {
        if (!groups.has(entry)) groups.set(entry, new Set());
        groups.get(entry).add(name);
      }
      rosterAliasMapCache[tName] = rosterMap;
      nameGroupCache[tName] = groups;
      return { rosterMap, groups };
    }

    const unrecognizedOpponents = [];
    const missingMirrors = [];
    const seenUnrecognized = new Set(); // dedupe: same replayId can be checked from both mirrored sides
    const seenMissingMirror = new Set();
    for (const [teamName, team] of Object.entries(seasonTeams)) {
      const { rosterMap } = nameGroupsFor(teamName);
      const rosterNames = new Set(Object.keys(rosterMap));
      if (!rosterNames.size) continue;
      const rosterBatches = allBatches.filter(b => rosterNames.has((b.player||'').toLowerCase()));
      for (const batch of rosterBatches) {
        for (const r of (batch.replays||[])) {
          const lbl = (r.eventLabel||'').toUpperCase().trim();
          const round = gfwlPlayoffRoundFromLabelInSeasonSrv(lbl, seasonKey);
          if (!round) continue; // not a playoff-round replay for this season
          const recordedOpponent = (r.parsed && r.parsed.oppName) || r.oppName || '';
          const oppName = recordedOpponent.toLowerCase().trim();
          if (!oppName) continue;
          const oppTeamName = playerTeamMap[oppName];
          if (!oppTeamName) {
            const dk = teamName+'|'+round+'|'+r.replayId;
            if (!seenUnrecognized.has(dk)) {
              seenUnrecognized.add(dk);
              unrecognizedOpponents.push({ team: teamName, player: batch.player, round, replayId: r.replayId, recordedOpponent });
            }
            continue;
          }
          if (oppTeamName === teamName) continue; // same-team pairing would be a data error of its own kind; skip here
          const { rosterMap: oppRosterMap, groups: oppGroups } = nameGroupsFor(oppTeamName);
          const oppEntry = oppRosterMap[oppName];
          const oppNames = oppEntry ? (oppGroups.get(oppEntry) || new Set([oppName])) : new Set([oppName]);
          const hasMirror = [...oppNames].some(n => (batchesByPlayer[n] || []).some(ob => (ob.replays||[]).some(orep => orep.replayId === r.replayId)));
          if (!hasMirror) {
            const mk = [teamName, oppTeamName].sort().join('|')+'|'+round+'|'+r.replayId;
            if (!seenMissingMirror.has(mk)) {
              seenMissingMirror.add(mk);
              missingMirrors.push({ team: teamName, player: batch.player, opponentTeam: oppTeamName, opponent: recordedOpponent, round, replayId: r.replayId });
            }
          }
        }
      }
    }
    return json(res, 200, { unrecognizedOpponents, missingMirrors });
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

  // ── Format Library scraper (miner+) ─────────────────────────────────────────
  // Uses a bearer token copied from a logged-in formatlibrary.com session
  // (FORMATLIBRARY_TOKEN env var on Railway — FL_TOKEN also accepted as an
  // alias) — same idea as DUELINGBOOK_SESSION_COOKIE, and it expires the
  // same way. Every FL call below returns a distinct, visible error (not
  // just a server log line) the moment FL responds 401, so a dead token is
  // obvious to whoever is running the import, not just to whoever happens
  // to check Railway logs.
  function flToken() { return process.env.FORMATLIBRARY_TOKEN || process.env.FL_TOKEN; }
  function flApiRequest(path) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const req2 = https.request({
        hostname: 'formatlibrary.com', path, method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + flToken(),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          'Referer': 'https://formatlibrary.com/replays/',
          'Origin': 'https://formatlibrary.com',
        }
      }, (r2) => {
        let buf = ''; r2.on('data', d => buf += d);
        r2.on('end', () => resolve({ status: r2.statusCode, body: buf }));
      });
      req2.on('error', reject);
      req2.setTimeout(15000, () => { req2.destroy(); reject(new Error('timeout')); });
      req2.end();
    });
  }
  const FL_EXPIRED_MSG = 'Format Library token expired or invalid — log back into formatlibrary.com, grab a fresh Authorization header (F12 → Network → any subscriber request → copy the header value), and update FORMATLIBRARY_TOKEN on Railway.';

  // ── GET /api/proxy/fl-replays?player=:name&aliases=:a,:b,:c ─────────────────
  // Paginates FL's own replay-subscriber API exactly like the standalone
  // Python scraper did, filtered down to GOAT-format rows.
  if (parts[0]==='proxy' && parts[1]==='fl-replays' && method==='GET') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above only' });
    if (!flToken()) return json(res, 500, { error: 'FORMATLIBRARY_TOKEN not set in environment' });
    const player = url.searchParams.get('player');
    if (!player) return json(res, 400, { error: 'player required' });
    // Checks the player's own registered name AND Duel Tools aliases on
    // Format Library itself, not just the one literal username typed in the
    // import box. A player can be recorded under more than one handle on FL
    // (an old username before a rename, a second account, a nickname a TO
    // typed slightly differently) — searching and matching only the single
    // "Format Library Username" field meant replays under any of those other
    // spellings were invisible here even when this app already knew they
    // were aliases of the same person (the aliases field only ever widened
    // the LOCAL "already saved?" dedup check, never the actual FL search).
    // `aliases` is optional and comma-separated — the client sends the
    // registry's known aliases plus whatever's typed in the Aliases field.
    const aliasesParam = (url.searchParams.get('aliases') || '').split(',').map(s => s.trim()).filter(Boolean);
    const searchNames = [...new Set([player, ...aliasesParam].filter(Boolean))];
    // Format Library's own 'player:or:' filter matches substrings (and
    // apparently un-word-bounded ones at that — searching "Chen" matches
    // "Grumplestielzchen" because it ends in "...zchen"), so every row FL
    // hands back has to be re-checked here against an EXACT username before
    // it's treated as this player's replay — exact against ANY of
    // searchNames, not fuzzy. Underscore/space is normalized the same way
    // the rest of the app treats FL usernames (isSameNameOrAlias et al.).
    const playerNorms = new Set(searchNames.map(n => n.trim().toLowerCase().replace(/_/g, ' ')));
    // Diagnostics — every row FL's own search returns before any filtering
    // here, and exactly which of the two filters below (format, then exact
    // name) dropped it, with a small sample of what it actually saw. Without
    // this, a gap between what the admin sees on Format Library's own site
    // and what this endpoint returns (e.g. "FL shows 46, we only get 20")
    // was invisible — the client only ever saw the final, already-filtered
    // `replays` array, with no way to tell whether the missing ones were a
    // different format (correctly excluded — this app is GOAT-only), a name
    // spelling FL has on file that doesn't exactly match what was searched
    // (a real, fixable gap), or something else entirely.
    let totalRowsSeen = 0, nonGoatCount = 0, nameMismatchCount = 0;
    const formatsSeen = new Set();
    const mismatchSamples = [];
    // pagesFetched / pageRowCounts — how many /api/replays/subscriber pages
    // we actually requested (summed across every name searched) and how many
    // raw rows each one came back with, before any local filtering. This is
    // the key signal for telling apart "FL really only has this many rows
    // for this filter" from "our own pagination loop stopped asking FL for
    // more pages too soon" — e.g. a report of "FL shows 46 but we only
    // import 20" with pagesFetched:2 and pageRowCounts:[10,10] means FL's
    // own API told us page 2 was the last page (returned exactly a full
    // page, then would need a page 3 request we never sent because
    // `rows.length < 10` only fires on a SHORT page — so a run that stops
    // exactly on a page boundary like this is the one case this loop can't
    // self-detect; pagesFetched/pageRowCounts make it visible here instead
    // of silently looking like "that's everything").
    let pagesFetched = 0;
    const pageRowCounts = [];
    // Hard cap on total pages fetched across EVERY searched name combined
    // (own name + every alias) for this one request. FL's 'player:or:'
    // filter is an un-word-bounded substring match (see the comment above —
    // "Chen" matches "Grumplestielzchen"), so a short/common handle, or a
    // player who's accumulated a long alias list over time, can make FL
    // hand back page after page of mostly false-positive rows that still
    // each cost a real round trip + the 250ms pacing below to page through.
    // Before this cap, that meant a single player's sync could legitimately
    // run for minutes without ever actually failing or timing out — exactly
    // the "still syncing the very first player for several minutes" symptom
    // reported live, which left a caller like eventsSyncAllPlayersFromFL's
    // bulk "Sync All Players" loop stuck on item 1/38 with no way forward.
    // 150 pages (1500 raw rows) is already far beyond what any real GOAT
    // player's match history should produce; hitting it is a sign FL's
    // search went broad, not that there's genuinely more to page through.
    const MAX_TOTAL_PAGES = 150;
    let truncated = false;
    try {
      const replays = [];
      const seenUrls = new Set(); // dedupe across multiple per-name searches — the same replay can surface under more than one searched name
      let eventDatesChanged = false;
      // One full paginated search per name (own name, then each alias) — FL's
      // substring filter is itself scoped to ONE name per request, so an
      // alias-only replay (neither side spelled exactly like `player`) would
      // never be found by searching `player` alone, no matter how the
      // exact-match check below is widened.
      outer:
      for (const searchName of searchNames) {
        let page = 1;
        while (true) {
          if (pagesFetched >= MAX_TOTAL_PAGES) { truncated = true; break outer; }
          const qs = new URLSearchParams({ page: String(page), limit: '10', sort: 'publishDate:desc,display:desc,roundAbs:desc', filter: 'player:or:' + searchName });
          const { status, body } = await flApiRequest('/api/replays/subscriber?' + qs.toString());
          if (status === 401) return json(res, 401, { error: FL_EXPIRED_MSG });
          if (status !== 200) return json(res, 502, { error: 'Format Library returned status ' + status });
          let rows;
          try { rows = JSON.parse(body); } catch(e) { return json(res, 502, { error: 'Format Library returned a non-JSON response' }); }
          pagesFetched++;
          pageRowCounts.push(Array.isArray(rows) ? rows.length : -1);
          if (!Array.isArray(rows) || !rows.length) break;
          for (const row of rows) {
            totalRowsSeen++;
            if ((row.formatName||'').toLowerCase() !== 'goat') {
              nonGoatCount++;
              if (row.formatName) formatsSeen.add(row.formatName);
              continue;
            }
            const winnerNorm = (row.winnerName||'').trim().toLowerCase().replace(/_/g, ' ');
            const loserNorm  = (row.loserName||'').trim().toLowerCase().replace(/_/g, ' ');
            if (!playerNorms.has(winnerNorm) && !playerNorms.has(loserNorm)) {
              // FL substring false-positive — not actually this player (or
              // any known alias). Sample a few of the actual name pairs seen
              // (capped so a very noisy substring match, e.g. a short/common
              // username, doesn't blow up the response) so a REAL near-miss
              // (a spelling variant that should be added as an alias) is
              // distinguishable from FL's search just casting a wide net.
              nameMismatchCount++;
              if (mismatchSamples.length < 8) mismatchSamples.push({ winner: row.winnerName||'', loser: row.loserName||'' });
              continue;
            }
            if (row.url && seenUrls.has(row.url)) continue; // already captured via a different searched name
            if (row.url) seenUrls.add(row.url);
            const eventId = row.eventAbbreviation || '';
            const replayDate = (row.publishDate||'').slice(0, 10);
            // Every replay carries its own event code + exact publish date, so
            // importing a player's replays is also a (free, incidental) way to
            // learn or correct that event's date in the shared catalog — the
            // same db.eventDates store that getEventDate()/sortEventKeys() on
            // the client use for the Year/Season filters and chronological
            // sorting everywhere else in the app.
            if (upsertEventDateFromFL(eventId, replayDate)) eventDatesChanged = true;
            replays.push({
              eventId,
              replayLink: row.url || '',
              round: row.roundName || '',
              winningPlayer: row.winnerName || '', winningDeck: row.winningDeckTypeName || '',
              losingPlayer: row.loserName || '', losingDeck: row.losingDeckTypeName || '',
              date: replayDate,
            });
          }
          if (rows.length < 10) break;
          page++;
          await new Promise(r => setTimeout(r, 250));
        }
      }
      if (eventDatesChanged) { try { await saveDB('eventDates'); } catch(e) { console.warn('[EventDates] Save after FL import failed:', e.message); } }
      if (truncated) console.warn(`[fl-replays] Hit the ${MAX_TOTAL_PAGES}-page cap searching for ${JSON.stringify(searchNames)} — results may be incomplete. This almost always means one of the searched names is short/common enough that Format Library's substring search is casting a very wide net, not that this player genuinely has that many matches.`);
      return json(res, 200, { ok: true, replays, truncated, diagnostics: {
        totalRowsSeen, nonGoatCount, nameMismatchCount,
        formatsSeen: [...formatsSeen], mismatchSamples,
        pagesFetched, pageRowCounts, searchNames, truncated,
      } });
    } catch(e) {
      return json(res, 502, { error: 'Format Library request failed: ' + e.message });
    }
  }

  // ── GET /api/proxy/fl-event/:eventId?player=:name ───────────────────────────
  // Looks up one event's top decks and returns the deck belonging to :player,
  // if any (matched the same way the standalone script matched it — case
  // insensitive, underscores treated as spaces).
  if (parts[0]==='proxy' && parts[1]==='fl-event' && parts[2] && method==='GET') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above only' });
    if (!flToken()) return json(res, 500, { error: 'FORMATLIBRARY_TOKEN not set in environment' });
    const eventId = decodeURIComponent(parts[2]);
    const player = (url.searchParams.get('player')||'').toLowerCase().replace(/_/g, ' ');
    try {
      const { status, body } = await flApiRequest('/api/events/subscriber/' + encodeURIComponent(eventId));
      if (status === 401) return json(res, 401, { error: FL_EXPIRED_MSG });
      if (status !== 200) return json(res, 502, { error: 'Format Library returned status ' + status });
      let data;
      try { data = JSON.parse(body); } catch(e) { return json(res, 502, { error: 'Format Library returned a non-JSON response' }); }
      const eventFormat = ((data.event && data.event.formatName) || '').toLowerCase();
      if (eventFormat && eventFormat !== 'goat') return json(res, 200, { ok: true, deck: null });
      // Learn the FULL bracket for the Events tab (see db.events comment up
      // top) every time this endpoint is hit, regardless of whether :player
      // has a deck in it — not just the one matched deck below.
      const capturedEvent = captureEventTopDecks(eventId, data);
      if (capturedEvent) { try { await saveDB(['events','eventDates']); } catch(e) { console.warn('[events] save after fl-event capture failed:', e.message); } }
      const decks = data.topDecks || [];
      const match = decks.find(d => ((d.builderName||'').toLowerCase().replace(/_/g, ' ')) === player);
      if (!match) return json(res, 200, { ok: true, deck: null });
      return json(res, 200, { ok: true, deck: { deckId: match.id, deckTypeName: match.deckTypeName || '', placement: match.placement || null, builderName: match.builderName || '' } });
    } catch(e) {
      return json(res, 502, { error: 'Format Library request failed: ' + e.message });
    }
  }

  // ── GET /api/proxy/fl-deck/:deckId — raw YDK text from Format Library ───────
  if (parts[0]==='proxy' && parts[1]==='fl-deck' && parts[2] && method==='GET') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above only' });
    if (!flToken()) return json(res, 500, { error: 'FORMATLIBRARY_TOKEN not set in environment' });
    const deckId = decodeURIComponent(parts[2]);
    try {
      const { status, body } = await flApiRequest('/api/decks/download/' + encodeURIComponent(deckId));
      if (status === 401) return json(res, 401, { error: FL_EXPIRED_MSG });
      if (status !== 200) return json(res, 502, { error: 'Format Library returned status ' + status });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(body);
    } catch(e) {
      return json(res, 502, { error: 'Format Library request failed: ' + e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // IMPORT EVENTS FROM FORMAT LIBRARY — admin picks one specific event (by
  // ID, or by browsing/searching FL's own public event list below) and this
  // pulls that event's FULL bracket: every player's YDK + their replays for
  // that one event, attached to whichever of those players already have a
  // profile (alias-aware), with everyone else getting a real but HIDDEN
  // batch created immediately (see the db.events comment near the top of
  // this file and autoMergeHiddenBatches above). Deliberately NOT a "mirror
  // all of Format Library" feature — same one-event-at-a-time scope the existing
  // single-player FL import already uses, just for every player in the
  // bracket instead of one.
  //
  // Replay fetching + parsing (loadReplay()/parseMatch()) only exists
  // client-side — there is no server-side replay parser to port (parseMatch
  // is pure client JS, confirmed nowhere referenced from server.js). So this
  // feature's heavy lifting (looping over the bracket, fetching each
  // player's replays, parsing them) runs CLIENT-side, the same way the
  // existing single-player FL import drives go(); these routes are the
  // server-side pieces that client loop calls into: browse FL's event list,
  // capture one event's full bracket + resolve it against existing
  // profiles, and store an unresolved player's already-parsed results.
  // ══════════════════════════════════════════════════════════════════════

  // ── GET /api/fl-import/browse?page=N — Format Library's own public event
  // list, filtered to GOAT, so an admin can pick an event instead of typing
  // a code blind. Confirmed-real endpoint (not a guess like
  // scrapeFormatLibraryEvents's 3 candidate URLs below): plain JSON array,
  // no pagination wrapper — each object's `abbreviation` field is the exact
  // code everything else in this file calls "eventId"/"code"
  // interchangeably (db.events is keyed by it).
  if (parts[0]==='fl-import' && parts[1]==='browse' && method==='GET') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above only' });
    if (!flToken()) return json(res, 500, { error: 'FORMATLIBRARY_TOKEN not set in environment' });
    const page = Math.max(1, parseInt(url.searchParams.get('page')||'1', 10) || 1);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: '25', sort: 'startedAt:desc' });
      const { status, body } = await flApiRequest('/api/events?' + qs.toString());
      if (status === 401) return json(res, 401, { error: FL_EXPIRED_MSG });
      if (status !== 200) return json(res, 502, { error: 'Format Library returned status ' + status });
      let rows;
      try { rows = JSON.parse(body); } catch(e) { return json(res, 502, { error: 'Format Library returned a non-JSON response' }); }
      if (!Array.isArray(rows)) return json(res, 502, { error: 'Unexpected response shape from Format Library' });
      const events = rows
        .filter(r => (r.formatName||'').toLowerCase() === 'goat')
        .map(r => ({
          code: r.abbreviation || '',
          name: r.name || '',
          date: (r.startedAt||'').slice(0, 10),
          size: r.size || null,
          winner: r.winnerName || null,
          alreadyInDatabase: !!(r.abbreviation && db.events[r.abbreviation.toUpperCase()]),
        }))
        .filter(e => e.code);
      return json(res, 200, { ok: true, events, page, hasMore: rows.length >= 25 });
    } catch(e) {
      return json(res, 502, { error: 'Format Library request failed: ' + e.message });
    }
  }

  // ── GET /api/fl-import/bracket/:eventId — full bracket for one event,
  // each deck annotated with whether a matching profile already exists
  // (matchedBatchId/matchedPlayerName) so the client can show a preview
  // ("N attach directly, M will be held pending") before committing to the
  // fetch-replays-for-everyone loop.
  if (parts[0]==='fl-import' && parts[1]==='bracket' && parts[2] && method==='GET') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above only' });
    if (!flToken()) return json(res, 500, { error: 'FORMATLIBRARY_TOKEN not set in environment' });
    const eventId = decodeURIComponent(parts[2]).toUpperCase();
    try {
      const { status, body } = await flApiRequest('/api/events/subscriber/' + encodeURIComponent(eventId));
      if (status === 401) return json(res, 401, { error: FL_EXPIRED_MSG });
      if (status === 404) return json(res, 404, { error: 'Format Library has no event with that ID.' });
      if (status !== 200) return json(res, 502, { error: 'Format Library returned status ' + status });
      let data;
      try { data = JSON.parse(body); } catch(e) { return json(res, 502, { error: 'Format Library returned a non-JSON response' }); }
      const eventFormat = ((data.event && data.event.formatName) || '').toLowerCase();
      if (eventFormat && eventFormat !== 'goat') return json(res, 400, { error: 'That event is not a GOAT-format event.' });
      const capturedEvent = captureEventTopDecks(eventId, data);
      if (capturedEvent) { try { await saveDB(['events','eventDates']); } catch(e) { console.warn('[fl-import] save after bracket capture failed:', e.message); } }
      const ev = db.events[eventId];
      const decks = (ev && ev.decks || []).map(d => {
        const matchedBatch = findBatchForBuilderName(d.builderName);
        return {
          deckId: d.deckId, builderName: d.builderName,
          placement: d.placement, placeNum: d.placeNum, deckTypeName: d.deckTypeName,
          matchedBatchId: matchedBatch ? matchedBatch.id : null,
          matchedPlayerName: matchedBatch ? matchedBatch.player : null,
        };
      }).sort((a,b) => { const an=(a.placeNum==null)?Infinity:a.placeNum, bn=(b.placeNum==null)?Infinity:b.placeNum; return an-bn; });
      return json(res, 200, { ok: true, code: eventId, name: ev?ev.name:'', date: ev?ev.date:'', size: ev?ev.size:decks.length, decks });
    } catch(e) {
      return json(res, 502, { error: 'Format Library request failed: ' + e.message });
    }
  }

  // ── POST /api/fl-import/pending — find-or-create a HIDDEN batch for a
  // player with no real profile yet, and attach this event's already-parsed
  // replays/YDK to it directly (via addReplayToBatchData — same dedup/
  // cross-link path a live import or a normal "add to batch" uses). Called
  // once per unresolved player by the client-side bracket-import loop, after
  // it has already fetched+parsed that player's replays for this event the
  // same way go() does for a live import. A hidden batch is a REAL batch —
  // it just doesn't show up in GET /api/batches (the Profiles grid) by
  // default — so this player's data is immediately visible everywhere else
  // (Format Data, Check & Fix Data, the Events tab) even before anyone
  // creates their "real" profile. See the db.events comment near the top of
  // this file and autoMergeHiddenBatches above for how this hidden batch
  // gets folded into a real profile the moment one is created or edited
  // with a matching name/alias.
  if (parts[0]==='fl-import' && parts[1]==='pending' && !parts[2] && method==='POST') {
    if (!isMiner(req)) return json(res, 403, { error: 'Miners and above only' });
    return readBody(req, async data => {
      const playerName = (data.playerName||'').trim();
      const eventId = (data.eventId||'').trim().toUpperCase();
      if (!playerName || !eventId) return json(res, 400, { error: 'playerName and eventId are required.' });

      let batch = Object.values(db.batches).find(b => b.hidden && isSameNameOrAlias(b.player, playerName));
      let created = false;
      if (!batch) {
        const id = crypto.randomUUID();
        batch = { id, name: playerName, player: playerName, aliases: [], replays: [], eventDecklists: [], createdAt: Date.now(), status: 'pending', hidden: true };
        db.batches[id] = batch;
        created = true;
      }

      const replays = Array.isArray(data.replays) ? data.replays : [];
      for (const replayData of replays) {
        try { await addReplayToBatchData(batch, replayData, req); }
        catch(e) { console.error('[fl-import] Failed to attach pending replay', replayData.replayId, 'for', playerName, ':', e.message); }
      }
      if (data.ydkData) {
        if (!batch.eventDecklists) batch.eventDecklists = [];
        // `code`, not `eventId` — every reader of an eventDecklists entry
        // (the client's getEventDecks/renderEventDecks, this file's own
        // computeEventStatus-adjacent code) keys off `.code`; an entry
        // stored under `.eventId` instead renders as a literal "undefined"
        // event on the player's profile once this hidden batch gets
        // promoted into a real one (see autoMergeHiddenBatches below). The
        // dupIdx check falls back to `.eventId` too, so an already-broken
        // legacy entry on this same hidden batch gets corrected in place
        // instead of duplicated.
        const dupIdx = batch.eventDecklists.findIndex(d => (d.code||d.eventId||'').toUpperCase() === eventId);
        const deckEntry = { code: eventId, ydkData: data.ydkData, importedAt: Date.now(), filename: `${playerName}-${eventId}.ydk` };
        if (dupIdx >= 0) batch.eventDecklists[dupIdx] = deckEntry; else batch.eventDecklists.push(deckEntry);
      }
      await saveBatchToPostgres(batch.id);
      logChange(req, created ? 'fl_import_hidden_batch_created' : 'fl_import_hidden_batch_updated', { batchId: batch.id, playerName, eventId, replayCount: replays.length, hasYdk: !!data.ydkData });
      return json(res, 200, { ok: true, batchId: batch.id, hidden: true });
    });
  }

  // ── GET /api/proxy/replay?id=:replayId ──────────────────────────────────────
  // Solves Cloudflare Turnstile via CapSolver, then POSTs to duelingbook view-replay
  if (parts[0]==='proxy' && parts[1]==='replay' && method==='GET') {
    const replayId = url.searchParams.get('id');
    if (!replayId) return json(res, 400, { error: 'id required' });

    // Serve from cache if we've already solved Turnstile and fetched this
    // exact replay before — for anyone. This is the single biggest win for
    // "loading in new parsed replays" feeling slow: a fresh CapSolver solve
    // can take anywhere from 5 to 90 seconds, and the same replay id often
    // gets fetched more than once (re-analysis, a different user importing
    // the same match, a retry after an unrelated error).
    const _cachedReplay = await getCachedReplay(replayId);
    if (_cachedReplay && (_cachedReplay.plays||[]).length) {
      return json(res, 200, { ok: true, replay: _cachedReplay, cached: true });
    }

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
      let taskRes = await httpsPost('api.capsolver.com', '/createTask', {
        clientKey: CAPSOLVER_API_KEY,
        task: {
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: DUELINGBOOK_URL,
          websiteKey: TURNSTILE_SITE_KEY,
        }
      });

      // Retry once if flagged
      if (taskRes.errorId && (taskRes.errorDescription||'').includes('600010')) {
        console.warn(`[proxy/replay] CapSolver 600010 on createTask for ${replayId} — waiting 5s and retrying`);
        await new Promise(r => setTimeout(r, 5000));
        taskRes = await httpsPost('api.capsolver.com', '/createTask', {
          clientKey: CAPSOLVER_API_KEY,
          task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: DUELINGBOOK_URL, websiteKey: TURNSTILE_SITE_KEY }
        });
      }

      if (taskRes.errorId) throw new Error('CapSolver createTask error: ' + taskRes.errorDescription);
      const taskId = taskRes.taskId;
      console.log(`[proxy/replay] CapSolver taskId=${taskId} for replay ${replayId}`);

      // Poll for solution (max 90s — Turnstile solves can take 40-60s+ under load)
      let token = null;
      let userAgent = null;
      let pollErrors = 0;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const resultRes = await httpsPost('api.capsolver.com', '/getTaskResult', { clientKey: CAPSOLVER_API_KEY, taskId });
        if (resultRes.status === 'ready') {
          token = resultRes.solution?.token;
          userAgent = resultRes.solution?.userAgent;
          break;
        }
        if (resultRes.errorId) {
          if ((resultRes.errorDescription||'').includes('600010')) {
            pollErrors++;
            if (pollErrors <= 3) {
              console.warn(`[proxy/replay] CapSolver 600010 during poll for ${replayId} (attempt ${pollErrors}) — waiting 5s`);
              await new Promise(r => setTimeout(r, 5000));
              continue;
            }
            // After 3 retries, abandon this task and create a fresh one with longer wait
            console.warn(`[proxy/replay] 600010 persisting for ${replayId} — creating new task after 10s wait`);
            await new Promise(r => setTimeout(r, 10000));
            const retryTaskRes = await httpsPost('api.capsolver.com', '/createTask', {
              clientKey: CAPSOLVER_API_KEY,
              task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: DUELINGBOOK_URL, websiteKey: TURNSTILE_SITE_KEY }
            });
            if (!retryTaskRes.errorId) {
              // Reset and poll new task
              token = null; pollErrors = 0;
              const newTaskId = retryTaskRes.taskId;
              for (let j = 0; j < 60; j++) {
                await new Promise(r => setTimeout(r, 1500));
                const nr = await httpsPost('api.capsolver.com', '/getTaskResult', { clientKey: CAPSOLVER_API_KEY, taskId: newTaskId });
                if (nr.status === 'ready') { token = nr.solution?.token; userAgent = nr.solution?.userAgent; break; }
                if (nr.errorId) break;
              }
              if (token) break;
            }
          }
          throw new Error('CapSolver poll error: ' + resultRes.errorDescription);
        }
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
        if ((retryData.plays||[]).length) cacheReplay(replayId, retryData);
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
          cacheReplay(replayId, masterData);
          return json(res, 200, { ok: true, replay: masterData });
        }
        // Still 0 plays — return what we have (may have other useful fields)
        console.warn(`[proxy/replay] ${replayId} still 0 plays after master=true retry. Full:`, JSON.stringify(replayData).slice(0, 300));
        return json(res, 200, { ok: true, replay: replayData });
      }

      cacheReplay(replayId, replayData);
      return json(res, 200, { ok: true, replay: replayData });

    } catch(e) {
      const is600010 = e.message && e.message.includes('600010');
      console.error(`[proxy/replay] Failed for ${replayId}:`, e.message, is600010 ? '— CapSolver bot flag, try again in a moment' : '');
      return json(res, 502, { error: is600010 ? 'CapSolver flagged as bot (error 600010). Wait a moment and retry — or check your CapSolver balance/account.' : e.message });
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

// ── Graceful shutdown ─────────────────────────────────────────────────────
// saveDB() with no arguments only flushes _ALWAYS_SAVE_KEYS (players, users,
// gfwl, eventDates, overrides, _changeLog, events) — 'batches' is
// deliberately NOT in that list (see saveDB's own comment: batches are
// written to their own per-row table, not serialized as one JSONB blob).
// Replay batch saves go through saveBatchToPostgres(), which is debounced
// 1.5s (BATCH_SAVE_DEBOUNCE_MS) and only actually hits Postgres once that
// timer fires — a POST /batches/:id/replay returns {ok:true} to the client
// the instant the write is QUEUED, not once it's durable. A redeploy sends
// SIGTERM to the old process; if that happened mid-debounce (e.g. a user
// adding replays in quick succession, each one re-arming the 1.5s timer),
// calling only saveDB() here silently dropped every batch still sitting in
// _dirtyBatches/_batchSaveQueue — replays the UI had already told the user
// were saved, gone for good the moment the old process exited. Flushing
// saveAllBatchesToPostgres() (dirty batches only, not a full re-save) here
// alongside saveDB() closes that gap for any ordinary graceful stop.
async function gracefulShutdown() {
  try {
    await Promise.all([ saveDB(), saveAllBatchesToPostgres() ]);
  } catch (e) {
    console.error('[shutdown] Save failed:', e.message);
  }
}
process.on('SIGINT',  () => { gracefulShutdown().then(() => process.exit(0)).catch(() => process.exit(1)); });
process.on('SIGTERM', () => { gracefulShutdown().then(() => process.exit(0)).catch(() => process.exit(1)); });

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


// ── GFWL playoff-round / wave / roster-alias logic — SERVER MIRROR of the
// client's implementation in public/index.html (gfwlPlayoffRoundFromLabel,
// gfwlPlayoffWaveNum, gfwlPlayoffOutcome, gfwlRosterAliasMap,
// computeTeamRegularSeasonRecord, computeTeamRoundOutcome,
// gfwlHighestPlayoffRound). Duplicated here (not shared via import — this is
// a single-file-per-side app with no build step) so /api/gfwl/:season/
// standings can compute the season grid's records/badges in one request
// instead of the client fetching every roster player's full batch
// individually. Keep in sync by hand if the client-side rules change.
const GFWL_PLAYOFF_ROUND_CODES_SRV = {
  'wildcard': 'WC',
  'top 16':   'T16',
  'top 10':   'T10',
  'top 8':    'T8',
  'top 4':    'T4',
  'top 2':    'T2',
  'finals':   'FINALS',
};
const GFWL_PLAYOFF_ROUND_ORDER_SRV = ['Wildcard','Top 8','Top 4','Finals'];

function gfwlPlayoffRoundFromLabelSrv(lbl) {
  const u = (lbl||'').toUpperCase().trim();
  if (!u) return null;
  const candidates = new Set([u]);
  if (u.includes(':')) candidates.add(u.split(':').slice(1).join(':').replace(/\s+/g,' ').trim());
  const stripped = u.replace(/^S\d+\s*:?\s*/, '').trim();
  if (stripped) candidates.add(stripped);
  for (const cand of candidates) {
    if (!cand) continue;
    for (const key of Object.keys(GFWL_PLAYOFF_ROUND_CODES_SRV)) {
      if (cand === key.toUpperCase()) return key;
    }
    for (const [key, code] of Object.entries(GFWL_PLAYOFF_ROUND_CODES_SRV)) {
      if (cand === code || cand.startsWith(code+'-') || cand.startsWith(code+' ')) return key;
    }
  }
  return null;
}

// Season-aware mirror of the client's gfwlPlayoffRoundFromLabelInSeason —
// see that function's comment for the full reasoning. gfwlPlayoffRoundFromLabelSrv
// deliberately strips any leading "S#:" prefix without checking its value,
// so a label from a completely different season collapses to the same
// round code. A batch holds every match a player has ever played across
// every season, so a round-outcome computation for S9 must reject a label
// that explicitly says "S8:" (or any other season) rather than silently
// counting it — otherwise a team that never made the S9 playoffs could get
// credited with a round via a player's stray prior-season data.
function gfwlPlayoffRoundFromLabelInSeasonSrv(lbl, seasonKey) {
  const u = (lbl||'').toUpperCase().trim();
  if (!u || !seasonKey) return gfwlPlayoffRoundFromLabelSrv(u);
  const sMatch = u.match(/^S(\d+)\s*:?\s*/);
  if (sMatch && ('S'+sMatch[1]) !== seasonKey.toUpperCase()) return null;
  return gfwlPlayoffRoundFromLabelSrv(u);
}

function gfwlPlayoffWaveNumSrv(label) {
  const u = (label||'').toUpperCase();
  const m = u.match(/WV\s*-?\s*(\d+)/) || u.match(/WAVE\s*(\d+)/);
  if (m) return parseInt(m[1], 10) || 1;
  return 1;
}

function gfwlPlayoffOutcomeSrv(roundReplays) {
  const list = roundReplays || [];
  const byWave = {};
  list.forEach(x => {
    const wv = gfwlPlayoffWaveNumSrv(x.label);
    if (!byWave[wv]) byWave[wv] = [];
    byWave[wv].push(x);
  });
  const waveNums = Object.keys(byWave).map(Number).sort((a,b) => a-b);
  const wave1 = waveNums.length ? byWave[waveNums[0]] : [];
  const wave1Players = new Set(wave1.map(x => x.player.toLowerCase()));
  const eliminated = new Set();
  list.forEach(x => {
    const r = x.replay || {};
    const effRes = r.resultOverride || (r.parsed && r.parsed.resultOverride) || (r.parsed && r.parsed.result) || r.result || null;
    if (effRes === 'l') eliminated.add(x.player.toLowerCase());
  });
  const remaining = [...wave1Players].filter(p => !eliminated.has(p));
  const fullyEliminated = wave1Players.size > 0 && remaining.length === 0;
  return { fullyEliminated, hasData: list.length > 0 };
}

// Resolves both a roster player's canonical name AND all their registered
// aliases (db.players[canon].aliases) to the same roster entry — a batch
// recorded under a player's secondary account is still recognized as this
// roster player.
function gfwlRosterAliasMapSrv(roster) {
  const map = {};
  for (const re of (roster||[])) {
    const canon = (re.player||'').toLowerCase().trim();
    if (!canon) continue;
    map[canon] = re;
    const entry = db.players[canon];
    (entry ? (entry.aliases||[]) : []).forEach(a => {
      const al = (a||'').toLowerCase().trim();
      if (al) map[al] = re;
    });
  }
  return map;
}

function gfwlResolveTeamSrv(seasonTeams, nameOrAlias) {
  if (!nameOrAlias) return null;
  const q = nameOrAlias.toLowerCase().trim();
  for (const [tName, tData] of Object.entries(seasonTeams)) {
    if (tName.toLowerCase() === q) return tName;
    if ((tData.aliases||[]).some(a => a.toLowerCase() === q)) return tName;
    if (tName.toLowerCase().includes(q) || q.includes(tName.toLowerCase())) return tName;
  }
  return null;
}

// Regular-season-only record — excludes any playoff-round replay even if it
// carries a season prefix out of habit (e.g. "S9: T8-WV1").
function computeTeamRegularSeasonRecordSrv(seasonKey, rosterBatches) {
  let w = 0, l = 0;
  for (const batch of rosterBatches) {
    for (const r of (batch.replays||[])) {
      const lbl = (r.eventLabel||'').toUpperCase();
      const isSeasonPrefixed = lbl.startsWith(seasonKey+':') || lbl.startsWith(seasonKey+' ') || lbl===seasonKey;
      if (!isSeasonPrefixed) continue;
      if (gfwlPlayoffRoundFromLabelSrv(lbl) !== null) continue; // playoff match — exclude
      const effResult = r.resultOverride || (r.parsed && r.parsed.resultOverride) || (r.parsed && r.parsed.result) || null;
      if (effResult === 'w') w++;
      else if (effResult === 'l') l++;
    }
  }
  return { w, l, total: w+l };
}

// Season-wide reverse index: lowercased player name (canonical or alias) ->
// the name of the team whose roster they're on. Used to figure out which
// team a recorded opponent actually plays for when a team has no schedule
// entry for a round to cross-check against (see gfwlInferRoundOpponentSrv).
function gfwlSeasonPlayerTeamMapSrv(seasonTeams) {
  const map = {};
  for (const [tName, t] of Object.entries(seasonTeams)) {
    Object.keys(gfwlRosterAliasMapSrv(t.roster||[])).forEach(n => { if (!(n in map)) map[n] = tName; });
  }
  return map;
}

// Figures out which OTHER team a set of round-tagged replays for `teamName`
// were actually played against — mirrors the client's
// gfwlInferRoundOpponent exactly, so this endpoint never disagrees with
// what a team's own page shows. Prefers the team's own schedule entry for
// the round when one is on file; when it isn't (schedule metadata for
// playoff rounds isn't always filled in even for teams that genuinely
// played), infers it from the replay data itself by resolving each
// candidate's recorded opponent to whichever team's roster they're
// actually on and trusting whichever team accounts for the most matches.
function gfwlInferRoundOpponentSrv(seasonTeams, teamName, team, round, candidates, playerTeamMap) {
  const schEntry = (team.schedule||[]).find(s => String(s.week).toLowerCase() === round.toLowerCase());
  if (schEntry && schEntry.opponent) {
    const resolvedName = gfwlResolveTeamSrv(seasonTeams, schEntry.opponent) || schEntry.opponent;
    const oppTeam = seasonTeams[resolvedName];
    if (oppTeam) return { oppTeamName: resolvedName, oppRosterMap: gfwlRosterAliasMapSrv(oppTeam.roster||[]) };
  }
  const counts = {};
  candidates.forEach(c => {
    const r = c.replay || {};
    const oName = ((r.parsed && r.parsed.oppName) || r.oppName || '').toLowerCase().trim();
    const oTeam = playerTeamMap[oName];
    if (oTeam && oTeam !== teamName) counts[oTeam] = (counts[oTeam]||0) + 1;
  });
  const ranked = Object.entries(counts).sort((a,b) => b[1]-a[1]);
  if (!ranked.length) return null;
  const inferredName = ranked[0][0];
  const inferredTeam = seasonTeams[inferredName];
  if (!inferredTeam) return null;
  return { oppTeamName: inferredName, oppRosterMap: gfwlRosterAliasMapSrv(inferredTeam.roster||[]) };
}

// One playoff round's outcome for a team. A round tag on a replay alone
// ("T8-WV1") is never proof the team actually reached that round — it could
// be a stray/mistagged replay from an unrelated pairing (a scrimmage, a
// copy-pasted label, cross-season leftovers) — so every candidate is
// checked against the inferred real opponent's roster (see
// gfwlInferRoundOpponentSrv) before counting.
function computeTeamRoundOutcomeSrv(seasonTeams, teamName, team, round, rosterBatches, playerTeamMap, seasonKey) {
  const target = round.toLowerCase().replace(/\s+/g,' ').trim();
  const candidates = [];
  for (const batch of rosterBatches) {
    for (const r of (batch.replays||[])) {
      const lbl = (r.eventLabel||'').toUpperCase().trim();
      if (gfwlPlayoffRoundFromLabelInSeasonSrv(lbl, seasonKey) !== target) continue;
      candidates.push({ player: batch.player, replay: r, label: lbl });
    }
  }
  if (!candidates.length) return { hasData:false, fullyEliminated:false };
  const inferred = gfwlInferRoundOpponentSrv(seasonTeams, teamName, team, round, candidates, playerTeamMap);
  if (!inferred) return { hasData:false, fullyEliminated:false };
  const roundReplays = candidates.filter(c => {
    const r = c.replay || {};
    const oName = ((r.parsed && r.parsed.oppName) || r.oppName || '').toLowerCase().trim();
    return !!inferred.oppRosterMap[oName];
  });
  const outcome = gfwlPlayoffOutcomeSrv(roundReplays);
  return { hasData: roundReplays.length > 0, fullyEliminated: outcome.fullyEliminated };
}

function gfwlHighestPlayoffRoundSrv(seasonTeams, teamName, team, rosterBatches, playerTeamMap, seasonKey) {
  let highest = null;
  for (const round of GFWL_PLAYOFF_ROUND_ORDER_SRV) {
    const outcome = computeTeamRoundOutcomeSrv(seasonTeams, teamName, team, round, rosterBatches, playerTeamMap, seasonKey);
    if (!outcome.hasData) break;
    highest = round;
    if (outcome.fullyEliminated) break;
  }
  return highest;
}

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
// Values may be either a bare year ('2026' — coarse fallback, sorts as Jan 1
// of that year) or an exact 'YYYY-MM-DD' date pulled straight from Format
// Library's Event Database (https://formatlibrary.com/events). Exact dates
// are what let events within the same year sort in their true chronological
// order instead of tying at the same Jan-1 placeholder — always prefer an
// exact date over a bare year when one is known.
const EVENT_DATE_CATALOG = {
  'PWCQ90': '2026-08-09',
  'PWCQ89': '2026-07-26',
  'FLC41': '2026-07-20',
  'GFCEU26': '2026-07-11',
  'PWCQ88': '2026-06-13',
  'SESB18': '2026-06-12',
  'CLASH26': '2026-06-06',
  'GWW02': '2026-05-30',
  'PWCQ87': '2026-05-23',
  'FLC40': '2026-05-18',
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

// Best-effort numeric placement, regardless of whether Format Library sends
// it as a bare number (1, 2) or an ordinal string ("1st", "T-9th"). Used
// both to detect the event winner (placement 1) and for display.
function placementNum(p) {
  if (p === null || p === undefined) return null;
  const m = String(p).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Decodes a cached deck's base64 .ydk text and splits it into main/side
// passcode lists — mirrors the client-side parsing in eventsRenderDeckCards,
// used server-side to aggregate card stats across a whole event's bracket.
function parseYdkPasscodes(ydkBase64) {
  let text;
  try { text = Buffer.from(ydkBase64, 'base64').toString('utf8'); } catch(e) { return null; }
  const main = [], side = [];
  let sec = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '#main') { sec='main'; continue; }
    if (t === '#extra') { sec='extra'; continue; }
    if (t === '!side') { sec='side'; continue; }
    if (t.startsWith('#') || t.startsWith('!')) { sec=null; continue; }
    if (/^\d+$/.test(t)) {
      const p = parseInt(t, 10);
      if (sec==='main') main.push(p);
      else if (sec==='side') side.push(p);
    }
  }
  return { main, side };
}

// Learns a full event's top-decks bracket from Format Library's
// /api/events/subscriber/:eventId response (see GET /api/proxy/fl-event/
// below) and merges it into db.events[code]. Called every time ANY
// Duel-Tools-tracked player's decklist lookup touches this event code —
// so db.events only ever grows for events a tracked player actually
// played in (see the db.events comment near the top of this file), but
// once it does, the FULL bracket is captured (every builder FL lists, not
// just the one matched player), which is what lets the Events tab show a
// complete decklist gallery and an accurate winner.
// flData is the parsed JSON body from /api/events/subscriber/:eventId —
// shape observed so far: { event: { formatName, ... }, topDecks: [ { id,
// builderName, deckTypeName, placement } ] }. Format Library doesn't
// document this endpoint anywhere we have access to, so every field read
// here is defensive — a missing/renamed field degrades gracefully instead
// of throwing.
function captureEventTopDecks(code, flData) {
  try {
    const c = (code||'').toUpperCase().trim();
    if (!c || !flData) return false;
    const rawDecks = Array.isArray(flData.topDecks) ? flData.topDecks : [];
    if (!rawDecks.length) return false; // nothing worth storing yet

    if (!db.events) db.events = {};
    const existing = db.events[c] || { code: c, decks: [] };
    const ev = flData.event || {};

    // Format Library's own entrant-count field name isn't known for certain
    // — try the common possibilities. Falls back to the top-decks count
    // (a lower bound: FL's own "Size" column counts every entrant, while
    // this endpoint typically only returns the top cut).
    const sizeCandidates = [ev.numEntrants, ev.entrantCount, ev.playerCount, ev.numPlayers, ev.totalPlayers, ev.participants, ev.entrants, ev.size, flData.numEntrants, flData.entrantCount, flData.size];
    const foundSize = sizeCandidates.find(v => typeof v === 'number' && v > 0);

    const decks = rawDecks.map(d => {
      const prior = (existing.decks||[]).find(x => String(x.deckId) === String(d.id));
      const priorSource = prior && prior.deckTypeSource;
      // OUR classification (from a decklist's own cards, or as a fallback
      // from cards seen in replays — see upsertEventDeckType) always
      // outranks Format Library's own deckTypeName string. A routine
      // re-capture of this bracket must never regress an already-classified
      // deck back to whatever FL happens to label it — FL's value is only
      // ever used as the lowest-priority fallback, same priority rule
      // upsertEventDeckType enforces for its two sources.
      const ourClassification = (priorSource === 'decklist' || priorSource === 'replay') ? prior.deckTypeName : null;
      return {
        deckId: d.id,
        builderName: d.builderName || '',
        placement: (d.placement != null) ? d.placement : null,
        placeNum: placementNum(d.placement),
        deckTypeName: ourClassification || d.deckTypeName || (prior && prior.deckTypeName) || '',
        deckTypeSource: ourClassification ? priorSource : (d.deckTypeName ? 'fl' : ((prior && prior.deckTypeSource) || null)),
        ydkData: (prior && prior.ydkData) || undefined, // keep any YDK already cached for this deck
        updatedAt: Date.now(),
      };
    });

    const winnerDeck = decks.find(d => d.placeNum === 1);

    db.events[c] = {
      code: c,
      name: ev.name || ev.eventName || existing.name || '',
      date: ((ev.date || ev.startDate || '')+'').slice(0,10) || existing.date || '',
      size: foundSize || existing.size || decks.length,
      winner: winnerDeck ? winnerDeck.builderName : (existing.winner || null),
      decks,
      updatedAt: Date.now(),
    };
    // Also feed any real date FL gave us for this event into the shared
    // eventDates catalog (db.eventDates / upsertEventDateFromFL) — that's
    // the store getEventDate()/_recordYear() on the client actually read
    // from for Year/Season filtering and chronological sorting everywhere
    // (Format Data, Profiles, RPS, Deck Viewer, Power Rankings, etc). Before
    // this, a brand-new event code learned here (via Import Event Data/
    // Import Event Decks on a batch, or an admin events backfill) only ever
    // showed up correctly in the Events tab's own gallery — every other
    // page kept treating it as undated until someone separately ran the FL
    // replay-import flow for a player or hand-edited the static catalog.
    if (db.events[c].date) upsertEventDateFromFL(c, db.events[c].date);
    return true;
  } catch(e) {
    console.error('[events] captureEventTopDecks failed for', code, ':', e.message);
    return false;
  }
}

// Record an event's date as learned from a real, individual FL replay (the
// per-player replay scraper, not the admin-only events-list scrape below).
// Only upgrades a missing or coarse 'catalog' entry — never clobbers an
// entry we already trust more (a direct FL events-API or HTML scrape).
function upsertEventDateFromFL(code, date) {
  if (!db.eventDates) db.eventDates = {};
  const c = (code||'').toUpperCase().trim();
  if (!c || !date) return false;
  const existing = db.eventDates[c];
  if (!existing || existing.source === 'catalog') {
    db.eventDates[c] = { date, name: (existing && existing.name) || '', source: 'fl-replay-import' };
    return true;
  }
  return false;
}

// Build the event date catalog from CSV-sourced data into db.eventDates.
// Catalog values are either a bare year ('2026') or an exact 'YYYY-MM-DD'.
function buildEventCatalog() {
  let added = 0;
  for (const [code, val] of Object.entries(EVENT_DATE_CATALOG)) {
    const dateStr = /^\d{4}$/.test(val) ? val + '-01-01' : val;
    const existing = db.eventDates[code];
    if (!existing) {
      db.eventDates[code] = { date: dateStr, source: 'catalog' };
      added++;
    } else if (existing.source === 'catalog' && existing.date !== dateStr) {
      // Upgrade a coarse year-only placeholder (or a stale catalog value)
      // with a more precise one — e.g. once we learn the exact date for a
      // code we previously only had the year for. Never overwrites a
      // 'formatlibrary-live'-sourced entry, which is already authoritative.
      db.eventDates[code] = { date: dateStr, source: 'catalog' };
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
