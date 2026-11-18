// ==UserScript==
// @name         Duel Tools — Deck Folders
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  When "Enable Deck Folders" is on, adds extension-side folders for saving/organizing YDK decks in the deck constructor — separate storage from DuelingBook's own saved-deck list.
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  function getSetting(key, def) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : def; } catch (e) { return def; }
  }
  function setSetting(key, val) {
    try { if (typeof GM_setValue === 'function') GM_setValue(key, val); } catch (e) {}
  }

  // Read live on every open/render (not cached) — same reasoning as
  // dt-default-card-pool.user.js and dt-historical-text.user.js: this
  // script can sit injected on a tab for a while before the setting is
  // ever turned on, and should pick that up without needing a reload.
  function isEnabled() { return getSetting('dt_deck_folders_enabled', false); }

  const FOLDERS_KEY = 'dt_deck_folders'; // { [folderName]: { [deckName]: ydkText } }
  function getFolders() { return getSetting(FOLDERS_KEY, {}) || {}; }
  function saveFolders(folders) { setSetting(FOLDERS_KEY, folders); }

  // ── Reading the CURRENT deck straight off the real board ───────────────
  // Confirmed live (deck constructor, 2026-11-14): the Deck/Extra/Side
  // areas are `.deck_bg`/`.extra_bg`/`.side_bg`, each holding a
  // `[class*="_cards"]` container (`.deck_cards`/`.extra_cards`/
  // `.side_cards`) of `.cardfront_content` tiles, each with a
  // `.passcode_txt` span holding that card's real 8-digit passcode. This
  // reads the board directly rather than depending on DuelingBook's own
  // internal arrays, so it reflects whatever is actually on screen right
  // now, including a card you just dragged in.
  function collectPasscodes(bgSelector) {
    const bg = document.querySelector(bgSelector);
    if (!bg) return [];
    const cardsDiv = bg.querySelector('[class*="_cards"]');
    if (!cardsDiv) return [];
    return Array.from(cardsDiv.querySelectorAll('.cardfront_content .passcode_txt'))
      .map((p) => (p.textContent || '').trim())
      .filter(Boolean);
  }

  function buildYdkFromCurrentDeck() {
    const main = collectPasscodes('.deck_bg');
    const extra = collectPasscodes('.extra_bg');
    const side = collectPasscodes('.side_bg');
    return '#created by Duel Tools\n#main\n' + main.join('\n') +
      (main.length ? '\n' : '') + '#extra\n' + extra.join('\n') +
      (extra.length ? '\n' : '') + '!side\n' + side.join('\n') + (side.length ? '\n' : '');
  }

  // ── Loading a saved deck back in ────────────────────────────────────────
  // Confirmed live: DuelingBook's own "Import Deck" button is backed by a
  // real `<input type="file" id="upload_ydk_btn" accept=".ydk, .xml, .txt">`
  // — building a synthetic File and assigning it here (then firing the
  // same 'change' DuelingBook's own handler listens for) reuses
  // DuelingBook's own real YDK parser and deck-population logic exactly as
  // if you'd picked the file yourself, instead of reimplementing it.
  function loadYdkIntoConstructor(ydkText, filename) {
    const input = document.getElementById('upload_ydk_btn');
    if (!input) {
      console.warn('[Duel Tools] Deck Folders: #upload_ydk_btn not found — can\'t load (are you on the deck constructor?).');
      return false;
    }
    try {
      const file = new File([ydkText], filename || 'deck.ydk', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      console.warn('[Duel Tools] Deck Folders: failed to load deck:', e);
      return false;
    }
  }

  // ── Finding where to anchor the panel ───────────────────────────────────
  // Same exact-text-match approach already proven in
  // dt-replay-controls.user.js (findByExactText) — DuelingBook's own deck
  // constructor buttons are plain unstyled divs with no ids, so matching
  // by their visible label is the reliable way to find "Import Deck".
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

  function ensureStyles() {
    if (document.getElementById('dt-df-styles')) return;
    const style = document.createElement('style');
    style.id = 'dt-df-styles';
    style.textContent =
      '#dt-deck-folders select{width:100%;background:#15241c;color:#bfe8cf;border:1px solid #2f6b45;border-radius:5px;font-family:monospace;font-size:10px;padding:3px;margin-bottom:4px}' +
      '#dt-deck-folders button{background:#222;color:#9c9;border:1px solid #333;border-radius:4px;padding:3px 4px;cursor:pointer;font-family:monospace;font-size:10px}' +
      '#dt-deck-folders button:hover{background:#2a2a2a}' +
      '#dt-deck-folders input[type=text]{width:100%;box-sizing:border-box;background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:4px;padding:4px;font-family:monospace;font-size:11px;margin-bottom:4px}';
    document.head.appendChild(style);
  }

  let state = { folder: '', deck: '' };

  function render(panel) {
    const folders = getFolders();
    const folderNames = Object.keys(folders).sort();
    if (!folderNames.includes(state.folder)) state.folder = folderNames[0] || '';
    const decksInFolder = state.folder ? Object.keys(folders[state.folder] || {}).sort() : [];
    if (!decksInFolder.includes(state.deck)) state.deck = decksInFolder[0] || '';

    panel.innerHTML =
      '<div style="color:#666;margin-bottom:6px">Duel Tools — Deck Folders</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:2px">' +
        '<select id="dt-df-folder" style="flex:1">' +
          (folderNames.length ? folderNames.map((f) => '<option value="' + escAttr(f) + '"' + (f === state.folder ? ' selected' : '') + '>' + escHtml(f) + '</option>').join('') : '<option value="">(no folders yet)</option>') +
        '</select>' +
        '<button id="dt-df-new-folder" title="New folder">+</button>' +
        '<button id="dt-df-del-folder" title="Delete this folder" ' + (state.folder ? '' : 'disabled') + '>🗑</button>' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px">' +
        '<select id="dt-df-deck" style="flex:1" ' + (decksInFolder.length ? '' : 'disabled') + '>' +
          (decksInFolder.length ? decksInFolder.map((d) => '<option value="' + escAttr(d) + '"' + (d === state.deck ? ' selected' : '') + '>' + escHtml(d) + '</option>').join('') : '<option value="">(empty)</option>') +
        '</select>' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px">' +
        '<button id="dt-df-save" style="flex:1" ' + (state.folder ? '' : 'disabled') + ' title="Save the deck currently on screen into this folder">💾 Save Here</button>' +
        '<button id="dt-df-load" style="flex:1" ' + (state.deck ? '' : 'disabled') + ' title="Load this saved deck into the constructor">📂 Load</button>' +
        '<button id="dt-df-del-deck" ' + (state.deck ? '' : 'disabled') + ' title="Delete this saved deck">🗑</button>' +
      '</div>' +
      '<div id="dt-df-inline" style="display:none"></div>' +
      '<div id="dt-df-status" style="color:#666;font-size:10px"></div>';

    panel.querySelector('#dt-df-folder').onchange = (e) => { state.folder = e.target.value; state.deck = ''; render(panel); };
    panel.querySelector('#dt-df-deck').onchange = (e) => { state.deck = e.target.value; render(panel); };
    panel.querySelector('#dt-df-new-folder').onclick = () => promptInline(panel, 'New folder name', '', (name) => {
      if (!name) return;
      const f = getFolders();
      if (!f[name]) f[name] = {};
      saveFolders(f);
      state.folder = name;
      state.deck = '';
      render(panel);
    });
    panel.querySelector('#dt-df-del-folder').onclick = () => {
      if (!state.folder) return;
      if (!window.confirm('Delete the folder "' + state.folder + '" and every deck saved in it?')) return;
      const f = getFolders();
      delete f[state.folder];
      saveFolders(f);
      state.folder = '';
      state.deck = '';
      render(panel);
    };
    panel.querySelector('#dt-df-save').onclick = () => promptInline(panel, 'Save as', state.deck || '', (name) => {
      if (!name || !state.folder) return;
      const f = getFolders();
      if (!f[state.folder]) f[state.folder] = {};
      f[state.folder][name] = buildYdkFromCurrentDeck();
      saveFolders(f);
      state.deck = name;
      setStatus(panel, 'Saved "' + name + '" to ' + state.folder + '.');
      render(panel);
    });
    panel.querySelector('#dt-df-load').onclick = () => {
      if (!state.folder || !state.deck) return;
      const f = getFolders();
      const ydk = f[state.folder] && f[state.folder][state.deck];
      if (!ydk) { setStatus(panel, 'Could not find that saved deck.'); return; }
      const ok = loadYdkIntoConstructor(ydk, state.deck + '.ydk');
      setStatus(panel, ok ? 'Loaded "' + state.deck + '".' : 'Load failed — see console.');
    };
    panel.querySelector('#dt-df-del-deck').onclick = () => {
      if (!state.folder || !state.deck) return;
      if (!window.confirm('Delete the saved deck "' + state.deck + '"?')) return;
      const f = getFolders();
      if (f[state.folder]) delete f[state.folder][state.deck];
      saveFolders(f);
      state.deck = '';
      render(panel);
    };
  }

  function setStatus(panel, text) {
    const el = panel.querySelector('#dt-df-status');
    if (el) el.textContent = text;
  }

  // Small inline name-entry row, reused for both "New Folder" and "Save
  // As" — matches the rest of this project's own styled boxes rather than
  // a native prompt(), which would look and feel out of place next to
  // every other Duel Tools panel.
  function promptInline(panel, label, initial, cb) {
    const box = panel.querySelector('#dt-df-inline');
    box.style.display = 'block';
    box.innerHTML =
      '<div style="color:#666;font-size:10px;margin-bottom:2px">' + escHtml(label) + '</div>' +
      '<input type="text" id="dt-df-inline-input" value="' + escAttr(initial) + '"/>' +
      '<div style="display:flex;gap:4px">' +
        '<button id="dt-df-inline-ok" style="flex:1">OK</button>' +
        '<button id="dt-df-inline-cancel" style="flex:1">Cancel</button>' +
      '</div>';
    const input = box.querySelector('#dt-df-inline-input');
    input.focus();
    input.select();
    function finish(val) {
      box.style.display = 'none';
      box.innerHTML = '';
      if (val !== null) cb(val);
    }
    box.querySelector('#dt-df-inline-ok').onclick = () => finish(input.value.trim() || null);
    box.querySelector('#dt-df-inline-cancel').onclick = () => finish(null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value.trim() || null);
      if (e.key === 'Escape') finish(null);
    });
  }

  function escHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

  // "Import Deck" is confirmed to stay mounted in the DOM (DuelingBook is a
  // single-page app that never fully tears the deck constructor down), it
  // just goes display:none on an ancestor once you leave it — so DOM
  // presence alone (the old check) can't tell "on deck constructor" apart
  // from "was on it earlier this tab session". offsetParent is null for
  // anything display:none (and anything detached), so this is what actually
  // distinguishes the two.
  function isOnDeckConstructor() {
    const btn = findByExactText('Import Deck');
    return !!(btn && btn.offsetParent !== null);
  }

  function buildPanel() {
    if (document.getElementById('dt-deck-folders')) return;
    if (!isOnDeckConstructor()) { setTimeout(buildPanel, 500); return; }
    ensureStyles();

    const panel = document.createElement('div');
    panel.id = 'dt-deck-folders';
    // v1.1: anchoring above "Import Deck" put this panel on top of
    // DuelingBook's own card description text box (confirmed live, by
    // screenshot) — that box's own height varies with the card being
    // previewed, so there was no reliable gap above the button to sit in.
    // Per the user's own screenshot, the real open space on this page is
    // the empty area at the bottom-left of the Live Tracker's column — a
    // flat fixed corner, same as every other Duel Tools panel (Live
    // Tracker top-left, Settings gear top-right, Save prompt bottom-right,
    // Advanced Replay Controls bottom-left on /replay*). This panel only
    // ever shows on the deck constructor, which is never a /replay* page,
    // so reusing bottom-left here never collides with Replay Controls.
    // Pinned tight to the corner (4px, matching Live Tracker's own 4px
    // top-left) per the user's explicit correction — the earlier 20px
    // gap (copied from Replay Controls) read as floating, not anchored.
    panel.style.cssText = [
      'position:fixed', 'left:4px', 'bottom:4px', 'z-index:2147483000',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:11px', 'padding:8px', 'width:220px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)'
    ].join(';');
    document.body.appendChild(panel);
    render(panel);
  }

  // Confirmed live: this panel was staying visible during an actual live
  // duel after being built once in the deck constructor earlier in the same
  // tab — buildPanel() only ever ran once, with nothing afterward to notice
  // you'd left. Same fix shape as Default Card Pool's enforcement poll:
  // don't chase exactly when DuelingBook shows/hides the constructor, just
  // check on an interval and match the panel's visibility to it. Toggling
  // display (not removing/rebuilding) keeps whatever folder/deck is
  // currently selected in the dropdowns intact across a round trip.
  setInterval(function () {
    const panel = document.getElementById('dt-deck-folders');
    if (!panel) return;
    panel.style.display = isOnDeckConstructor() ? 'block' : 'none';
  }, 800);

  if (!isEnabled()) {
    // Still watch for the setting turning on, same as the other two Deck
    // Building scripts — no reload needed to start using this once enabled.
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.dt_deck_folders_enabled && changes.dt_deck_folders_enabled.newValue) {
          buildPanel();
        }
      });
    }
  } else {
    buildPanel();
  }
})();
