// Duel Tools extension — background service worker.
//
// Two responsibilities:
//
//  1) Two-phase content script injection into DuelingBook tabs. The shim
//     (installShim, below — chrome.storage/chrome.runtime-backed
//     GM_getValue/GM_setValue/GM_xmlhttpRequest, plus an unsafeWindow
//     stand-in fed by page-bridge.js) must finish its async storage
//     preload BEFORE the actual tracker scripts run, since those files are
//     the EXACT, unmodified userscripts — the same files Tampermonkey used
//     to run — and they call GM_getValue synchronously the moment they
//     start. A static content_scripts array in manifest.json can't
//     guarantee that ordering: Chrome injects each listed file in order,
//     but doesn't wait for one file's async work to finish before starting
//     the next. chrome.scripting.executeScript calls, awaited in sequence
//     here instead, do guarantee it — an async `func` isn't considered
//     finished until its returned promise resolves.
//
//  2) Relaying GM_xmlhttpRequest calls (which the shim turns into
//     chrome.runtime messages) as real cross-origin fetches. That's done
//     here, not in the content script, because a service worker isn't
//     bound by a page's own CSP/CORS the way an isolated-world content
//     script's own fetch still can be — this mirrors what
//     GM_xmlhttpRequest's cross-origin bypass gave the original userscript
//     for free under Tampermonkey.

