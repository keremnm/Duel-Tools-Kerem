// ==UserScript==
// @name         Duel Tools — Unlock (scaffold)
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Modular, toggleable DuelingBook enhancements (card mechanics / UI / slash commands). Separate from the Duel Tools analysis + save-prompt scripts on purpose.
// @author       Kerem's Duel Tools
// @match        *://*.duelingbook.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ── STATUS ──────────────────────────────────────────────────────────────
  // This is a scaffold, not a finished feature set. Each module below is a
  // real, independently-toggleable switch with its settings persisted — but
  // the module bodies are stubs (they just log what they'd do) until I can
  // see how DuelingBook's own duel-page client code actually works.
  //
  // Why: things like "set an Extra Deck monster face-down", "shuffle a card
  // into the opponent's deck", or "add a card to the opponent's hand" are
  // mechanics DuelingBook's UI deliberately blocks. Making them real means
  // calling whatever internal function DuelingBook itself uses to move a
  // card / change a zone / talk to its server — and I can't see or guess
  // that function from here. I have no network access to duelingbook.com
  // from this environment, so I can't just go look.
  //
  // What unlocks the real modules: the actual JavaScript DuelingBook serves
  // on a duel page. Easiest way to grab it — open a live or replay duel,
  // open DevTools → Sources tab, find the main script file(s) (there may be
  // one big bundle or a few), and save/attach them. Once I can read that,
  // I'll go module by module (card mechanics first, per what you asked for)
  // and wire in real behavior instead of these stubs.
  //
  // Kept as its own script (not merged with the Duel Tools save-prompt or
  // tracker scripts) so a bug in an experimental game-mechanic hook here
  // can never break the analysis/import tooling, and vice versa.

  const MODULES = {
    cardMechanics: {
      label: 'Card mechanics unlocking',
      detail: 'Face-down Extra Deck / Links, shuffle into opp deck, banish random Extra Deck card, add to opp hand, Spell/Trap-as-monster, LP math, etc.',
      init(ctx) {
        ctx.log('Card mechanics module enabled — no hooks wired yet (needs DuelingBook client source, see notice above).');
      }
    },
    uiOverhaul: {
      label: 'UI / click-to-play overhaul',
      detail: 'Bird UI, left-click-to-act, double-click face-down, Ctrl+click repeat-last-action, right-click menus, editable ATK/DEF.',
      init(ctx) {
        ctx.log('UI overhaul module enabled — no hooks wired yet (needs DuelingBook client source, see notice above).');
      }
    },
    slashCommands: {
      label: 'Slash commands & opponent notes',
      detail: 'Search / excavate / pendulum / banish / special-summon commands, plus free-text notes on opponent cards.',
      init(ctx) {
        ctx.log('Slash commands module enabled — no hooks wired yet (needs DuelingBook client source, see notice above).');
      }
    },
    // Unlike the three scaffold modules above, this one is fully real and
    // ships ON by default (per request) — the only toggle here is whether
    // the user wants to turn it OFF.
    cardStats: {
      label: 'Card Stats (auto-hide ATK/DEF)',
      detail: 'On duelingbook.com/replay* pages: hides every on-field monster’s ATK/DEF text by default. A card’s stats reveal again the moment the Duel Log shows its stats changed, and hide again once that same card is Set, Banished, Sent, or Added (i.e. leaves the zone).',
      defaultOn: true,
      init(ctx) { initCardStats(ctx); }
    }
  };

  // ── Card Stats module ─────────────────────────────────────────────────
  // Scoped to duelingbook.com/replay* only, per spec. Implemented as its
  // own small, self-contained duel-log watcher rather than reusing
  // dt-live-tracker.user.js's — these are separate content scripts with
  // separate scopes, and keeping this independent means a bug here can
  // never break the tracker (or vice versa), same reasoning as keeping
  // this whole file separate from the tracker/save-prompt scripts.
  //
  // Zone mapping assumption (not yet confirmed against a real replay):
  // DuelingBook's own replay DOM exposes exactly 5 monster-zone stat
  // elements, #om1_txt..#om5_txt, given directly by the user — assumed
  // to correspond 1:1 to the "M-1".."M-5" zone numbers the Duel Log uses
  // in lines like "Changed stats of X in M-3 to 2000/1000". If a real
  // replay's log turns out to number zones differently (e.g. 0-indexed,
  // or Extra Monster Zones as "EMZ-1"/"EMZ-2" instead of M-1..M-5), the
  // CHANGED_RE / RESET_RE patterns below are the only things that need
  // adjusting — everything else (the style injection, the reveal/hide
  // toggle) stays correct.
  function initCardStats(ctx) {
    if (window.location.pathname.indexOf('/replay') !== 0) {
      ctx.log('not on a /replay* page — Card Stats only applies there, nothing to do here.');
      return;
    }

    const ZONE_IDS = [1, 2, 3, 4, 5].map((n) => 'om' + n + '_txt');
    const STYLE_ID = 'dt-card-stats-style';
    const REVEAL_CLASS = 'dt-cs-reveal';

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      // :not(.REVEAL_CLASS) means revealing/hiding a zone is just toggling
      // one class — no fighting this rule's own !important specificity.
      style.textContent = ZONE_IDS.map((id) => '#' + id + ':not(.' + REVEAL_CLASS + ')').join(', ') +
        ' { display: none !important; }';
      document.head.appendChild(style);
    }

    function zoneEl(n) { return document.getElementById('om' + n + '_txt'); }
    function reveal(n) { const el = zoneEl(n); if (el) el.classList.add(REVEAL_CLASS); }
    function hideZone(n) { const el = zoneEl(n); if (el) el.classList.remove(REVEAL_CLASS); }

    const CHANGED_RE = /Changed stats of .+ in M-(\d+) to/i;
    // "Set" / "Banished" / "Sent" / "Added" are the 4 verbs specified —
    // "Set"/"Sent" are confirmed real DuelingBook log verbs elsewhere in
    // this project (see dt-live-tracker.user.js's RESET_WORDS); "Banished"
    // and "Added" are assumed to follow the same "Verb ... M-N ..." shape.
    const RESET_RE = /^(Set|Banished|Sent|Added)\b.*\bM-(\d+)\b/i;
    let unmatchedChangedLogged = 0;

    function handleLine(text) {
      let m = CHANGED_RE.exec(text);
      if (m) { reveal(parseInt(m[1], 10)); return; }
      // RESET_RE is anchored to the start of the *action text*, not the
      // raw line -- every line is prefixed with "[m:ss] " (and sometimes
      // "Username: " ahead of that), which would otherwise make the ^
      // anchor never match a real line.
      const action = text.replace(/^\[\d+:\d+\]\s*/, '').replace(/^[^:]{1,40}:\s*/, '');
      m = RESET_RE.exec(action);
      if (m) { hideZone(parseInt(m[2], 10)); return; }
      // Diagnostic, same spirit as dt-live-tracker's own capped diagnostic
      // logging: if DuelingBook ever logs a stat change in a shape this
      // regex doesn't catch, this makes it a one-console-paste fix instead
      // of another blind guess.
      if (/changed stats/i.test(text) && unmatchedChangedLogged < 10) {
        unmatchedChangedLogged++;
        console.warn('[Duel Tools Unlock] (cardStats) a "changed stats" log line didn’t match the expected "...in M-<N> to..." shape:', text);
      }
    }

    function getCandidateLogLines(duelLogEl) {
      return Array.from(duelLogEl.querySelectorAll('*')).filter((el) => {
        const t = (el.textContent || '').trim();
        return /^\[\d+:\d+\]/.test(t) && el.children.length === 0;
      });
    }

    function armLogWatcher(duelLogEl) {
      // Only react to lines added from here on — a replay's log panel can
      // already be fully populated (or mid-played-back) by the time this
      // attaches, and replaying its whole history isn't needed: the CSS
      // rule above already hides everything by default, so nothing needs
      // "catching up" retroactively.
      let seen = getCandidateLogLines(duelLogEl).length;
      let pending = false;
      function scan() {
        const all = getCandidateLogLines(duelLogEl);
        for (let i = seen; i < all.length; i++) handleLine(all[i].textContent || '');
        seen = all.length;
      }
      function scheduleScan() {
        if (pending) return;
        pending = true;
        setTimeout(function () { pending = false; scan(); }, 250);
      }
      new MutationObserver(scheduleScan).observe(duelLogEl, { childList: true, subtree: true, characterData: true });
    }

    function waitFor(selector, cb) {
      const existing = document.querySelector(selector);
      if (existing) { cb(existing); return; }
      const obs = new MutationObserver(function () {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); cb(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }

    // The CSS hide rule applies regardless of whether the log panel is
    // open — that part works immediately. The log panel is only needed to
    // know WHEN to reveal/re-hide a given zone, so try to open it the same
    // way dt-live-tracker.user.js does on the live page (click #log_btn if
    // #duel_log doesn't already exist); if this replay page has neither,
    // reveal/re-hide simply never fires and stats just stay hidden, which
    // is still the requested default-safe behavior.
    ensureStyle();
    const existingLog = document.querySelector('#duel_log');
    if (existingLog) {
      armLogWatcher(existingLog);
    } else {
      waitFor('#log_btn', function (btn) {
        try { btn.click(); } catch (e) {}
        waitFor('#duel_log', function (duelLogEl) {
          ctx.log('opened replay Duel Log panel to watch for stat changes.');
          armLogWatcher(duelLogEl);
        });
      });
    }
  }

  function getSetting(key, def) {
    try { return GM_getValue(key, def); } catch (e) { return def; }
  }
  function setSetting(key, val) {
    try { GM_setValue(key, val); } catch (e) {}
  }

  function log(moduleKey, msg) {
    console.log('[Duel Tools Unlock]', moduleKey ? '(' + moduleKey + ')' : '', msg);
  }

  function runEnabledModules() {
    Object.keys(MODULES).forEach(function (key) {
      const mod = MODULES[key];
      const enabled = getSetting('dt_unlock_' + key, !!mod.defaultOn);
      if (!enabled) return;
      try {
        mod.init({ log: function (msg) { log(key, msg); } });
      } catch (e) {
        log(key, 'FAILED to init: ' + e.message);
      }
    });
  }

  // ── Settings panel — small floating toggle box, each module independent ──
  function buildSettingsUI() {
    // BUGFIX: this used to `return` with no value here once the panel
    // already existed — toggleSettingsUI() does `buildSettingsUI().style
    // .display = ...`, so on every call AFTER the first one it was setting
    // `.style` on `undefined` and throwing, which silently broke the ⚙️ tab
    // for the rest of the page's life the moment you closed the panel once
    // (closing it set display:none directly, so even that still "worked" —
    // it was only re-opening that was broken). Returning the existing
    // panel instead of nothing is the actual fix.
    const existing = document.getElementById('dt-unlock-panel');
    if (existing) return existing;

    const panel = document.createElement('div');
    panel.id = 'dt-unlock-panel';
    panel.style.cssText = [
      'position:fixed', 'top:20px', 'z-index:2147483647',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:12px', 'width:270px', 'padding:12px',
      // box-sizing:border-box so this element's rendered box is EXACTLY
      // 270px wide (padding+border included) — without it the real
      // on-screen width was 270+24(padding)+2(border)=296px, 26px wider
      // than positionBesideBoard()'s width fallback assumed for a
      // display:none element, which let the panel's real right edge drift
      // past the clamp and overlap DuelingBook's own right-side UI again.
      'box-sizing:border-box',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)', 'display:none'
    ].join(';');

    let rows = '';
    Object.keys(MODULES).forEach(function (key) {
      const mod = MODULES[key];
      const checked = getSetting('dt_unlock_' + key, !!mod.defaultOn) ? 'checked' : '';
      rows +=
        '<label style="display:block;margin-bottom:10px;cursor:pointer">' +
          '<div style="display:flex;align-items:flex-start;gap:8px">' +
            '<input type="checkbox" data-mod="' + key + '" ' + checked + ' style="margin-top:2px"/>' +
            '<div>' +
              '<div style="font-weight:bold">' + mod.label + '</div>' +
              '<div style="color:#888;font-size:10px;margin-top:2px">' + mod.detail + '</div>' +
            '</div>' +
          '</div>' +
        '</label>';
    });

    panel.innerHTML =
      '<div style="font-weight:bold;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">' +
        '<span>⚙️ Duel Tools Unlock</span>' +
        '<span id="dt-unlock-close" style="cursor:pointer;color:#888">✕</span>' +
      '</div>' +
      rows +
      '<div style="font-size:10px;color:#666;border-top:1px solid #333;padding-top:8px;margin-top:4px">' +
        'Modules are stubs until real DuelingBook hooks are wired in. Toggling one on just enables it for next time it’s ready — check the console for status.' +
      '</div>';

    document.body.appendChild(panel);
    // Measures real layout (offsetWidth etc.), so this runs AFTER the
    // panel is actually in the DOM, not before.
    positionBesideBoard(panel, 20);

    panel.querySelector('#dt-unlock-close').onclick = function () {
      panel.style.display = 'none';
    };
    panel.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        setSetting('dt_unlock_' + cb.dataset.mod, cb.checked);
        log(cb.dataset.mod, cb.checked ? 'enabled (takes effect on next page load)' : 'disabled');
      });
    });

    return panel;
  }

  function toggleSettingsUI() {
    const panel = buildSettingsUI();
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }

  // DuelingBook's own board (#duel) is a responsively-scaled canvas that
  // can sit anywhere in the window depending on its size — on a real
  // replay page this was confirmed to leave an empty margin on either
  // side of the board itself (e.g. ~276px wide at one real window size),
  // with the board's own player banners/chat panel living right up
  // against its edges. A flat `right:20px` landed this panel ON TOP of
  // that real DuelingBook UI (the top player banner + chat panel occupy
  // that exact corner) — confirmed from the user's own screenshot.
  // Anchoring to #duel's measured right edge instead keeps this panel in
  // the actual empty margin beside the board, never on top of DuelingBook's
  // own UI, regardless of window size. Falls back to the old flat
  // right:20px when #duel can't be found yet (e.g. a non-duel page, or
  // before the board has finished loading).
  function positionBesideBoard(el, topPx) {
    function reposition() {
      const duel = document.querySelector('#duel');
      el.style.top = topPx + 'px';
      if (!duel) { el.style.right = '20px'; el.style.left = ''; return; }
      const r = duel.getBoundingClientRect();
      // offsetWidth reads 0 for a display:none element (true for the
      // settings panel, which starts closed) even once it's in the DOM,
      // so fall back to its own CSS width rather than a guessed constant.
      const w = el.offsetWidth || parseInt(el.style.width, 10) || 270;
      let left = r.right + 10;
      if (left + w > window.innerWidth) {
        // Pull it back toward the viewport's own right edge instead of
        // off-screen — BUT never past #duel's right edge. A narrow window
        // can leave less margin beside the board than this panel needs
        // (270px); pulling fully back to fit the viewport would walk the
        // panel's left edge back ONTO the board itself, covering
        // DuelingBook's own UI again — the exact bug this function exists
        // to avoid. Letting the panel's right edge spill slightly past the
        // visible viewport in that rare case is the better tradeoff.
        const altLeft = window.innerWidth - w - 10;
        if (altLeft >= r.right) left = Math.max(4, altLeft);
      }
      el.style.right = '';
      el.style.left = left + 'px';
    }
    reposition();
    window.addEventListener('resize', reposition);
  }

  // ── On-page logo tab → opens Settings as an in-page overlay ────────────
  // Settings UI overhaul, per spec: clicking the on-page tab (or the pinned
  // toolbar icon — see dt-popup.html/.js) no longer asks "Open Settings?"
  // first, AND no longer navigates to a brand new browser tab/window either
  // — it opens the real settings page (the exact same dt-settings.html/.js/
  // .css, unmodified) right over the current duel, in a centered panel with
  // a translucent/blurred backdrop so the board stays visible behind it.
  // Framing the extension's OWN page in an iframe like this is allowed by
  // default (no X-Frame-Options/CSP issue — chrome-extension:// pages are
  // self-framable unless the extension's manifest says otherwise, which
  // this one doesn't), and it's extension-privileged either way, so
  // chrome.storage.local inside that iframe works exactly like it does when
  // dt-settings.html is its own tab. The old confirmation prompt
  // (buildOpenSettingsPrompt/toggleOpenSettingsPrompt) stays removed, same
  // as before this change — nothing referenced it.
  //
  // dt-settings.js's Save & Close button needs to behave differently in
  // this embedded context (window.close() is a no-op on an iframe, not a
  // real popup window) — it detects window.self !== window.top and
  // postMessages 'DT_SETTINGS_CLOSE' up to this page instead, which the
  // listener below turns into just hiding the overlay.
  //
  // NOTE: the OLD inline module-toggle panel (buildSettingsUI/
  // toggleSettingsUI, directly below) is intentionally left in place but no
  // longer wired to the tab — it's not deleted because Card Stats' on/off
  // toggle still only lives there for now. It'll get a proper home in the
  // new Settings Overview once a "Watching & Replays" category is spec'd
  // out; until then this old panel is dormant/unreachable from the UI, and
  // Card Stats just runs on its stored default.
  function buildSettingsOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'dt-settings-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:none', 'align-items:center', 'justify-content:center',
      'background:rgba(5,5,10,.55)', '-webkit-backdrop-filter:blur(4px)', 'backdrop-filter:blur(4px)'
    ].join(';');

    const panel = document.createElement('div');
    panel.id = 'dt-settings-overlay-panel';
    panel.style.cssText = [
      'position:relative', 'width:min(1100px,92vw)', 'height:min(760px,88vh)',
      'border-radius:12px', 'overflow:hidden', 'box-shadow:0 20px 60px rgba(0,0,0,.6)'
    ].join(';');

    const closeBtn = document.createElement('div');
    closeBtn.id = 'dt-settings-overlay-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = [
      'position:absolute', 'top:8px', 'right:8px', 'z-index:1',
      'width:26px', 'height:26px', 'line-height:26px', 'text-align:center',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:6px',
      'cursor:pointer', 'font-family:monospace', 'font-size:13px'
    ].join(';');
    closeBtn.onclick = requestOverlayClose;

    const iframe = document.createElement('iframe');
    iframe.id = 'dt-settings-overlay-iframe';
    iframe.style.cssText = 'display:block;width:100%;height:100%;border:none;background:#06060c;';

    panel.appendChild(closeBtn);
    panel.appendChild(iframe);
    overlay.appendChild(panel);
    // Clicking the backdrop (not the panel itself) closes the overlay —
    // same affordance as the Duel Commands overlay already uses.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) requestOverlayClose(); });
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeSettingsOverlay() {
    const overlay = document.getElementById('dt-settings-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  // BUGFIX: the X button and a backdrop click used to call
  // closeSettingsOverlay() directly, which just hides the iframe — it never
  // ran dt-settings.js's flushPending(), and the page's own `beforeunload`
  // guard never fires either, because hiding an iframe isn't an unload.
  // Net effect: toggling something in Settings and closing the panel any
  // way OTHER than clicking "Save" or "Save & Close" silently threw the
  // change away with zero warning — the real stored value never changed.
  // This is very likely why "Automated RPS" looked enabled but never did
  // anything: the toggle's own checked state was staged-only until Save.
  // Fix: X/backdrop now ask the settings iframe to save (same as Save &
  // Close) before closing, so there is no way to lose a staged edit just by
  // closing the panel. Falls back to a plain close if the iframe was never
  // actually opened (nothing could be staged yet).
  function requestOverlayClose() {
    const iframe = document.getElementById('dt-settings-overlay-iframe');
    if (!iframe || !iframe.src) { closeSettingsOverlay(); return; }
    try {
      iframe.contentWindow.postMessage({ source: 'dt-unlock-overlay', type: 'DT_REQUEST_CLOSE' }, '*');
    } catch (e) {
      closeSettingsOverlay();
    }
  }

  function openSettingsOverlay() {
    const overlay = document.getElementById('dt-settings-overlay') || buildSettingsOverlay();
    const iframe = document.getElementById('dt-settings-overlay-iframe');
    // Lazy-load: the settings page only ever gets fetched the first time
    // you actually open the overlay, not on every DuelingBook page load.
    if (!iframe.src) iframe.src = chrome.runtime.getURL('dt-settings.html');
    overlay.style.display = 'flex';
  }

  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.data.source !== 'dt-settings-overlay') return;
    if (ev.data.type === 'DT_SETTINGS_CLOSE') closeSettingsOverlay();
  });

  // Small always-there tab so settings are reachable without a menu command
  // (Tampermonkey's menu command list isn't visible on every browser/setup).
  // The image is the user-supplied Kerem Duel Tools logo (the businessman
  // Pepe GIF), shipped as icons/dt-tab-logo.gif and declared in
  // manifest.json's web_accessible_resources so this page is actually
  // allowed to load it — chrome.runtime.getURL() is available here because
  // this file runs as a real (isolated-world) content script, not in the
  // page's own MAIN world.
  function buildTab() {
    const tab = document.createElement('div');
    tab.id = 'dt-unlock-tab';
    tab.title = 'Kerem Duel Tools settings';
    tab.style.cssText = [
      // Fixed top-right corner — matches the four-corner layout (Live
      // Tracker top-left, this tab top-right, Save-to-Duel-Tools
      // bottom-right, Advanced Replay Controls bottom-left).
      'position:fixed', 'top:20px', 'right:20px', 'z-index:2147483646',
      'background:#111', 'border:1px solid #333', 'border-radius:6px',
      'padding:4px', 'cursor:pointer', 'line-height:0',
      'box-shadow:-2px 2px 8px rgba(0,0,0,.4)'
    ].join(';');
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/dt-tab-logo.gif');
    img.alt = 'Kerem Duel Tools settings';
    img.style.cssText = 'display:block;width:32px;height:32px;border-radius:4px;';
    tab.appendChild(img);
    tab.onclick = openSettingsOverlay;
    document.body.appendChild(tab);
  }

  try { GM_registerMenuCommand('Duel Tools Unlock settings', toggleSettingsUI); } catch (e) {}

  setTimeout(function () {
    buildTab();
    runEnabledModules();
  }, 800);
})();
