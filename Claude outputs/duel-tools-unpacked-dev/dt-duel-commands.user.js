// ==UserScript==
// @name         Duel Tools — Duel Commands
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  A tile-based UI for DuelingBook's own "/" slash commands (draw/mill/banish N, LP changes, discard/banish hand) so you don't have to type them by hand.
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
//
// Scope: "Playing" category — duelingbook.com only, NEVER /replay* pages
// (enforced below — see background.js's injectAll() for the actual
// gating). Off by default; a single master toggle in settings is the only
// configuration this feature has, per spec.
//
// STATUS:
// The command TEXT (/drawN, /millN, /banishN, /banishfdN, /addN, /subN,
// /half, /discardhand, /banishhand, /discardrandom) is exactly what the
// user specified, per their own redesign mockup (see COMMANDS below).
//
// CONFIRMED LIVE — the input + submission mechanism: inspected the real
// #duel DOM directly and found the actual chat/command input,
// `input.cin_txt` (findCommandInput() now matches it by that class — see
// the comment there for why the old keyword-based scan could never have
// found it). sendCommand() sets its value with the native setter + fires
// an 'input' event, then dispatches a real keydown/keypress/keyup for
// Enter — the same sequence a manual keystroke produces, per the user's
// own confirmation that typing a command and hitting Enter by hand works.
// Not independently re-tested end-to-end by clicking an actual tile yet —
// that's the next thing to confirm live.
//
// CONFIRMED LIVE BUG, FIXED — positioning anchor: the original spec says
// "next to the Thinking indicator", and the first version of this file
// looked for that via findByExactText('Thinking'), assuming it was a text
// label like the phase buttons. Checked directly against a real live duel's
// DOM and that assumption was wrong — "Thinking" is not a text node at all.
// Two false leads turned up first: an `<img alt="Thinking" class="think">`
// per avatar (display:none almost always — a brief flash indicator, not a
// stable anchor), and chat log lines like "KereMnM: Thinking" (something a
// player literally typed). The real element, found by clicking where the
// user pointed and reading document.elementFromPoint there: a genuine,
// always-present, always-visible `#think_btn` — a real DuelingBook button
// (it's what sends that "Thinking" chat line in the first place) sitting
// right next to the chat input. findThinkButton() below anchors to it
// directly; isLikelyPlayer() (checking Admit Defeat / Begin Siding / Offer
// Draw / Call Judge, the same set isSpectatingNow() in
// dt-spectate-engine.js checks) is kept as a belt-and-suspenders guard in
// case #think_btn ever turns out visible while spectating too (unverified
// either way).
(function () {
  'use strict';

  if (window.location.pathname.indexOf('/replay') === 0) return; // belt-and-suspenders — see background.js

  function getSetting(key, def) {
    try { return GM_getValue(key, def); } catch (e) { return def; }
  }

  function findByExactText(text) {
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      if (el.offsetParent === null) continue;
      const t = (el.textContent || '').trim();
      if (t !== text) continue;
      if (el.children.length && Array.from(el.children).some((c) => (c.textContent || '').trim() === text)) continue;
      return el;
    }
    return null;
  }

  // CONFIRMED LIVE — the chat/command input: inspected the real DOM inside
  // #duel directly and found it: `<input type="text" class="cin_txt">`
  // (no id). The original best-effort scan could never have found it — its
  // keyword check (chat|msg|message|command against className/id/
  // placeholder) doesn't match "cin_txt" at all, which is presumably short
  // for "chat input text" but shares none of those substrings.
  //
  // CONFIRMED LIVE BUG, FIXED — there isn't just one .cin_txt on the page.
  // DuelingBook keeps FIVE of them at once: one for the lobby's "all
  // messages" tab, one inside #duel (the one we actually want), and one
  // each for #public_chat/#private_chat/#watch_chat. Only the one for
  // whatever tab/view is currently active is actually visible — the rest
  // sit there with offsetParent null. querySelector('input.cin_txt') only
  // ever returns the FIRST one in document order (the hidden "all
  // messages" one, confirmed live), so the old `direct && direct.
  // offsetParent !== null` check correctly rejected it as invisible but
  // then had nothing else to fall back to that could find the right one —
  // this is exactly why nothing ever got typed. Fixed: loop every
  // `.cin_txt` and take the first one that's actually visible, same
  // "existence vs visibility" trap this project has hit before with
  // avatar1..4 and the per-avatar think icons.
  let warnedInput = false;
  function findCommandInput() {
    const candidates = document.querySelectorAll('input.cin_txt');
    for (const el of candidates) {
      if (el.offsetParent !== null) return el;
    }
    const all = document.querySelectorAll('input[type="text"],textarea');
    for (const el of all) {
      if (el.offsetParent === null) continue;
      const hay = ((el.className && el.className.toString()) + ' ' + (el.id || '') + ' ' + (el.placeholder || '')).toLowerCase();
      if (/chat|msg|message|command/.test(hay)) return el;
    }
    if (!warnedInput) {
      warnedInput = true;
      console.warn('[Duel Tools Commands] chat/command input (.cin_txt) not found — check whether DuelingBook renamed it.');
    }
    return null;
  }

  // Types `text` into DuelingBook's command input and submits it. Native
  // value setter + 'input' event first (so any framework watching the
  // field sees the change), then a synthetic Enter keydown/keypress/keyup
  // to submit (keypress included alongside keydown/keyup since some chat
  // implementations listen for keypress specifically to detect Enter).
  function sendCommand(text) {
    const input = findCommandInput();
    if (!input) return false;
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    });
    return true;
  }

  // ── Command definitions — row labels/wording and the two added commands
  // (Banish face-down, Discard random) match the user's own redesign
  // mockup verbatim, including its exact slash-command casing (lowercase
  // /banishhand, replacing the earlier /BanishHand).
  const COMMANDS = [
    { id: 'draw', label: 'Draw', template: '/draw{n}', tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { id: 'mill', label: 'Mill to GY', template: '/mill{n}', tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { id: 'banishDeck', label: 'Banish from deck', template: '/banish{n}', tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { id: 'banishFd', label: 'Banish face-down', template: '/banishfd{n}', tiles: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { id: 'addLp', label: 'Gain LP', template: '/add{n}', tiles: [1000, 500, 100] },
    { id: 'subLp', label: 'Lose LP', template: '/sub{n}', tiles: [1000, 500, 100] },
    { id: 'half', label: 'Halve LP', template: '/half', tiles: ['Use'] },
    { id: 'discardHand', label: 'Discard entire hand', template: '/discardhand', tiles: ['Use'] },
    { id: 'banishHand', label: 'Banish entire hand', template: '/banishhand', tiles: ['Use'] },
    { id: 'discardRandom', label: 'Discard random (Solo only)', template: '/discardrandom', tiles: ['Use'] }
  ];
  function commandText(cmd, tileValue) {
    return tileValue === 'Use' ? cmd.template : cmd.template.replace('{n}', String(tileValue));
  }

  // ── One-time stylesheet for the overlay — hover states and the row
  // divider live here instead of inline, same pattern dt-spectate-
  // controls.user.js uses for its own .dt-spec-tile rules.
  let styleInjected = false;
  function ensureStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement('style');
    style.id = 'dt-commands-style';
    style.textContent =
      '#dt-commands-overlay .dt-cmd-row{display:flex;align-items:center;justify-content:space-between;gap:16px;' +
        'padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.1)}' +
      '#dt-commands-overlay .dt-cmd-row:last-child{border-bottom:none}' +
      '#dt-commands-overlay .dt-cmd-label{font-weight:bold;color:#fff;font-size:14px;margin-bottom:3px;' +
        'text-shadow:0 1px 3px rgba(0,0,0,.9)}' +
      '#dt-commands-overlay .dt-cmd-template{color:#9fb0bc;font-size:11px;text-shadow:0 1px 3px rgba(0,0,0,.9)}' +
      '#dt-commands-overlay .dt-cmd-tile{background:rgba(26,26,40,0.85);color:#00e596;border:1px solid #00e596;' +
        'border-radius:5px;padding:7px 12px;cursor:pointer;text-align:center;font-family:monospace;' +
        'font-size:12px;min-width:16px;transition:background .1s,color .1s}' +
      '#dt-commands-overlay .dt-cmd-tile:hover{background:#00e596;color:#050508}' +
      '#dt-commands-close:hover{color:#00e596;border-color:#00e596}';
    document.head.appendChild(style);
  }

  // ── Command overlay — full-row layout (label + slash command stacked on
  // the left, a strip of value tiles on the right) matching the user's own
  // mockup exactly, recolored into Duel Tools' established dark/green theme
  // (#eee text / #00e596 accent — the same palette every other
  // dt-*.user.js modal already uses), but kept semi-transparent (per the
  // user's own mockup, where the board's grid pattern shows through the
  // rows) instead of the usual solid #111 modal background, and centered
  // on screen via top/left/transform instead of anchored to the button —
  // the button sits in a tight corner of the UI and the panel is much
  // bigger than it, so anchoring there pushed it off-center/off-screen.
  let overlayEl = null;
  function buildOverlay() {
    ensureStyle();
    const el = document.createElement('div');
    el.id = 'dt-commands-overlay';
    el.style.cssText = [
      'position:fixed', 'z-index:2147483600', 'display:none',
      'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'background:rgba(10,14,20,0.85)', 'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
      'color:#eee', 'border:1px solid rgba(255,255,255,0.12)', 'border-radius:10px',
      'font-family:monospace', 'width:600px', 'max-width:92vw', 'max-height:90vh', 'overflow-y:auto',
      'padding:18px 22px', 'box-shadow:0 12px 36px rgba(0,0,0,.7)', 'box-sizing:border-box'
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.15)';
    header.innerHTML = '<span style="font-size:22px;font-weight:bold;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.8)">Duel Commands</span>';
    const close = document.createElement('button');
    close.id = 'dt-commands-close';
    close.textContent = 'Close';
    close.style.cssText = 'background:transparent;color:#eee;border:1px solid rgba(255,255,255,0.4);border-radius:999px;' +
      'padding:6px 18px;font-family:monospace;font-size:13px;cursor:pointer';
    close.onclick = function () { el.style.display = 'none'; };
    header.appendChild(close);
    el.appendChild(header);

    COMMANDS.forEach((cmd) => {
      const row = document.createElement('div');
      row.className = 'dt-cmd-row';
      const labelWrap = document.createElement('div');
      const label = document.createElement('div');
      label.className = 'dt-cmd-label';
      label.textContent = cmd.label;
      const tmpl = document.createElement('div');
      tmpl.className = 'dt-cmd-template';
      tmpl.textContent = cmd.template;
      labelWrap.appendChild(label);
      labelWrap.appendChild(tmpl);
      row.appendChild(labelWrap);

      const tilesWrap = document.createElement('div');
      tilesWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end';
      cmd.tiles.forEach((val) => {
        const tile = document.createElement('div');
        tile.className = 'dt-cmd-tile';
        tile.dataset.cmd = cmd.id;
        tile.dataset.val = String(val);
        tile.textContent = String(val);
        tile.onclick = function () { sendCommand(commandText(cmd, val)); };
        tilesWrap.appendChild(tile);
      });
      row.appendChild(tilesWrap);
      el.appendChild(row);
    });

    document.body.appendChild(el);
    overlayEl = el;
    return el;
  }

  // Found live, directly in the DOM of a real duel: DuelingBook has an
  // actual #think_btn element — a small, always-present, always-visible
  // button right next to the chat input (it's what sends a "Thinking"
  // chat line — that's what the earlier false leads, the chat-log text and
  // the per-avatar <img alt="Thinking" class="think">, were both echoes
  // of). This is the real, stable "Thinking indicator" the original spec
  // meant, confirmed by getElementById('think_btn') returning a real,
  // visible, correctly-placed node live on the user's own duel. Anchoring
  // here directly (not by proximity/guesswork) replaces the old
  // avatar-proximity fallback entirely — simpler and matches the spot the
  // user pointed at.
  const PLAYER_ONLY_LABELS = ['Admit Defeat', 'Begin Siding', 'Offer Draw', 'Call Judge'];
  function isLikelyPlayer() {
    for (const label of PLAYER_ONLY_LABELS) {
      if (findByExactText(label)) return true;
    }
    return false;
  }
  function findThinkButton() {
    const el = document.getElementById('think_btn');
    if (!el || el.offsetParent === null) return null;
    return el;
  }

  // ── The "Commands" button — real DOM insertion is too risky against a
  // page layout we don't control, so instead this is a fixed-position
  // button whose rect is recomputed from #think_btn's own live rect (same
  // "measure real layout, don't guess a fixed offset" approach
  // dt-unlock.user.js's positionBesideBoard already uses), re-run on an
  // interval so it tracks that button if the page reflows. Positioned via
  // `right`/`top` (not `left`) so it sits just outside #think_btn's left
  // edge regardless of the Commands button's own rendered width.
  let buttonEl = null;
  function buildButton() {
    const btn = document.createElement('div');
    btn.id = 'dt-commands-button';
    btn.textContent = 'Commands';
    btn.style.cssText = [
      'position:fixed', 'z-index:2147483600', 'display:none',
      'background:#1a1a28', 'color:#00e596', 'border:1px solid #252538', 'border-radius:5px',
      'padding:4px 8px', 'font-family:monospace', 'font-size:11px', 'cursor:pointer'
    ].join(';');
    btn.onclick = function () {
      const overlay = overlayEl || buildOverlay();
      overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none';
    };
    document.body.appendChild(btn);
    buttonEl = btn;
    return btn;
  }

  let warnedNoThink = false;
  function reposition() {
    if (!getSetting('dt_duel_commands_enabled', false)) {
      if (buttonEl) buttonEl.style.display = 'none';
      if (overlayEl) overlayEl.style.display = 'none';
      return;
    }
    const think = findThinkButton();
    const btn = buttonEl || buildButton();
    if (!think || !isLikelyPlayer()) {
      // Either spectating (no player-only control, #think_btn likely
      // hidden too), or the very start of a duel before things have
      // rendered yet. Hide rather than leave the button stranded at a
      // stale position.
      btn.style.display = 'none';
      if (!warnedNoThink) { warnedNoThink = true; console.log('[Duel Tools Commands] not currently in an active duel as a player — Commands button will appear once you are.'); }
      return;
    }
    const r = think.getBoundingClientRect();
    btn.style.display = 'block';
    btn.style.left = 'auto';
    btn.style.right = (window.innerWidth - r.left + 8) + 'px';
    btn.style.top = r.top + 'px';
  }

  setInterval(reposition, 500);
  reposition();
  console.log('[Duel Tools Commands] ready');

  // Exposed for tests only — real page code never reads this.
  if (typeof window !== 'undefined') window.__dtCommandsTestHooks = { COMMANDS, commandText, sendCommand, findCommandInput, reposition };
})();