const TRACKER_FILES = ['dt-live-tracker.user.js', 'dt-save-prompt.user.js', 'dt-unlock.user.js', 'dt-replay-hand-view.user.js'];
// dt-replay-hand-view.user.js rides in TRACKER_FILES, not its own injectPhase
// call, on purpose: a dedicated 'replay-hand-view' phase (and, before that,
// a manifest.json-declared content script) both mysteriously never fired on
// /replay?id=... pages specifically, for reasons never root-caused, while
// this exact TRACKER_FILES injection call has fired reliably on that same
// route in every test run. The file self-gates (it just polls for a radio
// group that only exists on a replay page and times out harmlessly if it's
// not there), so riding along here on every page load is safe.
const RELAY_FILE = 'relay.user.js';
// Replay-only, like RELAY_FILE — adds Game 1/2/3 jump + Rewind Play buttons
// to DuelingBook's own replay viewer. Kept as its own file/phase (not added
// to TRACKER_FILES) since it only ever makes sense on a /replay* page.
const REPLAY_CONTROLS_FILE = 'dt-replay-controls.user.js';
// MAIN-world engine behind REPLAY_CONTROLS_FILE's UI — takes the actual
// board-state snapshots and drives window.initDuel for real rewinds (see
// that file's own header comment for why it exists instead of the simpler
// stepBackwardE() this project used at first). Injected as early as
// possible, right alongside page-bridge.js, BEFORE the tracker files and
// before REPLAY_CONTROLS_FILE — it has to win a real race against
// DuelingBook's own loadReplayComplete() call so it can capture the
// replay's full play list and pristine JSON the moment the page loads.
// Every other MAIN-world hook in this file (initializeDeckCards, via
// page-bridge.js) is proof that this injection point reliably gets there
// before the page's own equivalent calls fire.
const REPLAY_ENGINE_FILE = 'dt-replay-engine.js';
// Replay-only, isolated world, its own phase for the same crash-isolation
// reason as REPLAY_CONTROLS_FILE — a small, independent feature (picks a
// default among DuelingBook's own Hide Hands/Show Hand/Show Both radio
// options once per page load) that has nothing to do with the replay
// engine/controls above and shouldn't be able to take them down or be
// taken down by them.
//
// Default Replay Hand View now lives in TRACKER_FILES above, not its own
// const/phase here — see the comment on TRACKER_FILES for why.
// "Playing" category features (Hot Keys, and whatever else lands in that
// category) — the opposite scope from REPLAY_CONTROLS_FILE: duelingbook.com
// pages that are NOT /replay*. Kept as its own injection phase for the same
// reason REPLAY_CONTROLS_FILE is: a bug in one can't take down the other.
// dt-transparent-facedowns.user.js is the tiny isolated-world settings
// relay for Transparent Facedowns — no UI of its own, just reads the
// toggle/opacity settings and postMessages them to
// TRANSPARENT_FACEDOWNS_ENGINE_FILE (MAIN-world, injected separately
// below — it needs direct access to player1/player2, which only exists
// in the page's own MAIN world).
// dt-choose-zones.user.js needs no MAIN-world access at all — it just
// drives DuelingBook's own real #choose_zones_cb checkbox with a genuine
// .click(), entirely from the isolated world, same as dt-hotkeys.user.js.
// dt-rps-automation.user.js decides WHEN/WHICH card from the isolated
// world (that's where its GM_getValue settings live), but hands the
// actual click off to RPS_ENGINE_FILE (MAIN world, injected below) —
// confirmed live that the isolated world's own dispatchEvent calls on
// these specific cards are unreliable, where the identical calls from
// MAIN world are not.
// dt-auto-hand-shuffle.user.js decides WHEN to shuffle (phase-bar edge
// detection + duel-log "added to hand" lines) entirely from the isolated
// world, then hands the actual shuffle off to HAND_SHUFFLE_ENGINE_FILE
// (MAIN world, injected below) — same split as RPS Automation/Transparent
// Facedowns, for the same reason: window.shuffleHandE() and
// window.turn_player both only exist in the MAIN world.
const PLAYING_FILES = ['dt-hotkeys.user.js', 'dt-card-tracking.user.js', 'dt-duel-commands.user.js', 'dt-transparent-facedowns.user.js', 'dt-choose-zones.user.js', 'dt-rps-automation.user.js', 'dt-auto-hand-shuffle.user.js'];
// MAIN-world click engine for RPS Automation — see dt-rps-engine.js's own
// header for the full story.
const RPS_ENGINE_FILE = 'dt-rps-engine.js';
// MAIN-world engine for Transparent Facedowns — same early injection
// timing as SPECTATE_ENGINE_FILE/REPLAY_ENGINE_FILE (alongside
// page-bridge.js) since it needs player1/player2 to exist; unlike those
// two it doesn't race any particular DuelingBook call, so being early is
// just for consistency, not correctness.
const TRANSPARENT_FACEDOWNS_ENGINE_FILE = 'dt-transparent-facedowns-engine.js';
// MAIN-world engine for Auto Hand Shuffling — same reasoning/timing as its
// siblings above: harmless no-op until a shuffle request actually arrives
// via postMessage, so there's no race to win by injecting it this early;
// just consistent with how every other such engine file is injected here.
const HAND_SHUFFLE_ENGINE_FILE = 'dt-hand-shuffle-engine.js';
// MAIN-world engine for Automatically Skip Opening Cinematic — same
// reasoning/timing as its siblings above.
const SKIP_CINEMATIC_ENGINE_FILE = 'dt-skip-cinematic-engine.js';
// "Enable Replays While Spectating" — dt-replay-engine.js's live-duel
// counterpart. REPLAY_ENGINE_FILE only ever runs on an already-finished
// /replay* page with the whole match pre-loaded; this pair runs on the
// regular duelingbook.com root and builds its OWN snapshot history as a
// real, still-ongoing match plays out, strictly while actually spectating
// (never for a player in their own duel — both files independently check
// this live, not just on a setting). SPECTATE_ENGINE_FILE is MAIN-world,
// same injection timing as REPLAY_ENGINE_FILE (as early as possible,
// alongside page-bridge.js) since it hooks endAction/saveGamestate/
// initDuel the same way; SPECTATE_CONTROLS_FILE is the isolated-world UI,
// gated on the dt_spectate_replay_enabled setting (off by default).
const SPECTATE_ENGINE_FILE = 'dt-spectate-engine.js';
const SPECTATE_CONTROLS_FILE = 'dt-spectate-controls.user.js';
// "Lobby Customization" category (Room Visibility, and whatever else lands
// in that category later) — own phase, own crash isolation, same reasoning
// as PLAYING_FILES/SPECTATE_CONTROLS_FILE. Isolated world, no MAIN-world
// access needed: Room Visibility only ever reassigns `left`/`display` on
// the lobby's own elements, confirmed live to need nothing DuelingBook's
// own JS exposes (see dt-room-visibility.user.js's header).
const LOBBY_FILES = ['dt-room-visibility.user.js', 'dt-hosted-duel-settings.user.js', 'dt-ranked-duelist-pool-settings.user.js'];
// Universal, isolated-world, unconditional — like TRACKER_FILES, these make
// sense on every duelingbook.com page (both self-guard on their own
// settings + page structure, so they're a no-op anywhere their target
// element doesn't exist). dt-goat-errata-data.js MUST come before
// dt-historical-text.user.js in this array: chrome.scripting executes a
// `files` array in order within one call, and the data file's unprefixed
// `window.DT_GOAT_ERRATA_TEXT =` assignment has to exist before the
// historical-text script reads it.
const DECK_BUILDING_FILES = ['dt-goat-errata-data.js', 'dt-historical-text.user.js', 'dt-default-card-pool.user.js', 'dt-deck-folders.user.js', 'dt-deck-version-history.user.js', 'dt-organize-decklists.user.js'];
// "Appearance Customization" category — universal and unconditional like
// TRACKER_FILES/DECK_BUILDING_FILES, injected on BOTH the replay and
// non-replay branches below (not just one), since the avatar elements
// Custom Emotes targets (div.duel_avatar's .think img / .bubbles div) show
// up in replays and while spectating too, not just a player's own live
// duel. Isolated world, no MAIN-world access needed — see
// dt-custom-emotes.user.js's own header for exactly what DOM it touches.
const APPEARANCE_FILES = ['dt-custom-emotes.user.js', 'dt-skip-opening-cinematic.user.js', 'dt-custom-colors-grid.user.js'];

