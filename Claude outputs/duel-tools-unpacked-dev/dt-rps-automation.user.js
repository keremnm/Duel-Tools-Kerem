// ==UserScript==
// @name         Duel Tools — RPS Automation
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Automated RPS (auto-picks Rock/Paper/Scissors for you) and Roll for RPS (a button that suggests a random pick you can use or ignore). Both off by default, independent of each other.
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
//
// CONFIRMED LIVE against a real duel's own RPS screen:
//  - The RPS round renders inside <div id="rps_start">, as 6 sibling
//    `.card` divs: the first 3 have class "card rps_card" and are MINE —
//    real, clickable, with DuelingBook's own jQuery click handler already
//    bound (`rock1`/`paper1`/`scissors1` in the page's own minified JS).
//    The other 3 (plain "card", no "rps_card") are the opponent's mirrored
//    row and are never interactive — never touched here.
//  - Reading chooseRPS()'s real (deobfuscated-by-reading) source confirms
//    exactly what a real click does: it reads `this` (the clicked card),
//    maps it to 'Rock'/'Paper'/'Scissors' by which of rock1/paper1/
//    scissors1 it is, turns off all three click handlers + pointer-events
//    so you can't double-pick, runs the flip animation, then calls
//    `Send({action:'Duel', play:'RPS', choice:<that name>})` — the actual
//    network action.
//  - This script never calls chooseRPS/Send directly. It finds the real
//    `.rps_card` element for the chosen move and calls a genuine
//    `.click()` on it — same as the user's own real click — so every bit
//    of DuelingBook's own logic (handler teardown, animation, the actual
//    Send call) runs exactly as it would manually. This mirrors the exact
//    same "drive the real control, don't reimplement its internals"
//    approach Duel Commands and Choose Zones already use.
//  - On a draw, DuelingBook replays RPS on its own (confirmed by the user)
//    — it detaches the old 3 cards and attaches 3 brand new ones for the
//    next round. Marking each round's own card elements (not some global
//    "already acted" flag) is what makes this naturally fire again for
//    that next round with zero extra bookkeeping — the new elements never
//    carry last round's marker, exactly the same trick dt-choose-zones
//    .user.js uses for "once per duel's own checkbox element".
//  - Per the user: Roll for RPS's button (and Automated RPS's own silent
//    action) ONLY ever show up/fire while an actual RPS round is on
//    screen — the instant it resolves (cards gone), there's nothing left
//    on screen from this feature until the next round, if any.
(function () {
  'use strict';

  if (window.location.pathname.indexOf('/replay') === 0) return; // live duels only, not replays

  function getSetting(key, def) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : def; } catch (e) { return def; }
  }

  // CONFIRMED LIVE: the actual decide-and-click loop for Automated RPS now
  // lives entirely in dt-rps-engine.js (MAIN world, injected alongside
  // this file). That file can read window.pickedRPS directly — the
  // page's own real, synchronous "has this round been picked yet" flag —
  // which is reliable ground truth in a way nothing visible from THIS
  // isolated world is. (An earlier version decided the pick here and
  // inferred "resolved" from the inline pointer-events:none style
  // chooseRPS sets; that inference could be missed between poll ticks,
  // especially since DuelingBook can reuse the same 3 DOM nodes across
  // rounds, which is what caused the "same pick 3-4 times then switches"
  // bug the user reported — the state machine would get stuck believing
  // an old round was still open.) All this script does now for Automated
  // RPS is relay the current on/off setting to the engine every tick, via
  // the same cross-world postMessage handoff dt-transparent-facedowns
  // .user.js already uses for the same kind of MAIN-world-only need.
  function relaySettingsToEngine(auto) {
    window.postMessage({ source: 'dt-rps-automation', type: 'DT_RPS_SETTINGS', auto: auto }, '*');
  }

  // CONFIRMED LIVE: chooseRPS sets `pointer-events: none` as a real INLINE
  // style on all 3 of the player's own cards the moment a pick actually
  // registers (jQuery's .css() always writes the inline style attribute).
  // Before any pick, these cards' inline style never includes
  // pointer-events at all. That inline style is a real DOM attribute, so
  // — unlike page globals such as pickedRPS/jQuery, which an isolated-
  // world content script can't see — this IS visible here, and it's a
  // reliable, world-safe way to know "did a click actually land" without
  // guessing at a delay.
  function roundResolved(cards) {
    return cards.some((c) => c.style.pointerEvents === 'none');
  }

  function liveRpsCards() {
    const el = document.getElementById('rps_start');
    if (!el) return [];
    const cards = Array.from(el.querySelectorAll('.rps_card')).filter((c) => c.offsetParent !== null);
    return cards.length === 3 ? cards : []; // only treat a full, real round as "live" — partial renders are ignored
  }

  // CONFIRMED LIVE: each card's own name lives in a dedicated `.name_txt`
  // span, but this used to regex-match the card's WHOLE textContent,
  // which also includes its `.effect_txt` flavor line — and that line
  // names all 3 moves on every single card ("Rock beats scissors but
  // loses to paper", etc). Checking /Rock/i first against that blob
  // matched "Rock" on every card, every time — this was the real,
  // deterministic root cause behind Automated RPS always landing on Rock
  // (same bug, same fix, as dt-rps-engine.js). Reading only `.name_txt`
  // fixes it for this file's own use too (the Roll-for-RPS suggestion
  // label below).
  function cardChoice(cardEl) {
    const nameEl = cardEl.querySelector('.name_txt');
    const t = (nameEl ? nameEl.textContent : cardEl.textContent) || '';
    if (/Rock/i.test(t)) return 'Rock';
    if (/Paper/i.test(t)) return 'Paper';
    if (/Scissors/i.test(t)) return 'Scissors';
    return null;
  }

  // ── Roll for RPS UI — a small fixed panel, only ever visible while a
  // round's 3 real cards are on screen. Positioned dynamically (not a
  // fixed viewport offset) in the gap between the opponent's mirrored row
  // and the player's own 3 cards, horizontally centered over them — per
  // the user's own on-screen markup of where they want it, which also
  // asked to drop the green glow/outline that used to highlight the
  // suggested card: the text label alone says what was suggested, no
  // highlight box needed on the card itself anymore. ────────────────────
  function ensureStyle() {
    if (document.getElementById('dt-rps-style')) return;
    const style = document.createElement('style');
    style.id = 'dt-rps-style';
    style.textContent =
      '#dt-rps-roll-ui{position:fixed;top:0;left:0;transform:translate(-50%,-50%);z-index:2147483646;' +
      'display:none;align-items:center;gap:10px;background:rgba(10,14,20,.88);backdrop-filter:blur(6px);' +
      '-webkit-backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.18);border-radius:10px;' +
      'padding:8px 14px;font-family:monospace;box-shadow:0 8px 24px rgba(0,0,0,.5);white-space:nowrap;}' +
      '#dt-rps-roll-btn{background:#00e596;color:#050508;border:none;border-radius:6px;padding:7px 14px;' +
      'font-weight:bold;cursor:pointer;font-family:monospace;font-size:13px;white-space:nowrap;' +
      'transition:background .15s ease;}' +
      '#dt-rps-roll-btn:hover{opacity:.9;}' +
      '#dt-rps-roll-label{color:#eee;font-size:13px;}' +
      '#dt-rps-roll-label .dt-rps-outcome{font-weight:bold;}';
    document.head.appendChild(style);
  }

  function buildRollUI() {
    ensureStyle();
    const ui = document.createElement('div');
    ui.id = 'dt-rps-roll-ui';
    const btn = document.createElement('button');
    btn.id = 'dt-rps-roll-btn';
    btn.textContent = 'Roll for RPS';
    btn.onclick = onRollClick;
    const label = document.createElement('span');
    label.id = 'dt-rps-roll-label';
    ui.appendChild(btn);
    ui.appendChild(label);
    document.body.appendChild(ui);
    return ui;
  }

  let currentCards = []; // the live round's 3 real card elements, refreshed every poll tick while a round is on screen

  // Per the user's own spec: Red, Yellow, Green, White, Blue, in that
  // order, looping — the Rock/Paper/Scissors outcome word gets the next
  // color in this list every single click, cycling back to Red after
  // Blue. Never reset by a new round — it's one continuous loop across
  // however many times the button gets clicked. Chosen as clearly-
  // readable variants of each named color against this panel's dark
  // background, rather than the literal (much lower-contrast) CSS
  // keywords 'red'/'green'/'blue'.
  const OUTCOME_COLORS = ['#ff3b30', '#ffd60a', '#30d158', '#ffffff', '#0a84ff']; // Red, Yellow, Green, White, Blue
  let outcomeColorIdx = 0;

  function onRollClick() {
    if (!currentCards.length) return;
    const idx = Math.floor(Math.random() * currentCards.length);
    const chosen = currentCards[idx];
    const outcomeName = cardChoice(chosen) || '?';

    const label = document.getElementById('dt-rps-roll-label');
    if (label) {
      const color = OUTCOME_COLORS[outcomeColorIdx % OUTCOME_COLORS.length];
      outcomeColorIdx++;
      // outcomeName only ever comes from cardChoice()'s own fixed
      // Rock/Paper/Scissors/null set above — never raw page text — so
      // building this as HTML here is safe.
      label.innerHTML =
        'Suggested: <span class="dt-rps-outcome" style="color:' + color + ';">' + outcomeName + '</span>' +
        ' — click it, or pick your own';
    }

    // Button flashes yellow, then settles back to its normal green —
    // purely a click acknowledgment, independent of the outcome-word
    // color cycle above.
    const btn = document.getElementById('dt-rps-roll-btn');
    if (btn) {
      btn.style.background = '#ffd60a';
      setTimeout(() => {
        btn.style.background = ''; // back to the CSS rule's normal green
      }, 250);
    }
  }

  // Sits in the gap between the opponent's mirrored row and these 3 own
  // cards, centered horizontally over them — computed fresh every tick
  // from the real, current layout (never a hardcoded viewport offset),
  // so it tracks correctly regardless of screen size or where DuelingBook
  // happens to lay the two rows out.
  function positionRollUI(ui, cards) {
    if (!cards.length) return;
    try {
      const rects = cards.map((c) => c.getBoundingClientRect());
      const mineTop = Math.min.apply(null, rects.map((r) => r.top));
      const left = Math.min.apply(null, rects.map((r) => r.left));
      const right = Math.max.apply(null, rects.map((r) => r.right));

      const el = document.getElementById('rps_start');
      const oppCards = el
        ? Array.from(el.querySelectorAll('.card:not(.rps_card)')).filter((c) => c.offsetParent !== null)
        : [];
      let midY;
      if (oppCards.length) {
        const oppBottom = Math.max.apply(null, oppCards.map((c) => c.getBoundingClientRect().bottom));
        midY = (oppBottom + mineTop) / 2;
      } else {
        midY = mineTop - 30; // no opponent row found — just sit a bit above our own row
      }

      ui.style.left = (left + right) / 2 + 'px';
      ui.style.top = midY + 'px';
    } catch (e) {
      // Layout read failed for some reason — leave the panel wherever it
      // last was rather than breaking anything.
    }
  }

  function showRollUI(cards) {
    const ui = document.getElementById('dt-rps-roll-ui') || buildRollUI();
    ui.style.display = 'flex';
    positionRollUI(ui, cards);
  }

  function hideRollUI() {
    const ui = document.getElementById('dt-rps-roll-ui');
    if (ui) ui.style.display = 'none';
    const label = document.getElementById('dt-rps-roll-label');
    if (label) label.textContent = '';
  }

  // "Has THIS round already had its suggestion label cleared" — only
  // used for the cosmetic Roll-for-RPS UI below now. DuelingBook can
  // reuse the same 3 DOM nodes across rounds, so this is tracked in a
  // plain variable here (not on the DOM) and keyed off the round's
  // resolved/unresolved transition, same pattern as the engine uses for
  // the real Automated RPS decision — but here it's purely cosmetic
  // (worst case the label lags a tick), so the DOM-inferred
  // roundResolved() signal is fine for it.
  let roundFresh = false;

  function poll() {
    const auto = !!getSetting('dt_rps_auto_enabled', false);
    const roll = !!getSetting('dt_rps_roll_enabled', false);

    // Automated RPS's actual decide-and-click loop lives in
    // dt-rps-engine.js (MAIN world) now — it needs to know the current
    // on/off setting every tick, since GM_getValue/settings aren't
    // readable from MAIN world.
    relaySettingsToEngine(auto);

    const cards = liveRpsCards();

    if (!cards.length) {
      // No RPS round on screen right now — nothing from this feature
      // should be visible, per spec ("only appear and disappear when a
      // Rock Paper Scissors game occurs").
      hideRollUI();
      currentCards = [];
      roundFresh = false;
      return;
    }

    // Automated RPS needs no further logic here at all — the engine
    // owns it entirely. This script's only remaining job is the
    // Roll-for-RPS suggestion UI, which only ever shows when auto is
    // off.
    if (auto) {
      hideRollUI();
      currentCards = cards;
      return;
    }

    if (roundResolved(cards)) {
      roundFresh = false;
      hideRollUI();
      currentCards = cards;
      return;
    }

    if (!roundFresh) {
      roundFresh = true;
      hideRollUI(); // clears any leftover suggestion label from a previous round
    }

    currentCards = cards;

    if (roll) {
      showRollUI(cards);
    } else {
      hideRollUI();
    }
  }

  setInterval(poll, 300);
  console.log('[Duel Tools] RPS Automation ready');
})();
