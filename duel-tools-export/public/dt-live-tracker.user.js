// ==UserScript==
// @name         Duel Tools — Live Tracker
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  Watches the in-page Duel Log during a live match to drive dual action timers, known-card tracking, a YDK export of the opponent's revealed cards, and live sync to the Duel Tools website's My Tracker / Opp Tracker.
// @author       Kerem's Duel Tools
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      db.ygoprodeck.com
// @connect      duel-tools-kerem-production.up.railway.app
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ── STATUS — read this before trusting any number this shows ───────────
  // This is a first working version, not the finished feature. It exists to
  // prove the core idea works: DuelingBook's #duel_log panel, with its
  // "Usernames" checkbox on, prints every action as
  //     [m:ss] Username: action text
  // which means whose action it is is just plain text — no WebSocket
  // reverse-engineering needed at all. That was the missing piece; this
  // script watches that panel, force-enables the checkboxes it needs, and
  // parses each new line as it appears.
  //
  // What's real right now: dual per-player timers (see the interpretation
  // note below — please confirm it matches what you meant), a live feed of
  // parsed events so you can sanity-check the parsing against what's
  // actually happening, a running LP total per player derived from
  // Lost/Gained lines, and a list of opponent cards seen so far. What's
  // NOT built yet: the actual draw-probability math (needs your own deck's
  // YDK as input, which has no upload UI yet either), the staple-card /
  // archetype-adaptive model for the opponent's deck, and a real Field
  // Possession score (shown for now as LP-difference only — the
  // hand/field card-count half needs a bit more log verification before
  // I'd trust it).
  //
  // Timer interpretation, please confirm: each player has a stopwatch.
  // Whoever's turn it is (tracked via who last "Entered Draw Phase" / "Chose
  // to go first") has their timer counting up, and it resets to 0 every
  // time they take one of the reset actions (Drew, Set, Activated, Sent,
  // Gained, Lost, Attacked, Normal/Special/Flip Summoned, Declared effect).
  // The other player's timer sits paused — UNLESS they take one of those
  // same actions (a response during your opponent's turn), in which case it
  // resets to 0 and runs for a few seconds before re-pausing. If that's not
  // what you pictured, tell me and I'll adjust — this was the most literal
  // reading of "pause off-turn, reset on action" I could make.

  const RESET_WORDS = [
    /^Drew /, /^Set /, /^Activated /, /^Sent /, /^Gained /, /^Lost /,
    /^Attacked/, /^Normal Summoned/, /^Special Summoned/, /^Flip Summoned/,
    /^Flipped /, /^Declared effect/
  ];
  const isResetAction = (text) => RESET_WORDS.some((re) => re.test(text));

  // ── Live sync to the Duel Tools website ─────────────────────────────────
  // Pushes a snapshot of the current match to a short-lived "pairing code"
  // slot on the Duel Tools backend, which the site's My Tracker / Opp
  // Tracker tabs poll to show the same data there instead of only in this
  // DuelingBook overlay. No site login ever touches this script — the code
  // is just a random shared secret between this tracker and whichever
  // browser tab on the site has it entered.
  const SITE_API_BASE = 'https://duel-tools-kerem-production.up.railway.app/api';
  function randomPairCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read/type
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }
  function getOrCreatePairCode() {
    let code = safeGetValue('dt_tracker_pair_code', null);
    if (!code) {
      code = randomPairCode();
      safeSetValue('dt_tracker_pair_code', code);
    }
    return code;
  }
  function pushLiveSnapshot(code, snapshot, onDone) {
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: SITE_API_BASE + '/live/' + code,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(snapshot),
        onload: function () { if (onDone) onDone(true); },
        onerror: function () { if (onDone) onDone(false); }
      });
    } catch (e) {
      console.warn('[Duel Tools Tracker] live sync push failed:', e);
      if (onDone) onDone(false);
    }
  }

  // ── Estimating how much of the opponent's deck is still unseen ─────────
  // ── Name → passcode resolution, for exporting a YDK of opponent cards ──
  // YDK files reference cards by their numeric passcode, not by name, so
  // turning the known-card list (plain text names, parsed from the log)
  // into a real .ydk means looking each name up. YGOPRODeck's public card
  // API is what Duel Tools' own site already uses for this exact kind of
  // lookup elsewhere. GM_xmlhttpRequest (not a plain fetch()) is used here
  // specifically because this script runs on duelingbook.com's origin —
  // a bare fetch() to a third-party API from page-injected code can get
  // blocked by CORS depending on the target's headers, while
  // GM_xmlhttpRequest is Tampermonkey's own cross-origin request API and
  // isn't subject to that at all.
  const passcodeCache = {}; // lowercased name -> numeric id, or null if unresolvable
  function resolvePasscode(name) {
    const key = name.trim().toLowerCase();
    if (key in passcodeCache) return Promise.resolve(passcodeCache[key]);
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') { passcodeCache[key] = null; resolve(null); return; }
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://db.ygoprodeck.com/api/v7/cardinfo.php?name=' + encodeURIComponent(name.trim()),
        onload: function (res) {
          let id = null;
          try {
            const data = JSON.parse(res.responseText);
            id = (data && data.data && data.data[0] && data.data[0].id) || null;
          } catch (e) { /* leave id null — unresolvable, not fatal */ }
          passcodeCache[key] = id;
          resolve(id);
        },
        onerror: function () { passcodeCache[key] = null; resolve(null); },
        ontimeout: function () { passcodeCache[key] = null; resolve(null); },
        timeout: 8000
      });
    });
  }

  // Resolves every known card sequentially (not in parallel) — a live
  // match's card list is short (dozens at most) and this is polite to a
  // free public API rather than firing a burst of simultaneous requests.
  async function buildYdkFromKnownCards(knownCards, onProgress) {
    const ids = [];
    const unresolved = [];
    for (let i = 0; i < knownCards.length; i++) {
      const c = knownCards[i];
      if (onProgress) onProgress(i + 1, knownCards.length, c.name);
      const id = await resolvePasscode(c.name);
      if (id) {
        // c.max is the peak number of copies ever simultaneously out of the
        // deck (see addKnownOppCard) — already the real proof-of-copies
        // count, not a raw reveal tally, but still capped at 3 as a final
        // sanity check since a real deck can never legally run more anyway.
        const copies = Math.min(c.max, 3);
        for (let n = 0; n < copies; n++) ids.push(id);
      } else {
        unresolved.push(c.name);
      }
    }
    return { ids, unresolved };
  }

  function downloadYdk(ids, filename) {
    const text = '#created by Duel Tools Live Tracker\n#main\n' + ids.join('\n') + '\n#extra\n!side\n';
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ── Reverse lookup (passcode → name + type), for reading back an uploaded
  // YDK. Type is captured alongside the name so the site can sort live tiles
  // Monster→Spell→Trap the same way it sorts everywhere else, instead of
  // whatever order the log happened to reveal cards in.
  const nameCache = {}; // numeric id (string) -> { name, type } or null if unresolvable
  function resolveNameFromPasscode(id) {
    const key = String(id);
    if (key in nameCache) return Promise.resolve(nameCache[key]);
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') { nameCache[key] = null; resolve(null); return; }
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://db.ygoprodeck.com/api/v7/cardinfo.php?id=' + encodeURIComponent(key),
        onload: function (res) {
          let result = null;
          try {
            const data = JSON.parse(res.responseText);
            const card = data && data.data && data.data[0];
            result = card ? { name: card.name, type: card.type || '' } : null;
          } catch (e) { /* leave result null — unresolvable, not fatal */ }
          nameCache[key] = result;
          resolve(result);
        },
        onerror: function () { nameCache[key] = null; resolve(null); },
        ontimeout: function () { nameCache[key] = null; resolve(null); },
        timeout: 8000
      });
    });
  }

  // Main-deck section only — Extra Deck cards aren't drawn from your deck
  // in the normal sense, so they're deliberately excluded from a "what's
  // left to draw" tracker.
  function parseYdkMainDeck(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const mainIdx = lines.indexOf('#main');
    if (mainIdx === -1) return [];
    let endIdx = lines.length;
    for (let i = mainIdx + 1; i < lines.length; i++) {
      if (lines[i] === '#extra' || lines[i] === '!side') { endIdx = i; break; }
    }
    const ids = [];
    for (let i = mainIdx + 1; i < endIdx; i++) {
      if (/^\d+$/.test(lines[i])) ids.push(lines[i]);
    }
    return ids;
  }

  // Groups a flat id list into [{id, name, type, total}], resolving each
  // UNIQUE id to a name+type sequentially (same politeness reasoning as the
  // opponent-card resolver above — a deck is at most ~15-20 unique cards
  // even with duplicates grouped, so this stays quick).
  async function buildDeckListFromYdk(text, onProgress) {
    const ids = parseYdkMainDeck(text);
    const counts = {};
    ids.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
    const uniqueIds = Object.keys(counts);
    const list = [];
    for (let i = 0; i < uniqueIds.length; i++) {
      const id = uniqueIds[i];
      if (onProgress) onProgress(i + 1, uniqueIds.length);
      const resolved = await resolveNameFromPasscode(id);
      list.push({ id, name: (resolved && resolved.name) || ('Unknown card #' + id), type: (resolved && resolved.type) || '', total: counts[id] });
    }
    return list;
  }

  function loadMyDeckList() {
    const raw = safeGetValue('dt_tracker_my_deck', '');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function saveMyDeckList(list) {
    safeSetValue('dt_tracker_my_deck', JSON.stringify(list));
  }

  // ── One-time setup: your own username, so "everyone else" = opponent ───
  // Every GM_* call here is wrapped in try/catch: if Tampermonkey's storage
  // ever throws (sandbox config varies by browser/setup), the tracker should
  // still start for THIS session instead of the click silently doing
  // nothing — persistence is a nice-to-have, not a requirement to proceed.
  function safeGetValue(key, def) {
    try { return GM_getValue(key, def); }
    catch (e) { console.warn('[Duel Tools Tracker] GM_getValue failed:', e); return def; }
  }
  function safeSetValue(key, val) {
    try { GM_setValue(key, val); }
    catch (e) { console.warn('[Duel Tools Tracker] GM_setValue failed (will ask again next time):', e); }
  }

  function getMyUsername(cb) {
    const stored = safeGetValue('dt_tracker_my_username', '');
    if (stored) { console.log('[Duel Tools Tracker] using saved username:', stored); cb(stored); return; }

    const box = document.createElement('div');
    box.id = 'dt-tracker-setup-box';
    box.style.cssText = [
      'position:fixed', 'top:20px', 'left:20px', 'z-index:2147483647',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:13px', 'width:260px', 'padding:14px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)'
    ].join(';');
    box.innerHTML =
      '<div style="font-weight:bold;margin-bottom:8px">🎯 Duel Tools Live Tracker</div>' +
      '<label style="display:block;font-size:11px;color:#999;margin-bottom:2px">Your DuelingBook username</label>' +
      '<input id="dt-tr-username" type="text" placeholder="type it exactly as shown in DuelingBook" style="width:100%;box-sizing:border-box;margin-bottom:8px;background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:4px;padding:5px;font-family:monospace"/>' +
      '<div id="dt-tr-err" style="display:none;color:#e04444;font-size:11px;margin-bottom:6px">Type your username first.</div>' +
      '<button id="dt-tr-save-username" style="width:100%;background:#00e596;color:#050508;border:none;border-radius:5px;padding:7px;font-weight:bold;cursor:pointer;font-family:monospace">Start Tracking</button>';
    document.body.appendChild(box);
    console.log('[Duel Tools Tracker] username prompt shown');
    const inp = box.querySelector('#dt-tr-username');
    const err = box.querySelector('#dt-tr-err');
    inp.focus();
    const go = () => {
      const v = inp.value.trim();
      console.log('[Duel Tools Tracker] Start Tracking clicked, value =', JSON.stringify(v));
      if (!v) {
        inp.style.borderColor = '#e04444';
        err.style.display = 'block';
        inp.focus();
        return;
      }
      safeSetValue('dt_tracker_my_username', v);
      box.remove();
      cb(v);
    };
    box.querySelector('#dt-tr-save-username').onclick = go;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    inp.addEventListener('input', () => { err.style.display = 'none'; inp.style.borderColor = '#333'; });
  }

  // ── Force-enable the log's own filter checkboxes ────────────────────────
  // Confirmed via inspecting the real page: these are native
  // <input type="checkbox"> elements made invisible (opacity:0) with a
  // custom checkmark drawn on top via CSS, and identified by class name —
  // e.g. class="usernames_cb" — not by any nearby visible text. Match on
  // class name first; keep the old nearby-text check as a fallback in case
  // any filter doesn't follow that pattern.
  const CHECKBOX_KEYWORDS = ['chat', 'duel', 'game', 'private', 'username'];
  function enableLogCheckboxes(duelLogEl) {
    const checkboxes = duelLogEl.querySelectorAll('input[type=checkbox]');
    let matchedCount = 0;
    checkboxes.forEach((cb) => {
      const classStr = (cb.className || '').toLowerCase();
      const context = ((cb.parentElement && cb.parentElement.textContent) || '').toLowerCase();
      const matches = CHECKBOX_KEYWORDS.some((w) => classStr.indexOf(w) !== -1 || context.indexOf(w) !== -1);
      if (matches) {
        matchedCount++;
        if (!cb.checked) {
          // A real .click() rather than manually flipping `checked` and
          // dispatching synthetic events — it reproduces the exact same
          // sequence an actual user click produces (toggling .checked AND
          // firing 'click'/'change' in native order), so whatever listener
          // DuelingBook itself wired up sees an entirely ordinary click.
          cb.click();
        }
      }
    });
    console.log('[Duel Tools Tracker] checkboxes: found', checkboxes.length, 'total,', matchedCount, 'matched a wanted filter (expected 5)');
    if (matchedCount < CHECKBOX_KEYWORDS.length) {
      console.warn('[Duel Tools Tracker] not all 5 log filters were found/checked — you may need to check them yourself (Chat, Duel, Game, Private Info, Usernames) in the Duel Log panel.');
    }
  }

  // ── Parse one log line ──────────────────────────────────────────────────
  const LINE_RE = /^\[(\d+):(\d+)\]\s*([^:]+):\s*(.*)$/;
  function parseLine(rawText) {
    const m = LINE_RE.exec(rawText.trim());
    if (!m) return null;
    const [, min, sec, username, text] = m;
    // Chat / typed messages render as quoted text ("gl hf", "/draw13") —
    // everything else (Drew X, Entered Main Phase 1, ...) is unquoted.
    const isChat = /^".*"$/.test(text.trim());
    return {
      seconds: parseInt(min, 10) * 60 + parseInt(sec, 10),
      username: username.trim(),
      text: text.trim(),
      isChat
    };
  }

  // ── Main tracker state + UI ─────────────────────────────────────────────
  function startTracker(myUsername, deckList) {
    const state = {
      myUsername,
      oppUsername: null,
      myLP: 8000,
      oppLP: 8000,
      turnHolder: null,
      myTimer: 0, oppTimer: 0,
      myTimerRunning: true, oppTimerRunning: false,
      oppInterruptUntil: 0, // ms timestamp — opponent's timer stays live until this passes, when it's not their turn
      knownOppCards: [], // [{name, records, max}] — records tracks currently-out copies by guessed zone, max is the peak count reached (see addKnownOppCard below); persists across games within a match, reset only on a new match
      feed: [], // last N parsed events for the debug view
      paused: false,
      myDeckList: deckList || null, // [{id, name, type, total}] — the uploaded YDK, persists indefinitely once set
      myDeckRemaining: null, // [{id, name, type, total, zones:{hand,field,grave,banish}}] — rebuilt fresh every GAME (the deck reshuffles each game)
      game: 1, // which game of this MATCH we're on — 1 unless resetForNewGame() has bumped it
      matchConcluded: false, // set true once "View Replay" appears — mirrors the outer matchConcluded flag, for the live-sync payload
      matchStartedAt: Date.now(), // fixed once per match — lets the site detect "this is a brand-new match" without guessing
      myWins: 0, oppWins: 0, // game wins THIS MATCH — first to 2 (Bo3, extending past G3 on a draw) wins the match
      gameResults: [], // ['win'|'loss', ...] — one entry per completed game this match, in order
      // Control-changing effects (Creature Swap is the only one legal in
      // Goat Format) make the OPPONENT's side of the log name a card that's
      // actually YOURS. controlSwappedNames remembers exactly which specific
      // card names that's happened to (lowercased), so only THOSE names keep
      // crediting your own deck when the opponent's side names them — see
      // the routing logic in applyEvent for why this replaced an earlier,
      // much broader "always check my deck first" rule that misfired for
      // any shared staple name (Sangan, Pot of Greed, etc.) the opponent
      // simply played a copy of themselves. Reset every new GAME, since
      // Creature Swap's control change doesn't survive a reshuffle.
      controlSwappedNames: new Set(),
      controlSwapWindowUntil: 0, // ms timestamp — the next opponent-voiced reveal of one of MY cards within this window is assumed to be the just-swapped copy
      awaitingNewGameChoice: false, // true right after a game-ending "Admitted defeat"/"Lost Duel" until the next "Chose to go first/second" — see applyEvent's new-game detection
      lastGameResetAt: 0 // ms timestamp of the last resetForNewGame() call — debounces against double-firing if the RPS-based reset (drawn games) and the "chose to go first" reset both react to the same boundary
    };

    function freshDeckRemaining() {
      return state.myDeckList ? state.myDeckList.map((c) => ({ id: c.id, name: c.name, type: c.type || '', total: c.total, zones: { hand: 0, field: 0, grave: 0, banish: 0 } })) : null;
    }
    state.myDeckRemaining = freshDeckRemaining();

    // Classifies a single log line into a zone transition — shared by both
    // your own deck (exact accounting, since we know your real decklist)
    // and the opponent's (inferred copy-records, since we only see what
    // they reveal). Zones are "hand", "field" (monster/spell/trap zones —
    // Set, Summoned, or Activated and still out there), "grave", "banish",
    // or null meaning "back in the deck / not tracked". Returns null when
    // the line isn't a recognized transition at all (e.g. a card merely
    // "Revealed ... from Deck" stays in the deck — nothing to track yet).
    //
    // NOTE: this is a best-effort guess at DuelingBook's real wording,
    // confirmed only for the verbs actually seen in testing (Drew, Set,
    // Summoned, Sent, Returned, Banished/Removed, Added). If a label isn't
    // tracking correctly in a real match, the fix is almost certainly
    // widening these regexes — the exact log line text is what's needed to
    // do that precisely, so please paste it if you spot a miss.
    function classifyCardAction(text, cardType) {
      if (/^Revealed .+ from Deck\b/i.test(text)) return null; // stays in the deck — nothing to track yet

      // A bare reveal with nothing else stated (e.g. a Trap Dustshoot-style
      // hand reveal) is NOT a zone move at all — the card doesn't leave
      // wherever it already was, it just becomes visible. Handled as its
      // own case, separate from the normal to/from machinery below (which
      // always assumes something actually moved), via the `reveal` flag —
      // see addKnownOppCard for how that's applied (reuse any existing
      // record for this name rather than assuming a new copy appeared).
      if (/^Revealed ([A-Za-z0-9 ,.'\-:]+)$/i.test(text)) {
        return { from: null, to: 'hand', reveal: true };
      }

      const toGrave  = /\bto (?:the )?(?:GY|Graveyard)\b/i.test(text);
      const toBanish = /^(?:Banished|Removed) /i.test(text) ||
                        /\bto (?:the )?Banish(?:ed)?(?: Zone)?\b/i.test(text) ||
                        /\bremoved .+ from (?:play|the field)\b/i.test(text);
      const toDeck   = /^Returned .+ to (?:the )?(?:top of |bottom of )?Deck\b/i.test(text) ||
                        /\bto (?:the )?(?:top|bottom) of (?:the )?Deck\b/i.test(text);
      const toHand   = /^Drew /i.test(text) || /^Added /i.test(text) || /\bto (?:your |their )?hand\b/i.test(text);
      const toField  = /^(?:Set|Activated|Normal Summoned|Special Summoned|Flip Summoned|Flipped) /i.test(text);

      let to;
      if (toGrave) to = 'grave';
      else if (toBanish) to = 'banish';
      else if (toDeck) to = null;
      else if (toHand) to = 'hand';
      else if (toField) to = 'field';
      else return null; // no recognized destination — e.g. "Attacked", pure chat, etc.

      const fromGrave  = /\bfrom (?:the )?(?:GY|Graveyard)\b/i.test(text);
      const fromBanish = /\bfrom (?:the )?Banish(?:ed)?(?: Zone)?\b/i.test(text) || /\bfrom (?:play|removal)\b/i.test(text);
      const fromDeckExplicit = /\bfrom Deck\b/i.test(text);
      const fromHand   = /\bfrom hand\b/i.test(text);

      let from;
      if (fromGrave) from = 'grave';
      else if (fromBanish) from = 'banish';
      else if (fromDeckExplicit) from = 'deck';
      else if (fromHand) from = 'hand';
      else {
        // No explicit "from X" clause in the log text at all — this used to
        // fall through to a single hardcoded zone-guessing order applied no
        // matter the destination, which silently corrupted counts for any
        // deck running 2+ copies of the same card: e.g. drawing a SECOND
        // Chaos Sorcerer while the first already sat in hand would "take"
        // from hand (since it already had a copy) and immediately give it
        // right back, net zero — the genuinely new copy was never counted.
        // Inferring the source from the DESTINATION instead avoids that: an
        // unqualified draw/return-to-hand is always a fresh copy off the
        // deck (DuelingBook's plain "Drew X" never spells out "from Deck"),
        // and an unqualified summon/set/activation is overwhelmingly played
        // straight from hand — both are near-certainties, unlike guessing
        // across every zone. Only to-grave/to-banish with truly no stated
        // source is left ambiguous (see applyZoneTransition's fallback).
        if (to === 'hand') from = 'deck';
        else if (to === 'field') {
          // Still ambiguous in general (a Spell is usually played straight
          // from hand) — EXCEPT for a Trap Card, which by the game's own
          // rules can only ever be activated from an already-Set position
          // on the field, never straight from hand. Without this, activating
          // a Set trap wrongly "borrowed" a copy that was really a separate
          // one still sitting in hand — reported as two Trap Dustshoots
          // showing "on field" when one had actually already resolved to
          // the Graveyard and the other was a second, untouched copy.
          const isTrapActivation = /^Activated /i.test(text) && cardType && /trap/i.test(cardType);
          // A more direct signal that doesn't need cardType at all (so it
          // also covers the OPPONENT's side, where card type is never known
          // synchronously): DuelingBook's own wording often spells out that
          // the card was already Set/face-down right in the verb itself —
          // "Activated Set <Name> ...", "Flip Summoned Set <Name> ...",
          // "Flipped Set <Name> ...". Any of those means the source is
          // unambiguously the field, never hand, for a monster or a
          // Spell/Trap alike.
          const textSaysFromSet = /^(?:Activated|Flip Summoned|Flipped) Set /i.test(text);
          from = (textSaysFromSet || isTrapActivation) ? 'field' : 'hand';
        }
        else from = null;
      }

      return { from, to };
    }

    // Moves one copy of a card between zones as the log reveals it
    // happening. Zones are aggregate counts, not per-physical-copy identity
    // (the log never gives us a serial number to track one specific copy
    // across lines) — a label sticks to a card until another recognized
    // move happens, it does NOT clear itself just because a copy sits on
    // the field being used for a while.
    function applyZoneTransition(entry, text) {
      const action = classifyCardAction(text, entry.type);
      if (!action) return;
      // A bare reveal never means a move — it's meaningful for the opponent
      // (addKnownOppCard uses it to note "now confirmed in hand"), but for
      // your OWN deck it doesn't tell us anything your exact draw/play
      // tracking doesn't already know, so it's a deliberate no-op here.
      if (action.reveal) return;
      function take(zone) {
        if (entry.zones[zone] > 0) { entry.zones[zone]--; return true; }
        return false;
      }
      if (action.from === 'deck') {
        // A fresh copy off the deck (a draw, or classifyCardAction inferred
        // it from an unqualified "to hand") — never consume an existing
        // zone tally for this. This is the fix for a second (or third) copy
        // of the same card silently not being counted: e.g. drawing a 2nd
        // Chaos Sorcerer while the 1st already sits in hand must ADD to the
        // hand tally, not cancel out against it.
      } else if (action.from) {
        // A specific source zone is known (either stated explicitly in the
        // log, or inferred from the destination — see classifyCardAction).
        // Take from it; only fall back through the other zones if that
        // exact zone's tally is unexpectedly already empty, so a genuinely
        // mis-tracked case still degrades gracefully instead of dropping
        // the transition entirely.
        const order = [action.from, 'field', 'hand', 'grave', 'banish'];
        for (let i = 0; i < order.length; i++) { if (take(order[i])) break; }
      } else {
        // Truly no source information at all — reachable for an unqualified
        // move to grave/banish (e.g. a plain "Sent X to GY", most often from
        // the field) or a return to deck with no "from X" clause (could
        // plausibly be leaving hand, field, grave, or banish). Falls back
        // through every zone in rough likelihood order rather than assuming
        // one, since narrowing this to just field/hand previously broke
        // "Returned X to Deck" reverting a banished copy correctly.
        const order = ['field', 'hand', 'grave', 'banish'];
        for (let i = 0; i < order.length; i++) { if (take(order[i])) break; }
      }
      if (action.to !== null) entry.zones[action.to]++;
      // action.to === null means "back in the deck" — nothing to increment.
    }

    // Mirrors the site's OWN established replay-parsing accounting (see
    // parseMatch()/buildGameCards() in index.html): a naive "count every
    // reveal" tally inflates fast for any card that returns to hand/deck and
    // gets reused (Jar of Greed, Thunder Dragon, etc. showing up as "×5" of
    // a 3-copy card). Uses the SAME classifyCardAction() transition logic as
    // your own deck above, but instead of one exact zone-count per card it
    // tracks actual per-copy "records" (one per physical copy currently
    // believed out of the deck, tagged with a guessed zone) — because unlike
    // your own deck, the opponent's hand is hidden, so a card can be
    // revealed for the first time by an action that implies it left the
    // deck a while ago (e.g. a "Discarded X from hand to GY" with no earlier
    // "Drew X" line, since opponent draws aren't named until something
    // reveals them). A transition tries to reuse an existing record in the
    // zone it should be coming from; if none matches, it assumes it's
    // revealing a copy we didn't know about yet and creates a new record —
    // this is what lets two simultaneous "Discarded ... from hand" lines for
    // the same name correctly register as 2 distinct copies instead of 1.
    // `max` (the peak record count ever reached) is what's actually
    // reported, since that's the real proof of how many distinct copies
    // exist, not how many times we've seen one.
    function addKnownOppCard(name, text) {
      let entry = state.knownOppCards.find((c) => c.name === name);
      if (!entry) { entry = { name, records: [], max: 0 }; state.knownOppCards.push(entry); }
      const action = classifyCardAction(text);
      if (action) {
        if (action.reveal) {
          // A bare reveal (e.g. Trap Dustshoot showing their hand) never
          // means a new copy just appeared — it's the same physical card
          // still sitting wherever it already was. Only when we have NO
          // existing record at all does this count as a genuinely new copy
          // being seen for the first time, in which case it's confirmed in
          // hand. An already-tracked copy's zone is left exactly as-is
          // (trust the more specific move that put it there over a bare
          // reveal, and this is also what lets it correctly "fall off" once
          // a later real move — sent back, played, discarded — is logged).
          if (entry.records.length === 0) entry.records.push(action.to);
        } else if (action.to === null) {
          // returning to deck — one fewer copy out. Prefer removing from the
          // named source zone; otherwise drop the most recently tracked one.
          const idx = (action.from && action.from !== 'deck') ? entry.records.lastIndexOf(action.from) : entry.records.length - 1;
          if (idx >= 0) entry.records.splice(idx, 1);
        } else if (action.from === 'deck' || !action.from) {
          // Fresh from the deck, or no source named — try to reuse an
          // existing record first (covers e.g. a card already known to be
          // in their hand now being Set/Activated), but NEVER reuse a
          // record already sitting in the SAME zone this move is heading
          // to — that's not a move at all, so it must be a genuinely
          // different, previously-unseen copy landing there directly (e.g.
          // a 2nd copy of a card being banished straight from the field
          // while the 1st copy is already banished — reusing the 1st copy's
          // record here silently ate the 2nd copy instead of counting it).
          let idx = -1;
          if (!action.from) {
            const order = ['field', 'hand', 'grave', 'banish'].filter((z) => z !== action.to);
            for (let i = 0; i < order.length && idx < 0; i++) idx = entry.records.lastIndexOf(order[i]);
          }
          if (idx >= 0) entry.records[idx] = action.to;
          else entry.records.push(action.to);
        } else {
          const idx = entry.records.lastIndexOf(action.from);
          if (idx >= 0) entry.records[idx] = action.to;
          else entry.records.push(action.to); // no matching source copy — reveals one we didn't know about
        }
      }
      if (entry.records.length > entry.max) entry.max = entry.records.length;
      return entry;
    }

    // Rough LP-based "who's ahead" estimate — NOT a real win probability
    // (that would need board state, hand size, resources, etc.), just a
    // clearly-labeled edge indicator: 50/50 at even LP, saturating toward
    // the extremes as the LP gap grows.
    function computeEdgePct() {
      const diff = state.myLP - state.oppLP;
      return Math.round(50 + 50 * Math.tanh(diff / 4000));
    }

    function buildSnapshot() {
      return {
        myUsername: state.myUsername,
        oppUsername: state.oppUsername,
        game: state.game,
        matchStartedAt: state.matchStartedAt,
        myWins: state.myWins,
        oppWins: state.oppWins,
        gameResults: state.gameResults,
        matchConcluded: !!state.matchConcluded,
        paused: state.paused,
        myLP: state.myLP,
        oppLP: state.oppLP,
        myTimer: Math.floor(state.myTimer),
        oppTimer: Math.floor(state.oppTimer),
        edgePct: computeEdgePct(),
        myDeck: state.myDeckRemaining || [],
        // Factual only — a card's count is exactly how many distinct copies
        // we've actually seen leave the deck (see addKnownOppCard above), no
        // guess at how many more might be left unseen in their deck/hand.
        // zones summarizes each CURRENTLY tracked copy's records (a copy
        // that's since returned to deck is no longer in any zone here, even
        // though it still counts toward the peak `count` above) — this is
        // what lets the site show "IN HAND"/"GRAVEYARD"/etc. on opponent
        // tiles the same way it already does for your own deck.
        oppCards: state.knownOppCards
          .filter((c) => c.max > 0)
          .map((c) => {
            const zones = { hand: 0, field: 0, grave: 0, banish: 0 };
            c.records.forEach((z) => { if (zones[z] !== undefined) zones[z]++; });
            return { name: c.name, count: c.max, zones };
          }),
        updatedAt: Date.now()
      };
    }

    let PAIR_CODE = getOrCreatePairCode(); // mutable — regeneratePairCode() below can replace it mid-session
    let lastPush = 0;
    function maybePushLive(force) {
      const now = Date.now();
      if (!force && now - lastPush < 3000) return;
      lastPush = now;
      pushLiveSnapshot(PAIR_CODE, buildSnapshot(), function (ok) {
        const el = panel.querySelector('#dt-tr-sync-status');
        if (!el) return;
        el.textContent = ok
          ? 'Synced ' + new Date().toLocaleTimeString()
          : 'Sync failed — will keep retrying';
        el.style.color = ok ? '#555' : '#a55';
      });
    }

    // ── Side Practice → Live Tracker siding sync ────────────────────────────
    // DuelingBook's actual in-duel siding screen never shows up in #duel_log
    // (it's a separate deck-editor UI, not a logged duel action) — there's no
    // event this tracker could watch to see what got swapped in/out on the
    // real DuelingBook siding step. The practical alternative: the website's
    // own Side Practice tab already lets you build the post-side deck by
    // hand, and its "Push to Live Tracker" button (index.html) sends that
    // composition here via the same pairing-code relay, one-shot, under
    // POST /api/live/:code/side. This just polls for it periodically and,
    // once one shows up, applies it as this match's new myDeckList (kept
    // for every future game of the match, exactly like a re-uploaded YDK)
    // and clears the pending slot so it isn't re-applied on the next game.
    function fetchPendingSideUpdate(cb) {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: SITE_API_BASE + '/live/' + PAIR_CODE + '/side',
          onload: function (res) {
            if (res.status !== 200) { cb(null); return; }
            try { cb(JSON.parse(res.responseText)); } catch (e) { cb(null); }
          },
          onerror: function () { cb(null); }
        });
      } catch (e) { cb(null); }
    }
    function clearPendingSideUpdate() {
      try { GM_xmlhttpRequest({ method: 'DELETE', url: SITE_API_BASE + '/live/' + PAIR_CODE + '/side' }); }
      catch (e) { /* best-effort — a stale pending update just gets re-applied harmlessly next poll, same list */ }
    }
    function applyPendingSideUpdate(mainList) {
      // mainList: [{id, name, type, total}] — already grouped by the site
      state.myDeckList = mainList;
      saveMyDeckList(mainList);
      state.myDeckRemaining = freshDeckRemaining();
      renderMyDeck();
      maybePushLive(true);
      const status = panel.querySelector('#dt-tr-ydk-status');
      if (status) status.textContent = 'Decklist updated from Side Practice (' + mainList.reduce((s, c) => s + c.total, 0) + ' cards) — applies starting now';
      console.log('[Duel Tools Tracker] applied a pending side-deck update from Side Practice:', mainList);
    }
    let lastSideCheck = Date.now(); // starts the 5s throttle from tracker init, not an immediate first check
    function maybeCheckPendingSide() {
      const now = Date.now();
      if (now - lastSideCheck < 5000) return;
      lastSideCheck = now;
      fetchPendingSideUpdate(function (payload) {
        if (payload && Array.isArray(payload.main) && payload.main.length) {
          applyPendingSideUpdate(payload.main);
          clearPendingSideUpdate();
        }
      });
    }

    function who(username) {
      if (username.toLowerCase() === state.myUsername.toLowerCase()) return 'me';
      // First "other" username we see becomes "the opponent" for this match
      if (!state.oppUsername) state.oppUsername = username;
      if (username.toLowerCase() === state.oppUsername.toLowerCase()) return 'opp';
      return 'other'; // spectator chat, etc.
    }

    // Extracts a real card name from a log line, when one is actually
    // present. "Drew <Name>" is handled on its own since the name runs to
    // the end of the line with nothing after it; every other recognized
    // action always has a zone reference or parenthetical stat block right
    // after the name, so those require seeing one — deliberately no
    // end-of-string fallback (a earlier version that had one silently
    // absorbed trailing words like "in S-3" into the name). "Revealed " is
    // included so a card shown but left in the deck is still recognized (it
    // just doesn't move the opponent's copy-record count — see classifyOppCardAction).
    function extractRevealedCardName(text) {
      const drewM = /^Drew (.+)$/.exec(text);
      if (drewM) {
        const n = drewM[1].trim();
        return /^a card$/i.test(n) ? null : n;
      }
      // A bare "Revealed <Name>" with nothing else in the line (e.g. a Trap
      // Dustshoot-style hand reveal) — same "runs to the end of the line"
      // shape as "Drew X" above, and just as easy to otherwise miss
      // entirely, since the general regex below requires a trailing zone/
      // stat clause that a plain reveal never has.
      const revealedM = /^Revealed ([A-Za-z0-9 ,.'\-:]+)$/.exec(text);
      if (revealedM) {
        const n = revealedM[1].trim();
        return /^a card$/i.test(n) ? null : n;
      }
      // DuelingBook's own log text often says "Activated Set <Name> ..." or
      // "Flip Summoned Set <Name> ..." / "Flipped Set <Name> ..." to spell
      // out that the card was already sitting face-down before this action
      // — the literal word "Set" shows up a SECOND time, right after the
      // leading verb, not just when "Set" is itself the verb. Without
      // stripping that redundant "Set " too, it got swallowed into the
      // capture group and came out the other end as a broken "Set Book of
      // Moon"-style name — a real, systemic bug, not a one-off (confirmed
      // by live-match screenshots showing it on essentially every Set/flip/
      // trap-from-Set reveal for the opponent). The optional (?:Set )? right
      // after the verb alternation strips it wherever it shows up.
      const m = /^(?:Set |Activated |Normal Summoned |Special Summoned |Flip Summoned |Flipped |Sent |Discarded |Banished |Removed |Added |Revealed |Declared effect of |Returned |Moved |Changed )(?:Set )?([A-Za-z0-9 ,.'\-:]+?)(?: from| to| in| on| \()/.exec(text);
      const n = m && m[1] && m[1].trim();
      return (n && !/^card$/i.test(n)) ? n : null;
    }

    function applyEvent(ev) {
      const side = who(ev.username);
      if (side === 'other' || ev.isChat) { pushFeed(side, ev.text, true); return; }

      // Turn tracking
      if (/^Entered Draw Phase$/.test(ev.text) || /^Chose to go first$/.test(ev.text)) {
        state.turnHolder = side;
      }

      // LP tracking
      let lpM = /^Lost (\d+) LP$/.exec(ev.text);
      if (lpM) { if (side === 'me') state.myLP -= parseInt(lpM[1], 10); else state.oppLP -= parseInt(lpM[1], 10); }
      lpM = /^Gained (\d+) LP$/.exec(ev.text);
      if (lpM) { if (side === 'me') state.myLP += parseInt(lpM[1], 10); else state.oppLP += parseInt(lpM[1], 10); }

      // Per-GAME win/loss — DuelingBook logs the loser's line as exactly
      // "Admitted defeat" or "Lost Duel" (same signal the site's own replay
      // parser uses to determine gameWinners — see parseMatch() in
      // index.html). The other side won that game. This does NOT touch
      // matchConcluded (the whole-match "View Replay" signal) — a single
      // game ending mid-Bo3 doesn't end the match.
      if (ev.text === 'Admitted defeat' || ev.text === 'Lost Duel') {
        if (side === 'me') { state.oppWins++; state.gameResults.push('loss'); }
        else if (side === 'opp') { state.myWins++; state.gameResults.push('win'); }
        // A normal (non-drawn) G2/G3 never replays DuelingBook's RPS/coin-toss
        // screen — only a DRAWN game forced into an extra one does (see
        // watchForNewDuels/#rps_start below). Instead the loser of THIS game
        // is simply given the choice to go first or second, logged as a
        // plain "Chose to go first/second" line with no #rps_start moment at
        // all. Arming this flag lets that exact line (matched below) trigger
        // resetForNewGame() itself, from inside the log stream, instead of
        // relying solely on a DOM watcher that never fires for this case.
        state.awaitingNewGameChoice = true;
        maybePushLive(true);
      }

      // New GAME within the same match, detected the same way (mirrors the
      // exact "Chose to go" substring the site's own trusted replay parser
      // already uses for game boundaries — see the parseMatch() comment in
      // index.html). Debounced against the DOM-based #rps_start reset (for
      // drawn games) firing for the same boundary via lastGameResetAt.
      if (ev.text.includes('Chose to go') && state.awaitingNewGameChoice) {
        state.awaitingNewGameChoice = false;
        if (Date.now() - state.lastGameResetAt > 3000) resetForNewGame();
      }

      // Which side a revealed card belongs to is decided by who SPOKE the
      // line, by default — that's correct the overwhelming majority of the
      // time, including when your opponent simply plays their own copy of a
      // card that happens to share a name with something in your deck (a
      // very common case in Goat Format, where most decks share staples).
      // The exception is a control-changing effect (only Creature Swap is
      // legal in Goat) handing one of YOUR cards to the opponent — the very
      // next time their side names a card that's in your OWN decklist right
      // after "Activated Creature Swap", that specific name is remembered in
      // controlSwappedNames for the rest of the game, so it keeps crediting
      // your deck no matter who controls it afterward. Everything else
      // routes by speaker, so an opponent's own Sangan/Pot of Greed/etc.
      // never gets misattributed to you just because you run one too.
      if (/^Activated Creature Swap\b/i.test(ev.text)) {
        state.controlSwapWindowUntil = Date.now() + 8000; // generous window covering the mandatory summons that immediately follow
      }
      const revealedName = extractRevealedCardName(ev.text);
      const myEntry = revealedName && state.myDeckRemaining
        ? state.myDeckRemaining.find((c) => c.name.toLowerCase() === revealedName.toLowerCase())
        : null;
      if (side === 'opp' && myEntry && Date.now() < state.controlSwapWindowUntil) {
        state.controlSwappedNames.add(myEntry.name.toLowerCase());
      }
      const isControlSwapped = revealedName && state.controlSwappedNames.has(revealedName.toLowerCase());
      if (side === 'me' && myEntry) {
        // Your OWN deck's cards: which zone each revealed copy is currently
        // sitting in (hand, field, graveyard, or banished) — a label sticks
        // until another recognized move happens, it never clears on its
        // own. "NOT IN DECK" is deliberately not something this ever sets —
        // that status is manual-only, reserved for the click-to-cycle UI.
        applyZoneTransition(myEntry, ev.text);
        renderMyDeck();
      } else if (side === 'opp') {
        if (myEntry && isControlSwapped) {
          // Confirmed via the Creature Swap window above: this is your own
          // card, just under the opponent's control — keep crediting your
          // deck's zone tracking instead of their known-card list.
          applyZoneTransition(myEntry, ev.text);
          renderMyDeck();
        } else if (revealedName) {
          // Known-card accumulation for the opponent (feeds the YDK export) —
          // covers every way a card of theirs becomes visible to you. Tracks
          // actual per-copy records (see addKnownOppCard above) using the
          // same "don't inflate past the real peak copy count" philosophy as
          // the site's own replay parser, so a card that returns to
          // hand/deck and gets reused (Jar of Greed, Thunder Dragon, ...)
          // doesn't inflate past its real copy count.
          addKnownOppCard(revealedName, ev.text);
        }
      }

      // Reset-action → reset that player's timer
      if (isResetAction(ev.text)) {
        if (side === 'me') {
          state.myTimer = 0; state.myTimerRunning = true;
        } else if (side === 'opp') {
          state.oppTimer = 0;
          state.oppTimerRunning = true;
          state.oppInterruptUntil = Date.now() + 4000; // brief live window, then re-pause if still not their turn
        }
      }

      pushFeed(side, ev.text, false);
    }

    function pushFeed(side, text, isChat) {
      state.feed.push({ side, text, isChat, t: Date.now() });
      if (state.feed.length > 40) state.feed.shift();
      renderFeed();
      // LP/timer text otherwise only refreshes on the 200ms tick below —
      // render right away too so an LP change shows up the instant it's
      // parsed, not up to 200ms later.
      renderTimers();
      maybePushLive(); // throttled to once/3s — new events don't spam the site
    }

    // ── Timer tick loop ────────────────────────────────────────────────
    let lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;

      if (state.paused) { renderTimers(); return; }

      state.myTimerRunning = (state.turnHolder === 'me') || (state.turnHolder === null);
      if (state.myTimerRunning) state.myTimer += dt;

      const oppLive = (state.turnHolder === 'opp') || (now < state.oppInterruptUntil);
      state.oppTimerRunning = oppLive;
      if (oppLive) state.oppTimer += dt;

      renderTimers();
      maybePushLive(); // throttled to once/3s inside
      maybeCheckPendingSide(); // throttled to once/5s inside
    }, 200);

    // ── Overlay UI ───────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.id = 'dt-live-tracker-panel';
    panel.style.cssText = [
      'position:fixed', 'top:20px', 'left:20px', 'z-index:2147483000',
      'background:#0d0d0d', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:11px', 'width:230px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)', 'overflow:hidden'
    ].join(';');
    panel.innerHTML =
      '<div id="dt-tr-head" style="background:#1a1a1a;padding:6px 10px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:move">' +
        '<span>🎯 Live Tracker (beta)</span>' +
        '<span style="display:flex;gap:8px">' +
          '<span id="dt-tr-pause" title="Pause/resume timers" style="cursor:pointer;color:#888">⏸</span>' +
          '<span id="dt-tr-refresh" title="Reset tracker — starts a brand-new match" style="cursor:pointer;color:#888">↻</span>' +
          '<span id="dt-tr-min" style="cursor:pointer;color:#888">−</span>' +
        '</span>' +
      '</div>' +
      '<div id="dt-tr-body" style="padding:8px 10px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
          '<div>You<br/><span id="dt-tr-mytimer" style="font-size:18px;font-weight:bold;color:#00e596">0:00</span></div>' +
          '<div style="text-align:right">Opp<br/><span id="dt-tr-opptimer" style="font-size:18px;font-weight:bold;color:#ff8a3d">0:00</span></div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:6px;color:#aaa">' +
          '<div>LP <span id="dt-tr-mylp">8000</span></div>' +
          '<div>LP <span id="dt-tr-opplp">8000</span></div>' +
        '</div>' +
        '<div id="dt-tr-edge" title="Rough LP-based estimate — not a real win probability" style="text-align:center;color:#887;font-size:10px;margin-bottom:6px">Edge: 50% / 50%</div>' +
        '<div style="color:#666;margin-bottom:4px">Opp cards seen (<span id="dt-tr-oppcount">0</span>):</div>' +
        '<div id="dt-tr-oppcards" style="max-height:60px;overflow-y:auto;color:#9ac;margin-bottom:6px;font-size:10px"></div>' +
        '<button id="dt-tr-ydk-btn" style="width:100%;background:#222;color:#9ac;border:1px solid #333;border-radius:5px;padding:5px;cursor:pointer;font-family:monospace;font-size:10px;margin-bottom:4px">📥 Download opponent YDK</button>' +
        '<div id="dt-tr-ydk-status" style="color:#666;font-size:10px;margin-bottom:6px"></div>' +
        '<div style="border-top:1px solid #333;margin:2px 0 6px;padding-top:6px">' +
          '<div style="color:#666;margin-bottom:4px">Your deck: <span id="dt-tr-mydeck-summary">not uploaded</span></div>' +
          '<div id="dt-tr-mydeck" style="max-height:50px;overflow-y:auto;color:#9c9;margin-bottom:4px;font-size:10px"></div>' +
          '<input id="dt-tr-deck-file" type="file" accept=".ydk" style="display:none"/>' +
          '<button id="dt-tr-deck-upload-btn" style="width:100%;background:#222;color:#9c9;border:1px solid #333;border-radius:5px;padding:5px;cursor:pointer;font-family:monospace;font-size:10px">📤 Upload your deck (YDK)</button>' +
          '<div id="dt-tr-deck-status" style="color:#666;font-size:10px;margin-top:2px"></div>' +
        '</div>' +
        '<div style="border-top:1px solid #333;margin:2px 0 6px;padding-top:6px">' +
          '<div style="color:#666;margin-bottom:4px">Site pairing code — enter once on My/Opp Tracker:</div>' +
          '<div style="display:flex;gap:6px;align-items:center;margin-bottom:2px">' +
            '<span id="dt-tr-paircode" style="font-weight:bold;color:#7cf;letter-spacing:2px;font-size:13px;flex:1"></span>' +
            '<button id="dt-tr-paircode-copy" style="background:#222;color:#7cf;border:1px solid #333;border-radius:4px;padding:2px 8px;cursor:pointer;font-family:monospace;font-size:10px">Copy</button>' +
            '<button id="dt-tr-paircode-regen" title="Generate a new code (you\'ll need to re-enter it on the site)" style="background:#222;color:#e8a03d;border:1px solid #333;border-radius:4px;padding:2px 8px;cursor:pointer;font-family:monospace;font-size:10px">↻ New</button>' +
          '</div>' +
          '<div id="dt-tr-sync-status" style="color:#555;font-size:9px">not synced yet</div>' +
        '</div>' +
        '<div style="color:#666;margin-bottom:2px">Live feed:</div>' +
        '<div id="dt-tr-feed" style="max-height:120px;overflow-y:auto;font-size:10px;line-height:1.5"></div>' +
      '</div>';
    document.body.appendChild(panel);

    panel.querySelector('#dt-tr-min').onclick = function () {
      const body = panel.querySelector('#dt-tr-body');
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      panel.querySelector('#dt-tr-min').textContent = collapsed ? '−' : '+';
    };
    panel.querySelector('#dt-tr-pause').onclick = function () {
      setPaused(!state.paused);
    };
    panel.querySelector('#dt-tr-refresh').onclick = function () {
      console.log('[Duel Tools Tracker] manual refresh clicked — starting a brand-new match');
      beginTrackingForNewDuel(state.myUsername);
    };
    panel.querySelector('#dt-tr-paircode').textContent = PAIR_CODE;
    panel.querySelector('#dt-tr-paircode-copy').onclick = function () {
      const btn = panel.querySelector('#dt-tr-paircode-copy');
      const done = function () { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(PAIR_CODE).then(done).catch(done);
      } else {
        done(); // clipboard API unavailable — code is still visible to copy by hand
      }
    };
    panel.querySelector('#dt-tr-paircode-regen').onclick = function () {
      // A fresh random code, same charset/length as a first-time one — for
      // when the old code was shared somewhere it shouldn't have been, or
      // just to start clean. It has to be re-entered on the site afterward;
      // nothing pushes the change there automatically since the pairing is
      // one-directional (this script initiates, the site just polls).
      if (!confirm('Generate a new pairing code?\n\nYou will need to re-enter it on the website\'s My Tracker / Opp Tracker tabs — the old code will stop syncing immediately.')) return;
      PAIR_CODE = randomPairCode();
      safeSetValue('dt_tracker_pair_code', PAIR_CODE);
      panel.querySelector('#dt-tr-paircode').textContent = PAIR_CODE;
      const status = panel.querySelector('#dt-tr-sync-status');
      if (status) status.textContent = 'New code generated — re-enter it on the site';
      maybePushLive(true);
    };
    // Basic drag-to-move on the header
    (function makeDraggable() {
      const head = panel.querySelector('#dt-tr-head');
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      head.addEventListener('mousedown', (e) => {
        if (e.target.id === 'dt-tr-min' || e.target.id === 'dt-tr-pause' || e.target.id === 'dt-tr-refresh') return;
        dragging = true; sx = e.clientX; sy = e.clientY;
        const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.left = (ox + e.clientX - sx) + 'px';
        panel.style.top  = (oy + e.clientY - sy) + 'px';
        panel.style.right = 'auto';
      });
      window.addEventListener('mouseup', () => { dragging = false; });
    })();

    panel.querySelector('#dt-tr-ydk-btn').onclick = function () {
      const btn = panel.querySelector('#dt-tr-ydk-btn');
      const status = panel.querySelector('#dt-tr-ydk-status');
      const provenCards = state.knownOppCards.filter((c) => c.max > 0);
      if (!provenCards.length) {
        status.textContent = 'No opponent cards seen yet this game.';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Resolving card names…';
      buildYdkFromKnownCards(provenCards, function (i, total, name) {
        status.textContent = 'Looking up ' + i + '/' + total + ': ' + name;
      }).then(function (result) {
        btn.disabled = false;
        btn.textContent = '📥 Download opponent YDK';
        const oppName = state.oppUsername || 'opponent';
        downloadYdk(result.ids, oppName + '_known_cards.ydk');
        status.textContent = result.ids.length + ' card(s) in the file.' +
          (result.unresolved.length ? ' Could not match: ' + result.unresolved.join(', ') : '');
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = '📥 Download opponent YDK';
        status.textContent = 'Something went wrong resolving card names: ' + e.message;
      });
    };

    panel.querySelector('#dt-tr-deck-upload-btn').onclick = function () {
      panel.querySelector('#dt-tr-deck-file').click();
    };
    panel.querySelector('#dt-tr-deck-file').onchange = function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const btn = panel.querySelector('#dt-tr-deck-upload-btn');
      const status = panel.querySelector('#dt-tr-deck-status');
      const reader = new FileReader();
      reader.onload = function () {
        btn.disabled = true;
        btn.textContent = 'Resolving card names…';
        buildDeckListFromYdk(String(reader.result), function (i, total) {
          status.textContent = 'Looking up ' + i + '/' + total;
        }).then(function (list) {
          btn.disabled = false;
          btn.textContent = '📤 Upload your deck (YDK)';
          state.myDeckList = list;
          state.myDeckRemaining = freshDeckRemaining();
          saveMyDeckList(list);
          const totalCards = list.reduce((s, c) => s + c.total, 0);
          status.textContent = 'Loaded ' + list.length + ' unique card(s), ' + totalCards + ' total in main deck.';
          renderMyDeck();
          maybePushLive(true);
        }).catch(function (err) {
          btn.disabled = false;
          btn.textContent = '📤 Upload your deck (YDK)';
          status.textContent = 'Failed to read that deck: ' + err.message;
        });
      };
      reader.onerror = function () { status.textContent = 'Could not read that file.'; };
      reader.readAsText(file);
    };

    function fmt(sec) {
      sec = Math.max(0, Math.floor(sec));
      return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    }
    function renderTimers() {
      panel.querySelector('#dt-tr-mytimer').textContent = fmt(state.myTimer);
      panel.querySelector('#dt-tr-opptimer').textContent = fmt(state.oppTimer);
      panel.querySelector('#dt-tr-mylp').textContent = state.myLP;
      panel.querySelector('#dt-tr-opplp').textContent = state.oppLP;
      panel.querySelector('#dt-tr-mytimer').style.opacity = state.paused ? '.3' : (state.myTimerRunning ? '1' : '.4');
      panel.querySelector('#dt-tr-opptimer').style.opacity = state.paused ? '.3' : (state.oppTimerRunning ? '1' : '.4');
      panel.querySelector('#dt-tr-pause').textContent = state.paused ? '▶' : '⏸';
      panel.querySelector('#dt-tr-pause').title = state.paused ? 'Resume timers' : 'Pause timers';
      const myEdge = computeEdgePct();
      panel.querySelector('#dt-tr-edge').textContent = 'Edge: You ' + myEdge + '% · Opp ' + (100 - myEdge) + '%';
    }
    function renderOppCards() {
      const el = panel.querySelector('#dt-tr-oppcards');
      const visible = state.knownOppCards.filter((c) => c.max > 0); // a card only ever "Revealed ... from Deck" (never drawn) has max 0 — nothing proven to have left the deck yet
      panel.querySelector('#dt-tr-oppcount').textContent = visible.reduce((s, c) => s + c.max, 0);
      // Factual only — exactly how many distinct copies we've actually seen
      // leave the deck, no guess at how many more are left unseen.
      el.innerHTML = visible.map((c) => c.name + (c.max > 1 ? ' ×' + c.max : '')).join('<br/>');
    }
    function renderMyDeck() {
      const summaryEl = panel.querySelector('#dt-tr-mydeck-summary');
      const el = panel.querySelector('#dt-tr-mydeck');
      if (!state.myDeckRemaining) {
        summaryEl.textContent = 'not uploaded';
        el.innerHTML = '';
        return;
      }
      const totalAll = state.myDeckRemaining.reduce((s, c) => s + c.total, 0);
      const totalOut = state.myDeckRemaining.reduce((s, c) => s + c.zones.hand + c.zones.field + c.zones.grave + c.zones.banish, 0);
      summaryEl.textContent = (totalAll - totalOut) + '/' + totalAll + ' unseen';
      el.innerHTML = state.myDeckRemaining
        .filter((c) => c.zones.hand + c.zones.field + c.zones.grave + c.zones.banish > 0)
        .map((c) => {
          const parts = [];
          if (c.zones.hand)   parts.push(c.zones.hand + ' in hand');
          if (c.zones.field)  parts.push(c.zones.field + ' on field');
          if (c.zones.grave)  parts.push(c.zones.grave + ' in GY');
          if (c.zones.banish) parts.push(c.zones.banish + ' banished');
          return c.name + ': ' + parts.join(', ');
        })
        .join('<br/>');
    }
    function renderFeed() {
      const el = panel.querySelector('#dt-tr-feed');
      el.innerHTML = state.feed.slice(-12).map((f) => {
        const tag = f.side === 'me' ? '<span style="color:#00e596">You</span>' : f.side === 'opp' ? '<span style="color:#ff8a3d">Opp</span>' : '<span style="color:#666">?</span>';
        return tag + ': ' + (f.isChat ? '<i>' + f.text + '</i>' : f.text);
      }).join('<br/>');
      el.scrollTop = el.scrollHeight;
      renderOppCards();
    }
    function setPaused(val) {
      state.paused = !!val;
      renderTimers();
      maybePushLive(true);
    }
    function setMatchConcluded(val) {
      state.matchConcluded = !!val;
      maybePushLive(true);
    }
    renderMyDeck();
    maybePushLive(true); // initial snapshot — the site sees "connected" right away instead of after 3s

    // Called when a new GAME starts within the SAME match (e.g. game 2/3 of
    // a Bo3, or a replay after a draw) — resets everything that's specific
    // to one game (LP, timers, turn tracking, feed, and your own deck's
    // remaining-copy counts, since the deck reshuffles every game) but
    // deliberately leaves knownOppCards/oppUsername/myDeckList alone, since
    // those describe the whole match, not one game of it.
    function resetForNewGame() {
      state.game = (state.game || 1) + 1;
      state.myLP = 8000;
      state.oppLP = 8000;
      state.turnHolder = null;
      state.myTimer = 0; state.oppTimer = 0;
      state.myTimerRunning = true; state.oppTimerRunning = false;
      state.oppInterruptUntil = 0;
      state.feed = [];
      state.paused = false;
      state.myDeckRemaining = freshDeckRemaining();
      // Creature Swap's control change doesn't survive a reshuffle — a new
      // game starts everyone back with their own deck.
      state.controlSwappedNames = new Set();
      state.controlSwapWindowUntil = 0;
      state.awaitingNewGameChoice = false;
      state.lastGameResetAt = Date.now();
      renderTimers();
      renderFeed();
      renderMyDeck();
      const status = panel.querySelector('#dt-tr-ydk-status');
      if (status) status.textContent = 'New game in this match — LP, timers & your deck reset. Opponent cards kept.';
      maybePushLive(true);
    }

    // Whether this MATCH's win condition (first to 2 game wins) has actually
    // been reached yet — a much more reliable signal than scraping for
    // "View Replay" text, which (per a real match) can appear after a
    // single game's own replay becomes available, not just at the true end
    // of a Bo3. Used to stop watchForMatchEnd from treating an early game's
    // replay button as the whole match concluding.
    function isMatchDecided() {
      return state.myWins >= 2 || state.oppWins >= 2;
    }

    return { applyEvent, resetForNewGame, setPaused, setMatchConcluded, isMatchDecided };
  }

  // ── Wire the log watcher up to a #duel_log element ──────────────────────
  function getCandidateLogLines(duelLogEl) {
    return Array.from(duelLogEl.querySelectorAll('*')).filter((el) => {
      const t = (el.textContent || '').trim();
      return /^\[\d+:\d+\]/.test(t) && el.children.length === 0 || (el.children.length && /^\[\d+:\d+\]/.test(t) && !Array.from(el.children).some((c) => /^\[\d+:\d+\]/.test((c.textContent || '').trim())));
    });
  }

  function armLogWatcher(duelLogEl, tracker, opts) {
    enableLogCheckboxes(duelLogEl);
    // DuelingBook's #duel_log panel is never torn down between duels (it's an
    // SPA), so when we arm a fresh watcher for a brand-new match, anything
    // already sitting in that panel belongs to a PREVIOUS match/session, not
    // the one we're about to track. Replaying it would silently merge the
    // wrong opponent's cards into the new match's list. skipExisting tells us
    // to start counting from "now" instead of from 0 in that case.
    //
    // "now" is deliberately opts.baselineCount when the caller provides one,
    // NOT a fresh re-count taken at this exact moment. Re-counting here used
    // to silently swallow the whole opening hand: ensureDuelLogOpen (the
    // caller) may need to click #log_btn and wait for #duel_log to even
    // exist, and DuelingBook can log the new match's RPS result and starting
    // "Drew X" x5/6 lines well within that gap — a live re-count at attach
    // time would then treat those as leftover from the PREVIOUS match and
    // skip them forever. baselineCount is captured by watchForNewDuels the
    // instant the new match/game is actually detected, closing that gap.
    let seen = 0;
    if (opts && opts.skipExisting) {
      seen = (typeof opts.baselineCount === 'number')
        ? Math.min(opts.baselineCount, getCandidateLogLines(duelLogEl).length)
        : getCandidateLogLines(duelLogEl).length;
    }
    if (opts && opts.skipExisting && seen > 0) {
      console.log('[Duel Tools Tracker] skipping', seen, 'pre-existing log line(s) from before this match');
    }
    let pending = false;

    let loggedZeroCandidatesOnce = false;
    // DIAGNOSTIC: confirmed via a real match's console output that DuelingBook's
    // actual duel log does NOT put "Username: " in front of ordinary action
    // lines the way LINE_RE (above) assumes — it's bare "[m:ss] action text"
    // for BOTH players, with no textual way to tell whose action it is (proven
    // by a real line where "Activated Delinquent Duo" was the opponent's move
    // but the very next randomly-discarded card belonged to the other side —
    // same bare shape, opposite owners). So the missing signal has to be in
    // the DOM (a class/color DuelingBook applies per side), not the text.
    // Capped at 20 (not the old 1) so a real session yields enough samples —
    // ideally at least one from each player — to spot that signal from a
    // single console paste instead of guessing at it blind again.
    let parseFailLogged = 0;
    function scan() {
      // Every entry rendered so far, in order — we only process ones past
      // the `seen` count so this stays cheap even as the log grows long.
      const all = getCandidateLogLines(duelLogEl);
      if (all.length === 0 && !loggedZeroCandidatesOnce && duelLogEl.textContent.trim()) {
        // The panel has SOME text in it, but nothing matched our "line
        // starts with [m:ss]" shape — the real DOM structure doesn't match
        // what this was built against (a screenshot). Log a sample so this
        // is fixable from one console paste instead of another guess.
        loggedZeroCandidatesOnce = true;
        console.warn('[Duel Tools Tracker] #duel_log has content but no lines matched the expected "[m:ss] Username: text" shape. First 300 chars of its text:', duelLogEl.textContent.trim().slice(0, 300));
      }
      for (let i = seen; i < all.length; i++) {
        const ev = parseLine(all[i].textContent);
        if (ev) {
          tracker.applyEvent(ev);
        } else if (parseFailLogged < 20) {
          parseFailLogged++;
          const el = all[i];
          let styleInfo = '(no computed style available)';
          try {
            const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
            const cs = view.getComputedStyle(el);
            styleInfo = 'color=' + cs.color + ' class=' + JSON.stringify(el.className);
          } catch (e) { styleInfo = '(getComputedStyle failed: ' + e.message + ')'; }
          console.warn(
            '[Duel Tools Tracker] DIAGNOSTIC (' + parseFailLogged + '/20) — candidate line without the expected "[m:ss] Username: text" shape, ' + styleInfo + ' — outerHTML:',
            (el.outerHTML || '').slice(0, 500)
          );
        }
      }
      if (all.length > seen) console.log('[Duel Tools Tracker] processed', all.length - seen, 'new log line(s), total seen:', all.length, JSON.stringify(all.slice(seen).map(e => e.textContent)));
      seen = all.length;
    }
    function scheduleScan() {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; scan(); }, 250);
    }
    const observer = new MutationObserver(scheduleScan);
    observer.observe(duelLogEl, { childList: true, subtree: true, characterData: true });
    scan();
    return observer; // caller keeps this so it can disconnect() when the duel ends
  }

  function waitFor(selector, cb) {
    const existing = document.querySelector(selector);
    if (existing) { cb(existing); return; }
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { obs.disconnect(); cb(el); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // The #duel_log panel doesn't exist in the page at all until it's opened —
  // confirmed from a real recorded session: clicking #log_btn is what
  // creates it. Earlier versions of this script only ever waited passively
  // for #duel_log to show up, which meant tracking silently did nothing
  // unless you'd already opened the log panel yourself. Now it opens the
  // panel itself (only if it isn't already open, so it never toggles a
  // panel you opened yourself closed again).
  function ensureDuelLogOpen(cb) {
    const existing = document.querySelector('#duel_log');
    if (existing) { console.log('[Duel Tools Tracker] #duel_log already open'); cb(existing); return; }
    waitFor('#log_btn', function (btn) {
      console.log('[Duel Tools Tracker] #log_btn found — opening Duel Log panel');
      try { btn.click(); } catch (e) { console.warn('[Duel Tools Tracker] could not click #log_btn:', e); }
      waitFor('#duel_log', function (duelLogEl) {
        console.log('[Duel Tools Tracker] #duel_log found, arming log watcher');
        cb(duelLogEl);
      });
    });
  }

  // ── Per-duel lifecycle ───────────────────────────────────────────────────
  // DuelingBook is a single-page app: going from one match to a rematch or a
  // brand new opponent does NOT reload the page. Earlier versions of this
  // script only ever ran its setup once per page load, so after your first
  // duel it just sat there forever showing that first duel's frozen numbers.
  //
  // Confirmed (per Kerem): RPS ("choose First/Second") is played once at
  // the start of a MATCH, and only gets redone if a game is drawn (forcing
  // an extra game — g4, g5, ...). A match is over once Admit Defeat has
  // produced a real winner/loser — at that point the "View Replay" button
  // appears in place of Admit Defeat (already the signal dt-save-prompt.js
  // uses for the same thing), and the NEXT #rps_start after that is a
  // brand-new match, not another game of this one. So:
  //   - #rps_start reappearing, match not yet concluded → new GAME within
  //     the same match: reset LP/timers/feed/your-deck-remaining, but KEEP
  //     the opponent's known-card list and identity (same deck, same foe).
  //   - #rps_start reappearing AFTER "View Replay" was seen → new MATCH:
  //     full reset, including the opponent's known cards.
  //   - "View Replay" appearing also auto-pauses the timers, so they don't
  //     keep running after the match is actually over and you're just
  //     sitting on the post-match screen.
  let activeLogObserver = null;
  let activeTracker = null;
  let matchConcluded = false;

  function teardownPreviousDuel() {
    const oldPanel = document.getElementById('dt-live-tracker-panel');
    if (oldPanel) oldPanel.remove();
    if (activeLogObserver) { activeLogObserver.disconnect(); activeLogObserver = null; }
  }

  function beginTrackingForNewDuel(myUsername, opts) {
    matchConcluded = false;
    teardownPreviousDuel();
    console.log('[Duel Tools Tracker] starting a fresh tracker for this match, as', myUsername);
    const tracker = startTracker(myUsername, loadMyDeckList());
    activeTracker = tracker;
    ensureDuelLogOpen(function (duelLogEl) {
      // baselineCount, when the caller captured one up front (see
      // watchForNewDuels), anchors "pre-existing, skip these" to the moment
      // the new match was actually detected rather than to whenever this
      // callback happens to fire — see armLogWatcher for why that gap
      // matters.
      const baselineCount = (opts && typeof opts.baselineCount === 'number') ? opts.baselineCount : undefined;
      activeLogObserver = armLogWatcher(duelLogEl, tracker, { skipExisting: true, baselineCount });
    });
  }

  function beginNewGameSameMatch() {
    if (activeTracker && activeTracker.resetForNewGame) activeTracker.resetForNewGame();
  }

  function promptNewDuel(cb) {
    if (document.getElementById('dt-tracker-newduel-box')) return;
    const box = document.createElement('div');
    box.id = 'dt-tracker-newduel-box';
    box.style.cssText = [
      'position:fixed', 'top:20px', 'left:20px', 'z-index:2147483647',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:13px', 'width:240px', 'padding:14px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)'
    ].join(';');
    box.innerHTML =
      '<div style="font-weight:bold;margin-bottom:6px">🎯 New match detected</div>' +
      '<div style="color:#999;font-size:11px;margin-bottom:10px">Start the live tracker for this one? (Your last match has been reset.)</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="dt-nd-yes" style="flex:1;background:#00e596;color:#050508;border:none;border-radius:5px;padding:7px;font-weight:bold;cursor:pointer;font-family:monospace">Track</button>' +
        '<button id="dt-nd-no" style="flex:1;background:transparent;color:#888;border:1px solid #333;border-radius:5px;padding:7px;cursor:pointer;font-family:monospace">Skip</button>' +
      '</div>';
    document.body.appendChild(box);
    box.querySelector('#dt-nd-yes').onclick = function () { box.remove(); cb(); };
    box.querySelector('#dt-nd-no').onclick = function () {
      box.remove();
      console.log('[Duel Tools Tracker] skipped tracking this match');
    };
  }

  // "View Replay" replacing "Admit Defeat" is the same signal
  // dt-save-prompt.user.js already relies on for "the match is truly
  // over" — a whole Bo3 is one replay, not one per game, so this only
  // fires once the match's winner/loser is actually decided.
  function watchForMatchEnd() {
    const handled = new WeakSet();
    function findViewReplay() {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (handled.has(el)) continue;
        const txt = (el.textContent || '').trim();
        if (txt !== 'View Replay') continue;
        let isLeaf = true;
        for (const child of el.children) {
          if ((child.textContent || '').trim() === 'View Replay') { isLeaf = false; break; }
        }
        if (isLeaf) return el;
      }
      return null;
    }
    let pending = false;
    function scan() {
      const el = findViewReplay();
      if (!el) return;
      // Gate on the match's actual win condition (first to 2 game wins),
      // not just the text appearing — a "View Replay" button can become
      // available after a SINGLE game's replay is ready, not only once the
      // whole Bo3 is decided. Treating that as the match ending prompted the
      // "new match?" confirmation box for what was really just G2 starting,
      // and if that box went unanswered/unnoticed the tracker just sat
      // frozen on the previous game's numbers — never resetting for G2 at
      // all. Deliberately does NOT add `el` to `handled` when undecided, so
      // the same element gets re-checked on every scan until the win
      // threshold is actually reached (cheap — this only runs a few times a
      // second while a "View Replay" element exists at all).
      if (activeTracker && activeTracker.isMatchDecided && !activeTracker.isMatchDecided()) return;
      handled.add(el);
      if (!matchConcluded) {
        matchConcluded = true;
        console.log('[Duel Tools Tracker] match concluded (View Replay appeared AND the win threshold was reached) — pausing timers; the next new duel will start a fresh match');
        if (activeTracker && activeTracker.setPaused) activeTracker.setPaused(true);
        if (activeTracker && activeTracker.setMatchConcluded) activeTracker.setMatchConcluded(true);
      }
    }
    function scheduleScan() {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; scan(); }, 300);
    }
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    scan();
  }

  // #rps_start (confirmed real: the "choose First/Second" screen) marks
  // either a new match or a new game within the current match, depending
  // on whether the previous match has already concluded (see above).
  // Edge-detected (false→true) rather than by element identity, in case
  // DuelingBook reuses the same DOM node across duels instead of
  // recreating it.
  function watchForNewDuels(myUsername) {
    let rpsPresent = !!document.querySelector('#rps_start');
    let pending = false;
    function check() {
      const nowPresent = !!document.querySelector('#rps_start');
      if (nowPresent && !rpsPresent) {
        if (matchConcluded) {
          // Snapshot how many log lines already exist RIGHT NOW — the
          // instant the new match is detected — not later once
          // promptNewDuel's confirmation box has been clicked and
          // ensureDuelLogOpen has finished (re-)opening the panel. That gap
          // is exactly where the opening hand's "Drew X" lines could
          // otherwise get skipped as if they were leftover from the
          // previous match — see armLogWatcher.
          const logEl = document.querySelector('#duel_log');
          const baselineCount = logEl ? getCandidateLogLines(logEl).length : 0;
          console.log('[Duel Tools Tracker] new MATCH detected (#rps_start after a concluded match)');
          promptNewDuel(function () { beginTrackingForNewDuel(myUsername, { baselineCount }); });
        } else {
          console.log('[Duel Tools Tracker] new GAME within the same match detected (#rps_start reappeared, e.g. a drawn game being replayed) — keeping opponent cards, resetting LP/timers');
          beginNewGameSameMatch();
        }
      }
      rpsPresent = nowPresent;
    }
    function scheduleCheck() {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; check(); }, 300);
    }
    new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });
  }

  console.log('[Duel Tools Tracker] script loaded, waiting for #duel...');
  waitFor('#duel', function () {
    console.log('[Duel Tools Tracker] #duel found');
    getMyUsername(function (myUsername) {
      // The very first duel found this page-load starts right away —
      // entering your username already counted as "yes, track this one".
      // Every match after that (rematch, new opponent, all on this same
      // page) goes through the explicit new-match prompt above instead.
      beginTrackingForNewDuel(myUsername);
      watchForNewDuels(myUsername);
      watchForMatchEnd();
    });
  });
})();