// ── Phase 1: the shim — injected via `func`, not `files`, specifically so
// its returned promise is actually awaited before phase 2 starts. Must be
// fully self-contained: Chrome serializes this function to inject it, so
// it cannot close over anything from this file's outer scope.
async function installShim() {
  if (window.__dtShimInstalled) return;
  window.__dtShimInstalled = true;

  const cache = await chrome.storage.local.get(null);

  window.GM_getValue = function (key, def) {
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : def;
  };
  window.GM_setValue = function (key, val) {
    cache[key] = val;
    chrome.storage.local.set({ [key]: val });
  };
  // Likely root cause of "I toggled it in Settings but it's not doing
  // anything on the page": every GM_getValue-reading script (Historical
  // Card Text, Default Card Pool, Card Stats, etc.) only ever reads from
  // THIS tab-load's one-time `cache` snapshot, taken the instant this shim
  // installed. The Settings page writes straight to chrome.storage.local
  // (confirmed in dt-settings.js), which is correct — but a DuelingBook
  // tab that was already open when you flipped a toggle never heard about
  // it, and on a single-page site that doesn't always do a full
  // navigation between "pages" (lobby → deck constructor → a duel can all
  // be the same tab the whole time), that stale snapshot can persist
  // across everything you try in that tab, not just the page you were on
  // when you toggled it. This keeps `cache` live instead of frozen, so a
  // toggle takes effect on its very next read — no tab refresh needed.
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    for (const key in changes) {
      cache[key] = changes[key].newValue;
    }
  });
  // dt-unlock.user.js declares this grant, but its module bodies are stubs
  // that don't actually call it yet — a safe no-op keeps it from throwing
  // once they do, without needing a real chrome.contextMenus wiring yet.
  window.GM_registerMenuCommand = function () {};

  window.GM_xmlhttpRequest = function (opts) {
    chrome.runtime.sendMessage(
      { source: 'dt-shim', type: 'DT_XHR', method: opts.method || 'GET', url: opts.url, headers: opts.headers, data: opts.data },
      function (resp) {
        if (chrome.runtime.lastError || !resp) {
          if (opts.onerror) opts.onerror(chrome.runtime.lastError || { error: 'no response' });
          return;
        }
        if (resp.error) { if (opts.onerror) opts.onerror(resp); return; }
        if (opts.onload) opts.onload({ status: resp.status, responseText: resp.responseText });
      }
    );
  };

  // ── unsafeWindow stand-in ────────────────────────────────────────────
  // A content script's own `window` is the ISOLATED world's window, not
  // the real page's — DuelingBook's own globals (currentLabel,
  // deck_filled_arr, side_filled_arr, initializeDeckCards) live only in
  // the MAIN world and are invisible here. page-bridge.js (injected
  // separately, with world:"MAIN") is the only thing that can actually see
  // them; it relays plain, serializable snapshots via postMessage, which
  // this listener turns back into the exact shape the unmodified tracker
  // code already expects — a `.data(key)` accessor per card, matching
  // DuelingBook's own jQuery-backed CardFront elements.
  const uw = { currentLabel: undefined, deck_filled_arr: [], side_filled_arr: [], initializeDeckCards: function () {} };
  window.unsafeWindow = uw;

  function toFakeCard(meta) {
    return { data: function (key) { return meta[key]; } };
  }
  function applySnapshot(msg) {
    if ('currentLabel' in msg) uw.currentLabel = msg.currentLabel;
    if (Array.isArray(msg.deckArr)) uw.deck_filled_arr = msg.deckArr.map(toFakeCard);
    if (Array.isArray(msg.sideArr)) uw.side_filled_arr = msg.sideArr.map(toFakeCard);
  }
  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.data.source !== 'dt-page-bridge') return;
    if (ev.data.type === 'DT_BRIDGE_SNAPSHOT') {
      applySnapshot(ev.data);
    } else if (ev.data.type === 'DT_BRIDGE_SIDING_CHANGED') {
      applySnapshot(ev.data);
      try { uw.initializeDeckCards(); } catch (e) { console.log('[Duel Tools Shim] siding hook relay error:', e); }
    }
  });
  // Covers reads that need to happen independent of a real
  // initializeDeckCards call — e.g. noticing the siding screen re-opened
  // for a new game, before any swap has happened yet.
  setInterval(function () {
    window.postMessage({ source: 'dt-content-shim', type: 'DT_BRIDGE_REQUEST' }, window.location.origin);
  }, 200);

  console.log('[Duel Tools Shim] ready');
}

