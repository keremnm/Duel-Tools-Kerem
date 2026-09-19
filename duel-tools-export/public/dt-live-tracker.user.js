// ==UserScript==
// @name         Duel Tools — Live Tracker
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Watches the in-page Duel Log during a live match to drive dual action timers, known-card tracking, and (soon) draw probabilities + Field Possession.
// @author       Kerem's Duel Tools
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @grant        GM_setValue
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

  // ── One-time setup: your own username, so "everyone else" = opponent ───
  function getMyUsername(cb) {
    const stored = GM_getValue('dt_tracker_my_username', '');
    if (stored) { cb(stored); return; }

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
      '<input id="dt-tr-username" type="text" style="width:100%;box-sizing:border-box;margin-bottom:8px;background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:4px;padding:5px;font-family:monospace"/>' +
      '<button id="dt-tr-save-username" style="width:100%;background:#00e596;color:#050508;border:none;border-radius:5px;padding:7px;font-weight:bold;cursor:pointer;font-family:monospace">Start Tracking</button>';
    document.body.appendChild(box);
    const inp = box.querySelector('#dt-tr-username');
    const go = () => {
      const v = inp.value.trim();
      if (!v) { inp.style.borderColor = '#e04444'; return; }
      GM_setValue('dt_tracker_my_username', v);
      box.remove();
      cb(v);
    };
    box.querySelector('#dt-tr-save-username').onclick = go;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  // ── Force-enable the log's own filter checkboxes ────────────────────────
  function enableLogCheckboxes(duelLogEl) {
    const wanted = ['Chat', 'Duel', 'Game', 'Private Info', 'Usernames'];
    const checkboxes = duelLogEl.querySelectorAll('input[type=checkbox]');
    checkboxes.forEach((cb) => {
      // The label text is usually right next to the checkbox — check the
      // parent element's text and the checkbox's own following sibling.
      const context = ((cb.parentElement && cb.parentElement.textContent) || '').trim();
      const matches = wanted.some((w) => context.indexOf(w) !== -1);
      if (matches && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new Event('click', { bubbles: true }));
      }
    });
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
  function startTracker(myUsername) {
    const state = {
      myUsername,
      oppUsername: null,
      myLP: 8000,
      oppLP: 8000,
      turnHolder: null,
      myTimer: 0, oppTimer: 0,
      myTimerRunning: true, oppTimerRunning: false,
      oppInterruptUntil: 0, // ms timestamp — opponent's timer stays live until this passes, when it's not their turn
      knownOppCards: [], // [{name, count}]
      feed: [] // last N parsed events for the debug view
    };

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

      // Known-card accumulation for the opponent (feeds the probability
      // engine once that's wired in) — covers every way a card of theirs
      // becomes visible to you.
      if (side === 'opp') {
        const cardM =
          /^(?:Drew |Set |Activated |Normal Summoned |Special Summoned |Flip Summoned |Sent )([A-Za-z0-9 ,.'\-:]+?)(?: from| to|$)/.exec(ev.text);
        // "Set card from hand ... to S-3" is DuelingBook's own generic
        // wording for a still-face-down Spell/Trap — "card" isn't a real
        // name, so don't let it pollute the known-card list. Same idea for
        // a bare "Drew" line with nothing after it.
        if (cardM && cardM[1] && cardM[1].trim().toLowerCase() !== 'card') {
          addKnownOppCard(cardM[1].trim());
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
    }

    // ── Timer tick loop ────────────────────────────────────────────────
    let lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;

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
      '<div id="dt-tr-head" style="background:#1a1a1a;padding:6px 10px;font-weight:bold;display:flex;justify-content:space-between;cursor:move">' +
        '<span>🎯 Live Tracker (beta)</span><span id="dt-tr-min" style="cursor:pointer;color:#888">−</span>' +
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
    // Basic drag-to-move on the header
    (function makeDraggable() {
      const head = panel.querySelector('#dt-tr-head');
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      head.addEventListener('mousedown', (e) => {
        if (e.target.id === 'dt-tr-min') return;
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

    function fmt(sec) {
      sec = Math.max(0, Math.floor(sec));
      return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    }
    function renderTimers() {
      panel.querySelector('#dt-tr-mytimer').textContent = fmt(state.myTimer);
      panel.querySelector('#dt-tr-opptimer').textContent = fmt(state.oppTimer);
      panel.querySelector('#dt-tr-mylp').textContent = state.myLP;
      panel.querySelector('#dt-tr-opplp').textContent = state.oppLP;
      panel.querySelector('#dt-tr-mytimer').style.opacity = state.myTimerRunning ? '1' : '.4';
      panel.querySelector('#dt-tr-opptimer').style.opacity = state.oppTimerRunning ? '1' : '.4';
    }
    function renderOppCards() {
      const el = panel.querySelector('#dt-tr-oppcards');
      panel.querySelector('#dt-tr-oppcount').textContent = state.knownOppCards.reduce((s, c) => s + c.count, 0);
      el.innerHTML = state.knownOppCards.map((c) => c.name + (c.count > 1 ? ' ×' + c.count : '')).join('<br/>');
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

    return { applyEvent };
  }

  // ── Wire the log watcher up to a #duel_log element ──────────────────────
  function armLogWatcher(duelLogEl, tracker) {
    enableLogCheckboxes(duelLogEl);
    let seen = 0;
    let pending = false;

    function scan() {
      // Every entry rendered so far, in order — we only process ones past
      // the `seen` count so this stays cheap even as the log grows long.
      const all = Array.from(duelLogEl.querySelectorAll('*')).filter((el) => {
        const t = (el.textContent || '').trim();
        return /^\[\d+:\d+\]/.test(t) && el.children.length === 0 || (el.children.length && /^\[\d+:\d+\]/.test(t) && !Array.from(el.children).some((c) => /^\[\d+:\d+\]/.test((c.textContent || '').trim())));
      });
      for (let i = seen; i < all.length; i++) {
        const ev = parseLine(all[i].textContent);
        if (ev) tracker.applyEvent(ev);
      }
      seen = all.length;
    }
    function scheduleScan() {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; scan(); }, 250);
    }
    new MutationObserver(scheduleScan).observe(duelLogEl, { childList: true, subtree: true, characterData: true });
    scan();
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

  waitFor('#duel', function () {
    getMyUsername(function (myUsername) {
      const tracker = startTracker(myUsername);
      waitFor('#duel_log', function (duelLogEl) {
        armLogWatcher(duelLogEl, tracker);
      });
    });
  });
})();
