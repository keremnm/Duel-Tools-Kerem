// Duel Tools — MAIN-world spectate-replay engine (live duels, spectating only).
//
// Runs in the real page's own JS context (injected with world:"MAIN", same
// as dt-replay-engine.js, but on the regular duelingbook.com root — never
// /replay*, and its restore() is only ever allowed to fire while genuinely
// SPECTATING, never while actually playing — see isSpectatingNow() below).
// dt-spectate-controls.user.js (isolated world) is UI only and drives this
// file over postMessage, the exact same bridge pattern dt-replay-engine.js
// already uses with dt-replay-controls.user.js.
//
// ── Why this is a separate file from dt-replay-engine.js, not a shared one
// A /replay* page already has the WHOLE match as one known JSON array
// (replay_arr) before you ever press play — rewinding there is "jump to a
// known index." A live spectated duel has no such thing: only what's
// actually happened so far is knowable, and the real match keeps playing
// out underneath you the whole time, live, over the same socket pipeline a
// real player uses. So instead of pre-seeding from a known array
// (loadReplayComplete/replay_arr), this file builds its OWN array by
// recording a snapshot after every real action, same shape, as it happens.
//
// ── What's confirmed live (2026-11-15, spectating real matches), not guessed:
// - Spectating a live duel runs through `duelResponse`/`duelResponse2`, NOT
//   `duelResponse0` (duelResponse0 doesn't even exist outside /replay* —
//   confirmed by instrumenting all three and counting real calls while a
//   real match played out: duelResponse/duelResponse2 incremented, 0 did
//   not). `endAction`/`saveGamestate` fire identically either way, which is
//   the half this file actually hooks (same as dt-replay-engine.js) — so
//   which duelResponse variant runs underneath doesn't matter here at all.
// - `window.initDuel` — the exact function DuelingBook's own code calls to
//   sync a spectator joining mid-duel — works identically on a live page as
//   it does on /replay*. Confirmed by taking a real snapshot, letting the
//   match advance ~10+ real seconds (LP/hand/turn all changed), then
//   restoring: board snapped back exactly right, no errors.
// - The FULL restore sequence matters, not just the initDuel call itself.
//   A first attempt that called initDuel without first killing in-flight
//   tweens and clearing actionsQueue/stopQueue left the live action
//   pipeline stalled afterward (actionsQueue backed up to 40+ and
//   endAction stopped firing entirely — a real, reproduced failure, not a
//   guess). Redone with the full sequence (TweenMax.killAll, clear the
//   queue, reset stopQueue, THEN initDuel), endAction/saveGamestate kept
//   firing normally afterward and actionsQueue stayed at 0. That is the
//   actual fix, confirmed by reproducing the break and then the clean
//   version back to back on the same real match.
// - Because of the above, "jump to a past moment" and "View Live" are the
//   SAME operation here — restore(index) — just aimed at a historical
//   index vs. the newest one recorded so far. No separate catch-up/replay
//   step is needed: real actions keep recording into this file's own
//   array the whole time you're sitting on a past index (the hooks below
//   don't care what's currently being displayed), so "View Live" is just
//   restoring to whatever the latest index already is.
// - replay_arr/previous_plays/lastAction and the native #play_btn/
//   #next_btn/#fast_btn/#pause_replay_btn element-enabling that
//   dt-replay-engine.js's restore() also does are /replay*-only — none of
//   those exist on a live page (confirmed: typeof replay_arr/nextE/playE/
//   pauseE/fastE/loadReplayComplete are all "undefined" while spectating
//   live). Left out here on purpose, not an oversight.
// - unswap()/RB.pristine (dt-replay-engine.js's mechanism for restoring a
//   face-down card's TRUE identity on rewind, since a replay secretly
//   already knows it) has no live equivalent and shouldn't be faked — a
//   spectator legitimately never knows a card's identity before it's
//   actually revealed, same as a real spectator watching live. Left out.
// - Game boundaries (G1/G2/G3): a replay knows every "Pick first" in its
//   JSON ahead of time. Live, the proven, already-confirmed-live signal
//   for "a new game just started" is #rps_start appearing (the exact
//   pattern dt-live-tracker.user.js's watchForNewDuels() already uses) —
//   reused here via a MutationObserver-free poll on the same interval as
//   snapshot bookkeeping, since this file has no DOM-mutation hook of its
//   own to piggyback on otherwise.
(function () {
  'use strict';
  if (/^\/replay\b/.test(window.location.pathname) || window.__dtSpectateEngineInstalled) return;
  window.__dtSpectateEngineInstalled = true;

  const g = (name) => window[name];
  const warn = (...a) => { try { console.warn('[Duel Tools Spectate Engine]', ...a); } catch (e) {} };
  const log = (...a) => { try { console.log('[Duel Tools Spectate Engine]', ...a); } catch (e) {} };

  const RB = {
    snaps: [],       // sequential, append-only — [{gs, turn, order, turnCount, logLen, chatLen, watchChatLen, watchers, game}]
    cur: -1,         // index into snaps currently being displayed; snaps.length-1 === "live"
    bookmarks: [],   // [{index, label}]
    game: 1,         // kept in sync with the real match score — see watchGameBoundary/readMatchScore
    dec: false,
    restoring: false,
    playTimer: null,
    // Explicit "am I tracking the real-time duel right now" flag — NOT the
    // same thing as "cur happens to equal snaps.length-1 right now".
    // Earlier versions inferred live-following purely from cursor
    // position, which meant Pause couldn't do anything: since a spectator
    // sits at the live edge by default, clicking Pause had nothing to
    // move away from, and the very next real action immediately dragged
    // cur right back to the new edge anyway (confirmed live — the user
    // reported Pause was "only momentarily useable when Play is clicked").
    // This flag decouples the two: true means every new snapshot keeps
    // auto-advancing cur (the normal "just watching it happen" state);
    // false means the cursor is deliberately frozen (via Pause, or any
    // manual seek) and new real actions keep recording in the background
    // without dragging the view away from where it was parked.
    followLive: true
  };

  // A spectator is never a player — confirmed live that "Admit Defeat" (and
  // its sibling player-only controls) stay in the DOM but go display:none
  // while spectating, same existence-vs-visibility trap as #duel itself.
  // This is the belt-and-suspenders check that must pass before restore()
  // is EVER allowed to run: the controls script (isolated world) already
  // gates on this itself before sending a command, but checking again here
  // too means a stale/buggy controls-side check can never actually rewind
  // a real player's own live duel.
  function findByExactText(label) {
    const all = document.querySelectorAll('div, span, button, input');
    for (const el of all) {
      if ((el.textContent || '').trim() !== label) continue;
      let isLeaf = true;
      for (const child of el.children) {
        if ((child.textContent || '').trim() === label) { isLeaf = false; break; }
      }
      if (isLeaf) return el;
    }
    return null;
  }
  // Checks several player-only controls, not just "Admit Defeat" — the
  // user caught this live in a solo duel (playing both sides against
  // themself): "Admit Defeat" isn't always rendered yet right at duel
  // start (confirmed: visible moments later, not visible in their
  // screenshot taken around the 0:15 mark), and during that brief window
  // the single-check version wrongly concluded "no Admit Defeat visible,
  // must be a spectator" and showed the spectate panel to an actual
  // player. "Begin Siding"/"Offer Draw"/"Call Judge" are each independently
  // player-only too, so checking all four means a real player is caught by
  // whichever one happens to be rendered, instead of depending on exactly
  // one of them existing yet.
  const PLAYER_ONLY_LABELS = ['Admit Defeat', 'Begin Siding', 'Offer Draw', 'Call Judge'];
  function isSpectatingNow() {
    const duelEl = document.querySelector('#duel');
    const duelVisible = !!duelEl && getComputedStyle(duelEl).display !== 'none';
    if (!duelVisible) return false;
    for (const label of PLAYER_ONLY_LABELS) {
      const el = findByExactText(label);
      if (el && el.offsetParent !== null) return false; // any one of these visible means a real player, never a spectator
    }
    return true;
  }

  // Confirmed live (2026-11-15): when both duelists leave a finished match,
  // #duel stays visible and isSpectatingNow() above keeps returning true —
  // DuelingBook tears down the actual card objects (player1/player2's
  // all_cards_arr goes to length 0) well before any "duel over" UI
  // disappears, so that's not a usable signal either. Without this check,
  // restore() ends up calling initDuel() against a torn-down duel and
  // initDuel's own initCards/initCard throws (reproduced live: "Cannot
  // read properties of null (reading 'data')" from inside duel.js). This
  // is the actual, narrower signal that card state still exists to
  // restore into, separate from "am I a spectator and not a player."
  // v2: distinguishes a NORMAL "no live card state" moment (between games,
  // or the match actually over — both players' arrays legitimately go
  // empty together) from a genuinely BROKEN one. Confirmed live: rewinding
  // while the real match kept playing underneath can corrupt DuelingBook's
  // own player object asymmetrically — one side's all_cards_arr emptied
  // out while the other stayed fully populated and LP values stayed real
  // (not reset to 8000/8000), which a normal between-games transition
  // never produces (that always empties BOTH sides together). That
  // specific shape — one side has cards, the other doesn't — is this
  // file's own doing corrupting the live page, not a match boundary, and
  // it can't be un-broken from here: the actual card objects are gone, not
  // just this engine's record of them, and nothing short of a real page
  // reload re-syncs with the server. restore() still refuses in BOTH
  // cases (there's no valid state to restore into either way) — the
  // distinction only matters for what the UI tells the user.
  function cardStateStatus() {
    const p1 = g('player1'), p2 = g('player2');
    const p1n = !!(p1 && p1.all_cards_arr && p1.all_cards_arr.length);
    const p2n = !!(p2 && p2.all_cards_arr && p2.all_cards_arr.length);
    if (p1n && p2n) return 'ok';
    if (!p1n && !p2n) return 'ended';
    return 'corrupted';
  }
  function hasLiveCardState() { return cardStateStatus() === 'ok'; }

  // ---------- snapshot capture (ported from dt-replay-engine.js's
  // serCard/unpack/serPlayer/takeSnapshot/actionDone, adapted: no RB.orig
  // position to key off since nothing is pre-known here, so this just
  // pushes sequentially instead) ----------
  function cardOf(e) { return (e && e.data ? e : null); }
  function serCard(e, who) {
    if (!cardOf(e)) return null;
    const o = { id: e.data('id') };
    let plain = true;
    const flag = (k, v) => { if (v) { o[k] = v; plain = false; } };
    flag('face_up', !!e.data('face_up')); flag('face_down', !!e.data('face_down'));
    flag('inATK', !!e.data('inATK')); flag('inDEF', !!e.data('inDEF'));
    flag('counters', ~~e.data('counters'));
    if (e.data('new_atk') != null) flag('new_atk', e.data('new_atk'));
    if (e.data('new_def') != null) flag('new_def', e.data('new_def'));
    const c = e.data('controller'), w = e.data('owner');
    if (c && c.username !== who) flag('controller', c.username);
    if (w && w.username !== who) flag('owner', w.username);
    const x = e.data('xyz_arr');
    if (x && x.length) flag('xyz_arr', x.map((m) => serCard(m, who)));
    return plain ? o.id : o;
  }
  const unpack = (c) => (c == null ? null : typeof c === 'object' ? (c.xyz_arr ? Object.assign({}, c, { xyz_arr: c.xyz_arr.map(unpack) }) : c) : { id: c });
  function unpackPlayer(sp) {
    const o = Object.assign({}, sp);
    for (const k of ['field', 'hand', 'main', 'grave', 'banished', 'extra']) o[k] = sp[k].map(unpack);
    return o;
  }
  function serPlayer(p, n) {
    const field = [p.m1, p.m2, p.m3, p.m4, p.m5, p.s1, p.s2, p.s3, p.s4, p.s5, p.pendulumLeft, p.pendulumRight,
      p.fieldSpell, g('linkLeft'), g('linkRight'), p.skillCard];
    const u = p.username, ser = (arr) => arr.map((e) => serCard(e, u));
    return {
      username: u, lifepoints: p.lifepoints, deck_face_up: p.deck_face_up,
      field: ser(field), hand: ser(p.hand_arr), main: ser(p.main_arr),
      grave: ser(p.grave_arr), banished: ser(p.banished_arr), extra: ser(p.extra_arr)
    };
  }
  // ---------- persistence across a page reload ----------
  // Keyed by the duel's own id (window.duelId/lastDuelId — confirmed live
  // to be a stable numeric handle for "which match", already used
  // elsewhere in this project) so a reload of the SAME spectated match
  // resumes where it left off instead of starting over from nothing.
  // Directly answers the user's "the match information should not be
  // wiped" — this engine's snaps/bookmarks previously lived in memory only
  // and vanished on any reload, including the one a corrupted live object
  // (see cardStateStatus() above) can genuinely require. Not meant to
  // outlive the duel itself: entries older than 6 hours are swept on
  // every persist() so this doesn't grow forever across many matches.
  function duelKey() {
    const id = g('duelId') || g('lastDuelId');
    return id ? ('dt_spectate_history_' + id) : null;
  }
  function persist() {
    const key = duelKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ snaps: RB.snaps, bookmarks: RB.bookmarks, game: RB.game, t: Date.now() }));
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || k.indexOf('dt_spectate_history_') !== 0 || k === key) continue;
        try {
          const old = JSON.parse(localStorage.getItem(k));
          if (!old || !old.t || Date.now() - old.t > 6 * 60 * 60 * 1000) localStorage.removeItem(k);
        } catch (e) { localStorage.removeItem(k); }
      }
    } catch (e) {} // localStorage can legitimately throw (quota, private mode) — losing persistence is not worth breaking the engine over
  }
  function tryResume() {
    const key = duelKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.snaps) || !data.snaps.length) return;
      RB.snaps = data.snaps;
      RB.bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
      RB.game = data.game || 1;
      RB.cur = RB.snaps.length - 1;
      RB.followLive = true;
      log('resumed ' + RB.snaps.length + ' saved moment(s) and ' + RB.bookmarks.length + ' bookmark(s) for this duel after reload.');
    } catch (e) {}
  }

  function takeSnapshot() {
    if (RB.restoring) return;
    const p1 = g('player1'), p2 = g('player2');
    if (!p1 || !p2 || !p1.all_cards_arr || g('tag_duel')) return;
    const tp = g('turn_player');
    RB.snaps.push({
      game: RB.game,
      gs: { player1: serPlayer(p1, 1), player2: serPlayer(p2, 2), phase: g('currentPhase') },
      turn: tp && tp.username, order: (g('players') || []).map((x) => x.username), turnCount: g('turnCount'),
      logLen: (g('duel_logs') || []).length,
      chatLen: ($('#duel .cout_txt')[0] || { childNodes: [] }).childNodes.length,
      watchChatLen: ($('#watch_chat .cout_txt')[0] || { childNodes: [] }).childNodes.length,
      watchers: $('#watchers .users').html(),
      t: Date.now()
    });
    // Only auto-follow the new snapshot as "current" while RB.followLive
    // is true — someone who paused or manually rewound should never get
    // silently fast-forwarded out from under them just because the real
    // match kept playing underneath.
    if (RB.followLive) RB.cur = RB.snaps.length - 1;
    persist();
    post('DT_SPECTATE_STATE', stateSummary());
  }
  function actionDone() {
    if (RB.restoring) return;
    if (!(g('actionsQueue') || []).length) takeSnapshot();
  }

  // ---------- new-game boundary ----------
  // v2: the game number now comes from DuelingBook's own match score,
  // confirmed live rather than inferred. The duel log panel (#duel
  // .cout_txt) actually embeds the match's running (wins-losses-draws)
  // tuple as plain text right at the start of each game's log section —
  // e.g. "(1-1-0)lionlion gained 1000 LP..." — confirmed directly against
  // a real spectated match. Per the user's own rule: 0-0-0 is Game 1,
  // 1-0-0 or 0-1-0 is Game 2, 1-1-0 is Game 3, and so on — i.e. game
  // number = wins + losses + draws + 1. This is read fresh every tick and
  // used as ground truth, which fixes TWO real problems at once: (1) the
  // old RPS-open edge-counter could mislabel Game 1 as Game 2 depending on
  // exactly when install() won its race against the opening RPS dialog
  // (confirmed live), and (2) a spectator who joins mid-match (e.g. at a
  // real Game 2 or 3) never had any way to know that — RB.game started at
  // 1 and only ever counted RPS opens seen AFTER joining, so it was wrong
  // from the start for anyone who didn't join at the very beginning. The
  // score marker is visible in the log the moment you join, regardless of
  // when that is, so this is correct from the first tick either way.
  // RPS-open edge detection is kept ONLY as a fallback for the brief
  // window before any score marker has appeared yet in a freshly-joined
  // Game 1 (where there's no "(0-0-0)" marker to find — it only appears
  // once a game actually concludes and the next one begins).
  function readMatchScore() {
    const el = document.querySelector('#duel .cout_txt');
    if (!el) return null;
    let last = null;
    const re = /\((\d+)-(\d+)-(\d+)\)/;
    for (const node of el.childNodes) {
      const m = re.exec(node.textContent || '');
      if (m) last = { w: +m[1], l: +m[2], d: +m[3] };
    }
    return last;
  }
  let rpsWasOpen = !!document.querySelector('#rps_start');
  function watchGameBoundary() {
    const open = !!document.querySelector('#rps_start');
    if (open && !rpsWasOpen) RB.game++; // fallback only — overridden below the instant a real score marker exists
    rpsWasOpen = open;
    const score = readMatchScore();
    if (score) RB.game = score.w + score.l + score.d + 1;
  }

  // ---------- restore (ported from dt-replay-engine.js's restore(), minus
  // the /replay*-only tail — see the file header for exactly what and why) ----------
  function restore(index) {
    if (!isSpectatingNow()) { warn('refused to restore — not currently spectating a live duel'); return false; }
    if (!hasLiveCardState()) { warn('refused to restore — duel has ended, no live card state to restore into'); return false; }
    const S = RB.snaps[index];
    if (!S) return false;
    const p1 = g('player1'), p2 = g('player2');
    RB.restoring = true;
    try {
      if (window.TweenMax && TweenMax.killAll) TweenMax.killAll(false, true, true, true);
      const q = g('actionsQueue'); if (q) q.length = 0;
      window.stopQueue = false;
      const before = p1.all_cards_arr.concat(p2.all_cards_arr);
      window.all_cards_arr = before.slice();
      window.viewing = '';
      window.resetting = true;
      p1.resetDeck(); p2.resetDeck();
      p1.lifepoints = S.gs.player1.lifepoints;
      p2.lifepoints = S.gs.player2.lifepoints;
      window.initDuel({ player1: unpackPlayer(S.gs.player1), player2: unpackPlayer(S.gs.player2), phase: S.gs.phase });
      window.resetting = false;

      const getPlayer = window.getPlayer;
      if (S.turn && getPlayer(S.turn)) window.turn_player = getPlayer(S.turn);
      if (S.order.length) window.players = S.order.map((u) => getPlayer(u));
      p1.opponent = p2; p2.opponent = p1;
      window.turnCount = S.turnCount;
      window.currentPhase = S.gs.phase;
      if (typeof window.changeDarks === 'function') window.changeDarks();

      const AZ = window.ABOUT_ZERO || 0;
      for (const p of [p1, p2]) {
        for (const e of [p.m1, p.m2, p.m3, p.m4, p.m5, p.s1, p.s2, p.s3, p.s4, p.s5, p.fieldSpell, p.pendulumLeft, p.pendulumRight]) {
          if (!e || !e.data) continue;
          if (window.TweenMax) TweenMax.set(e, { rotationY: e.data('face_down') ? 180 + AZ : AZ });
          if (e.onRotate) e.onRotate();
        }
        const show = window.show_cards == 2 || (window.show_cards && p === window.Player1());
        for (const e of p.hand_arr) {
          if (window.TweenMax) TweenMax.set(e, { rotationY: show ? AZ : 180 + AZ });
          if (e.onRotate) e.onRotate();
        }
      }

      const logs = g('duel_logs');
      if (logs) { logs.length = Math.min(logs.length, S.logLen); window.updateDuelLog(); }
      function trimChildren(el, n) { if (!el || n == null) return; while (el.childNodes.length > n) el.removeChild(el.lastChild); }
      trimChildren($('#duel .cout_txt')[0], S.chatLen);
      trimChildren($('#watch_chat .cout_txt')[0], S.watchChatLen);

      $('#over, #view, #sword, #red_stream, #blue_stream, .red_target, .blue_target, .green_target, .all_good').hide();
      if (typeof window.removeFieldSpellPic === 'function') window.removeFieldSpellPic();
      if (typeof window.updateCounters === 'function') window.updateCounters();

      RB.cur = index;
      return true;
    } catch (e) {
      warn('restore failed', e);
      window.resetting = false;
      return false;
    } finally {
      RB.restoring = false;
    }
  }

  // ---------- public command surface, driven by dt-spectate-controls.user.js ----------
  function stateSummary() {
    const cur = RB.snaps[RB.cur];
    return {
      total: RB.snaps.length,
      cur: RB.cur,
      isLive: RB.cur === RB.snaps.length - 1,
      game: cur ? cur.game : RB.game,
      games: Array.from(new Set(RB.snaps.map((s) => s.game))),
      bookmarks: RB.bookmarks.slice(),
      spectating: isSpectatingNow(),
      duelEnded: !hasLiveCardState(),
      corrupted: cardStateStatus() === 'corrupted',
      playing: !!RB.playTimer,
      followLive: !!RB.followLive
    };
  }
  function stopPlay() {
    if (RB.playTimer) { clearInterval(RB.playTimer); RB.playTimer = null; }
  }
  function startPlay() {
    stopPlay();
    RB.playTimer = setInterval(() => {
      if (RB.cur >= RB.snaps.length - 1) {
        // Caught all the way back up to real time under its own power —
        // treat that the same as clicking "View Live": resume following.
        stopPlay();
        RB.followLive = true;
        post('DT_SPECTATE_STATE', stateSummary());
        return;
      }
      restore(RB.cur + 1);
      post('DT_SPECTATE_STATE', stateSummary());
    }, 900); // paced for readability, same spirit as a replay's own step delay — not tied to the real plays' original timestamps since, unlike a replay, there's no fixed total length to pace against
  }

  function handleCommand(cmd, data) {
    switch (cmd) {
      case 'prev': stopPlay(); RB.followLive = false; if (RB.cur > 0) restore(RB.cur - 1); break;
      case 'next': stopPlay(); RB.followLive = false; if (RB.cur < RB.snaps.length - 1) restore(RB.cur + 1); break;
      case 'earliest': {
        stopPlay();
        RB.followLive = false;
        const first = RB.snaps.findIndex((s) => s.game === (RB.snaps[RB.cur] || {}).game);
        if (first >= 0) restore(first);
        break;
      }
      // "View Live" — the one command that explicitly RESUMES following,
      // same as Play naturally catching all the way back up does above.
      case 'latest': stopPlay(); RB.followLive = true; if (RB.snaps.length) restore(RB.snaps.length - 1); break;
      case 'jumpToGame': {
        stopPlay();
        RB.followLive = false;
        const idx = RB.snaps.findIndex((s) => s.game === (data && data.game));
        if (idx >= 0) restore(idx);
        break;
      }
      case 'play': if (RB.snaps.length) startPlay(); break;
      // Freezes the view EVEN IF currently sitting right at the live edge
      // — this is the actual fix for "Pause does nothing / only works for
      // a moment": previously there was no way to stop following live
      // other than already being rewound, so Pause had nothing to do and
      // the very next real action silently dragged the view forward again
      // regardless. Now it unconditionally stops auto-following from here.
      case 'pause': stopPlay(); RB.followLive = false; break;
      case 'jumpToIndex': stopPlay(); RB.followLive = false; if (data && typeof data.index === 'number') restore(data.index); break;
      case 'addBookmark': {
        if (RB.cur < 0) break;
        RB.bookmarks.push({ index: RB.cur, label: (data && data.label) || ('Bookmark ' + (RB.bookmarks.length + 1)) });
        persist();
        break;
      }
      case 'jumpToBookmark': {
        stopPlay();
        RB.followLive = false;
        const bm = RB.bookmarks[data && data.i];
        if (bm) restore(bm.index);
        break;
      }
      case 'deleteBookmark': {
        if (data && typeof data.i === 'number') RB.bookmarks.splice(data.i, 1);
        persist();
        break;
      }
      default: warn('unknown command', cmd);
    }
    post('DT_SPECTATE_STATE', stateSummary());
  }

  function post(type, extra) {
    window.postMessage(Object.assign({ source: 'dt-spectate-engine' }, extra || {}, { type: type }), window.location.origin);
  }
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.source !== 'dt-spectate-controls') return;
    if (d.type === 'DT_SPECTATE_CMD') handleCommand(d.cmd, d.data);
    else if (d.type === 'DT_SPECTATE_QUERY') post('DT_SPECTATE_STATE', stateSummary());
  });

  // ---------- install (poll until the live page's own functions exist,
  // same pattern dt-replay-engine.js uses for loadReplayComplete/
  // duelResponse0 — here it's endAction/saveGamestate/initDuel instead,
  // since those (not duelResponse0) are the ones confirmed to actually
  // fire while spectating live) ----------
  function install() {
    if (typeof window.endAction !== 'function' || typeof window.saveGamestate !== 'function' || typeof window.initDuel !== 'function') {
      setTimeout(install, 300);
      return;
    }
    tryResume();
    const origEndAction = window.endAction;
    window.endAction = function () {
      RB.dec = !g('resetting') && (g('actionsQueue') || []).length > 0;
      return origEndAction.apply(this, arguments);
    };
    const origSaveGamestate = window.saveGamestate;
    window.saveGamestate = function () {
      const r = origSaveGamestate.apply(this, arguments);
      if (RB.dec) { RB.dec = false; try { actionDone(); } catch (e) { warn(e); } }
      return r;
    };
    setInterval(watchGameBoundary, 500);
    log('installed.');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