// Each phase gets its OWN try/catch — not one try/catch around the whole
// sequence. A single shared try/catch was a real bug: if any one phase
// threw (e.g. a bad file path, or the new REPLAY_ENGINE_FILE phase added
// below failing for any reason), every phase AFTER it in that shared try
// block silently never ran either, including totally unrelated features
// like the Live Tracker (TRACKER_FILES) — one phase's failure took down
// the whole page's worth of features instead of just itself. Logging each
// phase's own failure separately (still to this service worker's own
// console — chrome://extensions → Duel Tools → "service worker" link, NOT
// the page's own console) also makes a real failure identifiable instead
// of just "nothing works", which is what made this bug hard to diagnose
// from the page side alone.
async function injectPhase(label, tabId, options) {
  try {
    await chrome.scripting.executeScript(Object.assign({ target: { tabId } }, options));
    return true;
  } catch (e) {
    console.log('[Duel Tools] phase "' + label + '" failed:', e);
    return false;
  }
}

async function injectAll(tabId, url) {
  await injectPhase('page-bridge', tabId, { world: 'MAIN', files: ['page-bridge.js'] });
  if (/\/replay/.test(url)) {
    // Fired in the SAME phase as page-bridge.js, both world:"MAIN", both
    // before the shim's async storage preload — this is the earliest
    // point this file has, and the engine needs every millisecond of it
    // to beat DuelingBook's own loadReplayComplete() call.
    await injectPhase('replay-engine', tabId, { world: 'MAIN', files: [REPLAY_ENGINE_FILE] });
  } else {
    // Same early MAIN-world slot, mirrored for the live-duel root instead
    // of /replay* — dt-spectate-engine.js self-gates on isSpectatingNow()
    // either way, so injecting it unconditionally here (even for a page
    // that turns out to be an actual player's own duel, or the lobby) is
    // safe and cheap; it just never does anything in those cases.
    await injectPhase('spectate-engine', tabId, { world: 'MAIN', files: [SPECTATE_ENGINE_FILE] });
    // Transparent Facedowns' MAIN-world engine — same reasoning: harmless
    // no-op until player1/player2 exist and its settings relay says a
    // toggle is on.
    await injectPhase('transparent-facedowns-engine', tabId, { world: 'MAIN', files: [TRANSPARENT_FACEDOWNS_ENGINE_FILE] });
    // RPS Automation's MAIN-world engine — just a postMessage listener
    // that performs the actual click; see dt-rps-engine.js's own header
    // for why that click has to happen in MAIN world, not the isolated
    // world dt-rps-automation.user.js (PLAYING_FILES, below) runs in.
    // Early injection isn't load-bearing here (no race to win, unlike
    // replay/spectate engines above) — just consistent with its siblings.
    await injectPhase('rps-engine', tabId, { world: 'MAIN', files: [RPS_ENGINE_FILE] });
    await injectPhase('hand-shuffle-engine', tabId, { world: 'MAIN', files: [HAND_SHUFFLE_ENGINE_FILE] });
    await injectPhase('skip-cinematic-engine', tabId, { world: 'MAIN', files: [SKIP_CINEMATIC_ENGINE_FILE] });
  }
  await injectPhase('shim', tabId, { func: installShim });
  await injectPhase('trackers', tabId, { files: TRACKER_FILES });
  await injectPhase('deck-building', tabId, { files: DECK_BUILDING_FILES });
  await injectPhase('appearance-files', tabId, { files: APPEARANCE_FILES });
  if (/\/replay/.test(url)) {
    // RELAY_FILE (relay.user.js) is deliberately NOT injected right now —
    // it POSTs to /api/relay/replay, which doesn't exist anywhere on the
    // server (confirmed by grep), so every run of it was silently
    // failing. Parked here, hidden, until it's rebuilt with a real
    // destination or retired for good — the file itself is untouched so
    // picking it back up later is just adding it back to this list.
    await injectPhase('replay-controls', tabId, { files: [REPLAY_CONTROLS_FILE] });
  } else {
    await injectPhase('playing-files', tabId, { files: PLAYING_FILES });
    await injectPhase('spectate-controls', tabId, { files: [SPECTATE_CONTROLS_FILE] });
    await injectPhase('lobby-files', tabId, { files: LOBBY_FILES });
  }
}

