// ==UserScript==
// @name         Duel Tools — Live Tracker
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  Watches the in-page Duel Log during a live match to drive dual action timers, known-card tracking, and a YDK export of the opponent's revealed cards.
// @author       Kerem's Duel Tools
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      db.ygoprodeck.com
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
        // A tracked "seen count" isn't necessarily the number of distinct
        // physical copies (the same copy can trigger multiple log lines),
        // so cap at 3 — a real deck can never legally run more anyway.
        const copies = Math.min(c.count, 3);
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

  // ── Reverse lookup (passcode → name), for reading back an uploaded YDK ──
  const nameCache = {}; // numeric id (string) -> name, or null if unresolvable
  function resolveNameFromPasscode(id) {
    const key = String(id);
    if (key in nameCache) return Promise.resolve(nameCache[key]);
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') { nameCache[key] = null; resolve(null); return; }
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://db.ygoprodeck.com/api/v7/cardinfo.php?id=' + encodeURIComponent(key),
        onload: function (res) {
          let name = null;
          try {
            const data = JSON.parse(res.responseText);
            name = (data && data.data && data.data[0] && data.data[0].name) || null;
          } catch (e) { /* leave name null — unresolvable, not fatal */ }
          nameCache[key] = name;
          resolve(name);
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

  // Groups a flat id list into [{id, name, total}], resolving each UNIQUE
  // id to a name sequentially (same politeness reasoning as the
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
      const name = await resolveNameFromPasscode(id);
      list.push({ id, name: name || ('Unknown card #' + id), total: counts[id] });
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
      knownOppCards: [], // [{name, count}] — persists across games within a match, reset only on a new match
      feed: [], // last N parsed events for the debug view
      paused: false,
      myDeckList: deckList || null, // [{id, name, total}] — the uploaded YDK, persists indefinitely once set
      myDeckRemaining: null // [{id, name, total, seen}] — rebuilt fresh every GAME (the deck reshuffles each game)
    };

    function freshDeckRemaining() {
      return state.myDeckList ? state.myDeckList.map((c) => ({ id: c.id, name: c.name, total: c.total, seen: 0 })) : null;
    }
    state.myDeckRemaining = freshDeckRemaining();

    function who(username) {
      if (username.toLowerCase() === state.myUsername.toLowerCase()) return 'me';
      // First "other" username we see becomes "the opponent" for this match
      if (!state.oppUsername) state.oppUsername = username;
      if (username.toLowerCase() === state.oppUsername.toLowerCase()) return 'opp';
      return 'other'; // spectator chat, etc.
    }

    function addKnownOppCard(name) {
      const existing = state.knownOppCards.find((c) => c.name === name);
      if (existing) existing.count++;
      else state.knownOppCards.push({ name, count: 1 });
    }

    // Extracts a real card name from a log line, when one is actually
    // present. "Drew <Name>" is handled on its own since the name runs to
    // the end of the line with nothing after it; every other recognized
    // action always has a zone reference or parenthetical stat block right
    // after the name, so those require seeing one — deliberately no
    // end-of-string fallback (a earlier version that had one silently
    // absorbed trailing words like "in S-3" into the name).
    function extractRevealedCardName(text) {
      const drewM = /^Drew (.+)$/.exec(text);
      if (drewM) {
        const n = drewM[1].trim();
        return /^a card$/i.test(n) ? null : n;
      }
      const m = /^(?:Set |Activated |Normal Summoned |Special Summoned |Flip Summoned |Flipped (?:Set )?|Sent |Banished |Declared effect of |Returned |Moved |Changed )([A-Za-z0-9 ,.'\-:]+?)(?: from| to| in| on| \()/.exec(text);
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

      // Known-card accumulation for the opponent (feeds the YDK export and
      // the probability engine once that's wired in) — covers every way a
      // card of theirs becomes visible to you.
      const revealedName = extractRevealedCardName(ev.text);
      if (side === 'opp' && revealedName) {
        addKnownOppCard(revealedName);
      }

      // Your OWN deck's remaining-copy count — only actions that actually
      // pull a card OUT of your deck should decrement it: being drawn, or
      // an effect that moves it from Deck to somewhere else. Everything
      // else (Set/Activated/Summoned/Sent from hand or a zone, etc.) is the
      // SAME physical card continuing to act, not a new copy leaving the
      // deck, so those must NOT double-count it.
      if (side === 'me' && state.myDeckRemaining && revealedName) {
        const leftDeck = /^Drew /.test(ev.text) || / from Deck\b/.test(ev.text);
        if (leftDeck) {
          const entry = state.myDeckRemaining.find((c) => c.name.toLowerCase() === revealedName.toLowerCase());
          if (entry && entry.seen < entry.total) {
            entry.seen++;
            renderMyDeck();
          }
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
      if (!state.knownOppCards.length) {
        status.textContent = 'No opponent cards seen yet this game.';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Resolving card names…';
      buildYdkFromKnownCards(state.knownOppCards, function (i, total, name) {
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
    }
    function renderOppCards() {
      const el = panel.querySelector('#dt-tr-oppcards');
      panel.querySelector('#dt-tr-oppcount').textContent = state.knownOppCards.reduce((s, c) => s + c.count, 0);
      el.innerHTML = state.knownOppCards.map((c) => c.name + (c.count > 1 ? ' ×' + c.count : '')).join('<br/>');
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
      const totalSeen = state.myDeckRemaining.reduce((s, c) => s + c.seen, 0);
      summaryEl.textContent = (totalAll - totalSeen) + '/' + totalAll + ' unseen';
      el.innerHTML = state.myDeckRemaining
        .filter((c) => c.seen > 0)
        .map((c) => c.name + ': ' + c.seen + '/' + c.total + ' seen')
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
    }
    renderMyDeck();

    // Called when a new GAME starts within the SAME match (e.g. game 2/3 of
    // a Bo3, or a replay after a draw) — resets everything that's specific
    // to one game (LP, timers, turn tracking, feed, and your own deck's
    // remaining-copy counts, since the deck reshuffles every game) but
    // deliberately leaves knownOppCards/oppUsername/myDeckList alone, since
    // those describe the whole match, not one game of it.
    function resetForNewGame() {
      state.myLP = 8000;
      state.oppLP = 8000;
      state.turnHolder = null;
      state.myTimer = 0; state.oppTimer = 0;
      state.myTimerRunning = true; state.oppTimerRunning = false;
      state.oppInterruptUntil = 0;
      state.feed = [];
      state.paused = false;
      state.myDeckRemaining = freshDeckRemaining();
      renderTimers();
      renderFeed();
      renderMyDeck();
      const status = panel.querySelector('#dt-tr-ydk-status');
      if (status) status.textContent = 'New game in this match — LP, timers & your deck reset. Opponent cards kept.';
    }

    return { applyEvent, resetForNewGame, setPaused };
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
    let seen = (opts && opts.skipExisting) ? getCandidateLogLines(duelLogEl).length : 0;
    if (opts && opts.skipExisting && seen > 0) {
      console.log('[Duel Tools Tracker] skipping', seen, 'pre-existing log line(s) from before this match');
    }
    let pending = false;

    let loggedZeroCandidatesOnce = false;
    let loggedParseFailOnce = false;
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
        } else if (!loggedParseFailOnce) {
          loggedParseFailOnce = true;
          console.warn('[Duel Tools Tracker] found a candidate line but could not parse it:', JSON.stringify(all[i].textContent));
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

  function beginTrackingForNewDuel(myUsername) {
    matchConcluded = false;
    teardownPreviousDuel();
    console.log('[Duel Tools Tracker] starting a fresh tracker for this match, as', myUsername);
    const tracker = startTracker(myUsername, loadMyDeckList());
    activeTracker = tracker;
    ensureDuelLogOpen(function (duelLogEl) {
      activeLogObserver = armLogWatcher(duelLogEl, tracker, { skipExisting: true });
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
      if (el) {
        handled.add(el);
        if (!matchConcluded) {
          matchConcluded = true;
          console.log('[Duel Tools Tracker] match concluded (View Replay appeared) — pausing timers; the next new duel will start a fresh match');
          if (activeTracker && activeTracker.setPaused) activeTracker.setPaused(true);
        }
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
          console.log('[Duel Tools Tracker] new MATCH detected (#rps_start after a concluded match)');
          promptNewDuel(function () { beginTrackingForNewDuel(myUsername); });
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
