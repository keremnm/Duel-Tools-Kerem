// Duel Tools — MAIN-world replay engine (replay pages only).
//
// Runs in the real page's own JS context (injected with world:"MAIN" from
// background.js, /replay* pages only — guarded below too, same as every
// other file here is guarded by its own @match/path check). This is where
// the ACTUAL rewind happens; dt-replay-controls.user.js (isolated world)
// is UI only and drives this file over postMessage, the same bridge
// pattern page-bridge.js already uses for the siding-screen snapshot relay.
//
// Why this file exists, instead of the simpler thing this project shipped
// first: DuelingBook does have a native step-backward function
// (window.stepBackwardE), directly callable with no click needed — and an
// earlier version of this project used exactly that. It genuinely moves
// the BOARD backward correctly. But it does NOT update the Duel Log panel
// — confirmed live: stepped backward 3 times, watched #duel_log the whole
// time, and its text never changed, still showing lines for plays the
// board had just un-done. That's not a guess; it's a direct, repeatable,
// confirmed gap, consistent with how independent reverse-engineering of
// this same feature (shared with this project, see that file's own
// comments) describes DuelingBook's native stepBackward as "unfinished".
//
// This file is that independent engineer's actual solution, carried over
// and adapted to drive THIS project's own UI instead of building its own
// button: rather than trust DuelingBook's own half-built rewind, it takes
// a full snapshot of board state after every play as the replay naturally
// advances (both players' field/hand/grave/banished/extra/main, LP, phase,
// turn, log length, chat length, watcher list), and restores one via
// window.initDuel — the SAME function DuelingBook's own code calls when a
// spectator joins a duel already in progress. Confirmed live before this
// was ported: every function this file hooks or calls (initDuel,
// saveGamestate, endAction, duelResponse0, loadReplayComplete, nextE,
// playE, pauseE, fastE, removeToken) exists as a real function on the live
// site right now. Because it restores the log/chat length too (trimming
// duel_logs and the chat panel back to the snapshot's own lengths, then
// calling updateDuelLog() to re-render), the log-panel gap above doesn't
// exist here — and because it re-points replay_arr/previous_plays/
// lastAction afterward, DuelingBook's own native Play/Next/Fast Forward
// keep working correctly after a rewind, with no separate resumeGame()
// workaround needed.
(function () {
  'use strict';
  if (!/^\/replay\b/.test(window.location.pathname) || window.__dtReplayEngineInstalled) return;
  window.__dtReplayEngineInstalled = true;

  const RB = {
    orig: null, snaps: new Map(), markers: [], cards: {}, tokens: new Set(),
    pristine: null, offset: 0, games: [], jump: null,
    dec: false, restoring: false, waiting: false
  };

  const NOISE = new Set(['Stop viewing', 'View deck', 'View GY', 'View GY 2', 'View Banished', 'View Banished 2',
    'View ED', 'View ED 2', 'View Extra Deck', 'View Graveyard', 'View materials', 'Good', 'Stop good', 'Thinking',
    'Add watcher', 'Remove watcher', 'Typing', 'Duel message', 'Watcher message', 'Edit duel message',
    'Permission event', 'Permission granted', 'Permission denied', 'Show hand', 'Countdown', 'Swap cards', 'Message']);
  const isBoardPlay = (pl) => !!pl && !!pl.play && !NOISE.has(pl.play);

  const g = (name) => window[name];
  const warn = (...a) => { try { console.warn('[Duel Tools Replay Engine]', ...a); } catch (e) {} };
  const log = (...a) => { try { console.log('[Duel Tools Replay Engine]', ...a); } catch (e) {} };

  function wrap(name, make) {
    const orig = window[name];
    if (typeof orig !== 'function') { warn('missing', name); return false; }
    window[name] = make(orig);
    return true;
  }

  // ---------- position ----------
  const pos = () => (RB.orig && Array.isArray(g('replay_arr')) ? RB.orig.length - g('replay_arr').length : 0);
  const inDuel = () => typeof g('currentLabel') === 'string' && g('currentLabel').indexOf('duel_start') === 0 && g('ready') === true;
  function gameOf(p) {
    let n = 0;
    for (let i = 0; i < p && i < RB.orig.length; i++) if (RB.orig[i] && RB.orig[i].play === 'Pick first') n++;
    return n;
  }

  // ---------- snapshots ----------
  const cardOf = (e) => (e && e.data ? e : null);
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
      viewing: $('#status' + n + ' .status_txt').text().replace(/^Viewing /, ''),
      field: ser(field), hand: ser(p.hand_arr), main: ser(p.main_arr),
      grave: ser(p.grave_arr), banished: ser(p.banished_arr), extra: ser(p.extra_arr)
    };
  }
  function takeSnapshot(p) {
    if (RB.restoring || !RB.orig || !inDuel() || RB.snaps.has(p)) return;
    if (p < RB.orig.length && !isBoardPlay(RB.orig[p])) return;
    const p1 = g('player1'), p2 = g('player2');
    if (!p1 || !p2 || !p1.all_cards_arr || g('tag_duel')) return;
    const cids = {};
    for (const e of p1.all_cards_arr.concat(p2.all_cards_arr)) {
      const cf = e.data('cardfront');
      const cid = cf && cf.data('id');
      if (cid == null) continue;
      cids[e.data('id')] = cid;
      if (!RB.cards[cid] && cf.data('name')) RB.cards[cid] = $.extend({}, cf.data());
    }
    const tp = g('turn_player');
    let watchers = $('#watchers .users').html();
    if (watchers === RB.lastWatchers) watchers = RB.lastWatchers; else RB.lastWatchers = watchers;
    RB.snaps.set(p, {
      p, game: gameOf(p),
      gs: { player1: serPlayer(p1, 1), player2: serPlayer(p2, 2), phase: g('currentPhase') },
      turn: tp && tp.username, order: (g('players') || []).map((x) => x.username), turnCount: g('turnCount'),
      cids, logLen: (g('duel_logs') || []).length,
      chatLen: ($('#duel .cout_txt')[0] || { childNodes: [] }).childNodes.length,
      watchChatLen: ($('#watch_chat .cout_txt')[0] || { childNodes: [] }).childNodes.length,
      watchers
    });
  }

  function actionDone() {
    if (!RB.orig || RB.restoring) return;
    const done = [];
    for (const m of RB.markers) if (--m.left <= 0) done.push(m);
    if (done.length) RB.markers = RB.markers.filter((m) => m.left > 0);
    for (const m of done) takeSnapshot(m.p);
    if (g('actionsQueue').length === 0) {
      RB.markers = [];
      takeSnapshot(pos());
      if (RB.jump && inDuel() && pos() > RB.jump.pick) jumpLanded();
    }
  }
  function playQueued(data) {
    if (!RB.orig || RB.restoring) return;
    const idx = RB.orig.indexOf(data);
    if (idx < 0) return;
    if (!inDuel()) { RB.markers = []; return; }
    const n = g('actionsQueue').length;
    if (n === 0) takeSnapshot(idx + 1);
    else RB.markers.push({ p: idx + 1, left: n });
  }

  // ---------- rewind ----------
  function targetBefore(p, turn) {
    const game = gameOf(p);
    const limit = turn ? p - 1 : lastBoardPlay(p);
    let best = null, first = null;
    for (const [k, s] of RB.snaps) {
      if (s.game !== game) continue;
      if (first == null || k < first) first = k;
      if (k > limit) continue;
      if (turn && !(k < RB.orig.length && RB.orig[k].play === 'Start turn')) continue;
      if (best == null || k > best) best = k;
    }
    if (best == null && turn && first != null && first < p) best = first;
    return best;
  }
  function lastBoardPlay(p) {
    for (let i = p - 1; i >= 0; i--) if (isBoardPlay(RB.orig[i])) return i;
    return -1;
  }
  function canGoBack() { return !!(RB.orig && !RB.restoring && !RB.jump && targetBefore(pos(), false) != null); }

  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  function unswap(from) {
    if (!RB.pristine) return;
    for (let i = Math.max(0, from); i < RB.orig.length; i++) {
      const P = RB.pristine.plays[i + RB.offset], O = RB.orig[i];
      if (!P || !O || P.player1 === undefined) continue;
      for (const k of ['player1', 'player2', 'player3', 'player4']) if (P[k] !== undefined) O[k] = clone(P[k]);
    }
  }

  function restore(t) {
    const S = RB.snaps.get(t);
    if (!S) return false;
    const p1 = g('player1'), p2 = g('player2');
    RB.restoring = true;
    try {
      TweenMax.killAll(false, true, true, true);
      const q = g('actionsQueue'); q.length = 0;
      window.stopQueue = false;
      RB.markers = [];
      const before = p1.all_cards_arr.concat(p2.all_cards_arr, [...RB.tokens]);
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

      const after = p1.all_cards_arr.concat(p2.all_cards_arr);
      for (const e of after) {
        const cid = S.cids[e.data('id')];
        const cf = e.data('cardfront');
        if (cid != null && cf && cf.data('id') != cid && RB.cards[cid]) cf.initializeFromData($.extend({}, RB.cards[cid]));
      }
      const AZ = window.ABOUT_ZERO || 0;
      for (const p of [p1, p2]) {
        for (const e of [p.m1, p.m2, p.m3, p.m4, p.m5, p.s1, p.s2, p.s3, p.s4, p.s5, p.fieldSpell, p.pendulumLeft, p.pendulumRight]) {
          if (!cardOf(e)) continue;
          TweenMax.set(e, { rotationY: e.data('face_down') ? 180 + AZ : AZ });
          if (e.onRotate) e.onRotate();
        }
        const show = window.show_cards == 2 || (window.show_cards && p === window.Player1());
        for (const e of p.hand_arr) { TweenMax.set(e, { rotationY: show ? AZ : 180 + AZ }); if (e.onRotate) e.onRotate(); }
      }
      const live = new Set(after.map((e) => e[0]));
      for (const e of before) {
        if (live.has(e[0])) { RB.tokens.delete(e); continue; }
        const cf = e.data('cardfront');
        if (cf && cf.data('monster_color') === 'Token') RB.tokens.add(e);
        e.detach();
      }

      const logs = g('duel_logs');
      if (logs) { logs.length = Math.min(logs.length, S.logLen); window.updateDuelLog(); }
      trimChildren($('#duel .cout_txt')[0], S.chatLen);
      trimChildren($('#watch_chat .cout_txt')[0], S.watchChatLen);
      if (S.watchers != null) { $('#watchers .users').html(S.watchers); $('#watchers .watchers_txt').text('Watchers: ' + $('#watchers .cell').length); }

      $('#over, #view, #sword, #red_stream, #blue_stream, .red_target, .blue_target, .green_target, .all_good').hide();
      if (typeof window.removeFieldSpellPic === 'function') window.removeFieldSpellPic();
      if (typeof window.updateCounters === 'function') window.updateCounters();

      unswap(t);
      window.replay_arr = RB.orig.slice(t);
      window.previous_plays = RB.orig.slice(0, t);
      window.lastAction = RB.orig[t - 1] || null;
      if (window.replay_arr.length) window.seconds = window.replay_arr[0].seconds - 0.5;
      $('#play_btn').disable(false); $('#next_btn').disable(false); $('#fast_btn').disable(false);
      $('#pause_replay_btn').disable(true);
    } catch (e) {
      warn('restore failed', e);
      window.resetting = false;
      return false;
    } finally {
      RB.restoring = false;
    }
    return true;
  }
  function trimChildren(el, n) {
    if (!el || n == null) return;
    while (el.childNodes.length > n) el.removeChild(el.lastChild);
  }

  function waitForIdle(cb, timeoutMs) {
    if (RB.waiting) { cb(false); return; }
    RB.waiting = true;
    const t0 = Date.now();
    (function wait() {
      const q = g('actionsQueue');
      if ((q && q.length) && Date.now() - t0 < (timeoutMs || 6000)) { setTimeout(wait, 40); return; }
      RB.waiting = false;
      cb(true);
    })();
  }

  // back(turn): pause native autoplay, let the in-flight play finish, then
  // restore the snapshot just before the current play (or the start of the
  // current turn if turn=true).
  function back(turn, done) {
    if (!RB.orig || RB.restoring || RB.waiting) { done(false); return; }
    if (typeof window.pauseE === 'function') window.pauseE();
    waitForIdle((idle) => {
      if (!idle) { done(false); return; }
      const t = targetBefore(pos(), !!turn);
      const ok = t != null ? restore(t) : false;
      done(ok);
    });
  }

  // seekToStep: drives repeated back()/nextE() calls, entirely inside this
  // MAIN-world file (no postMessage round-trip per intermediate step, just
  // one request in and one DONE reply out) until `pos()` lands exactly on
  // `target`. back() jumps by whatever snapshot is nearest at or before the
  // position it's called from — usually several native plays at once, and
  // always correct, never partial — so a long rewind here is normally a
  // handful of back() calls, not one per play; any remaining gap (an
  // overshoot past `target`, or the forward direction, where there's no
  // bulk primitive) is closed one native nextE() at a time. Used for the
  // Share/Game-N moment modal's Middle/End/Custom tiles and for resuming a
  // Duel Tools share link (#dt-replay-step=N) — Start tiles and the
  // standalone G1/G2/G3 buttons use jumpTo()/DT_ENGINE_JUMP_GAME instead,
  // since DuelingBook's own deal-out reconstruction is both more reliable
  // and faster than walking there one play at a time.
  function seekToStep(target, done) {
    if (!RB.orig) { done(false); return; }
    target = Math.max(0, Math.min(target, RB.orig.length));
    let guard = 0;
    const cap = RB.orig.length + 40;
    function step() {
      if (RB.jump) { done(false); return; } // a game-jump is in flight; don't fight it
      if (++guard > cap) { warn('seekToStep gave up — too many steps'); done(false); return; }
      const p = pos();
      if (p === target) { done(true); return; }
      if (p > target) {
        back(false, (ok) => { if (!ok) { done(false); return; } step(); });
      } else {
        try {
          if (typeof window.pauseE === 'function') window.pauseE();
          window.nextE();
        } catch (e) { warn('seekToStep nextE failed', e); done(false); return; }
        waitForIdle((idle) => { if (!idle) { done(false); return; } step(); }, 4000);
      }
    }
    step();
  }

  // ---------- jump to a game ----------
  function buildGames() {
    RB.games = [];
    let match = 1, game = 0;
    RB.orig.forEach((pl, i) => {
      if (pl.play === 'Back to RPS') { match++; game = 0; }
      if (pl.play === 'Pick first') RB.games.push({ match, game: ++game, pick: i });
    });
  }
  function gameAt(p) {
    let cur = null;
    for (const gm of RB.games) if (gm.pick < p) cur = gm;
    return cur || RB.games[0] || null;
  }
  function deckSource(pick) {
    for (let i = pick - 1; i >= 0; i--) {
      const pl = RB.orig[i].play;
      if (pl === 'Pick first') break;
      if (pl === 'Begin next duel' || pl === 'Back to RPS') return RB.pristine.plays[i + RB.offset];
    }
    return RB.pristine;
  }
  function rebuildLog(upto) {
    const logs = g('duel_logs');
    if (!logs || !RB.pristine) return;
    logs.length = 0;
    for (const l of RB.pristine.logs || []) logs.push(Object.assign({}, l, { seconds: 0 }));
    for (let i = 0; i < upto; i++) {
      const P = RB.pristine.plays[i + RB.offset];
      if (!P || !P.log) continue;
      for (const l of Array.isArray(P.log) ? P.log : [P.log]) logs.push(Object.assign({}, l, { seconds: P.seconds }));
    }
    window.updateDuelLog();
  }
  function jumpTo(entry, done) {
    if (!RB.orig || !RB.pristine || RB.jump || RB.restoring || g('tag_duel')) { done(false); return; }
    const resume = !g('paused');
    if (typeof window.pauseE === 'function') window.pauseE();
    waitForIdle((idle) => {
      if (!idle) { done(false); return; }
      try {
        TweenMax.killAll(false, true, true, true);
        const q = g('actionsQueue'); if (q) q.length = 0;
        window.stopQueue = false;
        RB.markers = [];
        const src = deckSource(entry.pick);
        const first = RB.orig[entry.pick];
        const reset = {
          action: 'Duel', play: 'Back to RPS', player1: clone(src.player1), player2: clone(src.player2),
          seconds: (first.seconds || 0) - 1, username: src.username
        };
        unswap(entry.pick);
        rebuildLog(entry.pick);
        RB.jump = { pick: entry.pick, resume, t0: Date.now(), done };
        window.replay_arr = [reset].concat(RB.orig.slice(entry.pick));
        window.previous_plays = RB.orig.slice(0, entry.pick);
        window.lastAction = null;
        window.seconds = reset.seconds;
        $('#play_btn').disable(false); $('#next_btn').disable(false); $('#fast_btn').disable(false);
        window.fastE();
      } catch (e) { warn('jump failed', e); RB.jump = null; done(false); }
    });
  }
  function jumpLanded() {
    const j = RB.jump;
    RB.jump = null;
    if (j.resume) window.playE(); else window.pauseE();
    if (j.done) j.done(true);
  }
  // A jump that never lands (corrupt data, etc.) shouldn't hang forever.
  setInterval(() => {
    if (RB.jump && Date.now() - RB.jump.t0 > 25000) {
      warn('jump timed out');
      const j = RB.jump; RB.jump = null;
      if (j.done) j.done(false);
    }
  }, 2000);

  // ---------- install (snapshot capture hooks) ----------
  function install() {
    if (typeof window.loadReplayComplete !== 'function' || typeof window.duelResponse0 !== 'function') { setTimeout(install, 300); return; }
    wrap('loadReplayComplete', (orig) => function () {
      const r = orig.apply(this, arguments);
      try {
        if (Array.isArray(g('replay_arr')) && g('replay_arr').length) {
          RB.orig = g('replay_arr').slice();
          RB.snaps.clear(); RB.markers = [];
          try {
            const d = JSON.parse(arguments[0]);
            d.plays = d.plays.filter((x) => x.play !== 'RPS');
            RB.pristine = d;
            RB.offset = d.plays.length - RB.orig.length;
          } catch (e) { warn('no pristine copy', e); }
          buildGames();
          log('loaded —', RB.orig.length, 'plays,', RB.games.length, 'game(s).');
        }
      } catch (e) { warn(e); }
      return r;
    });
    wrap('duelResponse0', (orig) => function (data) {
      const r = orig.apply(this, arguments);
      try { playQueued(data); } catch (e) { warn(e); }
      return r;
    });
    wrap('endAction', (orig) => function () {
      RB.dec = !g('resetting') && (g('actionsQueue') || []).length > 0;
      return orig.apply(this, arguments);
    });
    wrap('saveGamestate', () => function () {
      if (!RB.dec) return;
      RB.dec = false;
      try { actionDone(); } catch (e) { warn(e); }
    });
    wrap('removeToken', (orig) => function (player, data) {
      try {
        const c = window.removeFromField(player, data) || window.removeFromField(player.opponent, data);
        if (!c) return orig.apply(this, arguments);
        const arr = c.data('owner').all_cards_arr;
        const i = arr.indexOf(c);
        if (i >= 0) arr.splice(i, 1);
        c.detach();
        RB.tokens.add(c);
        window.endAction();
      } catch (e) { warn(e); return orig.apply(this, arguments); }
    });
    log('installed.');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();

  // ---------- postMessage bridge to dt-replay-controls.user.js (isolated world) ----------
  function post(type, extra) {
    window.postMessage(Object.assign({ source: 'dt-replay-engine' }, extra || {}, { type: type }), window.location.origin);
  }
  // Each game's [start, end] step range, for dt-replay-controls.user.js's
  // Start/Middle/End moment tiles — computed here, not re-derived in the
  // isolated world, since only this file actually knows RB.orig.length and
  // where each game's "Pick first" play sits. `start` is that game's own
  // deal-out point (what DT_ENGINE_JUMP_GAME lands on); `end` is one step
  // before the next known game starts, or the last play of the whole
  // replay for the last known game — undefined if neither is knowable yet
  // (an unloaded replay can't say where its own last game ends).
  function gameRanges() {
    return RB.games.map((x, i) => {
      const next = RB.games[i + 1];
      const end = next ? next.pick - 1 : (RB.orig ? RB.orig.length - 1 : undefined);
      return { match: x.match, game: x.game, start: x.pick, end: end };
    });
  }
  function status() {
    const cur = gameOf(pos());
    return {
      ready: !!RB.orig, pos: pos(), game: cur || 1,
      canGoBack: canGoBack(), jumping: !!RB.jump, waiting: RB.waiting,
      playing: !g('paused'), totalPlays: RB.orig ? RB.orig.length : null,
      games: gameRanges()
    };
  }
  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.source !== 'dt-content-shim') return;
    const reqId = ev.data.reqId;
    if (ev.data.type === 'DT_ENGINE_STATUS_REQUEST') {
      post('DT_ENGINE_STATUS', Object.assign({ reqId: reqId }, status()));
    } else if (ev.data.type === 'DT_ENGINE_BACK') {
      back(!!ev.data.turn, (ok) => post('DT_ENGINE_BACK_DONE', { reqId: reqId, ok: ok }));
    } else if (ev.data.type === 'DT_ENGINE_NEXT') {
      if (!RB.orig || RB.restoring || RB.waiting || RB.jump) { post('DT_ENGINE_NEXT_DONE', { reqId: reqId, ok: false }); return; }
      try {
        if (typeof window.nextE === 'function') window.nextE();
        waitForIdle((idle) => post('DT_ENGINE_NEXT_DONE', { reqId: reqId, ok: idle }), 4000);
      } catch (e) { warn('nextE failed', e); post('DT_ENGINE_NEXT_DONE', { reqId: reqId, ok: false }); }
    } else if (ev.data.type === 'DT_ENGINE_PLAY') {
      try { if (typeof window.playE === 'function') window.playE(); post('DT_ENGINE_PLAY_DONE', { reqId: reqId, ok: true }); }
      catch (e) { post('DT_ENGINE_PLAY_DONE', { reqId: reqId, ok: false }); }
    } else if (ev.data.type === 'DT_ENGINE_PAUSE') {
      try { if (typeof window.pauseE === 'function') window.pauseE(); post('DT_ENGINE_PAUSE_DONE', { reqId: reqId, ok: true }); }
      catch (e) { post('DT_ENGINE_PAUSE_DONE', { reqId: reqId, ok: false }); }
    } else if (ev.data.type === 'DT_ENGINE_JUMP_GAME') {
      const entry = RB.games.find((x) => x.game === ev.data.game);
      if (!entry) { post('DT_ENGINE_JUMP_DONE', { reqId: reqId, ok: false }); return; }
      jumpTo(entry, (ok) => post('DT_ENGINE_JUMP_DONE', { reqId: reqId, ok: ok }));
    } else if (ev.data.type === 'DT_ENGINE_SEEK') {
      seekToStep(ev.data.step | 0, (ok) => post('DT_ENGINE_SEEK_DONE', { reqId: reqId, ok: ok }));
    }
  });
})();