chrome.webNavigation.onCommitted.addListener(function (details) {
  if (details.frameId !== 0) return; // top frame only
  let host;
  try { host = new URL(details.url).hostname; } catch (e) { return; }
  if (host !== 'www.duelingbook.com' && host !== 'duelingbook.com') return;
  injectAll(details.tabId, details.url);
});

// ── XHR relay — the actual cross-origin fetch, run from the service worker
// so it's never subject to duelingbook.com's own CSP/CORS the way an
// isolated-world content script's fetch still can be.
// ── Open Settings — the on-page gear prompt (dt-unlock.user.js) asks here
// because a content script can't call chrome.runtime.openOptionsPage()
// itself; the toolbar popup (dt-popup.js) calls it directly since IT runs
// as an extension page, not a content script, so it doesn't need this.
chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.source !== 'dt-shim' || msg.type !== 'DT_OPEN_SETTINGS') return false;
  chrome.runtime.openOptionsPage();
  return false;
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.source !== 'dt-shim' || msg.type !== 'DT_XHR') return false;
  (async () => {
    try {
      const res = await fetch(msg.url, {
        method: msg.method || 'GET',
        headers: msg.headers || undefined,
        body: msg.data || undefined
      });
      const responseText = await res.text();
      sendResponse({ status: res.status, responseText: responseText });
    } catch (e) {
      sendResponse({ error: true, message: String(e) });
    }
  })();
  return true; // keep the message channel open for the async sendResponse above
});
