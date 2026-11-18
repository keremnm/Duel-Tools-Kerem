// Duel Tools — Transparent Facedowns (MAIN-world engine).
//
// Spec (from the user, across several messages this session):
//  - Your OWN set monster/spell/trap cards: always see-through to you,
//    trivially, since you already know your own cards. Off by default, via
//    an opacity slider (default 60%).
//  - KNOWN opponent cards: if an opponent's card was legitimately seen
//    face-up at any point while on the field, and later goes face-down
//    again (an effect, a flip, etc.), it stays see-through too — "we know
//    Tribe-Infecting Virus was face up, but now it is face down, so that
//    card should also show." The moment that same card instance LEAVES
//    THE FIELD (graveyard, back to hand, banished, deck) the memory is
//    forgotten — a different copy of the same card name showing up later
//    starts unknown again. Separate toggle from the "own cards" one.
//
// CONFIRMED LIVE, against a real duel's own JS state (not guessed):
//  - `player1`/`player2` are real globals holding the full duel state.
//    Each has direct zone properties m1..m5 (monster zones 1-5) and
//    s1..s5 (spell/trap zones 1-5), each either `null` (empty) or a
//    jQuery-wrapped element (the live `.card` div for whatever occupies
//    that zone) — `.data('id')` is a stable per-instance id, `.data
//    ('face_down')` is accurate (confirmed matching the real on-screen
//    look).
//  - `window.username` (MAIN-world global, the logged-in user's own name)
//    matches whichever of player1.username/player2.username is the local
//    player — this is how "mine" vs "opponent's" is resolved, with a
//    geometric (bottom-half-of-board) fallback in case that global is
//    ever missing.
//  - IMPORTANT, and the reason this feature's opponent-side logic never
//    trusts raw DOM presence: a face-down card's `.cardfront` (real art
//    and `.name_txt`) is ALREADY populated in the DOM for both players'
//    cards, known or not — confirmed live even for a card the user had
//    legitimately seen before (so this one data point doesn't fully rule
//    out "DuelingBook just sends everyone's data to everyone's browser
//    regardless of fairness"). Because of that, this engine NEVER uses
//    "is real data present in the DOM" as its signal for "do I know this
//    card" — it only ever reveals an opponent's card if THIS ENGINE itself
//    independently observed, from the real duel action log, that exact
//    zone receive a legitimate face-up action. That is what keeps this a
//    legitimate memory aid instead of a window into the opponent's hidden
//    information.
//  - LEARNING MECHANISM (confirmed correct by the user against real log
//    text, replacing an earlier `.data('face_up')`-polling approach that
//    was tested extensively live and NEVER once fired true): DuelingBook
//    keeps the full scrolling duel action log at
//    `#duel_log .log_txt .os_viewport`, as a flat run of sibling
//    `<font color="#0000FF">...</font>` elements (one per line) separated
//    by `<br>`. A line's flattened textContent looks like:
//      "[21:22] Battle Ox: Normal Summoned Magician of Faith from hand (2/6) to M-3"
//      "[21:46] Battle Ox: Activated Set Card Destruction in S-2"
//    Any line naming the OPPONENT and one of the reveal verbs (Normal
//    Summoned / Special Summoned / Flip Summoned / Placed / Activated)
//    ending "to M-N"/"to S-N" or "in M-N"/"in S-N" means that zone just
//    legitimately became visible — whatever card instance (by id)
//    currently occupies that zone at that moment gets remembered. A
//    later "Set <name> in M-N" line for the same zone needs no separate
//    handling: the engine already detects "now face-down" via
//    `.data('face_down')`, and the id stays remembered until it leaves
//    the field entirely (per the purge step below).
//  - Stacking: a facedown card's `.cardback` (the sleeve `<img>`) and
//    `.cardfront` (the real card) are siblings inside `.content`, both
//    `position:absolute`, same size/position, with `.cardfront` LATER in
//    DOM order. With no z-index on either, default stacking already
//    paints `.cardfront` on top of `.cardback` once both are visible — so
//    revealing is just: make `.cardfront` `display:block` and dial ITS
//    opacity down from the slider (lower opacity = more of the opaque
//    sleeve shows through from behind it). No z-index juggling needed.
(function () {
  'use strict';

  if (window.location.pathname.indexOf('/replay') === 0) return; // live duels only, not replays

  var ZONES = ['m1', 'm2', 'm3', 'm4', 'm5', 's1', 's2', 's3', 's4', 's5'];

  var cfg = { ownEnabled: false, oppEnabled: false, opacity: 0.6 };
  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.data.source !== 'dt-transparent-facedowns-settings') return;
    cfg.ownEnabled = !!ev.data.ownEnabled;
    cfg.oppEnabled = !!ev.data.oppEnabled;
    cfg.opacity = (typeof ev.data.opacity === 'number') ? Math.max(0, Math.min(1, ev.data.opacity)) : cfg.opacity;
  });

  var localPlayer = null; // resolved once per duel, then cached
  function resolveLocalPlayer() {
    // BUG FIX (confirmed live against a real duel): DuelingBook's SPA can
    // move straight from one duel into another in the same tab — a
    // practice/host session into a real match, a "2 out of 3" rematch,
    // etc. — without a full page reload. When that happens `window.
    // player1`/`player2` get reassigned to brand-new objects for the new
    // duel, but this cache (and knownOppIds/touched/processedLogCount
    // below) would otherwise keep pointing at the old duel's now-detached
    // objects forever. That silently broke the me/opponent split: with
    // `localPlayer` matching neither current global, `scan()`'s own `opp
    // = (me === player1) ? player2 : player1` logic always fell through
    // to treating the REAL player1 as "opponent" — which is how a
    // player's own freshly-Set cards stopped getting the "always
    // see-through to you" reveal (reproduced live: ids 1/2 never
    // revealed, id 3 only "revealed" by coincidence because the
    // opponent-learning log-matcher was, by the same swap, matching the
    // player's OWN name instead of the real opponent's). Re-validating
    // the cache on every call, not just once, is what catches this.
    if (localPlayer && typeof player1 !== 'undefined' && typeof player2 !== 'undefined' &&
        localPlayer !== player1 && localPlayer !== player2) {
      for (var ti = 0; ti < touched.length; ti++) {
        try { if (touched[ti].isConnected) revert(touched[ti]); } catch (e) { /* best-effort */ }
      }
      localPlayer = null;
      knownOppIds = {};
      touched = [];
      processedLogCount = 0;
    }
    if (localPlayer) return localPlayer;
    try {
      if (typeof player1 === 'undefined' || typeof player2 === 'undefined') return null;
      if (typeof window.username === 'string' && window.username) {
        if (player1.username === window.username) { localPlayer = player1; return localPlayer; }
        if (player2.username === window.username) { localPlayer = player2; return localPlayer; }
      }
      // Fallback: whichever player currently has any zone card rendered in
      // the bottom half of the board is "mine" — the same self-is-bottom
      // convention already confirmed elsewhere in this project (avatar1,
      // player-only controls).
      function anyZoneTop(p) {
        for (var i = 0; i < ZONES.length; i++) {
          var slot = p[ZONES[i]];
          if (slot && slot.length && slot[0]) return slot[0].getBoundingClientRect().top;
        }
        return null;
      }
      var t1 = anyZoneTop(player1), t2 = anyZoneTop(player2);
      if (t1 !== null && t2 !== null) {
        localPlayer = (t1 > t2) ? player1 : player2;
        return localPlayer;
      }
    } catch (e) { /* duel not ready yet */ }
    return null;
  }

  var knownOppIds = {}; // id -> true, for cards legitimately seen face-up while on the opponent's field
  var touched = []; // elements we've applied the reveal effect to, so we can cleanly revert them

  function slotId(slot) { try { return slot.data('id'); } catch (e) { return null; } }
  function slotFaceDown(slot) { try { return slot.data('face_down') === true; } catch (e) { return false; } }

  // Duel action log parsing (the real "did I legitimately see this"
  // signal — see header comment). Each log line is a sibling <font> with
  // flattened text like "[21:22] Battle Ox: Normal Summoned Magician of
  // Faith from hand (2/6) to M-3" or "[21:46] Battle Ox: Activated Set
  // Card Destruction in S-2".
  var LOG_LINE_RE = /^\[(\d{1,2}:\d{2})\]\s*([^:]+):\s*(Normal Summoned|Special Summoned|Flip Summoned|Placed|Activated)\s+(.+?)\s+(?:from\s+\S+\s*(?:\([^)]*\))?\s*)?(?:to|in)\s+(M|S)-(\d+)\b/;
  var LINE_TIME_RE = /^\[(\d{1,2}:\d{2})\]/;
  var processedLogCount = 0;

  // STALE-BACKLOG GUARD — confirmed root cause of a real false reveal
  // (reported live: two Set cards that were never face-up showed
  // see-through, right after the duel log itself showed a lag spike).
  // learnFromLog() below reads opp[zoneKey]'s CURRENT occupant id to
  // attribute an older log line's reveal — correct when lines are
  // processed close to real time, but WRONG if several lines back up and
  // get processed together in one call (a laggy/backgrounded tab, or
  // catching up on page load mid-duel): an earlier line in that batch can
  // describe a card that has since left the zone, and whatever NEW
  // (never-revealed) card now occupies it gets incorrectly marked known
  // instead. There's no card-name field to cross-check against (confirmed
  // live: `.data('name')` reads back undefined on these zone objects, even
  // for an already face-up card), so instead of guessing, a reveal line is
  // only trusted when it's close to "now" on the duel's OWN elapsed clock
  // (the timestamp on the most recent log line of any kind) — a stale
  // batch spans more clock time than one real-time action normally would.
  // This can't catch every possible case (a zone that genuinely cycles to
  // a new unrevealed card within this same short window would still slip
  // through), but it directly fixes the lag-spike case that was actually
  // reported, and per the user's own rule for this feature — "if it was
  // never face up, we cannot make it transparent" — erring toward missing
  // a legitimate reveal is the correct trade-off over risking a false one.
  var STALE_LEARN_SECONDS = 4;
  function parseClockSeconds(mmss) {
    var parts = mmss.split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }

  function getLogLines() {
    try {
      var viewport = document.querySelector('#duel_log .log_txt .os_viewport');
      if (!viewport) return [];
      var out = [];
      var kids = viewport.children;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].tagName === 'FONT') {
          var t = (kids[i].textContent || '').trim();
          if (t) out.push(t);
        }
      }
      return out;
    } catch (e) { return []; }
  }

  // Scans any newly-appended log lines since last call and marks the
  // opponent's zone contents as known whenever a reveal-verb line names
  // the opponent and that zone. Resets if the log got shorter (a
  // disconnect/new-duel log reset observed live: "Battle Ox has left the
  // duel... The game can now resume" clears the log).
  function learnFromLog(opp) {
    var lines = getLogLines();
    if (lines.length < processedLogCount) processedLogCount = 0;
    if (lines.length <= processedLogCount) return;

    // "Now", on the duel's own elapsed clock — the timestamp on the newest
    // log line of ANY kind (not just lines we otherwise match below). See
    // the STALE-BACKLOG GUARD comment above for why this exists.
    var nowMatch = LINE_TIME_RE.exec(lines[lines.length - 1]);
    var nowSeconds = nowMatch ? parseClockSeconds(nowMatch[1]) : null;

    for (var li = processedLogCount; li < lines.length; li++) {
      var m = LOG_LINE_RE.exec(lines[li]);
      if (!m) continue;
      if (m[2].trim() !== opp.username) continue; // only the opponent's own actions teach us anything
      if (nowSeconds !== null && (nowSeconds - parseClockSeconds(m[1])) > STALE_LEARN_SECONDS) continue; // too old relative to the newest line in this batch — don't trust it
      var zoneKey = m[5].toLowerCase() + m[6];
      if (ZONES.indexOf(zoneKey) === -1) continue;
      var zoneSlot = opp[zoneKey];
      if (zoneSlot && zoneSlot.length) {
        var zid = slotId(zoneSlot);
        if (zid !== null && zid !== undefined) knownOppIds[zid] = true;
      }
    }
    processedLogCount = lines.length;
  }

  function applyReveal(slot) {
    var el = slot[0];
    if (!el) return;
    var front = el.querySelector('.cardfront');
    if (!front) return;
    if (front.dataset.dtOriginalDisplay === undefined) front.dataset.dtOriginalDisplay = front.style.display || '';
    front.style.display = 'block';
    front.style.opacity = String(cfg.opacity);
    if (touched.indexOf(front) === -1) touched.push(front);
  }

  function revert(front) {
    front.style.display = (front.dataset.dtOriginalDisplay !== undefined) ? front.dataset.dtOriginalDisplay : 'none';
    front.style.opacity = '';
    delete front.dataset.dtOriginalDisplay;
  }

  function scan() {
    var me = resolveLocalPlayer();
    if (!me) return;
    var opp = (me === player1) ? player2 : player1;

    // 1) Purge knownOppIds for anything no longer present anywhere on the
    // opponent's field at all (left the field = forgotten, per spec).
    var liveOppIds = {};
    for (var i = 0; i < ZONES.length; i++) {
      var s = opp[ZONES[i]];
      if (s && s.length) {
        var id = slotId(s);
        if (id !== null && id !== undefined) liveOppIds[id] = true;
      }
    }
    for (var knownId in knownOppIds) {
      if (!liveOppIds[knownId]) delete knownOppIds[knownId];
    }

    // 2) Learn: parse any new duel-log lines for the opponent's own
    // reveal actions (Normal/Special/Flip Summon, Placed, Activated into
    // a zone) and remember whatever currently occupies that zone.
    learnFromLog(opp);

    // 3) Apply/revert the visual effect across both players' zones.
    var stillTouched = [];
    for (var k = 0; k < ZONES.length; k++) {
      var mySlot = me[ZONES[k]];
      if (mySlot && mySlot.length && slotFaceDown(mySlot)) {
        if (cfg.ownEnabled) applyReveal(mySlot);
      }
      var oppSlot = opp[ZONES[k]];
      if (oppSlot && oppSlot.length && slotFaceDown(oppSlot)) {
        var oppId = slotId(oppSlot);
        if (cfg.oppEnabled && oppId !== null && oppId !== undefined && knownOppIds[oppId]) applyReveal(oppSlot);
      }
    }
    // Revert anything we previously touched that no longer qualifies this
    // tick (feature toggled off, card flipped face-up for real, card
    // moved/left the field, or the element just isn't facedown anymore).
    //
    // BUG FIX (confirmed live, real duel log: "Set Book of Moon... to S-5"
    // then "Activated Set Book of Moon in S-5"): a REAL flip (the card
    // legitimately going face-up for real, not just our toggle turning
    // off) also makes `stillQualifies` false below, because slotFaceDown()
    // is now false. The old code treated that identically to every other
    // "stop qualifying" case and called revert(), which forces `display`
    // back to whatever was captured in dtOriginalDisplay BEFORE we ever
    // touched the element — i.e. back to its hidden, face-down state.
    // That stomped the real flip: the card had just legitimately gone
    // face-up, so forcing it back to "hidden" made it render as a blank
    // sleeve instead of the real card. The fix: once a card is genuinely
    // face-up, DuelingBook owns its display from here — we only ever
    // need to stop forcing OUR low reveal-opacity (full opacity is the
    // correct look for a real face-up card, and `display:block` is
    // already correct too, so it's left alone). The old hard revert()
    // — which also restores the pre-reveal `display` — is still exactly
    // right for the other cases: toggle turned off, or an opponent card's
    // "known" memory lapsed, while the card is STILL face-down and
    // nothing else on the page is managing its visibility.
    for (var m = 0; m < touched.length; m++) {
      var frontEl = touched[m];
      if (!frontEl.isConnected) continue; // DOM node gone entirely, nothing to revert
      var matchedSlot = null, matchedIsMine = false;
      for (var z = 0; z < ZONES.length; z++) {
        var a = me[ZONES[z]], b = opp[ZONES[z]];
        if (a && a.length && a[0].querySelector && a[0].querySelector('.cardfront') === frontEl) { matchedSlot = a; matchedIsMine = true; break; }
        if (b && b.length && b[0].querySelector && b[0].querySelector('.cardfront') === frontEl) { matchedSlot = b; matchedIsMine = false; break; }
      }
      var stillQualifies = false;
      if (matchedSlot && frontEl.dataset.dtOriginalDisplay !== undefined && frontEl.style.display === 'block') {
        if (matchedIsMine) stillQualifies = cfg.ownEnabled && slotFaceDown(matchedSlot);
        else stillQualifies = cfg.oppEnabled && slotFaceDown(matchedSlot) && !!knownOppIds[slotId(matchedSlot)];
      }
      if (stillQualifies) {
        stillTouched.push(frontEl);
      } else if (matchedSlot && !slotFaceDown(matchedSlot)) {
        // Genuinely flipped face-up for real — let go without forcing it
        // back to hidden (see fix note above).
        frontEl.style.removeProperty('opacity');
        delete frontEl.dataset.dtOriginalDisplay;
      } else {
        revert(frontEl);
      }
    }
    touched = stillTouched;
  }

  setInterval(scan, 400);
  console.log('[Duel Tools] Transparent Facedowns engine ready');

  if (typeof window !== 'undefined') {
    window.__dtTransparentFacedownsTestHooks = { scan, knownOppIds, resolveLocalPlayer, cfg, getLogLines, learnFromLog };
  }
})();
