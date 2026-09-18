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
    }
  };

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
      const enabled = getSetting('dt_unlock_' + key, false);
      if (!enabled) return;
      const mod = MODULES[key];
      try {
        mod.init({ log: function (msg) { log(key, msg); } });
      } catch (e) {
        log(key, 'FAILED to init: ' + e.message);
      }
    });
  }

  // ── Settings panel — small floating toggle box, each module independent ──
  function buildSettingsUI() {
    if (document.getElementById('dt-unlock-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'dt-unlock-panel';
    panel.style.cssText = [
      'position:fixed', 'top:20px', 'right:20px', 'z-index:2147483647',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:12px', 'width:270px', 'padding:12px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)', 'display:none'
    ].join(';');

    let rows = '';
    Object.keys(MODULES).forEach(function (key) {
      const mod = MODULES[key];
      const checked = getSetting('dt_unlock_' + key, false) ? 'checked' : '';
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

  // Small always-there tab so the panel is reachable without a menu command
  // (Tampermonkey's menu command list isn't visible on every browser/setup).
  function buildTab() {
    const tab = document.createElement('div');
    tab.id = 'dt-unlock-tab';
    tab.textContent = '⚙️';
    tab.title = 'Duel Tools Unlock settings';
    tab.style.cssText = [
      'position:fixed', 'top:20px', 'right:0', 'z-index:2147483646',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-right:none',
      'border-radius:6px 0 0 6px', 'padding:6px 8px', 'cursor:pointer', 'font-size:14px',
      'box-shadow:-2px 2px 8px rgba(0,0,0,.4)'
    ].join(';');
    tab.onclick = toggleSettingsUI;
    document.body.appendChild(tab);
  }

  try { GM_registerMenuCommand('Duel Tools Unlock settings', toggleSettingsUI); } catch (e) {}

  setTimeout(function () {
    buildTab();
    runEnabledModules();
  }, 800);
})();
