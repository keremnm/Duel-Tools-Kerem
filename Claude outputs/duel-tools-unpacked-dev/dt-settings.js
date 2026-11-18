// Kerem Duel Tools — Extension Settings page logic.
//
// This is the extension's options page (opened full-tab via
// chrome.runtime.openOptionsPage(), from either the toolbar popup or the
// on-page gear tab — see dt-popup.js and the gear tab's click handler in
// dt-unlock.user.js). It talks to chrome.storage.local DIRECTLY (no GM_*
// shim needed here — that shim exists only for the content scripts injected
// into duelingbook.com, which can't reach chrome.storage on their own; this
// page IS extension-privileged code, so it has chrome.storage natively).
//
// Data model: CATEGORIES is the single source of truth for the whole
// Overview → category → feature navigation tree. Adding a new category or
// feature later (as more get spec'd out) means adding an entry here and a
// render function — nothing else in this file needs to change.
(function () {
  'use strict';

  const STORAGE = chrome.storage.local;

  // ── Staged save model ────────────────────────────────────────────────────
  // Settings UI overhaul, per spec: edits made anywhere on this page no
  // longer write straight to chrome.storage.local the instant you flip a
  // toggle. They're held here, in-memory, until Save or Save & Close is
  // clicked — closing the tab without saving discards them, since they
  // never touched real storage. getSettings() overlays any pending edit on
  // top of the real stored value, so every panel you open (including one
  // you already edited and navigated away from) reflects the staged state
  // consistently, not just the last-rendered one.
  //
  // ALL_DEFAULTS is the master key→default map used by "Reset Everything"
  // (below). Every feature's own defaults constant gets folded into it
  // right after it's defined (HOTKEYS_DEFAULT_SETTINGS, CARD_TRACKING_
  // DEFAULTS, etc.), and renderSimpleToggleFeature folds its (storageKey,
  // defaultOn) pair in automatically the moment it's called — which, for
  // every `render: renderSimpleToggleFeature(...)` entry in CATEGORIES
  // below, is immediately, as this file loads (CATEGORIES is one big array
  // literal, evaluated top-to-bottom), so this stays complete with zero
  // manual upkeep as long as new simple-toggle features keep going through
  // that same factory.
  const ALL_DEFAULTS = {};
  let pendingChanges = {};

  function getSettings(defaultsObj, cb) {
    STORAGE.get(defaultsObj, (stored) => {
      const merged = Object.assign({}, stored);
      Object.keys(defaultsObj).forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(pendingChanges, k)) merged[k] = pendingChanges[k];
      });
      cb(merged);
    });
  }
  function setSetting(obj) {
    Object.assign(pendingChanges, obj);
    markDirty();
  }

  function isDirty() { return Object.keys(pendingChanges).length > 0; }
  function markDirty() {
    const bar = document.getElementById('dt-footer-status');
    if (bar) bar.textContent = isDirty() ? 'Unsaved changes' : '';
  }
  // Writes every staged edit to real storage in one batch, per spec's
  // "only apply on Save" model. `cb` runs after the write actually lands
  // (chrome.storage.local.set's own callback), not just after this
  // function returns — Save & Close relies on that to never close the tab
  // before the write is confirmed.
  function flushPending(cb) {
    if (!isDirty()) { if (cb) cb(); return; }
    const toWrite = pendingChanges;
    STORAGE.set(toWrite, () => {
      pendingChanges = {};
      markDirty();
      if (cb) cb();
    });
  }

  // ── Theme ────────────────────────────────────────────────────────────────
  // Dark is the default (per spec: "default dark mode but offer a light
  // mode") — matching the real Duel Tools website's own default look, not
  // the OS theme, so it stays consistent regardless of the user's system
  // setting.
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
    document.getElementById('dt-theme-label').textContent = theme === 'light' ? 'Light mode' : 'Dark mode';
  }
  // Staged like everything else on this page (per spec) — picking a theme
  // still re-paints the page immediately via applyTheme() below, it just
  // doesn't persist to storage until Save/Save & Close is clicked.
  ALL_DEFAULTS.dt_theme = 'dark';
  getSettings({ dt_theme: 'dark' }, (s) => applyTheme(s.dt_theme));
  document.getElementById('dt-theme-toggle').addEventListener('click', () => {
    getSettings({ dt_theme: 'dark' }, (s) => {
      const next = s.dt_theme === 'light' ? 'dark' : 'light';
      setSetting({ dt_theme: next });
      applyTheme(next);
    });
  });

  // ── Key-capture helper — shared by every feature with rebindable keys ───
  // Click a .dt-keycap, then press any key; Escape cancels without changing
  // anything. Normalizes to the same key-name space used for storage/default
  // maps (single letters uppercased, or one of the named keys below).
  function labelForKey(key) {
    if (!key) return '—'; // cleared/unbound
    const NAMES = {
      ' ': 'Space', 'Space': 'Space', 'ArrowUp': '↑', 'ArrowDown': '↓',
      'ArrowLeft': '←', 'ArrowRight': '→'
    };
    if (NAMES[key]) return NAMES[key];
    if (key.length === 1) return key.toUpperCase();
    return key;
  }
  function beginKeyCapture(capEl, onCaptured) {
    capEl.classList.add('listening');
    const prevLabel = capEl.textContent;
    capEl.textContent = '…';
    function cleanup() {
      capEl.classList.remove('listening');
      window.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { capEl.textContent = prevLabel; cleanup(); return; }
      // Normalize single letters to uppercase at capture time (e.key is
      // case-sensitive — an unshifted "w" keypress is e.key "w", not "W")
      // so what gets STORED always matches what labelForKey() DISPLAYS, and
      // matches dt-hotkeys.user.js's own normalized comparison. See the
      // comment above eventKey() in dt-hotkeys.user.js for the bug this
      // fixes (WASD silently never matching while Arrows/Space, which
      // aren't case-sensitive, worked fine).
      const raw = e.code === 'Space' ? 'Space' : e.key;
      const key = raw.length === 1 ? raw.toUpperCase() : raw;
      cleanup();
      onCaptured(key);
    }
    window.addEventListener('keydown', onKey, true);
  }

  // ── Hot Keys feature (Playing category) ──────────────────────────────────
  const HOTKEY_ACTIONS = [
    {
      id: 'thinking', label: 'Thinking',
      detail: 'Clicks the Thinking button without needing to move the mouse.',
      defaultOn: true
    },
    {
      id: 'prevPhase', label: 'Previous Phase',
      detail: 'Clicks Previous Phase, aware of the current phase (DP → SP → M1 → BP → M2 → EP) and moves backward one step.',
      defaultOn: false
    },
    {
      id: 'nextPhase', label: 'Next Phase',
      detail: 'Clicks Next Phase, aware of the current phase (DP → SP → M1 → BP → M2 → EP) and moves forward one step.',
      defaultOn: false
    },
    {
      id: 'thumbsUp', label: 'Thumbs Up',
      detail: 'Clicks the thumbs up / okay button without needing to move the mouse.',
      defaultOn: true
    },
    {
      id: 'endTurn', label: 'End/Start Turn',
      detail: 'Clicks the End Turn button.',
      defaultOn: false
    }
  ];
  // Corrected per the user's reference screenshot of the target Hot Keys
  // panel (W=Thinking, A=Previous Phase, D=Next Phase, Space=Thumbs Up,
  // S=End/Start Turn) — the three non-phase keys were rotated wrong in an
  // earlier version of this file (thinking/thumbsUp/endTurn each had one
  // of the OTHER two actions' keys). Arrow scheme rotated the same way, to
  // match: Up=Thinking, Down=End/Start Turn (mirroring W/S's up/down
  // feel), Space=Thumbs Up, Left/Right unchanged for Previous/Next Phase.
  const SCHEME_DEFAULTS = {
    wasd:   { thinking: 'W', prevPhase: 'A', nextPhase: 'D', thumbsUp: 'Space', endTurn: 'S' },
    arrows: { thinking: 'ArrowUp', prevPhase: 'ArrowLeft', nextPhase: 'ArrowRight', thumbsUp: 'Space', endTurn: 'ArrowDown' }
  };
  const HOTKEYS_DEFAULT_SETTINGS = {
    dt_hotkeys_enabled: true, // master toggle — defaults on so Thinking/Thumbs
                               // Up (the two per-action defaults the spec
                               // calls out as on) actually do something out
                               // of the box; the spec didn't say explicitly,
                               // this is the one inferred default here.
    dt_hotkeys_scheme: 'wasd',
    dt_hotkeys_keys: SCHEME_DEFAULTS.wasd,
    dt_hotkeys_action_enabled: { thinking: true, prevPhase: false, nextPhase: false, thumbsUp: true, endTurn: false }
  };
  Object.assign(ALL_DEFAULTS, HOTKEYS_DEFAULT_SETTINGS);

  function renderHotkeysFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Hot Keys</b><div class="dt-row-detail">Master switch for every key below. Only applies on duelingbook.com — not on /replay pages.</div></div>' +
        switchHtml('hk-master') +
      '</div>' +
      '<div style="margin-top:14px;font-size:11px;color:var(--muted)">Key scheme</div>' +
      '<div class="dt-radio-group" id="hk-scheme-group">' +
        '<label class="dt-radio-pill" id="hk-scheme-wasd"><input type="radio" name="hk-scheme" value="wasd"/> WASD</label>' +
        '<label class="dt-radio-pill" id="hk-scheme-arrows"><input type="radio" name="hk-scheme" value="arrows"/> Arrow Keys</label>' +
      '</div>' +
      '<div class="dt-keymap-table" id="hk-keymap"></div>' +
      '<div class="dt-note">Hot keys are ignored while you\'re typing in chat or any text field, so they never interfere with typing.</div>' +
      '<div class="dt-note warn">Previous/Next Phase click DuelingBook\'s own live-duel phase controls — not yet verified against a real live match in this build; flag it if the targeting is off and it\'ll get corrected.</div>';

    const masterInput = container.querySelector('#hk-master input');
    const keymapEl = container.querySelector('#hk-keymap');

    function renderKeymap(keys, actionEnabled) {
      keymapEl.innerHTML = HOTKEY_ACTIONS.map((a) =>
        '<div class="dt-keymap-row">' +
          '<div class="dt-keymap-info">' +
            '<div class="dt-keymap-name">' + a.label + '</div>' +
            '<div class="dt-keymap-desc">' + a.detail + '</div>' +
          '</div>' +
          switchHtml('hk-act-' + a.id, actionEnabled[a.id]) +
          '<div class="dt-keycap" id="hk-key-' + a.id + '" data-action="' + a.id + '">' + labelForKey(keys[a.id]) + '</div>' +
          '<button type="button" class="dt-keycap-clear" id="hk-clear-' + a.id + '">Clear</button>' +
        '</div>'
      ).join('');

      HOTKEY_ACTIONS.forEach((a) => {
        container.querySelector('#hk-act-' + a.id + ' input').addEventListener('change', (e) => {
          getSettings({ dt_hotkeys_action_enabled: HOTKEYS_DEFAULT_SETTINGS.dt_hotkeys_action_enabled }, (s) => {
            const next = Object.assign({}, s.dt_hotkeys_action_enabled, { [a.id]: e.target.checked });
            setSetting({ dt_hotkeys_action_enabled: next });
          });
        });
        const capEl = container.querySelector('#hk-key-' + a.id);
        capEl.addEventListener('click', () => {
          beginKeyCapture(capEl, (key) => {
            capEl.textContent = labelForKey(key);
            getSettings({ dt_hotkeys_keys: SCHEME_DEFAULTS.wasd }, (s) => {
              const next = Object.assign({}, s.dt_hotkeys_keys, { [a.id]: key });
              setSetting({ dt_hotkeys_keys: next });
            });
          });
        });
        // Clear — unbinds this one action's key (set to null) without
        // touching the other 4, per the reference screenshot's per-row
        // Clear button. A cleared action's switch can stay on; it just has
        // no key that triggers it until re-bound by clicking the keycap.
        container.querySelector('#hk-clear-' + a.id).addEventListener('click', () => {
          capEl.textContent = labelForKey(null);
          getSettings({ dt_hotkeys_keys: SCHEME_DEFAULTS.wasd }, (s) => {
            const next = Object.assign({}, s.dt_hotkeys_keys, { [a.id]: null });
            setSetting({ dt_hotkeys_keys: next });
          });
        });
      });
    }

    getSettings(HOTKEYS_DEFAULT_SETTINGS, (s) => {
      masterInput.checked = !!s.dt_hotkeys_enabled;
      container.querySelector('#hk-scheme-' + s.dt_hotkeys_scheme).classList.add('selected');
      container.querySelector('#hk-scheme-' + s.dt_hotkeys_scheme + ' input').checked = true;
      renderKeymap(s.dt_hotkeys_keys, s.dt_hotkeys_action_enabled);
    });

    masterInput.addEventListener('change', (e) => setSetting({ dt_hotkeys_enabled: e.target.checked }));

    container.querySelectorAll('input[name="hk-scheme"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const scheme = radio.value;
        container.querySelectorAll('.dt-radio-pill').forEach((p) => p.classList.remove('selected'));
        radio.closest('.dt-radio-pill').classList.add('selected');
        // Switching the layout resets all 5 keys to that layout's defaults
        // (simplest, most predictable behavior — a custom rebind under the
        // OLD scheme wouldn't make sense carried over to the new one).
        const defaults = SCHEME_DEFAULTS[scheme];
        setSetting({ dt_hotkeys_scheme: scheme, dt_hotkeys_keys: defaults });
        getSettings({ dt_hotkeys_action_enabled: HOTKEYS_DEFAULT_SETTINGS.dt_hotkeys_action_enabled }, (s) => {
          renderKeymap(defaults, s.dt_hotkeys_action_enabled);
        });
      });
    });
  }

  // ── Choose Zones feature (Playing category) ─────────────────────────────
  // Master toggle decides whether Duel Tools touches DuelingBook's own
  // "Choose Zones" checkbox at all; the On/Off pills below it decide WHICH
  // state it gets set to at the start of each duel, once the master is on.
  // Both default off, per spec ("by default it should be turned off").
  const CHOOSE_ZONES_DEFAULTS = {
    dt_choose_zones_enabled: false,
    dt_choose_zones_default_state: false // false = Off, true = On
  };
  Object.assign(ALL_DEFAULTS, CHOOSE_ZONES_DEFAULTS);
  function renderChooseZonesFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Choose Zones</b><div class="dt-row-detail">Sets DuelingBook\'s own "Choose Zones" checkbox (next to Quit, in the player action row) to the state below at the start of each duel, so you don\'t have to click it yourself every time.</div></div>' +
        switchHtml('cz-master') +
      '</div>' +
      '<div style="margin-top:14px;font-size:11px;color:var(--muted)">Default state each duel</div>' +
      '<div class="dt-radio-group" id="cz-state-group">' +
        '<label class="dt-radio-pill" id="cz-state-on"><input type="radio" name="cz-state" value="on"/> On</label>' +
        '<label class="dt-radio-pill" id="cz-state-off"><input type="radio" name="cz-state" value="off"/> Off</label>' +
      '</div>' +
      '<div class="dt-note">Only sets the INITIAL state for each new duel — if you flip it yourself mid-duel, Duel Tools leaves it alone until the next duel starts.</div>';

    const masterInput = container.querySelector('#cz-master input');

    getSettings(CHOOSE_ZONES_DEFAULTS, (s) => {
      masterInput.checked = !!s.dt_choose_zones_enabled;
      const sel = s.dt_choose_zones_default_state ? 'cz-state-on' : 'cz-state-off';
      container.querySelector('#' + sel).classList.add('selected');
      container.querySelector('#' + sel + ' input').checked = true;
    });

    masterInput.addEventListener('change', (e) => setSetting({ dt_choose_zones_enabled: e.target.checked }));

    container.querySelectorAll('input[name="cz-state"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        container.querySelectorAll('#cz-state-group .dt-radio-pill').forEach((p) => p.classList.remove('selected'));
        radio.closest('.dt-radio-pill').classList.add('selected');
        setSetting({ dt_choose_zones_default_state: radio.value === 'on' });
      });
    });
  }

  // ── RPS Automation (Playing category) ───────────────────────────────────
  // Two fully independent toggles, both off by default, per the user's own
  // spec. Automated RPS silently auto-picks and clicks a random Rock/
  // Paper/Scissors for you the instant a round appears. Roll for RPS adds
  // a button that suggests a random pick (highlighting that real card) —
  // you still have to click a card yourself, the suggested one or any
  // other. If Automated RPS is on, it takes priority each round (nothing
  // left to manually click on, so Roll for RPS's button doesn't show even
  // if that toggle is also on). Both only ever appear while an actual RPS
  // round is on screen, and DuelingBook's own replay-on-a-draw behavior is
  // handled automatically — see dt-rps-automation.user.js's header for the
  // confirmed DOM/mechanics.
  const RPS_AUTOMATION_DEFAULTS = {
    dt_rps_auto_enabled: false,
    dt_rps_roll_enabled: false
  };
  Object.assign(ALL_DEFAULTS, RPS_AUTOMATION_DEFAULTS);
  function renderRpsAutomationFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Automated RPS</b><div class="dt-row-detail">Randomly picks and clicks Rock/Paper/Scissors for you the instant a round appears — fully automatic, no manual click needed.</div></div>' +
        switchHtml('rps-auto') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Roll for RPS</b><div class="dt-row-detail">Adds a "Roll for RPS" button that highlights a random suggestion — click it to use that pick, or click a different card yourself. Ignored while Automated RPS is on.</div></div>' +
        switchHtml('rps-roll') +
      '</div>' +
      '<div class="dt-note">Both only show up while an actual RPS round is on screen. If a round ends in a draw, DuelingBook replays it on its own — this applies fresh to that next round too.</div>';

    const autoInput = container.querySelector('#rps-auto input');
    const rollInput = container.querySelector('#rps-roll input');
    getSettings(RPS_AUTOMATION_DEFAULTS, (s) => {
      autoInput.checked = !!s.dt_rps_auto_enabled;
      rollInput.checked = !!s.dt_rps_roll_enabled;
    });
    autoInput.addEventListener('change', (e) => setSetting({ dt_rps_auto_enabled: e.target.checked }));
    rollInput.addEventListener('change', (e) => setSetting({ dt_rps_roll_enabled: e.target.checked }));
  }

  function switchHtml(id, checked) {
    return '<label class="dt-switch" id="' + id + '">' +
      '<input type="checkbox" ' + (checked ? 'checked' : '') + '/>' +
      '<span class="dt-switch-track"><span class="dt-switch-thumb"></span></span>' +
    '</label>';
  }

  // ── Generic single-toggle feature — Duel Commands and Live Tracker Tool
  // are both just one on/off switch, per spec, so this one function renders
  // either instead of duplicating the same markup/wiring twice.
  //
  // Also where every such feature's default gets folded into ALL_DEFAULTS
  // for Reset Everything — this factory call itself runs immediately, as
  // CATEGORIES (a plain array literal, evaluated once as the file loads)
  // builds each `render: renderSimpleToggleFeature(...)` entry, so this
  // registration happens automatically with no separate list to maintain.
  function renderSimpleToggleFeature(storageKey, defaultOn, label, detail, note) {
    ALL_DEFAULTS[storageKey] = defaultOn;
    return function (container) {
      container.innerHTML =
        '<div class="dt-row">' +
          '<div class="dt-row-label"><b>' + label + '</b><div class="dt-row-detail">' + detail + '</div></div>' +
          switchHtml('st-' + storageKey) +
        '</div>' +
        (note ? '<div class="dt-note">' + note + '</div>' : '');
      const input = container.querySelector('#st-' + storageKey + ' input');
      getSettings({ [storageKey]: defaultOn }, (s) => { input.checked = !!s[storageKey]; });
      input.addEventListener('change', (e) => setSetting({ [storageKey]: e.target.checked }));
    };
  }

  // ── Card Tracking feature (Playing category) ────────────────────────────
  const CARD_TRACKING_DEFAULTS = {
    dt_card_tracking_enabled: false, // off by default, per spec
    dt_card_tracking_track_added: true,
    dt_card_tracking_track_revealed: true,
    // Shared with dt-live-tracker.user.js (same storage key, same purpose —
    // "which username in the duel log is actually me"). Both features read
    // it with their own safeGetValue/GM_getValue call; setting it here (or
    // from Live Tracker's own one-time setup prompt) updates it for both,
    // since chrome.storage.local is the same backing store either way.
    // Without a correct value, Card Tracking falls back to a "first
    // prefixed username seen = opponent" guess — confirmed broken once the
    // Usernames log checkbox is on for both players (Live Tracker forces it
    // on), since the account owner's own lines are prefixed too and the
    // guess can lock onto the wrong one, showing the player's own hand in
    // the opponent slot and silently dropping the real opponent's lines.
    dt_tracker_my_username: ''
  };
  Object.assign(ALL_DEFAULTS, CARD_TRACKING_DEFAULTS);
  function renderCardTrackingFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Card Tracking</b><div class="dt-row-detail">Shows card art for every opponent card currently known to be in their hand, in unused screen space.</div></div>' +
        switchHtml('ct-master') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label">Your DuelingBook username<div class="dt-row-detail">Lets Card Tracking tell your own duel-log lines apart from your opponent\'s. Shared with Live Tracker — set it once here and both features use it.</div></div>' +
        '<input type="text" class="dt-hds-text" id="ct-my-username" placeholder="e.g. KereMnM" style="width:160px">' +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label">Track cards added to hand<div class="dt-row-detail">Marked with a <b>+</b> icon.</div></div>' +
        switchHtml('ct-added') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label">Track revealed hand cards<div class="dt-row-detail">Marked with an <b>eye</b> icon.</div></div>' +
        switchHtml('ct-revealed') +
      '</div>' +
      '<div class="dt-note">A tracked card disappears the moment it becomes public information again or leaves their hand: returned to deck, banished, sent to Graveyard, Normal Summoned, Special Summoned, or Activated.</div>' +
      '<div class="dt-note warn">If your username above is blank or wrong, this feature can misattribute lines — fill it in if cards ever show up in the wrong place.</div>';

    const master = container.querySelector('#ct-master input');
    const myUsernameInput = container.querySelector('#ct-my-username');
    const added = container.querySelector('#ct-added input');
    const revealed = container.querySelector('#ct-revealed input');

    getSettings(CARD_TRACKING_DEFAULTS, (s) => {
      master.checked = !!s.dt_card_tracking_enabled;
      myUsernameInput.value = s.dt_tracker_my_username || '';
      added.checked = !!s.dt_card_tracking_track_added;
      revealed.checked = !!s.dt_card_tracking_track_revealed;
    });
    master.addEventListener('change', (e) => setSetting({ dt_card_tracking_enabled: e.target.checked }));
    myUsernameInput.addEventListener('change', (e) => setSetting({ dt_tracker_my_username: e.target.value.trim() }));
    added.addEventListener('change', (e) => setSetting({ dt_card_tracking_track_added: e.target.checked }));
    revealed.addEventListener('change', (e) => setSetting({ dt_card_tracking_track_revealed: e.target.checked }));
  }

  // ── Auto Hand Shuffling (Playing category) ──────────────────────────────
  // SP Shuffle / M1 Shuffle / M2 Shuffle only fire on the player's OWN turn
  // reaching that phase (never the opponent's), per the user's explicit
  // call — the actual turn check happens in dt-hand-shuffle-engine.js (MAIN
  // world, the only place window.turn_player is visible); this page just
  // stores the three sub-toggles. An original 4th trigger, "Add Card to
  // Hand", was dropped per the user's own correction — DuelingBook already
  // has a native "Auto-Shuffle" checkbox (#auto_shuffle_cb, confirmed live,
  // checked by default) that covers that case on its own.
  const AUTO_HAND_SHUFFLE_DEFAULTS = {
    dt_auto_hand_shuffle_enabled: false, // off by default, per spec
    dt_auto_hand_shuffle_sp: true,
    dt_auto_hand_shuffle_m1: true,
    dt_auto_hand_shuffle_m2: true
  };
  Object.assign(ALL_DEFAULTS, AUTO_HAND_SHUFFLE_DEFAULTS);
  function renderAutoHandShuffleFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Auto Hand Shuffling</b><div class="dt-row-detail">Automatically re-shuffles the visual order of cards in your own hand (DuelingBook’s own "Shuffle" action, same as clicking the dice icon yourself), on whichever of the triggers below are on.</div></div>' +
        switchHtml('ahs-master') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label">SP Shuffle<div class="dt-row-detail">Shuffles the instant YOUR OWN turn reaches Standby Phase.</div></div>' +
        switchHtml('ahs-sp') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label">M1 Shuffle<div class="dt-row-detail">Shuffles the instant YOUR OWN turn reaches Main Phase 1.</div></div>' +
        switchHtml('ahs-m1') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label">M2 Shuffle<div class="dt-row-detail">Shuffles the instant YOUR OWN turn reaches Main Phase 2.</div></div>' +
        switchHtml('ahs-m2') +
      '</div>' +
      '<div class="dt-note">Each trigger is independent — turn any combination on or off. Never shuffles on a replay or while spectating. DuelingBook’s own built-in "Auto-Shuffle" (on by default) already reshuffles after a card is added to hand, so this extension doesn’t duplicate that.</div>';

    const master = container.querySelector('#ahs-master input');
    const sp = container.querySelector('#ahs-sp input');
    const m1 = container.querySelector('#ahs-m1 input');
    const m2 = container.querySelector('#ahs-m2 input');

    getSettings(AUTO_HAND_SHUFFLE_DEFAULTS, (s) => {
      master.checked = !!s.dt_auto_hand_shuffle_enabled;
      sp.checked = !!s.dt_auto_hand_shuffle_sp;
      m1.checked = !!s.dt_auto_hand_shuffle_m1;
      m2.checked = !!s.dt_auto_hand_shuffle_m2;
    });
    master.addEventListener('change', (e) => setSetting({ dt_auto_hand_shuffle_enabled: e.target.checked }));
    sp.addEventListener('change', (e) => setSetting({ dt_auto_hand_shuffle_sp: e.target.checked }));
    m1.addEventListener('change', (e) => setSetting({ dt_auto_hand_shuffle_m1: e.target.checked }));
    m2.addEventListener('change', (e) => setSetting({ dt_auto_hand_shuffle_m2: e.target.checked }));
  }

  // ── Transparent Facedowns (Playing category) ────────────────────────────
  // Two independent toggles sharing one opacity slider, per the user's own
  // spec: your own set cards are always safe to reveal (you already know
  // them); an opponent's card only reveals once you've legitimately seen
  // it face-up this duel, and that memory is forgotten the instant it
  // leaves the field — see dt-transparent-facedowns-engine.js's header for
  // the full mechanics. Off by default for both; opacity defaults to 60%
  // ("see-through" reading: higher = more of the real card shows through
  // the sleeve, 100% = fully revealed, 0% = normal facedown look).
  const TRANSPARENT_FACEDOWNS_DEFAULTS = {
    dt_transparent_own_enabled: false,
    dt_transparent_opp_enabled: false,
    dt_transparent_opacity: 60
  };
  Object.assign(ALL_DEFAULTS, TRANSPARENT_FACEDOWNS_DEFAULTS);
  function renderTransparentFacedownsFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Transparent Own Facedowns</b><div class="dt-row-detail">See through your own set monsters/spells/traps.</div></div>' +
        switchHtml('tf-own') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Reveal Known Opponent Facedowns</b><div class="dt-row-detail">If you saw an opponent\'s card face-up this duel and it goes face-down again, keep showing it — forgotten the instant it leaves the field (graveyard, hand, banished, deck).</div></div>' +
        switchHtml('tf-opp') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>See-through amount</b><div class="dt-row-detail">How much of the real card shows through the sleeve.</div></div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input id="tf-opacity" type="range" min="0" max="100" step="5" style="width:120px">' +
          '<span id="tf-opacity-val" style="min-width:34px;text-align:right;font-family:monospace;font-size:12px;color:#9aa">60%</span>' +
        '</div>' +
      '</div>' +
      '<div class="dt-note warn">Shown card data is already present in DuelingBook\'s own page for every facedown card, known or not — this feature deliberately never reveals an opponent\'s card unless you saw it face-up yourself; flag it if that ever seems wrong.</div>';

    const ownInput = container.querySelector('#tf-own input');
    const oppInput = container.querySelector('#tf-opp input');
    const opacityInput = container.querySelector('#tf-opacity');
    const opacityVal = container.querySelector('#tf-opacity-val');

    getSettings(TRANSPARENT_FACEDOWNS_DEFAULTS, (s) => {
      ownInput.checked = !!s.dt_transparent_own_enabled;
      oppInput.checked = !!s.dt_transparent_opp_enabled;
      opacityInput.value = s.dt_transparent_opacity;
      opacityVal.textContent = s.dt_transparent_opacity + '%';
    });
    ownInput.addEventListener('change', (e) => setSetting({ dt_transparent_own_enabled: e.target.checked }));
    oppInput.addEventListener('change', (e) => setSetting({ dt_transparent_opp_enabled: e.target.checked }));
    opacityInput.addEventListener('input', (e) => { opacityVal.textContent = e.target.value + '%'; });
    opacityInput.addEventListener('change', (e) => setSetting({ dt_transparent_opacity: Number(e.target.value) }));
  }

  // ── Card Text Size feature (Appearance Customization) ───────────────────
  // Confirmed live: a card's rules/effect text (.effect_txt for a normal
  // card, .card_pendulum_effect_txt for a Pendulum monster's lower text
  // box) is plain HTML text laid inside .cardfront_content — not baked
  // into the card art — the same mechanism that presumably backs Card
  // Languages above. This slider overrides that text's font-size sitewide
  // (hand, field hover-zoom, deck constructor, siding screen, replays —
  // see dt-card-text-size.user.js, which lives in background.js's
  // APPEARANCE_FILES, the same universal bucket as Background Image) via
  // one injected CSS rule rather than walking/observing every card
  // individually — robust to new cards appearing without needing a
  // MutationObserver. 12px (per the user's own stated default) sits well
  // below the ~29px this renders at natively in the big deck-constructor/
  // siding preview, so the slider's range runs from noticeably smaller
  // than that native size up to noticeably larger.
  const CARD_TEXT_SIZE_DEFAULTS = {
    dt_card_text_size_enabled: false,
    dt_card_text_size_px: 12
  };
  Object.assign(ALL_DEFAULTS, CARD_TEXT_SIZE_DEFAULTS);
  function renderCardTextSizeFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Card Text Size</b><div class="dt-row-detail">Overrides every card\'s rules/effect text to one font size you pick, everywhere on the site (hand, field, deck constructor, replays).</div></div>' +
        switchHtml('cts-enabled') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Text size</b><div class="dt-row-detail">How big a card\'s rules text renders.</div></div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input id="cts-size" type="range" min="8" max="28" step="1" style="width:120px">' +
          '<span id="cts-size-val" style="min-width:34px;text-align:right;font-family:monospace;font-size:12px;color:#9aa">12px</span>' +
        '</div>' +
      '</div>';

    const enabledInput = container.querySelector('#cts-enabled input');
    const sizeInput = container.querySelector('#cts-size');
    const sizeVal = container.querySelector('#cts-size-val');

    getSettings(CARD_TEXT_SIZE_DEFAULTS, (s) => {
      enabledInput.checked = !!s.dt_card_text_size_enabled;
      sizeInput.value = s.dt_card_text_size_px;
      sizeVal.textContent = s.dt_card_text_size_px + 'px';
    });
    enabledInput.addEventListener('change', (e) => setSetting({ dt_card_text_size_enabled: e.target.checked }));
    sizeInput.addEventListener('input', (e) => { sizeVal.textContent = e.target.value + 'px'; });
    sizeInput.addEventListener('change', (e) => setSetting({ dt_card_text_size_px: Number(e.target.value) }));
  }

  // ── Card Language feature (Appearance Customization) ────────────────────
  // Same toggle-less radio-group pattern as Card Pool/Replay Hand View above
  // (no separate master switch — "en" IS the off state, the site's own
  // native text, untouched). See dt-card-language.user.js's own header for
  // the full live-verified breakdown of which of these are real Konami card
  // text (fetched from db.ygoprodeck.com, already a host_permission) versus
  // machine-translated on the fly (translate.googleapis.com, new
  // host_permission) because Yu-Gi-Oh has never been officially printed in
  // that language. Grouped into two <optgroup>-style sections here so that
  // distinction is visible at a glance, not just in a footnote.
  const CARD_LANGUAGE_DEFAULTS = { dt_card_language_enabled: false, dt_card_language: 'en' };
  Object.assign(ALL_DEFAULTS, CARD_LANGUAGE_DEFAULTS);
  const CARD_LANGUAGE_GROUPS = [
    {
      label: 'Official Konami text',
      options: [
        { id: 'en', label: 'English (default)' },
        { id: 'fr', label: 'French' },
        { id: 'de', label: 'German' },
        { id: 'it', label: 'Italian' },
        { id: 'pt', label: 'Portuguese' }
      ]
    },
    {
      label: 'Machine-translated (unofficial)',
      options: [
        { id: 'es', label: 'Spanish' },
        { id: 'ar', label: 'Arabic' },
        { id: 'tr', label: 'Turkish' },
        { id: 'hr', label: 'Croatian' },
        { id: 'ru', label: 'Russian' },
        { id: 'sr', label: 'Serbian' },
        { id: 'el', label: 'Greek' }
      ]
    }
  ];
  function renderCardLanguageFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Card Language</b><div class="dt-row-detail">Translates every card\'s rules text — on the field, in hand, in the preview panel, deck constructor, replays — everywhere on the site. Off by default (cards show DuelingBook\'s native English text).</div></div>' +
        switchHtml('cl-master') +
      '</div>' +
      CARD_LANGUAGE_GROUPS.map((g) =>
        '<div class="dt-note" style="margin-bottom:4px"><b>' + g.label + '</b></div>' +
        '<div class="dt-radio-group" id="cl-group-' + g.label.replace(/[^a-z]/gi, '') + '">' +
          g.options.map((o) => '<label class="dt-radio-pill" id="cl-' + o.id + '"><input type="radio" name="cl-choice" value="' + o.id + '"/> ' + o.label + '</label>').join('') +
        '</div>'
      ).join('') +
      '<div class="dt-note">English is real, native DuelingBook text — nothing is changed. French, German, Italian and Portuguese are genuine Konami-published card text pulled from the official Yu-Gi-Oh! card database, so they\'re accurate rulings, not a guess (though a handful of individual cards have gaps in that database and may still show a line or two in English). Spanish, Arabic, Turkish, Croatian, Russian, Serbian and Greek have never been official Yu-Gi-Oh! print languages — there is no Konami text to show, so those are machine-translated from the English ruling instead. They\'re a reading aid, not a rules source — double-check anything that matters against the English text.</div>';

    const master = container.querySelector('#cl-master input');
    getSettings(CARD_LANGUAGE_DEFAULTS, (s) => {
      master.checked = !!s.dt_card_language_enabled;
      const sel = s.dt_card_language || 'en';
      const pill = container.querySelector('#cl-' + sel);
      if (pill) { pill.classList.add('selected'); pill.querySelector('input').checked = true; }
    });
    master.addEventListener('change', (e) => setSetting({ dt_card_language_enabled: e.target.checked }));
    container.querySelectorAll('input[name="cl-choice"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        container.querySelectorAll('.dt-radio-pill').forEach((p) => p.classList.remove('selected'));
        radio.closest('.dt-radio-pill').classList.add('selected');
        setSetting({ dt_card_language: radio.value });
      });
    });
  }

  // ── Card Pool feature (Deck Building category) ───────────────────────────
  // The only Deck Building feature that's more than a single switch — it
  // also picks WHICH pool, per spec's explicit order (Official → Goat →
  // Edison). Same toggle+radio-group pattern as Hot Keys' scheme picker
  // above. Like every Deck Building feature tonight, this is settings-only:
  // the deck constructor page needs a logged-in account to even load, which
  // isn't something to go do alone overnight (see the stub notes on each
  // Deck Building feature below) — so this persists the choice and is ready
  // to wire in once that page's real DOM can be inspected together.
  const CARD_POOL_DEFAULT_SETTINGS = { dt_card_pool_enabled: false, dt_card_pool_selected: 'official' };
  Object.assign(ALL_DEFAULTS, CARD_POOL_DEFAULT_SETTINGS);
  const CARD_POOL_OPTIONS = [
    { id: 'official', label: 'Official Cards Only' },
    { id: 'goat', label: 'Goat Format Cards' },
    { id: 'edison', label: 'Edison Format Cards' }
  ];
  function renderCardPoolFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Default Card Pool</b><div class="dt-row-detail">Adds a dropdown in the deck constructor for which card pool you\'re searching/adding from.</div></div>' +
        switchHtml('cp-master') +
      '</div>' +
      '<div class="dt-radio-group" id="cp-pool-group">' +
        CARD_POOL_OPTIONS.map((o) => '<label class="dt-radio-pill" id="cp-pool-' + o.id + '"><input type="radio" name="cp-pool" value="' + o.id + '"/> ' + o.label + '</label>').join('') +
      '</div>' +
      '<div class="dt-note">Default is Official Cards Only. Order above (Official → Goat Format → Edison Format) matches the spec\'d dropdown order.</div>' +
      '<div class="dt-note">Live — on page load, this selects your saved choice in DuelingBook\'s own Cardpool dropdown (confirmed live: `select.custom_cb` in the deck constructor) and fires its real change event, same as picking it yourself. It only sets this once per page load, so switching pools yourself afterward is never fought.</div>';

    const master = container.querySelector('#cp-master input');
    getSettings(CARD_POOL_DEFAULT_SETTINGS, (s) => {
      master.checked = !!s.dt_card_pool_enabled;
      const sel = s.dt_card_pool_selected || 'official';
      const pill = container.querySelector('#cp-pool-' + sel);
      if (pill) { pill.classList.add('selected'); pill.querySelector('input').checked = true; }
    });
    master.addEventListener('change', (e) => setSetting({ dt_card_pool_enabled: e.target.checked }));
    container.querySelectorAll('input[name="cp-pool"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        container.querySelectorAll('#cp-pool-group .dt-radio-pill').forEach((p) => p.classList.remove('selected'));
        radio.closest('.dt-radio-pill').classList.add('selected');
        setSetting({ dt_card_pool_selected: radio.value });
      });
    });
  }

  // ── Default Replay Hand View (Replays category) ─────────────────────────
  // Same toggle+radio-group pattern as Card Pool above — but this one is
  // actually wired live (see dt-replay-hand-view.user.js): on a replay
  // page load, it calls .click() on the real DuelingBook radio input
  // (#show_rb/#show1_rb/#show2_rb) matching your saved choice here, once,
  // confirmed live to both flip the checked state and trigger the real
  // hand-show/hide behavior — same as picking it yourself. It never
  // re-applies after that first click, so changing it yourself mid-replay
  // is never fought.
  const REPLAY_HAND_VIEW_DEFAULT_SETTINGS = { dt_replay_hand_view_enabled: false, dt_replay_hand_view_choice: 'hand' };
  Object.assign(ALL_DEFAULTS, REPLAY_HAND_VIEW_DEFAULT_SETTINGS);
  const REPLAY_HAND_VIEW_OPTIONS = [
    { id: 'hide', label: 'Hide Hands' },
    { id: 'hand', label: 'Show Hand' },
    { id: 'both', label: 'Show Both' }
  ];
  function renderDefaultReplayHandViewFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Default Replay Hand View</b><div class="dt-row-detail">When a replay opens, automatically selects one of DuelingBook\'s own Hide Hands / Show Hand / Show Both options for you, instead of whatever it would otherwise default to.</div></div>' +
        switchHtml('rhv-master') +
      '</div>' +
      '<div class="dt-radio-group" id="rhv-group">' +
        REPLAY_HAND_VIEW_OPTIONS.map((o) => '<label class="dt-radio-pill" id="rhv-' + o.id + '"><input type="radio" name="rhv-choice" value="' + o.id + '"/> ' + o.label + '</label>').join('') +
      '</div>' +
      '<div class="dt-note">Live — sets this once the moment a replay loads. Picking a different one yourself afterward during playback is never overridden.</div>';

    const master = container.querySelector('#rhv-master input');
    getSettings(REPLAY_HAND_VIEW_DEFAULT_SETTINGS, (s) => {
      master.checked = !!s.dt_replay_hand_view_enabled;
      const sel = s.dt_replay_hand_view_choice || 'hand';
      const pill = container.querySelector('#rhv-' + sel);
      if (pill) { pill.classList.add('selected'); pill.querySelector('input').checked = true; }
    });
    master.addEventListener('change', (e) => setSetting({ dt_replay_hand_view_enabled: e.target.checked }));
    container.querySelectorAll('input[name="rhv-choice"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        container.querySelectorAll('#rhv-group .dt-radio-pill').forEach((p) => p.classList.remove('selected'));
        radio.closest('.dt-radio-pill').classList.add('selected');
        setSetting({ dt_replay_hand_view_choice: radio.value });
      });
    });
  }

  // ── Replay Viewer download (Downloads category) ──────────────────────────
  // Deliberately a stub, not a guess. The ask is a standalone, OFFLINE page
  // that loads a .json file saved by Download JSON Replay (above) and lets
  // you step back through that duel without duelingbook.com at all. Download
  // JSON Replay itself was small and fully specified (grab a string that
  // already exists, save it) — this is a different kind of task: it means
  // recreating enough of DuelingBook's own duel-field rendering (zones, card
  // art, LP/phase/turn display, the Duel Log) to work with no access to
  // duelingbook.com's own page, CSS, or JS, which is both a much bigger
  // build and has real open design questions (a full graphical field like
  // the real site, vs. a simpler text/log-based step-through?) that are
  // better pinned down together than guessed at solo. Left here, visible and
  // findable, rather than silently skipped.
  // Downloads a single self-contained KeremBook.html: the bundled
  // replay-viewer.html (an extension asset, no build step — opens directly
  // in any browser, no duelingbook.com needed) with a fresh
  // https://db.ygoprodeck.com/api/v7/cardinfo.php dump baked directly into
  // it (already covered by manifest.json's host_permissions) in place of
  // the EMBEDDED_CARDINFO placeholder near the top of that file's own
  // <script> block. One file, not a zip — now that the card database lives
  // INSIDE the page by default rather than as a second file alongside it,
  // a zip has nothing left to bundle.
  //
  // Runs entirely on this options page (chrome-extension://…/dt-
  // settings.html — a privileged extension page, not a content script), so
  // both fetch() calls below work without any web_accessible_resources
  // entry: chrome.runtime.getURL() reads the extension's OWN bundled file,
  // and db.ygoprodeck.com is already granted host access.
  function renderReplayViewerDownloadFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Replay Viewer (KeremBook)</b><div class="dt-row-detail">Downloads KeremBook.html — a standalone offline replay viewer with the full YGOPRODeck card database baked in by default. Just open the file — no install, no duelingbook.com needed, no separate database file to keep track of. Open a .json saved with Download JSON Replay (Settings → Replays) inside it to visually replay the duel: real zones, cards, and toggles to show or hide each player\'s hand.</div></div>' +
        '<button type="button" class="dt-keycap-clear" id="dt-replay-viewer-dl">Download KeremBook.html</button>' +
      '</div>' +
      '<div id="dt-replay-viewer-status" class="dt-note" style="display:none"></div>' +
      '<div class="dt-note">The card database (db.ygoprodeck.com/api/v7/cardinfo.php) is the full catalog of every card — tens of thousands of entries — so this is a sizable one-time download; expect it to take a little while on a slower connection. Once downloaded, the file needs no internet at all except to pull card art (names, stats, full effect text, and the whole visual board all work fully offline). The board reconstruction is confirmed accurate for Monster Zones, Spell/Trap Zones, Graveyard, Banished, Hand, and Deck/Extra counts — Field Spell, Pendulum, shared Extra Monster Zones, and Skill cards are best-effort and not yet verified against real data.</div>';

    const btn = container.querySelector('#dt-replay-viewer-dl');
    const status = container.querySelector('#dt-replay-viewer-status');

    function setStatus(msg) {
      status.style.display = msg ? 'block' : 'none';
      status.textContent = msg || '';
    }

    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      const origLabel = btn.textContent;
      btn.disabled = true;

      Promise.resolve()
        .then(function () {
          setStatus('Fetching the card database from db.ygoprodeck.com… this is the full catalog, so it can take a little while.');
          return fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php');
        })
        .then(function (res) {
          if (!res.ok) throw new Error('cardinfo.php request failed (HTTP ' + res.status + ')');
          return res.text();
        })
        .then(function (cardJsonText) {
          setStatus('Got the card database. Baking it into the viewer…');
          return fetch(chrome.runtime.getURL('replay-viewer.html')).then(function (res) {
            if (!res.ok) throw new Error('could not load the bundled replay-viewer.html (HTTP ' + res.status + ')');
            return res.text();
          }).then(function (viewerHtml) {
            const placeholder = '/*__DT_CARDINFO_JSON__*/null';
            if (viewerHtml.indexOf(placeholder) === -1) throw new Error('bundled replay-viewer.html is missing its embed placeholder — extension files may be out of sync');
            // Guard against the JSON text containing a literal "</script"
            // sequence (astronomically unlikely in card data, but cheap to
            // guard) — that would otherwise terminate the <script> block
            // early and corrupt the downloaded file.
            const safeJson = cardJsonText.replace(/<\/script/gi, '<\\/script');
            return viewerHtml.replace(placeholder, safeJson);
          });
        })
        .then(function (finalHtml) {
          const blob = new Blob([finalHtml], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'KeremBook.html';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
          setStatus('Downloaded KeremBook.html — just open it in any browser.');
        })
        .catch(function (e) {
          setStatus('Failed: ' + (e && e.message ? e.message : e));
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = origLabel;
          setTimeout(function () { setStatus(''); }, 8000);
        });
    });
  }

  // ── Deck Version History (Deck Building category) ────────────────────────
  // Per spec: "if a deck is saved while this setting is enabled, it stays
  // in the extension's Deck Version bank. If that deck is deleted [on
  // DuelingBook's side], you can come here and restore it or permanently
  // delete it forever." Every Save/Save As appends a NEW backup — this is
  // a running history, not just the latest one — captured by
  // dt-deck-version-history.user.js, which hooks DuelingBook's real
  // #save_btn/#save_as_btn (confirmed live, see that file's own header).
  //
  // Restore/Delete Forever are destructive, immediate actions, not
  // preferences to hold until Save/Save & Close — same reasoning as Reset
  // Everything below, and the same fix: they write straight to
  // chrome.storage.local, bypassing the staged pendingChanges model
  // entirely. The bank itself (dt_deck_version_bank) is real user data,
  // not a "setting," so it's deliberately left OUT of ALL_DEFAULTS —
  // Reset Everything must never wipe someone's saved backups.
  const DECK_VERSION_HISTORY_BANK_KEY = 'dt_deck_version_bank';
  const DECK_VERSION_HISTORY_BANK_CAP = 500; // generous — see dt-deck-version-history.user.js, which enforces this on write
  const DECK_VERSION_HISTORY_DEFAULT_SETTINGS = { dt_deck_version_history_enabled: false };
  Object.assign(ALL_DEFAULTS, DECK_VERSION_HISTORY_DEFAULT_SETTINGS);

  function escHtmlDvh(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function formatSavedAt(ts) { return ts ? new Date(ts).toLocaleString() : ''; }

  function renderDeckVersionHistoryFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Deck Version History</b><div class="dt-row-detail">While enabled, every time you Save or Save As a deck in the constructor, a backup of that exact YDK is kept here permanently — even after you delete or overwrite it on DuelingBook\'s side.</div></div>' +
        switchHtml('dvh-master') +
      '</div>' +
      '<div class="dt-note">Live — hooks DuelingBook\'s own Save Deck / Save Deck As buttons. Canceling out of Save Deck As without confirming a name never adds a backup.</div>' +
      '<div id="dvh-list" style="margin-top:10px"></div>';

    const master = container.querySelector('#dvh-master input');
    getSettings(DECK_VERSION_HISTORY_DEFAULT_SETTINGS, (s) => { master.checked = !!s.dt_deck_version_history_enabled; });
    master.addEventListener('change', (e) => setSetting({ dt_deck_version_history_enabled: e.target.checked }));

    renderDvhBankList(container.querySelector('#dvh-list'));
  }

  function renderDvhBankList(listEl) {
    STORAGE.get({ [DECK_VERSION_HISTORY_BANK_KEY]: [] }, (s) => {
      const bank = s[DECK_VERSION_HISTORY_BANK_KEY] || [];
      const sorted = bank.slice().sort((a, b) => b.savedAt - a.savedAt);
      if (!sorted.length) {
        listEl.innerHTML = '<div class="dt-note">No backups yet. Save a deck in the constructor while this is enabled to start building history.</div>';
        return;
      }
      listEl.innerHTML = '<div class="dt-keymap-table">' +
        sorted.map((entry) =>
          '<div class="dt-keymap-row">' +
            '<div class="dt-keymap-info">' +
              '<div class="dt-keymap-name">' + escHtmlDvh(entry.deckName || '(unnamed)') + '</div>' +
              '<div class="dt-keymap-desc">' + formatSavedAt(entry.savedAt) + (entry.source === 'save_as' ? ' · Save As' : ' · Save') + '</div>' +
            '</div>' +
            '<button type="button" class="dt-keycap-clear" data-dvh-restore="' + entry.id + '">Restore</button>' +
            '<button type="button" class="dt-keycap-clear dt-keycap-clear-danger" data-dvh-delete="' + entry.id + '">Delete Forever</button>' +
          '</div>'
        ).join('') +
      '</div>' +
      (bank.length >= DECK_VERSION_HISTORY_BANK_CAP ? '<div class="dt-note warn">At the ' + DECK_VERSION_HISTORY_BANK_CAP + '-backup cap — oldest backups are dropped automatically as new ones come in.</div>' : '');

      listEl.querySelectorAll('[data-dvh-restore]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-dvh-restore');
          const entry = sorted.find((x) => x.id === id);
          if (!entry) return;
          STORAGE.set({ dt_deck_version_restore_pending: { id: entry.id, deckName: entry.deckName, ydk: entry.ydk, requestedAt: Date.now() } }, () => {
            flashStatus('Queued restore of "' + entry.deckName + '" — open the deck constructor tab to apply it.');
          });
        });
      });
      listEl.querySelectorAll('[data-dvh-delete]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-dvh-delete');
          const entry = sorted.find((x) => x.id === id);
          if (!entry) return;
          if (!window.confirm('Permanently delete the backup "' + entry.deckName + '" from ' + formatSavedAt(entry.savedAt) + '? This cannot be undone.')) return;
          STORAGE.get({ [DECK_VERSION_HISTORY_BANK_KEY]: [] }, (s2) => {
            const next = (s2[DECK_VERSION_HISTORY_BANK_KEY] || []).filter((x) => x.id !== id);
            STORAGE.set({ [DECK_VERSION_HISTORY_BANK_KEY]: next }, () => {
              flashStatus('Backup deleted');
              renderDvhBankList(listEl);
            });
          });
        });
      });
    });
  }

  // ── Room Visibility (Lobby Customization category) ──────────────────────
  // Per spec: the Duel Lobby shows 10 format/pool panels (DuelingBook's own
  // 2-letter ids in parens) — Ranked (ar, DuelingBook's own "Duelist Pool"
  // matchmaking box), Advanced Unrated (au), Genesys (yu), Goat (gu), Edison
  // (eu), Custom Cards Unrated (cu), Speed Duels (su), Rush Duels (ru),
  // Unlimited Unrated (uu), Traditional Unrated (tu) — and this feature lets
  // you reorder them (drag handle, or the up/down arrows) and/or hide any of
  // them, same list-row layout as the user's own mockup. The list above
  // always holds all 10 ids; hidden ones just get flagged separately so
  // un-hiding one later doesn't need re-adding it or losing its place.
  //
  // Confirmed live (see dt-room-visibility.user.js's own header for the
  // full investigation): each panel's left-to-right slot is its own
  // absolute CSS `left` offset, not its position in the page's HTML — so
  // the content script reorders/hides by reassigning those offsets, and
  // this settings UI only ever needs to persist the order + hidden list,
  // never touch the live page itself.
  const ROOM_VISIBILITY_POOLS = [
    { id: 'ar', label: 'Ranked' },
    { id: 'au', label: 'Advanced (Unrated)' },
    { id: 'yu', label: 'Genesys Format' },
    { id: 'gu', label: 'Goat Format' },
    { id: 'eu', label: 'Edison Format' },
    { id: 'cu', label: 'Custom Cards (Unrated)' },
    { id: 'su', label: 'Speed Duels' },
    { id: 'ru', label: 'Rush Duels' },
    { id: 'uu', label: 'Unlimited (Unrated)' },
    { id: 'tu', label: 'Traditional (Unrated)' }
  ];
  const ROOM_VISIBILITY_DEFAULT_ORDER = ROOM_VISIBILITY_POOLS.map((p) => p.id);
  const ROOM_VISIBILITY_DEFAULT_SETTINGS = {
    dt_room_visibility_enabled: false,
    dt_room_visibility_order: ROOM_VISIBILITY_DEFAULT_ORDER,
    dt_room_visibility_hidden: [],
    // Watch Mode gets its OWN order/hidden list — same 10 panels/ids
    // (confirmed live: switching DuelingBook's own Mode radio from Duel to
    // Watch reuses the exact same #ar/#au/.../#tu elements, just swapping
    // each one's inner content from the join/host UI to a list of that
    // format's ongoing watchable duels — nothing about the ids, the
    // position:absolute + left-offset layout mechanism, or this feature's
    // existing apply logic needs to differ), but a user may reasonably
    // want a different arrangement for "which formats am I watching" than
    // for "which formats am I playing", hence a second independent list
    // rather than reusing dt_room_visibility_order for both.
    dt_room_visibility_watch_order: ROOM_VISIBILITY_DEFAULT_ORDER,
    dt_room_visibility_watch_hidden: []
  };
  Object.assign(ALL_DEFAULTS, ROOM_VISIBILITY_DEFAULT_SETTINGS);

  // Shared drag/reorder/hide list controller — used twice below (once for
  // the Duel Mode order, once for the Watch Mode order), identical
  // behavior, only the storage keys and DOM ids differ.
  function createReorderListController(container, idPrefix, labelById, defaultOrder, orderStorageKey, hiddenStorageKey) {
    const listEl = container.querySelector('#' + idPrefix + '-list');
    const resetBtn = container.querySelector('#' + idPrefix + '-reset');

    let order = defaultOrder.slice();
    let hidden = [];
    let dragId = null;

    function renderList() {
      listEl.innerHTML = order.map((id, i) => {
        const isHidden = hidden.indexOf(id) !== -1;
        return '<li class="dt-rv-row' + (isHidden ? ' dt-rv-row-hidden' : '') + '" draggable="true" data-id="' + id + '">' +
          '<span class="dt-rv-handle" title="Drag to reorder">⠇</span>' +
          '<span class="dt-rv-label">' + (labelById[id] || id) + '</span>' +
          '<button type="button" class="dt-rv-icon-btn dt-rv-eye" data-action="eye" data-id="' + id + '" title="' + (isHidden ? 'Hidden — click to show' : 'Visible — click to hide') + '">' + (isHidden ? '\u{1F6AB}' : '\u{1F441}️') + '</button>' +
          '<button type="button" class="dt-rv-icon-btn" data-action="up" data-id="' + id + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="dt-rv-icon-btn" data-action="down" data-id="' + id + '" title="Move down"' + (i === order.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '</li>';
      }).join('');
    }

    function persist() {
      setSetting({ [orderStorageKey]: order.slice(), [hiddenStorageKey]: hidden.slice() });
    }

    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.dt-rv-icon-btn');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const action = btn.getAttribute('data-action');
      const idx = order.indexOf(id);
      if (idx === -1) return;
      if (action === 'eye') {
        const hIdx = hidden.indexOf(id);
        if (hIdx === -1) hidden.push(id); else hidden.splice(hIdx, 1);
      } else if (action === 'up' && idx > 0) {
        const tmp = order[idx - 1]; order[idx - 1] = order[idx]; order[idx] = tmp;
      } else if (action === 'down' && idx < order.length - 1) {
        const tmp = order[idx + 1]; order[idx + 1] = order[idx]; order[idx] = tmp;
      } else {
        return;
      }
      renderList();
      persist();
    });

    listEl.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.dt-rv-row');
      if (!row) return;
      dragId = row.getAttribute('data-id');
      row.classList.add('dt-rv-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* Firefox needs this set; Chrome doesn't require it to work */ }
      }
    });
    listEl.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const row = e.target.closest('.dt-rv-row');
      if (!row || !dragId) return;
      const targetId = row.getAttribute('data-id');
      if (targetId === dragId) return;
      const fromIdx = order.indexOf(dragId);
      const toIdx = order.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, dragId);
      dragId = null;
      renderList();
      persist();
    });
    listEl.addEventListener('dragend', () => {
      dragId = null;
      const dragging = listEl.querySelector('.dt-rv-dragging');
      if (dragging) dragging.classList.remove('dt-rv-dragging');
    });

    resetBtn.addEventListener('click', () => {
      order = defaultOrder.slice();
      hidden = [];
      renderList();
      persist();
    });

    function loadFrom(s) {
      order = (Array.isArray(s[orderStorageKey]) && s[orderStorageKey].length)
        ? s[orderStorageKey].slice() : defaultOrder.slice();
      // Guard against a saved order that's stale/short (missing a pool id,
      // e.g. saved before this list grew) — append anything missing at the
      // end so nothing silently vanishes from the lobby.
      const have = {};
      order.forEach((id) => { have[id] = true; });
      defaultOrder.forEach((id) => { if (!have[id]) order.push(id); });
      hidden = Array.isArray(s[hiddenStorageKey]) ? s[hiddenStorageKey].slice() : [];
      renderList();
    }

    return { loadFrom };
  }

  function renderRoomVisibilityFeature(container) {
    const labelById = {};
    ROOM_VISIBILITY_POOLS.forEach((p) => { labelById[p.id] = p.label; });

    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Room Visibility</b><div class="dt-row-detail">Reorders and/or hides the format/pool panels on the Duel Lobby to match the lists below, left to right — one list for Duel mode, one for Watch mode (DuelingBook\'s own Mode: Duel/Watch picker). Both use the same master switch; which list applies just depends on which mode is currently selected.</div></div>' +
        switchHtml('rv-master') +
      '</div>' +
      '<div class="dt-note" style="margin-top:4px"><b>Duel Mode order</b> — the panels you join/host a duel from.</div>' +
      '<div class="dt-rv-toolbar"><button type="button" class="dt-rv-reset" id="rv-reset">Reset to Default Order</button></div>' +
      '<ul class="dt-rv-list" id="rv-list"></ul>' +
      '<div class="dt-note" style="margin-top:14px"><b>Watch Mode order</b> — the same panels, but listing ongoing duels you can watch instead.</div>' +
      '<div class="dt-rv-toolbar"><button type="button" class="dt-rv-reset" id="rv-watch-reset">Reset to Default Order</button></div>' +
      '<ul class="dt-rv-list" id="rv-watch-list"></ul>' +
      '<div class="dt-note">Drag a row by its handle (or use the arrows) to change the order the panels appear left-to-right on the Duel Lobby — the first one in your order sits right next to the Duelist Pool. The eye icon hides a panel entirely.</div>' +
      '<div class="dt-note">Live — see dt-room-visibility.user.js. Confirmed live that DuelingBook positions each pool panel with its own CSS left offset, independent of where it sits in the page\'s HTML, so this works by reassigning those offsets directly instead of fighting DuelingBook\'s own layout code. Switching Duel/Watch mode reuses the exact same panel elements — confirmed live (#ar still shows the Ranked/"Advanced (Rated)" format in both modes, just with different content) — so one saved order simply hands off to the other the instant the Mode radio changes.</div>';

    const master = container.querySelector('#rv-master input');

    const duelList = createReorderListController(container, 'rv', labelById, ROOM_VISIBILITY_DEFAULT_ORDER, 'dt_room_visibility_order', 'dt_room_visibility_hidden');
    const watchList = createReorderListController(container, 'rv-watch', labelById, ROOM_VISIBILITY_DEFAULT_ORDER, 'dt_room_visibility_watch_order', 'dt_room_visibility_watch_hidden');

    getSettings(ROOM_VISIBILITY_DEFAULT_SETTINGS, (s) => {
      master.checked = !!s.dt_room_visibility_enabled;
      duelList.loadFrom(s);
      watchList.loadFrom(s);
    });
    master.addEventListener('change', (e) => setSetting({ dt_room_visibility_enabled: e.target.checked }));
  }

  // ── Main Menu Section Visibility (Appearance Customization category) ───
  // Same reorder/hide list UI as Room Visibility above (drag handle + up/
  // down arrows + eye icon), for the Main Menu's 3-page carousel instead of
  // the Duel Lobby's 10 format panels. Mechanically different underneath,
  // though (see dt-main-menu-sections.user.js's own header): the carousel's
  // 3 dots are bound to FIXED content by DuelingBook's own click handlers
  // (confirmed live — physically moving either the dot elements or the
  // content divs in the DOM does not change what a given dot shows), so
  // reordering can't work by repositioning DuelingBook's own elements the
  // way Room Visibility's absolute-`left` trick does. Instead the content
  // script intercepts every dot's click in the CAPTURE phase and fully
  // replaces DuelingBook's own show/hide + active-dot-opacity logic with
  // its own, driven by the order/hidden lists this UI saves — the native
  // handler never runs while the master switch is on. This UI only ever
  // needs to persist the order + hidden list, same as Room Visibility.
  //
  // Hiding all of them would leave an empty carousel, so (unlike Room
  // Visibility, which allows hiding everything) the eye icon on the last
  // remaining visible section is disabled instead of letting it go to
  // zero.
  //
  // 'keremTools' (added per the user's own follow-up) is NOT one of
  // DuelingBook's own 3 native carousel pages — there's no 4th page or
  // dot in DuelingBook's own markup. dt-main-menu-sections.user.js
  // synthesizes both a 4th dot (cloned from a real one — confirmed live
  // the dots lay out via plain inline-block flow with margin, not fixed
  // per-dot offsets, so a cloned one just slots in) and a 4th content
  // panel (an iframe loading the user's own
  // duel-tools-kerem-production.up.railway.app app — confirmed live it
  // has no X-Frame-Options/CSP block on being iframed) the moment this id
  // is anywhere in a non-hidden position, so it behaves exactly like a
  // real page from this settings panel's own point of view with no
  // special-casing needed here.
  const MAIN_MENU_SECTIONS = [
    { id: 'statuses0', label: 'Chat' },
    { id: 'videos0', label: 'Videos & Streams' },
    { id: 'tourneys0', label: 'Tournaments' },
    { id: 'keremTools', label: 'Kerem Duel Tools' }
  ];
  const MAIN_MENU_SECTIONS_DEFAULT_ORDER = MAIN_MENU_SECTIONS.map((p) => p.id);
  const MAIN_MENU_SECTIONS_DEFAULT_SETTINGS = {
    dt_main_menu_sections_enabled: false,
    dt_main_menu_sections_order: MAIN_MENU_SECTIONS_DEFAULT_ORDER,
    dt_main_menu_sections_hidden: [],
    dt_keremtools_opacity: 100
  };
  Object.assign(ALL_DEFAULTS, MAIN_MENU_SECTIONS_DEFAULT_SETTINGS);

  function renderMainMenuSectionsFeature(container) {
    const labelById = {};
    MAIN_MENU_SECTIONS.forEach((p) => { labelById[p.id] = p.label; });

    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Main Menu Section Visibility</b><div class="dt-row-detail">Reorders and/or hides the Main Menu\'s carousel pages (the dots above the status feed) to match the list below. Includes a 4th page, Kerem Duel Tools, which isn\'t one of DuelingBook\'s own pages — turning it on embeds your own duel-tools-kerem-production.up.railway.app app right there in the carousel, sign-in and all.</div></div>' +
        switchHtml('mms-master') +
      '</div>' +
      '<div class="dt-rv-toolbar"><button type="button" class="dt-rv-reset" id="mms-reset">Reset to Default Order</button></div>' +
      '<ul class="dt-rv-list" id="mms-list"></ul>' +
      '<div class="dt-note">Drag a row by its handle (or use the arrows) to change which carousel dot (left to right) shows which page. The eye icon hides a page from the carousel entirely — at least one has to stay visible.</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Kerem Duel Tools panel transparency</b><div class="dt-row-detail">Kerem Duel Tools is a separate embedded site (not a regular DuelingBook element), so this fades the WHOLE panel as one piece — its background, sign-in form, and text all become more see-through together as you lower it. There\'s no way to fade just its background while keeping the text crisp; that part of the panel lives behind a cross-origin boundary this extension can\'t reach into. 100% is fully opaque (default, no change).</div></div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input id="mms-kerem-opacity" type="range" min="10" max="100" step="5" style="width:120px">' +
          '<span id="mms-kerem-opacity-val" style="min-width:34px;text-align:right;font-family:monospace;font-size:12px;color:#9aa">100%</span>' +
        '</div>' +
      '</div>' +
      '<div class="dt-note">Live — see dt-main-menu-sections.user.js.</div>';

    const master = container.querySelector('#mms-master input');
    const listEl = container.querySelector('#mms-list');
    const resetBtn = container.querySelector('#mms-reset');
    const keremOpacityInput = container.querySelector('#mms-kerem-opacity');
    const keremOpacityVal = container.querySelector('#mms-kerem-opacity-val');

    let order = MAIN_MENU_SECTIONS_DEFAULT_ORDER.slice();
    let hidden = [];
    let dragId = null;

    function renderList() {
      listEl.innerHTML = order.map((id, i) => {
        const isHidden = hidden.indexOf(id) !== -1;
        const lastVisible = !isHidden && (order.length - hidden.length) <= 1;
        return '<li class="dt-rv-row' + (isHidden ? ' dt-rv-row-hidden' : '') + '" draggable="true" data-id="' + id + '">' +
          '<span class="dt-rv-handle" title="Drag to reorder">⠇</span>' +
          '<span class="dt-rv-label">' + (labelById[id] || id) + '</span>' +
          '<button type="button" class="dt-rv-icon-btn dt-rv-eye" data-action="eye" data-id="' + id + '"' + (lastVisible ? ' disabled' : '') + ' title="' + (isHidden ? 'Hidden — click to show' : (lastVisible ? 'At least one page must stay visible' : 'Visible — click to hide')) + '">' + (isHidden ? '\u{1F6AB}' : '\u{1F441}️') + '</button>' +
          '<button type="button" class="dt-rv-icon-btn" data-action="up" data-id="' + id + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="dt-rv-icon-btn" data-action="down" data-id="' + id + '" title="Move down"' + (i === order.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '</li>';
      }).join('');
    }

    function persist() {
      setSetting({ dt_main_menu_sections_order: order.slice(), dt_main_menu_sections_hidden: hidden.slice() });
    }

    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.dt-rv-icon-btn');
      if (!btn || btn.disabled) return;
      const id = btn.getAttribute('data-id');
      const action = btn.getAttribute('data-action');
      const idx = order.indexOf(id);
      if (idx === -1) return;
      if (action === 'eye') {
        const hIdx = hidden.indexOf(id);
        if (hIdx === -1) {
          if (order.length - hidden.length <= 1) return; // guard: never hide the last visible one
          hidden.push(id);
        } else {
          hidden.splice(hIdx, 1);
        }
      } else if (action === 'up' && idx > 0) {
        const tmp = order[idx - 1]; order[idx - 1] = order[idx]; order[idx] = tmp;
      } else if (action === 'down' && idx < order.length - 1) {
        const tmp = order[idx + 1]; order[idx + 1] = order[idx]; order[idx] = tmp;
      } else {
        return;
      }
      renderList();
      persist();
    });

    listEl.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.dt-rv-row');
      if (!row) return;
      dragId = row.getAttribute('data-id');
      row.classList.add('dt-rv-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* Firefox needs this set; Chrome doesn't require it to work */ }
      }
    });
    listEl.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const row = e.target.closest('.dt-rv-row');
      if (!row || !dragId) return;
      const targetId = row.getAttribute('data-id');
      if (targetId === dragId) return;
      const fromIdx = order.indexOf(dragId);
      const toIdx = order.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, dragId);
      dragId = null;
      renderList();
      persist();
    });
    listEl.addEventListener('dragend', () => {
      dragId = null;
      const dragging = listEl.querySelector('.dt-rv-dragging');
      if (dragging) dragging.classList.remove('dt-rv-dragging');
    });

    resetBtn.addEventListener('click', () => {
      order = MAIN_MENU_SECTIONS_DEFAULT_ORDER.slice();
      hidden = [];
      renderList();
      persist();
    });

    getSettings(MAIN_MENU_SECTIONS_DEFAULT_SETTINGS, (s) => {
      master.checked = !!s.dt_main_menu_sections_enabled;
      order = (Array.isArray(s.dt_main_menu_sections_order) && s.dt_main_menu_sections_order.length)
        ? s.dt_main_menu_sections_order.slice() : MAIN_MENU_SECTIONS_DEFAULT_ORDER.slice();
      const have = {};
      order.forEach((id) => { have[id] = true; });
      MAIN_MENU_SECTIONS_DEFAULT_ORDER.forEach((id) => { if (!have[id]) order.push(id); });
      hidden = Array.isArray(s.dt_main_menu_sections_hidden) ? s.dt_main_menu_sections_hidden.slice() : [];
      renderList();
      const op = s.dt_keremtools_opacity == null ? 100 : s.dt_keremtools_opacity;
      keremOpacityInput.value = op;
      keremOpacityVal.textContent = op + '%';
    });
    master.addEventListener('change', (e) => setSetting({ dt_main_menu_sections_enabled: e.target.checked }));
    keremOpacityInput.addEventListener('input', (e) => { keremOpacityVal.textContent = e.target.value + '%'; });
    keremOpacityInput.addEventListener('change', (e) => setSetting({ dt_keremtools_opacity: Number(e.target.value) }));
  }

  // ── Hosted Duel Settings (Lobby Customization category) ──────────────────
  // Per spec, modeled on the exact same mechanic as Default Card Pool /
  // Default Replay Hand View above: this just pre-selects DuelingBook's
  // own real dropdown/checkbox/text values on its own Host a Duel form
  // (confirmed live, #host_bg) and fires the real events, same as picking
  // them yourself — applied ONCE, the instant the Duel Lobby loads (per
  // the user's explicit call: switching the real Format dropdown
  // afterward does NOT re-trigger this).
  //
  // Two kinds of saved profile, both holding the exact same 9 fields
  // (Type, Rules, Duel Note, Duel Password, Watching, Classic, Tag Duel,
  // Watch Note, Watch Password — confirmed live these fields exist
  // identically for every one of DuelingBook's 10 host-format options,
  // Solo Mode included):
  //   - "Default" — ALSO carries its own Format field (which of the 10
  //     host options to select on load). This is the one tab in the
  //     mockup with a Format picker.
  //   - 9 per-format "Override" profiles, one for every host format
  //     EXCEPT Advanced (Unrated) (confirmed live: DuelingBook's own
  //     #host_bg .format_cb options are au/yu/cu/gu/eu/uu/su/ru/tu/so —
  //     every one of those except "au" gets its own Override tab here,
  //     matching the user's own mockup 1:1).
  //
  // On page load, dt-hosted-duel-settings.user.js selects whichever
  // format Default says to open with, then fills in the other 9 fields
  // from THAT format's own Override profile if one exists (i.e. every
  // format except Advanced (Unrated)) — Default's own Type/Rules/etc only
  // ever come into play when Default's Format is itself Advanced
  // (Unrated), the one format with no Override tab to defer to. This is
  // exactly the "overrides take precedence whenever that format is
  // selected" behavior from the original spec, just resolved at the one
  // moment this feature ever acts (page load) instead of continuously.
  const HDS_FORMAT_OPTIONS = [
    { id: 'au', label: 'Advanced (Unrated)' },
    { id: 'yu', label: 'Genesys Format (Unrated)' },
    { id: 'cu', label: 'Custom Cards (Unrated)' },
    { id: 'gu', label: 'Goat Format (Unrated)' },
    { id: 'eu', label: 'Edison Format (Unrated)' },
    { id: 'uu', label: 'Unlimited (Unrated)' },
    { id: 'su', label: 'Speed Duels (Unrated)' },
    { id: 'ru', label: 'Rush Duels (Unrated)' },
    { id: 'tu', label: 'Traditional (Unrated)' },
    { id: 'so', label: 'Solo Mode' }
  ];
  // Override tabs, in the user's own mockup order.
  const HDS_OVERRIDE_FORMATS = [
    { id: 'yu', label: 'Genesys Format' },
    { id: 'gu', label: 'Goat Format' },
    { id: 'eu', label: 'Edison Format' },
    { id: 'cu', label: 'Custom Cards (Unrated)' },
    { id: 'su', label: 'Speed Duels' },
    { id: 'ru', label: 'Rush Duels' },
    { id: 'uu', label: 'Unlimited (Unrated)' },
    { id: 'tu', label: 'Traditional (Unrated)' },
    { id: 'so', label: 'Solo Mode' }
  ];
  const HDS_TYPE_OPTIONS = [
    { id: 's', label: 'Single (with siding)' },
    { id: 'n', label: 'Single (no siding)' },
    { id: 'm', label: '2 out of 3 Match' }
  ];
  const HDS_RULES_OPTIONS = [
    { id: '*', label: 'TCG + OCG' },
    { id: 'TCG', label: 'TCG' },
    { id: 'OCG', label: 'OCG' }
  ];

  function hdsBlankProfileFields() {
    return {
      type: 's', rules: '*', duelNote: '', duelPassword: '',
      watching: true, classic: false, tagDuel: false,
      watchNote: '', watchPassword: ''
    };
  }
  function hdsDefaultProfile() {
    return Object.assign({ format: 'au' }, hdsBlankProfileFields());
  }
  function hdsDefaultOverrides() {
    const o = {};
    HDS_OVERRIDE_FORMATS.forEach((f) => { o[f.id] = hdsBlankProfileFields(); });
    return o;
  }

  const HOSTED_DUEL_SETTINGS_DEFAULTS = {
    dt_hosted_duel_settings_enabled: false,
    dt_hosted_duel_default: hdsDefaultProfile(),
    dt_hosted_duel_overrides: hdsDefaultOverrides()
  };
  Object.assign(ALL_DEFAULTS, HOSTED_DUEL_SETTINGS_DEFAULTS);

  function hdsEscAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function renderHostedDuelSettingsFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Hosted Duel Settings</b><div class="dt-row-detail">Pre-fills DuelingBook\'s own "Host a Duel" form the instant the Duel Lobby loads — Format, Type, Rules, Duel Note, Duel Password, Watching, Classic, Tag Duel, Watch Note, and Watch Password.</div></div>' +
        switchHtml('hds-master') +
      '</div>' +
      '<div class="dt-hds-tabs" id="hds-tabs"></div>' +
      '<div class="dt-hds-form" id="hds-form"></div>' +
      '<div class="dt-note">Applied once, the moment the Duel Lobby page loads — switching DuelingBook\'s own Format dropdown yourself afterward never re-triggers this.</div>' +
      '<div class="dt-note">Live — see dt-hosted-duel-settings.user.js. Confirmed live against DuelingBook\'s own Host a Duel form: selects the Default tab\'s Format in DuelingBook\'s real dropdown, then fills Type/Rules/Duel Note/Duel Password/Watching/Classic/Tag Duel/Watch Note/Watch Password from that format\'s own Override tab (every format has one except Advanced (Unrated), which uses Default\'s own fields instead) — same mechanic as Default Card Pool: real values, real change events.</div>';

    const master = container.querySelector('#hds-master input');
    const tabsEl = container.querySelector('#hds-tabs');
    const formEl = container.querySelector('#hds-form');

    let defaultProfile = hdsDefaultProfile();
    let overrides = hdsDefaultOverrides();
    let activeTab = 'default';

    function currentProfile() {
      return activeTab === 'default' ? defaultProfile : overrides[activeTab];
    }

    function persist() {
      setSetting({
        dt_hosted_duel_default: Object.assign({}, defaultProfile),
        dt_hosted_duel_overrides: JSON.parse(JSON.stringify(overrides))
      });
    }

    function renderTabs() {
      const tabs = [{ id: 'default', label: 'Default' }].concat(
        HDS_OVERRIDE_FORMATS.map((f) => ({ id: f.id, label: f.label + ' Override' }))
      );
      tabsEl.innerHTML = tabs.map((t) =>
        '<button type="button" class="dt-hds-tab' + (t.id === activeTab ? ' selected' : '') + '" data-tab="' + t.id + '">' + t.label + '</button>'
      ).join('');
      tabsEl.querySelectorAll('.dt-hds-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeTab = btn.getAttribute('data-tab');
          renderTabs();
          renderForm();
        });
      });
    }

    function pillGroup(name, options, value) {
      return '<div class="dt-radio-group dt-hds-pills">' +
        options.map((o) =>
          '<label class="dt-radio-pill' + (o.id === value ? ' selected' : '') + '" data-hds-pill="' + name + '" data-value="' + hdsEscAttr(o.id) + '">' +
            '<input type="radio" name="hds-' + name + '-' + activeTab + '" value="' + hdsEscAttr(o.id) + '" ' + (o.id === value ? 'checked' : '') + '/> ' + o.label +
          '</label>'
        ).join('') +
      '</div>';
    }

    function renderForm() {
      const p = currentProfile();
      const showFormat = activeTab === 'default';
      formEl.innerHTML =
        (showFormat
          ? '<div class="dt-hds-field"><div class="dt-hds-field-label">Format</div>' + pillGroup('format', HDS_FORMAT_OPTIONS, defaultProfile.format) + '</div>'
          : '') +
        '<div class="dt-hds-field"><div class="dt-hds-field-label">Type</div>' + pillGroup('type', HDS_TYPE_OPTIONS, p.type) + '</div>' +
        '<div class="dt-hds-field"><div class="dt-hds-field-label">Rules</div>' + pillGroup('rules', HDS_RULES_OPTIONS, p.rules) + '</div>' +
        '<div class="dt-hds-row2">' +
          '<div class="dt-hds-field"><div class="dt-hds-field-label">Duel Note</div><input type="text" class="dt-hds-text" id="hds-duel-note" value="' + hdsEscAttr(p.duelNote) + '"/></div>' +
          '<div class="dt-hds-field"><div class="dt-hds-field-label">Duel Password</div><input type="text" class="dt-hds-text" id="hds-duel-password" value="' + hdsEscAttr(p.duelPassword) + '" placeholder="Leave blank for none"/></div>' +
        '</div>' +
        '<div class="dt-hds-checks">' +
          '<label class="dt-hds-check"><input type="checkbox" id="hds-watching" ' + (p.watching ? 'checked' : '') + '/> Watching</label>' +
          '<label class="dt-hds-check"><input type="checkbox" id="hds-classic" ' + (p.classic ? 'checked' : '') + '/> Classic</label>' +
          '<label class="dt-hds-check"><input type="checkbox" id="hds-tag-duel" ' + (p.tagDuel ? 'checked' : '') + '/> Tag Duel</label>' +
        '</div>' +
        '<div class="dt-hds-row2">' +
          '<div class="dt-hds-field"><div class="dt-hds-field-label">Watch Note</div><input type="text" class="dt-hds-text" id="hds-watch-note" value="' + hdsEscAttr(p.watchNote) + '"/></div>' +
          '<div class="dt-hds-field"><div class="dt-hds-field-label">Watch Password</div><input type="text" class="dt-hds-text" id="hds-watch-password" value="' + hdsEscAttr(p.watchPassword) + '" placeholder="Leave blank for none"/></div>' +
        '</div>';

      if (showFormat) {
        formEl.querySelectorAll('[data-hds-pill="format"]').forEach((lbl) => {
          lbl.querySelector('input').addEventListener('change', () => {
            formEl.querySelectorAll('[data-hds-pill="format"]').forEach((l2) => l2.classList.remove('selected'));
            lbl.classList.add('selected');
            defaultProfile.format = lbl.getAttribute('data-value');
            persist();
          });
        });
      }
      formEl.querySelectorAll('[data-hds-pill="type"]').forEach((lbl) => {
        lbl.querySelector('input').addEventListener('change', () => {
          formEl.querySelectorAll('[data-hds-pill="type"]').forEach((l2) => l2.classList.remove('selected'));
          lbl.classList.add('selected');
          p.type = lbl.getAttribute('data-value');
          persist();
        });
      });
      formEl.querySelectorAll('[data-hds-pill="rules"]').forEach((lbl) => {
        lbl.querySelector('input').addEventListener('change', () => {
          formEl.querySelectorAll('[data-hds-pill="rules"]').forEach((l2) => l2.classList.remove('selected'));
          lbl.classList.add('selected');
          p.rules = lbl.getAttribute('data-value');
          persist();
        });
      });

      formEl.querySelector('#hds-duel-note').addEventListener('input', (e) => { p.duelNote = e.target.value; persist(); });
      formEl.querySelector('#hds-duel-password').addEventListener('input', (e) => { p.duelPassword = e.target.value; persist(); });
      formEl.querySelector('#hds-watch-note').addEventListener('input', (e) => { p.watchNote = e.target.value; persist(); });
      formEl.querySelector('#hds-watch-password').addEventListener('input', (e) => { p.watchPassword = e.target.value; persist(); });
      formEl.querySelector('#hds-watching').addEventListener('change', (e) => { p.watching = e.target.checked; persist(); });
      formEl.querySelector('#hds-classic').addEventListener('change', (e) => { p.classic = e.target.checked; persist(); });
      formEl.querySelector('#hds-tag-duel').addEventListener('change', (e) => { p.tagDuel = e.target.checked; persist(); });
    }

    getSettings(HOSTED_DUEL_SETTINGS_DEFAULTS, (s) => {
      master.checked = !!s.dt_hosted_duel_settings_enabled;
      defaultProfile = Object.assign(hdsDefaultProfile(), s.dt_hosted_duel_default || {});
      const storedOverrides = s.dt_hosted_duel_overrides || {};
      overrides = hdsDefaultOverrides();
      HDS_OVERRIDE_FORMATS.forEach((f) => {
        overrides[f.id] = Object.assign(hdsBlankProfileFields(), storedOverrides[f.id] || {});
      });
      renderTabs();
      renderForm();
    });
    master.addEventListener('change', (e) => setSetting({ dt_hosted_duel_settings_enabled: e.target.checked }));
  }

  // ── Ranked Duelist Pool Settings (Lobby Customization category) ─────────
  // Much simpler than Hosted Duel Settings: the Duelist Pool box (#ar,
  // confirmed live) is a single, un-tabbed form — Format, Rules, Type,
  // then its own "Join Pool" button — not one form per format the way
  // Host a Duel's ten format options each render their own instance.
  // Confirmed live, #ar's own option lists (narrower than Host a Duel's):
  // Format offers 13 choices (4 Rated: Advanced/Genesys/Goat/Edison, plus
  // 9 Unrated — no Solo Mode, no Traditional... correction, Traditional
  // Unrated IS one of the 9), Rules offers only TCG/OCG (no combined
  // "TCG + OCG"), Type offers only Match/Single (with siding) (no
  // "Single, no siding"). Per the user's explicit call, this only ever
  // pre-fills those 3 fields — it never auto-clicks Join Pool; joining
  // the pool stays a deliberate action you take yourself.
  const RDP_FORMAT_OPTIONS = [
    { id: 'ar', label: 'Advanced (Rated)' },
    { id: 'yr', label: 'Genesys Format (Rated)' },
    { id: 'gr', label: 'Goat Format (Rated)' },
    { id: 'er', label: 'Edison Format (Rated)' },
    { id: 'au', label: 'Advanced (Unrated)' },
    { id: 'yu', label: 'Genesys Format (Unrated)' },
    { id: 'cu', label: 'Custom Cards (Unrated)' },
    { id: 'gu', label: 'Goat Format (Unrated)' },
    { id: 'eu', label: 'Edison Format (Unrated)' },
    { id: 'uu', label: 'Unlimited (Unrated)' },
    { id: 'su', label: 'Speed Duels (Unrated)' },
    { id: 'ru', label: 'Rush Duels (Unrated)' },
    { id: 'tu', label: 'Traditional (Unrated)' }
  ];
  const RDP_RULES_OPTIONS = [
    { id: 'TCG', label: 'TCG' },
    { id: 'OCG', label: 'OCG' }
  ];
  const RDP_TYPE_OPTIONS = [
    { id: 'm', label: 'Match' },
    { id: 's', label: 'Single (with siding)' }
  ];
  const RANKED_DUELIST_POOL_DEFAULTS = {
    dt_ranked_duelist_pool_settings_enabled: false,
    dt_ranked_duelist_pool_format: 'ar',
    dt_ranked_duelist_pool_rules: 'TCG',
    dt_ranked_duelist_pool_type: 'm'
  };
  Object.assign(ALL_DEFAULTS, RANKED_DUELIST_POOL_DEFAULTS);

  function renderRankedDuelistPoolFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Ranked Duelist Pool Settings</b><div class="dt-row-detail">Pre-fills DuelingBook\'s own Duelist Pool box (Format, Rules, Type) the instant the Duel Lobby loads. Never auto-clicks Join Pool — that stays your own call.</div></div>' +
        switchHtml('rdp-master') +
      '</div>' +
      '<div class="dt-hds-field"><div class="dt-hds-field-label">Format</div><div class="dt-radio-group" id="rdp-format-group"></div></div>' +
      '<div class="dt-hds-field"><div class="dt-hds-field-label">Rules</div><div class="dt-radio-group" id="rdp-rules-group"></div></div>' +
      '<div class="dt-hds-field"><div class="dt-hds-field-label">Type</div><div class="dt-radio-group" id="rdp-type-group"></div></div>' +
      '<div class="dt-note">Live — see dt-ranked-duelist-pool-settings.user.js. Same mechanic as Hosted Duel Settings/Default Card Pool: sets DuelingBook\'s own real Duelist Pool dropdowns and fires their real change events, once, the moment the lobby loads.</div>';

    const master = container.querySelector('#rdp-master input');

    function buildPillGroup(groupEl, name, options, getValue, setValue) {
      groupEl.innerHTML = options.map((o) =>
        '<label class="dt-radio-pill' + (o.id === getValue() ? ' selected' : '') + '" data-value="' + o.id + '">' +
          '<input type="radio" name="rdp-' + name + '" value="' + o.id + '" ' + (o.id === getValue() ? 'checked' : '') + '/> ' + o.label +
        '</label>'
      ).join('');
      groupEl.querySelectorAll('.dt-radio-pill').forEach((lbl) => {
        lbl.querySelector('input').addEventListener('change', () => {
          groupEl.querySelectorAll('.dt-radio-pill').forEach((l2) => l2.classList.remove('selected'));
          lbl.classList.add('selected');
          setValue(lbl.getAttribute('data-value'));
        });
      });
    }

    let format = 'ar';
    let rules = 'TCG';
    let type = 'm';

    getSettings(RANKED_DUELIST_POOL_DEFAULTS, (s) => {
      master.checked = !!s.dt_ranked_duelist_pool_settings_enabled;
      format = s.dt_ranked_duelist_pool_format || 'ar';
      rules = s.dt_ranked_duelist_pool_rules || 'TCG';
      type = s.dt_ranked_duelist_pool_type || 'm';

      buildPillGroup(container.querySelector('#rdp-format-group'), 'format', RDP_FORMAT_OPTIONS, () => format, (v) => { format = v; setSetting({ dt_ranked_duelist_pool_format: v }); });
      buildPillGroup(container.querySelector('#rdp-rules-group'), 'rules', RDP_RULES_OPTIONS, () => rules, (v) => { rules = v; setSetting({ dt_ranked_duelist_pool_rules: v }); });
      buildPillGroup(container.querySelector('#rdp-type-group'), 'type', RDP_TYPE_OPTIONS, () => type, (v) => { type = v; setSetting({ dt_ranked_duelist_pool_type: v }); });
    });
    master.addEventListener('change', (e) => setSetting({ dt_ranked_duelist_pool_settings_enabled: e.target.checked }));
  }

  // ── Category / feature tree ──────────────────────────────────────────────
  const CATEGORIES = [
    {
      id: 'playing',
      label: 'Playing',
      icon: '⚔️',
      scope: 'duelingbook.com — not /replay',
      features: [
        { id: 'hotkeys', label: 'Hot Keys', render: renderHotkeysFeature },
        { id: 'cardTracking', label: 'Card Tracking', render: renderCardTrackingFeature },
        {
          id: 'duelCommands', label: 'Duel Commands',
          render: renderSimpleToggleFeature(
            'dt_duel_commands_enabled', false,
            'Enable Duel Commands',
            'Adds a Commands button next to Thinking with tile shortcuts for DuelingBook\'s "/" commands (draw/mill/banish N, LP changes, discard/banish hand).'
          )
        },
        {
          id: 'liveTracker', label: 'Live Tracker Tool',
          render: renderSimpleToggleFeature(
            'dt_live_tracker_enabled', true,
            'Enable Live Tracker',
            'The dual-timer / known-card / LP tracking panel from earlier in this extension. On by default.'
          )
        },
        { id: 'transparentFacedowns', label: 'Transparent Facedowns', render: renderTransparentFacedownsFeature },
        {
          id: 'hidePendulumZones', label: 'Hide Pendulum Zones',
          render: renderSimpleToggleFeature(
            'dt_hide_pendulum_zones_enabled', false,
            'Hide Pendulum Zones',
            'Removes the Pendulum Zones from the duel field entirely — the diamond icon AND its border box, all 4 of them (both yours and your opponent\'s, left and right). Off by default (DuelingBook\'s own Pendulum Zone markers and borders show as normal).',
            'Confirmed against a live duel: the diamond icons are 4 individually-addressable elements inside DuelingBook\'s own zone-grid image, and — despite an earlier version of this note claiming otherwise — each Pendulum Zone\'s border box is also its own separate piece of geometry inside that same image, cleanly removable without touching the 10 real monster/spell-trap zones next to it. Both the icon and the border box are stripped out together, so the cell disappears into the background instead of just losing its marker.'
          )
        },
        { id: 'chooseZones', label: 'Choose Zones', render: renderChooseZonesFeature },
        { id: 'rpsAutomation', label: 'RPS Automation', render: renderRpsAutomationFeature },
        { id: 'autoHandShuffle', label: 'Auto Hand Shuffling', render: renderAutoHandShuffleFeature }
      ]
    },
    {
      id: 'replays',
      label: 'Replays',
      icon: '🎬',
      scope: 'duelingbook.com/replay?id=…',
      features: [
        {
          id: 'advancedControls', label: 'Advanced Replay Controls',
          render: renderSimpleToggleFeature(
            'dt_replay_controls_enabled', true,
            'Enable Advanced Replay Controls',
            'Replaces DuelingBook\'s own Play / Pause / Prev / Next / Fast Rewind / Fast Forward row with Duel Tools\' own Play / Checkpoint / Prev / Next / « / » controls, a Checkpoints dropdown for jumping straight back to a saved point, and the G1 / G2 / G3 game-jump buttons.',
            'Stepping backward (Prev, «, or an older Checkpoint) never reloads the page — it takes a full board snapshot after every play as the replay runs, and restores one with the same function DuelingBook itself uses to sync a spectator joining mid-duel, including the Duel Log panel (DuelingBook\'s own built-in step-backward moves the board correctly but leaves the Log panel out of sync — confirmed live, and fixed here). Live-verified: rewinding and re-advancing through the same point reproduces the exact same board state and Log panel text. Jumping straight to Game 2/3 (G2/G3, or a Checkpoint saved in a later game) rebuilds that game\'s own deal-out the same way DuelingBook does — logic is in place and bridge-tested, but not yet confirmed against a real live multi-game replay.'
          )
        },
        {
          id: 'spectateReplay', label: 'Enable Replays While Spectating',
          render: renderSimpleToggleFeature(
            'dt_spectate_replay_enabled', false,
            'Enable Replays While Spectating',
            'While spectating a LIVE duel (not a saved replay), adds a "View Live" control that lets you pause, rewind, bookmark moments, and switch between that rewound view and the real-time duel — similar to Advanced Replay Controls above, but on a match that\'s still being played.',
            'Stub — off by default and not yet wired to anything. This needs an actual live duel to spectate while inspecting DuelingBook\'s own client code for how it handles that (a reference: Duel Enhancer does something similar), which has to happen together rather than guessed at blind. Toggling this on right now does nothing yet.'
          )
        },
        {
          id: 'hideCardStats', label: 'Hide Stats of Cards',
          render: renderSimpleToggleFeature(
            'dt_unlock_cardStats', true,
            'Hide Stats of Cards',
            'On replay pages, hides every on-field monster\'s ATK/DEF text by default. A card\'s stats reveal again the moment the Duel Log shows them changing, and hide again once that card is Set, Banished, Sent, or Added (i.e. leaves the zone).',
            'Ported over from the extension this project replaced — the logic is real and already shipping (dt-unlock.user.js\'s Card Stats module), this just gives it a real home in Settings instead of the old, unreachable floating toggle panel it used to live behind.'
          )
        },
        { id: 'defaultHandView', label: 'Default Replay Hand View', render: renderDefaultReplayHandViewFeature },
        {
          id: 'grabReplayMidDuel', label: 'Grab Replay Mid Duel',
          render: renderSimpleToggleFeature(
            'dt_grab_replay_mid_duel_enabled', false,
            'Grab Replay Mid Duel',
            'While you\'re spectating a LIVE duel, adds a small "Copy Replay Link" button that copies that duel\'s duelingbook.com/replay link to your clipboard right away — instead of waiting for the duel to end before DuelingBook\'s own "View Replay" button appears.',
            'The replay link (duelingbook.com/replay?id=&lt;duelId&gt;) is already determined the moment a duel starts — confirmed live by calling DuelingBook\'s own window.viewReplayE() mid-duel and getting back a real, correctly-formed link. Opening that link before the duel ends just times out (confirmed live — there\'s no replay data to show yet), so this is for grabbing the link now to go back to once the duel is over, not for watching it live as it happens.'
          )
        },
        {
          id: 'downloadJsonReplay', label: 'Download JSON Replay',
          render: renderSimpleToggleFeature(
            'dt_download_json_replay_enabled', false,
            'Download JSON Replay',
            'On a replay page (duelingbook.com/replay?id=…), adds a "Download Replay JSON" button that saves that duel\'s own raw replay data to your computer as a .json file.',
            'The file is the exact raw payload DuelingBook\'s own replay page loads internally (captured straight from its own loadReplayComplete call), not a re-built copy — so it\'s a byte-for-byte match of what the server actually sent. Pairs with the Replay Viewer under Settings → Downloads, which is what loads a saved .json file like this back up outside of duelingbook.com.'
          )
        }
      ]
    },
    {
      id: 'downloads',
      label: 'Downloads',
      icon: '📥',
      scope: "Settings page itself — doesn't touch duelingbook.com",
      features: [
        {
          id: 'replayViewer', label: 'Replay Viewer',
          render: renderReplayViewerDownloadFeature
        }
      ]
    },
    {
      id: 'deckBuilding',
      label: 'Deck Building',
      icon: '🛠️',
      scope: 'duelingbook.com/deck-constructor (or wherever DuelingBook\'s real path turns out to be)',
      features: [
        {
          id: 'deckFolders', label: 'Enable Deck Folders',
          render: renderSimpleToggleFeature(
            'dt_deck_folders_enabled', false,
            'Enable Deck Folders',
            'Adds a Duel Tools panel in the deck constructor with its own folders for saving YDKs — separate, extra storage and organization on top of DuelingBook\'s own saved-deck list.',
            'Live — reads the deck currently on screen straight off the board (the real Deck/Extra/Side card passcodes) to save it, and loads a saved one back in by handing it to DuelingBook\'s own Import Deck file picker, same as picking a file yourself. Sits anchored just above the Import Deck button in the deck constructor.'
          )
        },
        {
          id: 'historicalCardText', label: 'Use Historical Card Text',
          render: renderSimpleToggleFeature(
            'dt_historical_card_text_enabled', false,
            'Use Historical Card Text',
            'Replaces the card text shown in the deck constructor with each card\'s Format-accurate (pre-errata) wording, for cards DuelingBook has since updated to their current, errata\'d text.',
            'Live — swaps the effect text of any of the 19 Goat Format Erratas cards wherever DuelingBook renders a card tile (`.cardfront_content` / `.name_txt` / `.effect_txt`, confirmed live in the deck constructor). It watches the page continuously, so it also covers newly-rendered tiles as you scroll or search. Only directly confirmed against the deck constructor so far — flag it if it doesn\'t swap text on a live duel or replay card.'
          )
        },
        {
          id: 'cardPool', label: 'Enable Default Card Pool',
          render: renderCardPoolFeature
        },
        {
          id: 'deckVersionHistory', label: 'Deck Version History',
          render: renderDeckVersionHistoryFeature
        },
        {
          id: 'organizeDecklists', label: 'Organize Decklists',
          render: renderSimpleToggleFeature(
            'dt_organize_decklists_enabled', false,
            'Organize Decklists',
            'Adds an "Organize Decklists" button next to the deck dropdown in the constructor. Opens a list of every deck saved to your account with checkboxes, so you can mass delete, rename, or apply a label (prefix/suffix) to several at once.',
            'Live — see dt-organize-decklists.user.js. DuelingBook requires a real click on its own confirm dialog per deck (a browser security boundary no extension can script around), so a mass action auto-fills and auto-advances but still needs you to click its real OK button once per deck.'
          )
        }
      ]
    },
    {
      // Placeholder category — the user is still spec'ing out exactly how
      // each feature below should look/behave. Everything here is a stub
      // toggle (renderSimpleToggleFeature) with a note saying so; the real
      // render function for each one replaces the stub once it's built,
      // same as every other category in this file did.
      id: 'lobbyCustomization',
      label: 'Lobby Customization',
      icon: '🚪',
      scope: 'duelingbook.com lobby / room list',
      features: [
        {
          id: 'roomVisibility', label: 'Room Visibility',
          render: renderRoomVisibilityFeature
        },
        {
          id: 'hostedDuelSettings', label: 'Hosted Duel Settings',
          render: renderHostedDuelSettingsFeature
        },
        {
          id: 'rankedDuelistPoolSettings', label: 'Ranked Duelist Pool Settings',
          render: renderRankedDuelistPoolFeature
        }
      ]
    },
    {
      id: 'appearanceCustomization',
      label: 'Appearance Customization',
      icon: '🎨',
      scope: 'duelingbook.com (site-wide)',
      features: [
        {
          id: 'cardTextSize', label: 'Card Text Size',
          render: renderCardTextSizeFeature
        },
        {
          id: 'languageAppearance', label: 'Language Appearance',
          render: renderLanguageAppearanceFeature
        },
        {
          id: 'skipOpeningCinematic', label: 'Automatically Skip Opening Cinematic',
          render: renderSimpleToggleFeature(
            'dt_skip_opening_cinematic_enabled', false,
            'Automatically Skip Opening Cinematic',
            'Calls DuelingBook’s own "Skip Intro" action for you the instant the page loads, so the opening animation never has to play out.',
            'Takes effect on your next page load/refresh of duelingbook.com — it won’t retroactively skip an intro that’s already partway through.'
          )
        },
        {
          id: 'mainMenuSections', label: 'Main Menu Section Visibility',
          render: renderMainMenuSectionsFeature
        },
        {
          id: 'customImagesThemes', label: 'Add Custom Images/Themes/Colors/Emotes',
          render: renderCustomAppearanceFeature
        }
      ]
    }
    // More Appearance Customization features are coming as the user spec's
    // them out one at a time — new entries get appended to that category's
    // features array above, same pattern as everything else in this file.
  ];

  // ── Custom Emotes feature (Appearance Customization) ───────────────────
  // Confirmed live against a real duel: DuelingBook's own "Thinking"
  // overlay is a plain <img class="think" src=".../think.webp"> per
  // avatar, and "Signaled OK" is a plain <img> (no class, wrapped in
  // <div class="all_good">) with src=".../svg/like_btn_up.svg" — see
  // dt-custom-emotes.user.js's own header for exactly how each gets
  // swapped. This page only stores each slot's LIBRARY of uploaded images
  // plus which one is currently selected (or 'default' for the image
  // bundled with the extension, emotes/default-thinking.png /
  // emotes/default-ok.png — see manifest.json's web_accessible_resources)
  // — per spec, those two bundled images can't be deleted, and anything
  // the user uploads themselves stays in the library (pickable again
  // later) instead of being overwritten by the next upload. The content
  // script does all the actual DOM work.
  const CUSTOM_EMOTES_DEFAULTS = {
    dt_custom_emotes_enabled: false,
    dt_custom_emote_thinking_library: [],
    dt_custom_emote_thinking_selected: 'default',
    dt_custom_emote_ok_library: [],
    dt_custom_emote_ok_selected: 'default'
  };
  Object.assign(ALL_DEFAULTS, CUSTOM_EMOTES_DEFAULTS);
  const CUSTOM_EMOTES_LIBRARY_CAP = 3;
  const CUSTOM_EMOTES_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB — these only ever render as a small avatar overlay, no reason to store anything bigger

  function ceReadFileAsDataUrl(file, cb) {
    const reader = new FileReader();
    reader.onload = () => cb(reader.result);
    reader.readAsDataURL(file);
  }

  function ceBuiltinSrc(id) {
    return chrome.runtime.getURL(id === 'thinking' ? 'emotes/default-thinking.png' : 'emotes/default-ok.png');
  }

  function ceThumbHtml(src, key, selected, deletable) {
    return (
      '<div class="dt-ce-thumb' + (selected ? ' selected' : '') + '" data-key="' + key + '" title="' + (deletable ? 'Click to use — or delete below' : 'Built-in default — click to use') + '">' +
        '<img src="' + src + '">' +
        (deletable ? '<button type="button" class="dt-ce-thumb-del" data-key="' + key + '" title="Delete this image">×</button>' : '') +
      '</div>'
    );
  }

  function ceSlotHtml(id, label) {
    return (
      '<div class="dt-ce-slot">' +
        '<div class="dt-ce-slot-label">' + label + ' <span class="dt-ce-slot-count" id="ce-' + id + '-count"></span></div>' +
        '<div class="dt-ce-gallery" id="ce-' + id + '-gallery"></div>' +
        '<label class="dt-ce-upload-btn">+ Add Image<input type="file" accept="image/*" id="ce-' + id + '-file" style="display:none"></label>' +
      '</div>'
    );
  }

  function ceWireSlot(container, id, libKey, selKey, initial) {
    const state = { library: (initial.library || []).slice(), selected: initial.selected || 'default' };
    const gallery = container.querySelector('#ce-' + id + '-gallery');
    const countEl = container.querySelector('#ce-' + id + '-count');
    const fileInput = container.querySelector('#ce-' + id + '-file');
    const builtinSrc = ceBuiltinSrc(id);

    function persist() {
      setSetting({ [libKey]: state.library, [selKey]: state.selected });
    }
    function render() {
      let html = ceThumbHtml(builtinSrc, 'default', state.selected === 'default', false);
      state.library.forEach((entry) => {
        html += ceThumbHtml(entry.dataUrl, entry.id, state.selected === entry.id, true);
      });
      gallery.innerHTML = html;
      countEl.textContent = '(' + state.library.length + '/' + CUSTOM_EMOTES_LIBRARY_CAP + ' added)';
    }

    gallery.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.dt-ce-thumb-del');
      if (delBtn) {
        const key = delBtn.getAttribute('data-key');
        state.library = state.library.filter((entry) => entry.id !== key);
        if (state.selected === key) state.selected = 'default';
        persist();
        render();
        return;
      }
      const thumb = e.target.closest('.dt-ce-thumb');
      if (thumb) {
        state.selected = thumb.getAttribute('data-key');
        persist();
        render();
      }
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (state.library.length >= CUSTOM_EMOTES_LIBRARY_CAP) {
        alert('You can save up to ' + CUSTOM_EMOTES_LIBRARY_CAP + ' images here — delete one first to add another.');
        return;
      }
      if (file.size > CUSTOM_EMOTES_MAX_FILE_BYTES) {
        alert('That image is ' + (file.size / (1024 * 1024)).toFixed(1) + 'MB — please use one under ' + (CUSTOM_EMOTES_MAX_FILE_BYTES / (1024 * 1024)) + 'MB (these only ever show as a small avatar overlay).');
        return;
      }
      ceReadFileAsDataUrl(file, (dataUrl) => {
        const newId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        state.library.push({ id: newId, dataUrl: dataUrl });
        state.selected = newId; // newly added image becomes active right away
        persist();
        render();
      });
    });

    render();
  }

  function renderCustomEmotesFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Custom Emotes</b><div class="dt-row-detail">Replaces DuelingBook’s own "Thinking" and "Signaled OK" images over the duel avatars. A built-in image is used automatically for each as soon as this is on, until you pick something else — anything you upload stays saved here so you can switch back to it later without re-uploading.</div></div>' +
        switchHtml('ce-master') +
      '</div>' +
      '<div class="dt-ce-slots">' +
        ceSlotHtml('thinking', 'Thinking') +
        ceSlotHtml('ok', 'Signaled OK') +
      '</div>' +
      '<div class="dt-note">Click a thumbnail to make it active. The first image in each row ships with the extension and can’t be deleted. Each image scales to fit DuelingBook’s own overlay box — any image works, no exact size required. Applies to BOTH players’ avatars, as seen on your own screen only.</div>';

    const masterInput = container.querySelector('#ce-master input');
    getSettings(CUSTOM_EMOTES_DEFAULTS, (s) => {
      masterInput.checked = !!s.dt_custom_emotes_enabled;
      ceWireSlot(container, 'thinking', 'dt_custom_emote_thinking_library', 'dt_custom_emote_thinking_selected', {
        library: s.dt_custom_emote_thinking_library, selected: s.dt_custom_emote_thinking_selected
      });
      ceWireSlot(container, 'ok', 'dt_custom_emote_ok_library', 'dt_custom_emote_ok_selected', {
        library: s.dt_custom_emote_ok_library, selected: s.dt_custom_emote_ok_selected
      });
    });
    masterInput.addEventListener('change', (e) => setSetting({ dt_custom_emotes_enabled: e.target.checked }));
  }

  // ── Add Custom Images/Themes/Colors/Emotes (Appearance Customization) ──
  // Parent feature combining four sub-features into one panel, per the
  // user's explicit restructure request: this replaces the old standalone
  // "Custom Themes" and "Custom Colors" stubs and the old standalone
  // "Add Custom Images/Themes" stub (their storage keys are reused below so
  // nothing anyone already toggled is lost), and Custom Emotes — previously
  // its own top-level feature, fully built — moves here to become a sub-
  // feature too. Every sub-feature keeps its own independent enable toggle
  // (all off by default) rather than there being one master switch for the
  // whole parent; opening/closing each sub-panel is purely cosmetic (same
  // accordion pattern as the top-level feature list, just nested one level
  // via the .dt-subfeature CSS variant) and has no effect on its setting.
  // ── Custom Images: Main Menu Splash Image (spec'd out this pass) ───────
  // Confirmed live: the big monster artwork on the pre-"DUEL!" splash
  // screen is one stable element, img#brionac_large (src brionac_small.
  // webp, inside #front_page) — not a randomized pick among several
  // built-in images, as an earlier investigation briefly assumed. Same
  // gallery/upload UI as Custom Emotes above, reused almost as-is, with
  // one difference: Custom Emotes picks ONE active image from its
  // library; here EVERY image in the library (up to 5) participates —
  // dt-main-menu-image.user.js picks a random one of them once per real
  // page load (per the user's explicit follow-up — an earlier version of
  // this cycled sequentially instead). Empty library (the default) leaves
  // DuelingBook's own artwork alone. Also per follow-up: whichever image
  // is shown renders upright (not rotated, unlike the native artwork), and
  // per a later follow-up (an annotated screenshot marking the acceptable
  // area), it's fitted inside a safe open box in the upper-left area of the
  // splash screen instead of being centered on the native artwork's own
  // spot — clear of the Welcome/Forum/Rules links, the DUEL! button, and
  // the bulletin box, computed live from those elements' real on-screen
  // positions (see dt-main-menu-image.user.js's own header for how).
  const CUSTOM_IMAGES_DEFAULTS = {
    dt_custom_images_enabled: false,
    dt_main_splash_images_library: [],
    // "Edit Positioning" — per the user's own follow-up idea: instead of
    // guessing coordinates from an annotated screenshot, let them grab the
    // image live on the real page and drop it exactly where they want it.
    // dt_main_splash_position_mode is 'auto' (the live safe-box fit
    // dt-main-menu-image.user.js computes on its own — see that file's
    // header) until a position is explicitly saved, at which point it
    // flips to 'custom' and dt_main_splash_custom_position holds
    // {leftFrac, topFrac, sizeFrac} — fractions of #front_page's own box,
    // not raw px, so it stays correct across window sizes the same way the
    // auto box does. dt_main_splash_position_edit_mode is a transient
    // signal flag, not a real preference — flipping it true (written
    // straight to storage below, bypassing this page's normal staged-save
    // model on purpose, since it has to reach the OTHER tab immediately)
    // tells dt-main-menu-image.user.js, on whichever DuelingBook tab is
    // open, to drop into an interactive drag/resize mode right there on
    // the page. That content script flips it back to false itself the
    // moment the user clicks Save Position or Cancel there.
    dt_main_splash_position_mode: 'auto',
    dt_main_splash_custom_position: null,
    dt_main_splash_position_edit_mode: false
  };
  Object.assign(ALL_DEFAULTS, CUSTOM_IMAGES_DEFAULTS);
  const MAIN_SPLASH_LIBRARY_CAP = 5;
  const MAIN_SPLASH_MAX_FILE_BYTES = 5 * 1024 * 1024; // this renders at full splash-art size, same cap as the Custom Colors background-image rows

  // Per the user's own follow-up, directly continuing this same "Custom
  // Images" panel: replaces DuelingBook's own circuit-board background
  // (img#circuit_board — confirmed live as ONE persistent element behind
  // every view on the site, not scoped to any one page) with a user-
  // uploaded image. Unlike the Splash Image library above (always random),
  // this one defaults to a single chosen "active" image — same
  // click-a-thumbnail-to-select pattern as Custom Emotes' own library
  // above — with an optional "Cycle Randomly" toggle that switches to the
  // Splash Image feature's random-per-page-load behavior instead. See
  // dt-background-image.user.js for the live DOM findings behind this.
  const BACKGROUND_IMAGE_DEFAULTS = {
    dt_bg_image_enabled: false,
    dt_bg_images_library: [],
    dt_bg_image_active_id: null,
    dt_bg_image_cycle_enabled: false,
    dt_bg_image_brightness: 100
  };
  Object.assign(ALL_DEFAULTS, BACKGROUND_IMAGE_DEFAULTS);
  const BG_IMAGE_LIBRARY_CAP = 5;
  const BG_IMAGE_MAX_FILE_BYTES = 5 * 1024 * 1024;

  function renderCustomImagesFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Main Menu Splash Image</b><div class="dt-row-detail">Replaces the big monster artwork on the pre-"DUEL!" splash screen with your own image(s). Add up to 5 — each time you reload or return to that screen, one of them is picked at random. Shown upright (not rotated like the native artwork), sized to fit a safe open area in the upper-left of the screen — clear of the Welcome/Forum/Rules links, the DUEL! button, and the bulletin box. Leave empty to keep DuelingBook\'s own artwork.</div></div>' +
        switchHtml('mi-master') +
      '</div>' +
      '<div class="dt-ce-slots">' +
        '<div class="dt-ce-slot">' +
          '<div class="dt-ce-slot-label">Splash images <span class="dt-ce-slot-count" id="mi-count"></span></div>' +
          '<div class="dt-ce-gallery" id="mi-gallery"></div>' +
          '<label class="dt-ce-upload-btn">+ Add Image<input type="file" accept="image/*" id="mi-file" style="display:none"></label>' +
        '</div>' +
      '</div>' +
      '<div class="dt-note">Any image works, no exact size required — it scales to fill the same box DuelingBook\'s own artwork does. Click a thumbnail\'s × to remove it; removing all of them restores the native artwork.</div>' +
      '<div class="dt-row" style="margin-top:14px;">' +
        '<div class="dt-row-label"><b>Image Position</b><div class="dt-row-detail">By default the image auto-fits into a safe open area of the screen. Want it exactly where you want instead? Click Edit Positioning below, then switch to your open DuelingBook tab — drag the image to move it, drag its corner handle to resize it, then click Save Position right there on the page. It\'ll stay put every time after that.</div></div>' +
      '</div>' +
      '<div class="dt-row" style="gap:10px; align-items:center;">' +
        '<button type="button" class="dt-cc-reset-theme" id="mi-edit-position">Edit Positioning</button>' +
        '<button type="button" class="dt-cc-reset-theme" id="mi-reset-position" style="display:none;">Reset to Automatic</button>' +
        '<span class="dt-note" id="mi-position-status" style="margin:0;"></span>' +
      '</div>' +
      '<div class="dt-row" style="margin-top:18px; border-top:1px solid var(--border2); padding-top:14px;">' +
        '<div class="dt-row-label"><b>Enable Background Image</b><div class="dt-row-detail">Replaces DuelingBook\'s circuit-board background with your own image — everywhere on the site: Main Menu, Lobby, Duel Room, Deck Constructor, Rankings, all of it. Add up to 5 below and click one to make it active, or flip on Cycle Randomly to re-roll a random one from the library each time the page loads instead.</div></div>' +
        switchHtml('bg-master') +
      '</div>' +
      '<div class="dt-ce-slots">' +
        '<div class="dt-ce-slot">' +
          '<div class="dt-ce-slot-label">Background images <span class="dt-ce-slot-count" id="bg-count"></span></div>' +
          '<div class="dt-ce-gallery" id="bg-gallery"></div>' +
          '<label class="dt-ce-upload-btn">+ Add Image<input type="file" accept="image/*" id="bg-file" style="display:none"></label>' +
        '</div>' +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Brightness</b><div class="dt-row-detail">100% is the image as uploaded. Lower it to dim the background — it fades toward solid black as it approaches 0%, which turns the background off entirely (no image at all).</div></div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input id="bg-brightness" type="range" min="0" max="100" step="5" style="width:120px">' +
          '<span id="bg-brightness-val" style="min-width:34px;text-align:right;font-family:monospace;font-size:12px;color:#9aa">100%</span>' +
        '</div>' +
      '</div>' +
      '<div class="dt-row" style="gap:10px; align-items:center;">' +
        '<div class="dt-row-label"><b>Cycle Randomly</b><div class="dt-row-detail">Off: always shows whichever thumbnail above has the green border. On: picks a random one from the library each time the page loads, same as the Splash Image feature.</div></div>' +
        switchHtml('bg-cycle') +
      '</div>' +
      '<div class="dt-note">Click a thumbnail to make it the active background. Any image works — it\'s stretched to cover the screen behind everything else. Click a thumbnail\'s × to remove it; removing all of them restores DuelingBook\'s own background.</div>' +
      '<div class="dt-row" style="margin-top:18px; border-top:1px solid var(--border2); padding-top:14px;">' +
        '<div class="dt-row-label"><b>Enable Custom Profile Picture</b><div class="dt-row-detail">Replaces YOUR OWN avatar — the bottom player\'s panel, in both live duels and replays — with your own image. Add up to 5 below and click one to make it active. Your opponent\'s avatar is never touched. <b>Local only:</b> DuelingBook only ever sends a plain card reference for an avatar, never an image — so this changes what YOU see on your own screen only.</div></div>' +
        switchHtml('cp-master') +
      '</div>' +
      '<div class="dt-ce-slots">' +
        '<div class="dt-ce-slot">' +
          '<div class="dt-ce-slot-label">Profile images <span class="dt-ce-slot-count" id="cp-count"></span></div>' +
          '<div class="dt-ce-gallery" id="cp-gallery"></div>' +
          '<label class="dt-ce-upload-btn">+ Add Image<input type="file" accept="image/*" id="cp-file" style="display:none"></label>' +
        '</div>' +
      '</div>' +
      '<div class="dt-note">Click a thumbnail to make it your active profile picture. Click a thumbnail\'s × to remove it; removing all of them restores your real DuelingBook avatar.</div>' +
      '<div class="dt-row" style="margin-top:18px; border-top:1px solid var(--border2); padding-top:14px;">' +
        '<div class="dt-row-label"><b>Enable Custom Card Sleeve</b><div class="dt-row-detail">Replaces the back art on YOUR OWN face-down cards — your Deck and Extra Deck zones, Set monsters and Set Spells/Traps, and your hand as your opponent sees it — with your own image. Add up to 5 below and click one to make it active. Your opponent\'s card backs are never touched. <b>Local only</b> — same reasoning as the avatar above.</div></div>' +
        switchHtml('cs-master') +
      '</div>' +
      '<div class="dt-ce-slots">' +
        '<div class="dt-ce-slot">' +
          '<div class="dt-ce-slot-label">Sleeve images <span class="dt-ce-slot-count" id="cs-count"></span></div>' +
          '<div class="dt-ce-gallery" id="cs-gallery"></div>' +
          '<label class="dt-ce-upload-btn">+ Add Image<input type="file" accept="image/*" id="cs-file" style="display:none"></label>' +
        '</div>' +
      '</div>' +
      '<div class="dt-note">Click a thumbnail to make it your active sleeve. Any image works — it\'s scaled to fill the same card-back shape DuelingBook\'s own sleeve art does. Click a thumbnail\'s × to remove it; removing all of them restores your real DuelingBook sleeve.</div>';

    const masterInput = container.querySelector('#mi-master input');
    const gallery = container.querySelector('#mi-gallery');
    const countEl = container.querySelector('#mi-count');
    const fileInput = container.querySelector('#mi-file');
    const editPositionBtn = container.querySelector('#mi-edit-position');
    const resetPositionBtn = container.querySelector('#mi-reset-position');
    const positionStatusEl = container.querySelector('#mi-position-status');
    const state = { library: [] };

    // Direct chrome.storage.local reads/writes for the position controls —
    // deliberately bypassing getSettings()/setSetting()'s staged-save
    // model. Everything else on this page waits for Save/Save & Close on
    // purpose; this doesn't, because "Edit Positioning" has to reach the
    // content script on the live DuelingBook tab right away, and Save/
    // Cancel there write the final result straight to storage themselves
    // too (see dt-main-menu-image.user.js) — staging either side here
    // would just mean clicking the button and nothing happening.
    function refreshPositionStatus() {
      STORAGE.get({
        dt_main_splash_position_mode: 'auto',
        dt_main_splash_position_edit_mode: false
      }, (s) => {
        if (!editPositionBtn.isConnected) return; // panel's been navigated away from — nothing left to update
        const editing = !!s.dt_main_splash_position_edit_mode;
        const custom = s.dt_main_splash_position_mode === 'custom';
        editPositionBtn.disabled = editing || !state.library.length;
        editPositionBtn.textContent = editing ? 'Editing… (go to your DuelingBook tab)' : 'Edit Positioning';
        resetPositionBtn.style.display = custom && !editing ? '' : 'none';
        positionStatusEl.textContent = editing
          ? ''
          : (custom ? 'Position: custom (saved)' : 'Position: automatic');
      });
    }
    editPositionBtn.addEventListener('click', () => {
      if (!state.library.length) { alert('Add at least one image above first.'); return; }
      STORAGE.set({ dt_main_splash_position_edit_mode: true }, refreshPositionStatus);
    });
    resetPositionBtn.addEventListener('click', () => {
      STORAGE.set({ dt_main_splash_position_mode: 'auto', dt_main_splash_custom_position: null }, refreshPositionStatus);
    });
    // Live-refresh this little status strip if the content script on the
    // DuelingBook tab changes any of this out from under us (Save/Cancel
    // there, or the edit-mode flag itself) while this panel happens to
    // still be open. Harmless no-op once this panel's been navigated away
    // from — refreshPositionStatus bails via the isConnected check above.
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.dt_main_splash_position_edit_mode || changes.dt_main_splash_position_mode) refreshPositionStatus();
      });
    }

    function persist() { setSetting({ dt_main_splash_images_library: state.library }); }
    function render() {
      let html = '';
      if (!state.library.length) {
        html = '<div class="dt-ce-thumb-empty">No images added — native artwork stays on.</div>';
      } else {
        state.library.forEach((entry) => {
          html +=
            '<div class="dt-ce-thumb" data-key="' + entry.id + '" title="Remove this image">' +
              '<img src="' + entry.dataUrl + '">' +
              '<button type="button" class="dt-ce-thumb-del" data-key="' + entry.id + '" title="Remove this image">×</button>' +
            '</div>';
        });
      }
      gallery.innerHTML = html;
      countEl.textContent = '(' + state.library.length + '/' + MAIN_SPLASH_LIBRARY_CAP + ' added)';
      refreshPositionStatus(); // library size affects whether Edit Positioning is clickable
    }

    getSettings(CUSTOM_IMAGES_DEFAULTS, (s) => {
      masterInput.checked = !!s.dt_custom_images_enabled;
      state.library = (s.dt_main_splash_images_library || []).slice();
      render();
    });
    masterInput.addEventListener('change', (e) => setSetting({ dt_custom_images_enabled: e.target.checked }));

    gallery.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.dt-ce-thumb-del');
      if (!delBtn) return;
      const key = delBtn.getAttribute('data-key');
      state.library = state.library.filter((entry) => entry.id !== key);
      persist();
      render();
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (state.library.length >= MAIN_SPLASH_LIBRARY_CAP) {
        alert('You can add up to ' + MAIN_SPLASH_LIBRARY_CAP + ' images here — remove one first to add another.');
        return;
      }
      if (file.size > MAIN_SPLASH_MAX_FILE_BYTES) {
        alert('That image is ' + (file.size / (1024 * 1024)).toFixed(1) + 'MB — please use one under ' + (MAIN_SPLASH_MAX_FILE_BYTES / (1024 * 1024)) + 'MB.');
        return;
      }
      ceReadFileAsDataUrl(file, (dataUrl) => {
        const newId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        state.library.push({ id: newId, dataUrl: dataUrl });
        persist();
        render();
      });
    });

    // ── Background Image (sitewide) ───────────────────────────────────────
    // Same gallery mechanics as the Splash Image library above, plus the
    // click-a-thumbnail-to-select pattern Custom Emotes already uses
    // (reusing its .dt-ce-thumb/.selected styling for the same green-
    // border highlight) for picking which ONE image is active when Cycle
    // Randomly is off.
    const bgMasterInput = container.querySelector('#bg-master input');
    const bgCycleInput = container.querySelector('#bg-cycle input');
    const bgGallery = container.querySelector('#bg-gallery');
    const bgCountEl = container.querySelector('#bg-count');
    const bgFileInput = container.querySelector('#bg-file');
    const bgBrightnessInput = container.querySelector('#bg-brightness');
    const bgBrightnessVal = container.querySelector('#bg-brightness-val');
    const bgState = { library: [], activeId: null };

    function bgPersist() {
      setSetting({
        dt_bg_images_library: bgState.library,
        dt_bg_image_active_id: bgState.activeId
      });
    }
    function bgRender() {
      let html = '';
      if (!bgState.library.length) {
        html = '<div class="dt-ce-thumb-empty">No images added — native background stays on.</div>';
      } else {
        bgState.library.forEach((entry) => {
          html +=
            '<div class="dt-ce-thumb' + (bgState.activeId === entry.id ? ' selected' : '') + '" data-key="' + entry.id + '" title="Click to make this the active background">' +
              '<img src="' + entry.dataUrl + '">' +
              '<button type="button" class="dt-ce-thumb-del" data-key="' + entry.id + '" title="Remove this image">×</button>' +
            '</div>';
        });
      }
      bgGallery.innerHTML = html;
      bgCountEl.textContent = '(' + bgState.library.length + '/' + BG_IMAGE_LIBRARY_CAP + ' added)';
    }

    getSettings(BACKGROUND_IMAGE_DEFAULTS, (s) => {
      bgMasterInput.checked = !!s.dt_bg_image_enabled;
      bgCycleInput.checked = !!s.dt_bg_image_cycle_enabled;
      bgState.library = (s.dt_bg_images_library || []).slice();
      bgState.activeId = s.dt_bg_image_active_id || (bgState.library[0] ? bgState.library[0].id : null);
      bgBrightnessInput.value = s.dt_bg_image_brightness;
      bgBrightnessVal.textContent = s.dt_bg_image_brightness + '%';
      bgRender();
    });
    bgMasterInput.addEventListener('change', (e) => setSetting({ dt_bg_image_enabled: e.target.checked }));
    bgCycleInput.addEventListener('change', (e) => setSetting({ dt_bg_image_cycle_enabled: e.target.checked }));
    bgBrightnessInput.addEventListener('input', (e) => { bgBrightnessVal.textContent = e.target.value + '%'; });
    bgBrightnessInput.addEventListener('change', (e) => setSetting({ dt_bg_image_brightness: Number(e.target.value) }));

    bgGallery.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.dt-ce-thumb-del');
      if (delBtn) {
        const key = delBtn.getAttribute('data-key');
        bgState.library = bgState.library.filter((entry) => entry.id !== key);
        if (bgState.activeId === key) bgState.activeId = bgState.library[0] ? bgState.library[0].id : null;
        bgPersist();
        bgRender();
        return;
      }
      const thumb = e.target.closest('.dt-ce-thumb');
      if (thumb) {
        bgState.activeId = thumb.getAttribute('data-key');
        bgPersist();
        bgRender();
      }
    });

    bgFileInput.addEventListener('change', () => {
      const file = bgFileInput.files && bgFileInput.files[0];
      bgFileInput.value = '';
      if (!file) return;
      if (bgState.library.length >= BG_IMAGE_LIBRARY_CAP) {
        alert('You can add up to ' + BG_IMAGE_LIBRARY_CAP + ' images here — remove one first to add another.');
        return;
      }
      if (file.size > BG_IMAGE_MAX_FILE_BYTES) {
        alert('That image is ' + (file.size / (1024 * 1024)).toFixed(1) + 'MB — please use one under ' + (BG_IMAGE_MAX_FILE_BYTES / (1024 * 1024)) + 'MB.');
        return;
      }
      ceReadFileAsDataUrl(file, (dataUrl) => {
        const newId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        bgState.library.push({ id: newId, dataUrl: dataUrl });
        bgState.activeId = newId; // newly added image becomes active right away
        bgPersist();
        bgRender();
      });
    });

    wireCustomProfileGalleries(container);
  }
  // ── Custom Profile: Profile Picture + Card Sleeve (nested inside Custom
  // Images, per the user's own request — "in custom images there with be a
  // sub feature called custom Profile") ──────────────────────────────────
  // Reuses the exact same gallery/upload/click-to-
  // select mechanics as Background Image (one active image at a time, not
  // Custom Emotes'/Splash Image's "every image participates" models).
  // Confirmed live on a real replay before writing this: DuelingBook's own
  // `.duel_avatar img.image` (the bottom-player avatar, same element in a
  // live duel and a replay) and every `img[src*="/sleeves/"]` (the stacked
  // card-back art drawn near the Deck/Extra Deck piles, Set cards, and a
  // hand that isn't yours to see) are both just asset references, exactly
  // like Custom Token Images' own Token art — see
  // dt-custom-profile.user.js's own header for the full live-DOM writeup.
  // Per the user's explicit choice when asked: the sleeve swap only ever
  // touches YOUR OWN card backs — your opponent's stay exactly as
  // DuelingBook renders them, same scope as the avatar (the bottom-player
  // slot only, never the opponent's panel).
  const PROFILE_SLEEVE_DEFAULTS = {
    dt_custom_profile_enabled: false,
    dt_custom_profile_library: [],
    dt_custom_profile_active_id: null,
    dt_custom_sleeve_enabled: false,
    dt_custom_sleeve_library: [],
    dt_custom_sleeve_active_id: null
  };
  Object.assign(ALL_DEFAULTS, PROFILE_SLEEVE_DEFAULTS);
  const PROFILE_LIBRARY_CAP = 5;
  const SLEEVE_LIBRARY_CAP = 5;
  const PROFILE_SLEEVE_MAX_FILE_BYTES = 5 * 1024 * 1024;

  function wireCustomProfileGalleries(container) {
    function wireGallery(opts) {
      const masterInput = container.querySelector('#' + opts.prefix + '-master input');
      const gallery = container.querySelector('#' + opts.prefix + '-gallery');
      const countEl = container.querySelector('#' + opts.prefix + '-count');
      const fileInput = container.querySelector('#' + opts.prefix + '-file');
      const state = { library: [], activeId: null };

      function persist() {
        setSetting({
          [opts.libraryKey]: state.library,
          [opts.activeKey]: state.activeId
        });
      }
      function render() {
        let html = '';
        if (!state.library.length) {
          html = '<div class="dt-ce-thumb-empty">' + opts.emptyText + '</div>';
        } else {
          state.library.forEach((entry) => {
            html +=
              '<div class="dt-ce-thumb' + (state.activeId === entry.id ? ' selected' : '') + '" data-key="' + entry.id + '" title="' + opts.selectTitle + '">' +
                '<img src="' + entry.dataUrl + '">' +
                '<button type="button" class="dt-ce-thumb-del" data-key="' + entry.id + '" title="Remove this image">×</button>' +
              '</div>';
          });
        }
        gallery.innerHTML = html;
        countEl.textContent = '(' + state.library.length + '/' + opts.cap + ' added)';
      }

      getSettings(PROFILE_SLEEVE_DEFAULTS, (s) => {
        masterInput.checked = !!s[opts.enabledKey];
        state.library = (s[opts.libraryKey] || []).slice();
        state.activeId = s[opts.activeKey] || (state.library[0] ? state.library[0].id : null);
        render();
      });
      masterInput.addEventListener('change', (e) => setSetting({ [opts.enabledKey]: e.target.checked }));

      gallery.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.dt-ce-thumb-del');
        if (delBtn) {
          const key = delBtn.getAttribute('data-key');
          state.library = state.library.filter((entry) => entry.id !== key);
          if (state.activeId === key) state.activeId = state.library[0] ? state.library[0].id : null;
          persist();
          render();
          return;
        }
        const thumb = e.target.closest('.dt-ce-thumb');
        if (thumb) {
          state.activeId = thumb.getAttribute('data-key');
          persist();
          render();
        }
      });

      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        if (state.library.length >= opts.cap) {
          alert('You can add up to ' + opts.cap + ' images here — remove one first to add another.');
          return;
        }
        if (file.size > PROFILE_SLEEVE_MAX_FILE_BYTES) {
          alert('That image is ' + (file.size / (1024 * 1024)).toFixed(1) + 'MB — please use one under ' + (PROFILE_SLEEVE_MAX_FILE_BYTES / (1024 * 1024)) + 'MB.');
          return;
        }
        ceReadFileAsDataUrl(file, (dataUrl) => {
          const newId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          state.library.push({ id: newId, dataUrl: dataUrl });
          state.activeId = newId; // newly added image becomes active right away
          persist();
          render();
        });
      });
    }

    wireGallery({
      prefix: 'cp', cap: PROFILE_LIBRARY_CAP,
      enabledKey: 'dt_custom_profile_enabled', libraryKey: 'dt_custom_profile_library', activeKey: 'dt_custom_profile_active_id',
      emptyText: 'No images added — your real DuelingBook avatar stays on.',
      selectTitle: 'Click to make this your active profile picture'
    });
    wireGallery({
      prefix: 'cs', cap: SLEEVE_LIBRARY_CAP,
      enabledKey: 'dt_custom_sleeve_enabled', libraryKey: 'dt_custom_sleeve_library', activeKey: 'dt_custom_sleeve_active_id',
      emptyText: 'No images added — your real DuelingBook sleeve stays on.',
      selectTitle: 'Click to make this your active sleeve'
    });
  }

  // ── Custom Colors (sub-feature) ─────────────────────────────────────────
  // UI SCAFFOLD ONLY for now, per the user's own explicit call: build the
  // whole panel first — every row from their mockup — then go section by
  // section wiring each one to actually repaint the live DuelingBook page.
  // NOTHING here touches duelingbook.com yet; that happens one section at a
  // time in a follow-up pass, verified live each time (same practice as
  // every other feature in this file). Every row is its own independent
  // staged setting (color + opacity, and an optional background image on
  // rows the mockup shows a "Load image" button for) with its own Reset;
  // "Enable Custom Colors" is the pre-existing dt_custom_colors_enabled key
  // (kept from when this was a stub), "Show Background Grid Lines" is new.
  // The Themes dropdown is intentionally inert beyond "Default" — theme
  // presets are a separate follow-up, not part of this pass.
  function hexToRgbStr(hex) {
    const h = (hex || '#000000').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    return 'rgb(' + r + ', ' + g + ', ' + b + ')';
  }
  function rgbStrToHex(str) {
    const v = (str || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
    if (!m) return null;
    const toHex = (n) => Math.max(0, Math.min(255, parseInt(n, 10) || 0)).toString(16).padStart(2, '0');
    return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
  }

  const CUSTOM_COLORS_MAX_FILE_BYTES = 5 * 1024 * 1024; // backgrounds can be bigger than an avatar emote, still capped

  const CUSTOM_COLOR_SECTIONS = [
    {
      id: 'roomPanels', label: 'Duel Room Customization',
      // Rows 1-10 below are panel-specific and have THREE independently
      // colorable parts, per the user's explicit follow-up spec:
      //   - fill (color/opacity: existing) + an optional background image
      //   - border — confirmed live as a separate gradient on the panel's
      //     own ::before pseudo-element; here it's simplified to one flat
      //     color + opacity (DB's own two-tone gradient's first stop is
      //     the default color below)
      //   - text — ONE color covering every text element the panel shows
      //     (confirmed live: .username_txt/.rating_txt/.game_type inside
      //     every panel's duel list, PLUS — only on the Ranked panel,
      //     since it alone has this content — .desc_txt/.format_lbl/
      //     .rules_lbl/.type_lbl/.join_btn). No opacity/transparent on
      //     text, per the user's explicit "not the text".
      // fill and border each also get a "Fully Transparent" quick toggle
      // instead of having to drag opacity all the way to 0.
      // Rows after that (no `border` field — that's what the render loop
      // below uses to tell the two row shapes apart) were merged in from
      // the old standalone "Duel Room" section per the user's explicit
      // "all of the features should be added to Room panels and Room
      // panels should be renamed to Duel Room Customization" request.
      // That section's 5th row, "Room panel body text", was dropped on the
      // user's own call: it's the same content the per-panel Text Color
      // above already covers (the Duelist-Pool-style hosted-duel list
      // text), so keeping it would've just been a duplicate control.
      //
      // deckPanel/modePanel/filterSortPanel/hostADuelPanel (added next,
      // confirmed live) are fill+border only — no `text` and no `image`
      // field, so ccRoomRowHtml/ccWireRoomRow skip rendering/wiring those
      // two groups for them (guarded on field presence). Confirmed live:
      // #decklist / #mode / #filter / #host_bg each have the exact same
      // structure as a format panel — a direct-child .border div (its own
      // background-color IS the translucent "inside" fill the mockup
      // shows, and its ::before carries the same two-tone-gradient-flattened-
      // to-one-color border treatment as the 10 rows above).
      //
      // Per the user's explicit follow-up: the bold TITLE text of every one
      // of those 4 (plus all 10 format panels) is now one shared setting,
      // "Room panel titles" — "Host a Duel heading" (previously its own
      // row) was folded into it, since it's the exact same title style.
      // "Host a Duel form labels" was likewise widened into the broader
      // "Host a Duel Text Colors" below (labels + buttons + the Joining
      // Duel/waiting-for-host bubble + the hosting-side waiting room, all
      // confirmed live as descendants of #host_bg), replacing the
      // narrower label-only row. New simple text rows for Filter/Sort,
      // Mode, and the Deck panel follow the same one-flat-color-for-
      // everything-in-that-box approach.
      rows: [
        { id: 'rankedRoom', label: 'Ranked room panel', color: '#b7daff', opacity: 80, image: '4:3', border: '#0066cc', text: '#000000' },
        { id: 'advancedRoom', label: 'Advanced (Unrated) room panel', color: '#a6edd6', opacity: 80, image: '4:3', border: '#33b801', text: '#000000' },
        { id: 'genesysRoom', label: 'Genesys Format room panel', color: '#ffd0b7', opacity: 80, image: '4:3', border: '#0099ff', text: '#000000' },
        { id: 'goatRoom', label: 'Goat Format room panel', color: '#d5b9ff', opacity: 80, image: '4:3', border: '#6600ff', text: '#000000' },
        { id: 'edisonRoom', label: 'Edison Format room panel', color: '#fff4a1', opacity: 80, image: '4:3', border: '#ffb801', text: '#000000' },
        { id: 'customCardsRoom', label: 'Custom Cards room panel', color: '#b7daff', opacity: 80, image: '4:3', border: '#0099ff', text: '#000000' },
        { id: 'speedDuelsRoom', label: 'Speed Duels room panel', color: '#cefae1', opacity: 80, image: '4:3', border: '#00ff00', text: '#000000' },
        { id: 'rushDuelsRoom', label: 'Rush Duels room panel', color: '#ffdbc4', opacity: 80, image: '4:3', border: '#ff6600', text: '#000000' },
        { id: 'unlimitedRoom', label: 'Unlimited room panel', color: '#efefef', opacity: 80, image: '4:3', border: '#666666', text: '#000000' },
        { id: 'traditionalRoom', label: 'Traditional room panel', color: '#ffc8de', opacity: 80, image: '4:3', border: '#ff3366', text: '#000000' },
        { id: 'deckPanel', label: 'Deck panel', color: '#282718', opacity: 20, border: '#ff6700', detail: 'The box around your deck selector and "Set as Default" button, lower-left of the lobby.' },
        { id: 'modePanel', label: 'Mode panel', color: '#282718', opacity: 20, border: '#6633ff', detail: 'The box around the Duel/Watch mode picker.' },
        { id: 'filterSortPanel', label: 'Filter/Sort panel', color: '#282718', opacity: 20, border: '#0066cc', detail: 'The box around the Username/Search Card/Match Type/Sort By filters.' },
        { id: 'hostADuelPanel', label: 'Host a Duel panel', color: '#282718', opacity: 20, border: '#33b801', detail: 'The box around the whole Host a Duel form (and its hosting-wait/joining-wait screens).' },
        { id: 'carouselArrows', label: 'Room carousel arrow buttons', color: '#cccccc', opacity: 100, detail: 'The ◀ ▶ buttons that page through these panels.' },
        { id: 'roomPanelTitles', label: 'Room panel titles (all panels)', color: '#ffffff', opacity: 100, detail: 'The big bold heading on every panel above — Duelist Pool, Goat Format, Edison Format, etc., plus Deck / Mode / Filter-Sort / Host a Duel (and "Joining Duel" while joining).' },
        { id: 'hostDuelTextColors', label: 'Host a Duel text colors', color: '#ffffff', opacity: 100, detail: 'Every label and button inside the Host a Duel panel: Format:/Type:/Rules:/Expert/Duel Note:/Duel Password:/Watching/Classic/Tag Duel/Watch Note:/Watch Password:, the Host Duel/Cancel Duel/Accept User/Reject User/Leave Duel buttons, and the "Waiting for..." text.' },
        { id: 'filterSortTextColors', label: 'Filter/Sort text colors', color: '#ffffff', opacity: 100, detail: 'Username:/Search Card:/Match Type:/Sort By:/Rules:/Style: and the rating/experience range labels in the Filter/Sort panel.' },
        { id: 'modeTextColors', label: 'Mode text colors', color: '#ffffff', opacity: 100, detail: 'The "Duel" and "Watch" radio button labels in the Mode panel.' },
        { id: 'deckPanelTextColors', label: 'Deck panel text colors', color: '#000000', opacity: 100, detail: 'The selected deck\'s name and the "Set as Default" button in the Deck panel.' },
        { id: 'hostDuelWidgetColors', label: 'Host a Duel button/dropdown colors', color: '#36cc00', opacity: 75, widgetAccent: true, detail: 'The solid color behind every dropdown (Format/Type/Rules) and button (Host Duel/Cancel Duel/Accept/Reject/Leave) in the Host a Duel panel. Native DuelingBook green.' },
        { id: 'filterSortWidgetColors', label: 'Filter/Sort dropdown colors', color: '#0099ff', opacity: 75, widgetAccent: true, detail: 'The solid color behind the Match Type and Sort By dropdowns in the Filter/Sort panel. Native DuelingBook blue.' },
        { id: 'modeWidgetColors', label: 'Mode radio button colors', color: '#6600cc', opacity: 75, widgetAccent: true, detail: 'The solid fill of the Duel/Watch radio buttons in the Mode panel. Native DuelingBook purple.' },
        { id: 'deckWidgetColors', label: 'Deck button/dropdown colors', color: '#ff3300', opacity: 75, widgetAccent: true, detail: 'The solid color behind the deck selector dropdown and the "Set as Default" button. Native DuelingBook orange.' }
      ]
    },
    {
      // Confirmed live this pass: the splash screen before "DUEL!" is
      // #front_page (NOT #start, despite that being the id this project
      // assumed earlier — #start turned out to be an unrelated/empty
      // frame; #front_page holds the logo, the Welcome/Forum/Rules/Blog/
      // Skip Intro links in #welcome_buttons, the #bulletin_txt box, and
      // #login_box). "Main Menu" (post-"DUEL!", #main_menu) shares the
      // same circuit-pattern page background, so one tint/image row here
      // covers both screens at once.
      id: 'mainInterface', label: 'Main Menu — Front Page',
      rows: [
        { id: 'frontPageBg', label: 'Page background tint', color: '#000000', opacity: 25, image: '16:9', detail: 'A tint (and, optionally, your own full-page background image) laid over DuelingBook\'s animated circuit-pattern background — behind everything else, on both the pre-"DUEL!" splash screen and the Main Menu itself.' },
        { id: 'welcomeBulletinBg', label: 'Welcome bulletin background', color: '#ffffff', opacity: 100, detail: 'The white "Welcome to Duelingbook!" news box on the splash screen.' },
        { id: 'welcomeBulletinText', label: 'Welcome bulletin text', color: '#000000', opacity: 100 },
        { id: 'loggedInBoxBg', label: '"Logged in as" box background', color: '#d4d4d4', opacity: 100, detail: 'The gray box showing your username on the splash screen, with Logout/Switch Account below it.' },
        { id: 'loggedInText', label: '"Logged in as" box text', color: '#ffffff', opacity: 100 },
        { id: 'mainMenuHeading', label: '"Main Menu" heading', color: '#ffffff', opacity: 100, detail: 'The big title once you click DUEL! and land on the Main Menu.' }
      ]
    },
    {
      id: 'navAccents', label: 'Main Menu — Nav Buttons',
      rows: [
        { id: 'navButtonBorder', label: 'Left-nav button borders', color: '#00ffff', opacity: 100, widgetAccent: true, detail: 'Duel Room / Deck Constructor / Profile Viewer / My Profile / Rankings / Tournaments / Settings / Messages / Friends, etc. — every button down the left side of the Main Menu. Native DuelingBook cyan (Exit/Settings keep their own gold/red accent either way).' },
        { id: 'navButtonFill', label: 'Left-nav button fill', color: '#00ffff', opacity: 12, widgetAccent: true, detail: 'A subtle tint behind those same buttons (they\'re transparent natively).' },
        { id: 'navButtonText', label: 'Left-nav button text', color: '#ffffff', opacity: 100 },
        { id: 'welcomeLink', label: 'Welcome link', color: '#ffaadd', opacity: 100 },
        { id: 'forumLink', label: 'Forum link', color: '#66ccff', opacity: 100 },
        { id: 'rulesLink', label: 'Rules link', color: '#90fc98', opacity: 100 },
        { id: 'blogLink', label: 'Blog link', color: '#ff9933', opacity: 100 },
        { id: 'skipIntroText', label: '"Skip Intro" link', color: '#ffffff', opacity: 100 },
        { id: 'privacyPolicyLink', label: 'Privacy Policy link', color: '#0077ff', opacity: 100 }
      ]
    },
    {
      // Confirmed live: every status post in the Main Menu's center feed
      // is a repeated #statuses_content .status block — avatar, username
      // (.username_txt), timestamp (.date_txt), like/dislike buttons +
      // counts, body text (.status_txt), and a .reply_btn. "All Statuses"
      // is a real native <select id="status_cb">, so it gets the same
      // .combobox_background widget-accent treatment as every dropdown
      // elsewhere in this extension. "Post Status" is a native .button.
      id: 'mainMenuFeed', label: 'Main Menu — Status Feed',
      rows: [
        { id: 'statusUsernameText', label: 'Poster username', color: '#ffffcc', opacity: 100 },
        { id: 'statusDateText', label: 'Post timestamp ("3 minutes ago")', color: '#ffffff', opacity: 100 },
        { id: 'statusBodyText', label: 'Post body text', color: '#ffffff', opacity: 100 },
        { id: 'statusReplyText', label: '"Reply" link', color: '#0077ff', opacity: 100 },
        { id: 'statusLikeDislikeText', label: 'Like/dislike counts', color: '#ffffff', opacity: 100 },
        { id: 'statusDropdownWidget', label: '"All Statuses" dropdown color', color: '#0099ff', opacity: 75, widgetAccent: true },
        { id: 'postStatusWidget', label: '"Post Status" button color', color: '#36cc00', opacity: 75, widgetAccent: true },
        { id: 'postStatusLink', label: '"Post Status" button text', color: '#0077ff', opacity: 100 }
      ]
    },
    {
      // Confirmed live: the Main Menu's right-side panel swaps between
      // three screens as you page the center carousel's 3 dots
      // (#main_menu_circles .main_menu_circle .background) — Official
      // Tourneys (#tourney_sidebar, dot 1), Streams (#streams, dot 2,
      // alongside a video-thumbnail grid in #videos0 whose titles are
      // .title_txt.cyan links), and a real (non-iframe) Discord member
      // list (#widget, dot 3). None of the three have their own
      // border/fill panel — they sit directly on the page background —
      // so every row here is text-only plus the shared dot color.
      id: 'mainMenuPanels', label: 'Main Menu — Side Panels',
      rows: [
        { id: 'carouselDots', label: 'Carousel page dots', color: '#ffffff', opacity: 80 },
        { id: 'tourneyHeadingText', label: 'Official Tourneys heading', color: '#ffffff', opacity: 100 },
        { id: 'tourneyBodyText', label: 'Tournament description text', color: '#ffffff', opacity: 100 },
        { id: 'tourneyLinkText', label: 'Tournament format links', color: '#0077ff', opacity: 100 },
        { id: 'streamsHeadingText', label: 'Streams heading', color: '#ffffff', opacity: 100 },
        { id: 'videoLinkText', label: 'Video titles', color: '#0077ff', opacity: 100 },
        { id: 'discordPanelText', label: 'Discord member list text', color: '#ffffff', opacity: 100 }
      ]
    },
    {
      // Confirmed live this pass: .deck_lbl/.side_lbl/.extra_lbl (the
      // vertical "DECK"/"SIDE"/"EXTRA" text) sit on .deck_bg/.side_bg/
      // .extra_bg respectively — confirmed live these are real elements
      // with their own native translucent fill (rgba(153,0,204,.6) /
      // rgba(0,204,255,.75) / rgba(255,121,0,.85)), now its own row —
      // mainDeckSection/sideDeckSection/extraDeckSection — separate from
      // the grid-line rows below (an earlier pass here had conflated the
      // two: the grid lines are drawn by each card slot's own border, a
      // completely different element, fixed and split apart once seen
      // live). deckDropdownBg targets every real `<select>` in the Deck
      // Constructor (Card/Type/Attrib/Limit/Order in the Search panel,
      // plus the deck-name/folder pickers) — confirmed live these are
      // genuine native selects with their own white background, not a
      // decorative overlay div the way some of DuelingBook's other
      // dropdowns work. searchPanelBg: the SEARCH panel's own fill lives
      // on a `.search_bg` sibling, same "real fill is a .background-like
      // sibling div" convention already documented in dt-custom-colors-
      // main.user.js's header.
      id: 'deckConstructor', label: 'Deck Constructor',
      rows: [
        { id: 'mainDeckLabel', label: '"DECK" label text', color: '#000000', opacity: 100 },
        { id: 'sideDeckLabel', label: '"SIDE" label text', color: '#000000', opacity: 100 },
        { id: 'extraDeckLabel', label: '"EXTRA" label text', color: '#000000', opacity: 100 },
        { id: 'deckDropdownBg', label: 'Deck Constructor dropdown backgrounds', color: '#efefef', opacity: 100 },
        { id: 'mainDeckSection', label: 'Main Deck section background', color: '#9900cc', opacity: 60 },
        { id: 'sideDeckSection', label: 'Side Deck section background', color: '#00ccff', opacity: 75 },
        { id: 'extraDeckSection', label: 'Extra Deck section background', color: '#ff7900', opacity: 85 },
        { id: 'mainDeckGrid', label: 'Main Deck grid lines', color: '#8601b3', opacity: 100 },
        { id: 'sideDeckGrid', label: 'Side Deck grid lines', color: '#0099ff', opacity: 100 },
        { id: 'extraDeckGrid', label: 'Extra Deck grid lines', color: '#ff7500', opacity: 100 },
        { id: 'searchPanelBg', label: 'Search panel background', color: '#c3ff00', opacity: 75 }
      ]
    },
    {
      id: 'rankings', label: 'Rankings',
      rows: [
        { id: 'rankByRating', label: 'Rankings — By Rating tab', color: '#ccff99', opacity: 100 },
        { id: 'rankByWins', label: 'Rankings — By Wins tab', color: '#ffcccc', opacity: 100 },
        { id: 'rankByExperience', label: 'Rankings — By Experience tab', color: '#9fe0ff', opacity: 100 },
        { id: 'rankByTotalExperience', label: 'Rankings — By Total Experience tab', color: '#ffff99', opacity: 100 }
      ]
    },
    {
      id: 'duelInterface', label: 'Duel interface',
      rows: [
        { id: 'sidingOverlay', label: 'Siding instruction overlay', color: '#000000', opacity: 65 },
        { id: 'watchersPanelBg', label: 'Watchers panel background', color: '#ffffff', opacity: 100 },
        { id: 'phaseButtons', label: 'Active phase highlight (DP/SP/M1/BP/M2/EP)', color: '#ff0000', opacity: 100 },
        { id: 'lifePointsBorder', label: 'Life Points box border', color: '#000000', opacity: 100 },
        { id: 'lifePointsBar', label: 'Life Points bar fill', color: '#ffffff', opacity: 100 },
        { id: 'avatarBorder', label: 'Player avatar panel border', color: '#ff0000', opacity: 100 },
        { id: 'zoneGridMine', label: 'Your duel zone grid (monster/spell-trap/pendulum zones, your side)', color: '#9900ff', opacity: 100 },
        { id: 'zoneGridOpponent', label: "Opponent's duel zone grid (monster/spell-trap/pendulum zones, their side)", color: '#00b400', opacity: 100 },
        // Confirmed live as a separate image (field_decks.svg) from the
        // main zone grid above — the Deck Zone and Extra Deck Zone corner
        // boxes (top corners = opponent's, bottom corners = yours) share
        // one outline color per side, same two-gradient-sweep approach.
        { id: 'deckZoneMine', label: 'Your Deck / Extra Deck zone boxes', color: '#9900ff', opacity: 100 },
        { id: 'deckZoneOpponent', label: "Opponent's Deck / Extra Deck zone boxes", color: '#00b400', opacity: 100 },
        // Added per the user's own follow-up, directly after Custom Token
        // Images: the Token picker's own modal background — confirmed live
        // (before the DuelingBook tab's connection dropped mid-check):
        // #token_select .background_inner > .background, native
        // rgb(153,51,204). Same modal opens from both the Deck Constructor's
        // Token button and a live duel's Token button (click-and-hold).
        { id: 'tokenMenuBg', label: 'Token menu background', color: '#9933cc', opacity: 100 }
      ]
    }
  ];

  const CUSTOM_COLORS_MASTER_DEFAULTS = {
    dt_custom_colors_enabled: false,
    dt_custom_colors_grid_lines: true,
    dt_custom_colors_remove_glow: true
  };
  const CUSTOM_COLORS_ROW_DEFAULTS = {};
  CUSTOM_COLOR_SECTIONS.forEach((sec) => sec.rows.forEach((row) => {
    CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_color'] = row.color;
    CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_opacity'] = row.opacity;
    if (row.image) CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_image'] = null;
    // Room panels only: fill gets a "Fully Transparent" quick toggle, plus
    // a whole separate border (color+opacity+transparent) and a flat text
    // color (no opacity — never transparent, per the user's explicit call).
    if (row.border) {
      CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_fillTransparent'] = false;
      CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_borderColor'] = row.border;
      CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_borderOpacity'] = 100;
      CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_borderTransparent'] = false;
    }
    if (row.text) CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_textColor'] = row.text;
  }));
  Object.assign(ALL_DEFAULTS, CUSTOM_COLORS_MASTER_DEFAULTS, CUSTOM_COLORS_ROW_DEFAULTS);

  // ── Theme Selector (sub-feature, renamed from the old "Custom Themes"
  // stub per the user's explicit spec) ────────────────────────────────────
  // A theme is a snapshot of every Custom Colors row (color + opacity +
  // image) at the moment "Save as New Theme" (in the Custom Colors panel,
  // below) is clicked — up to CUSTOM_THEMES_MAX at a time, each Load-able
  // or Delete-able from here. Same staged-save model as everything else on
  // this page: Load/Delete/Save-as-New-Theme all just call setSetting(),
  // nothing is permanent until the page's own Save/Save & Close is clicked.
  // UI only for now, same as the rest of Custom Colors — there's nothing to
  // actually apply live yet until Custom Colors itself is wired up.
  const CUSTOM_THEMES_MAX = 5;
  const CUSTOM_THEMES_LIST_DEFAULTS = { dt_custom_themes_list: [] };
  Object.assign(ALL_DEFAULTS, CUSTOM_THEMES_LIST_DEFAULTS);

  function ctSnapshotCurrentColors(cb) {
    getSettings(CUSTOM_COLORS_ROW_DEFAULTS, (s) => {
      const snap = {};
      Object.keys(CUSTOM_COLORS_ROW_DEFAULTS).forEach((k) => { snap[k] = s[k]; });
      cb(snap);
    });
  }

  // ── Built-in Default Themes ──────────────────────────────────────────────
  // Ported per the user's explicit request ("bring over the other theme
  // features" from a different, unrelated extension they showed via 7
  // screenshots of its own theme-picker list). That list showed ~62 named
  // themes, each with its own small multi-color preview swatch, plus a
  // pinned "Default" entry at the top — no actual color-application logic
  // was visible to port (it's a different extension's UI, not ours), so
  // per the user's own framing ("do what you think this does color wise,
  // it should look good and features the colors shown") the exact 4-color
  // palette for every theme below was extracted pixel-for-pixel from those
  // screenshots (Python/PIL sampling of each swatch's flat color bands,
  // cross-checked against the one image-to-image overlap this session
  // found — Smoky Amethyst through Turquoise Amber appeared in both the
  // 6th and 7th screenshots with identical sampled colors, confirming the
  // extraction), and how each palette maps onto OUR rows (fills/borders/
  // text across every Custom Colors section, not just the live Duel Room
  // one) is this project's own original design — see buildThemeColors()
  // below. Picking one just stages the exact same dt_cc_* keys a manually
  // saved Custom Theme would (see ctSnapshotCurrentColors above) — nothing
  // new to apply live, it reuses 100% of the existing Custom Colors
  // plumbing. "Default" (palette: null) re-stages CUSTOM_COLORS_ROW_DEFAULTS
  // itself, i.e. this extension's own built-in colors.
  const DEFAULT_THEMES = [
    { id: 'default', name: 'Default', palette: null },
    { id: 'amberEmber', name: "Amber Ember", palette: ['#241610', '#38251b', '#ffc071', '#ffcab4'] },
    { id: 'antiqueGold', name: "Antique Gold", palette: ['#211c12', '#342c1b', '#ebd28b', '#b9d8d0'] },
    { id: 'aquaChampagne', name: "Aqua Champagne", palette: ['#142631', '#243b49', '#a6dce8', '#ebdcb2'] },
    { id: 'ashClay', name: "Ash & Clay", palette: ['#201f25', '#33313b', '#e7b596', '#cfc2dd'] },
    { id: 'blueberryRose', name: "Blueberry Rose", palette: ['#1c2232', '#2e384d', '#bccef6', '#f2bbd5'] },
    { id: 'blueprintBlue', name: "Blueprint Blue", palette: ['#132334', '#20364b', '#a9d9ff', '#ecd5a4'] },
    { id: 'burgundyBlush', name: "Burgundy Blush", palette: ['#2a1824', '#40293a', '#f0aec7', '#ebc89c'] },
    { id: 'chartreuseCopper', name: "Chartreuse Copper", palette: ['#21271c', '#333f2b', '#d2e7a6', '#e4c4a4'] },
    { id: 'citronLilac', name: "Citron Lilac", palette: ['#20231b', '#33392a', '#dce998', '#dbbfe9'] },
    { id: 'copperPatina', name: "Copper Patina", palette: ['#251a14', '#3b2a20', '#f0b17f', '#9ad7ca'] },
    { id: 'coralIndigo', name: "Coral Indigo", palette: ['#281b20', '#3d2930', '#ffc4a4', '#c2ddf2'] },
    { id: 'cottonCandy', name: "Cotton Candy", palette: ['#241c32', '#3a2d48', '#f1b6de', '#a8ddec'] },
    { id: 'cyanCopper', name: "Cyan Copper", palette: ['#0b2027', '#123540', '#f8ba87', '#80e4f2'] },
    { id: 'denimPeach', name: "Denim Peach", palette: ['#1b2030', '#2d354b', '#f5caa3', '#bacff4'] },
    { id: 'duskBronze', name: "Dusk & Bronze", palette: ['#121d30', '#233149', '#bacff6', '#e4c39a'] },
    { id: 'emeraldCanopy', name: "Emerald Canopy", palette: ['#071d14', '#123424', '#74e4a5', '#c3de89'] },
    { id: 'fallMin', name: "Fall (minimalist)", palette: ['#29170f', '#8ca35b', '#e46f2e', '#d9a441'] },
    { id: 'fernLavender', name: "Fern Lavender", palette: ['#17261f', '#263e31', '#dcc4e8', '#bde4ba'] },
    { id: 'frostedLilac', name: "Frosted Lilac", palette: ['#162335', '#26394f', '#c9e3ff', '#d5c6f5'] },
    { id: 'glacierRose', name: "Glacier Rose", palette: ['#16232a', '#263842', '#b6e2ea', '#e9c1d0'] },
    { id: 'ivoryWisteria', name: "Ivory Wisteria", palette: ['#26211c', '#3b352c', '#e8dcc0', '#cab6dd'] },
    { id: 'jadeStone', name: "Jade Stone", palette: ['#0e2526', '#1c3b3b', '#e1ceab', '#9ad9cf'] },
    { id: 'lagoonMist', name: "Lagoon Mist", palette: ['#102832', '#1e3d47', '#9bdce3', '#d4e6bd'] },
    { id: 'lavenderIce', name: "Lavender Ice", palette: ['#171726', '#252638', '#d6bdff', '#83d6ec'] },
    { id: 'lilacLime', name: "Lilac Lime", palette: ['#231c32', '#382e4b', '#e6beff', '#acedcf'] },
    { id: 'limeLinen', name: "Lime & Linen", palette: ['#152219', '#23382a', '#c3e995', '#e7d6aa'] },
    { id: 'limestoneBlue', name: "Limestone Blue", palette: ['#24221b', '#3c382a', '#bbd1e5', '#d9d3a2'] },
    { id: 'mintBrass', name: "Mint & Brass", palette: ['#0c1724', '#15283b', '#f4c76b', '#79e7c4'] },
    { id: 'mossMauve', name: "Moss & Mauve", palette: ['#22251d', '#353d2c', '#d3dfac', '#c9bcd9'] },
    { id: 'mulberryGold', name: "Mulberry Gold", palette: ['#291b23', '#402b36', '#ebd0a1', '#e7b6ce'] },
    { id: 'oatmilkLilac', name: "Oatmilk Lilac", palette: ['#252018', '#383226', '#e1cba4', '#c9c4e9'] },
    { id: 'oceanBlue', name: "Ocean Blue", palette: ['#081b2b', '#12374d', '#80d9ff', '#93e7d6'] },
    { id: 'oliveSteel', name: "Olive Steel", palette: ['#1e2224', '#30383a', '#96d4e6', '#d5df8d'] },
    { id: 'orchidMint', name: "Orchid Mint", palette: ['#231d29', '#352c40', '#d5b6ef', '#9de7d9'] },
    { id: 'peachSorbet', name: "Peach Sorbet", palette: ['#2d1f1d', '#42302b', '#ffd0ad', '#ebc1d9'] },
    { id: 'pearlInk', name: "Pearl & Ink", palette: ['#090b0e', '#20242a', '#e5e7eb', '#abb2bc'] },
    { id: 'periwinkleGold', name: "Periwinkle Gold", palette: ['#191d29', '#292e43', '#b7c8ff', '#f0d991'] },
    { id: 'pewterCopper', name: "Pewter Copper", palette: ['#202630', '#323f4e', '#e5c5a9', '#c5d8ec'] },
    { id: 'pistachioCream', name: "Pistachio Cream", palette: ['#17291f', '#263f30', '#f2d4a2', '#c9e3b2'] },
    { id: 'porcelainLilac', name: "Porcelain Lilac", palette: ['#19272b', '#2b3d43', '#dcc5ec', '#cbebe8'] },
    { id: 'rainySage', name: "Rainy Sage", palette: ['#172328', '#293940', '#aed5db', '#c7d5a7'] },
    { id: 'rosewaterBlue', name: "Rosewater Blue", palette: ['#251722', '#392636', '#ffaccb', '#b5ddef'] },
    { id: 'royalViolet', name: "Royal Violet", palette: ['#150d28', '#2b1a47', '#d5b3ff', '#f4d88a'] },
    { id: 'sageMoss', name: "Sage & Moss", palette: ['#10211d', '#1b352d', '#86d9ae', '#d6dea6'] },
    { id: 'salmonSeafoam', name: "Salmon Seafoam", palette: ['#282024', '#3d3038', '#f4afa3', '#aeddd6'] },
    { id: 'seafoamCream', name: "Seafoam Cream", palette: ['#112420', '#1b3832', '#9de4d0', '#d6e8c0'] },
    { id: 'silverSand', name: "Silver Sand", palette: ['#1c2026', '#2a323c', '#edd8ab', '#bad1e4'] },
    { id: 'skySand', name: "Sky & Sand", palette: ['#152331', '#25394b', '#a5dcf3', '#f1cfac'] },
    { id: 'slateAlmond', name: "Slate & Almond", palette: ['#1e2330', '#30394c', '#c4d4f3', '#d9c8b0'] },
    { id: 'smokyAmethyst', name: "Smoky Amethyst", palette: ['#1d1930', '#2f2946', '#cdbfeb', '#afcfe3'] },
    { id: 'springMin', name: "Spring (minimalist)", palette: ['#17251f', '#80c7d9', '#ff8fb3', '#a7d676'] },
    { id: 'steelApricot', name: "Steel Apricot", palette: ['#181b23', '#2a2f3a', '#f1b793', '#bdddf2'] },
    { id: 'summerMin', name: "Summer (minimalist)", palette: ['#062a38', '#39c6d6', '#ff6f61', '#ffd166'] },
    { id: 'sunflowerInk', name: "Sunflower Ink", palette: ['#10100f', '#282718', '#f0db71', '#d2d4cd'] },
    { id: 'tangerineCoal', name: "Tangerine Coal", palette: ['#15110e', '#2d2118', '#ffb475', '#bdd0c2'] },
    { id: 'terracottaRose', name: "Terracotta Rose", palette: ['#281815', '#402720', '#f4bc91', '#e7aaa0'] },
    { id: 'turquoiseAmber', name: "Turquoise Amber", palette: ['#13272b', '#213e43', '#f6cf96', '#a8e4da'] },
    { id: 'vampireVelvet', name: "Vampire Velvet", palette: ['#09080b', '#1b1015', '#f2647b', '#d9bac6'] },
    { id: 'vanillaSlate', name: "Vanilla Slate", palette: ['#24211c', '#373329', '#e6dab5', '#b9d5dc'] },
    { id: 'violetVoltage', name: "Violet Voltage", palette: ['#1d1834', '#30294a', '#ceb8ff', '#a4f0e5'] },
    { id: 'winterMin', name: "Winter (minimalist)", palette: ['#0a1728', '#b8d7e8', '#80b9e8', '#c9c0ef'] },
    { id: 'wisteriaTeal', name: "Wisteria Teal", palette: ['#231e2d', '#393047', '#dac5f0', '#b7dee0'] }
  ];
  const DEFAULT_THEMES_MAP = {};
  DEFAULT_THEMES.forEach((t) => { DEFAULT_THEMES_MAP[t.id] = t; });

  // Perceived luminance (0=black..1=white) — decides whether a row's own
  // ORIGINAL default color was meant to read as "dark" (e.g. black text, a
  // near-black background) or "light" (white text, a pastel fill), so a
  // theme's dark-vs-accent colors land on the same role that row already
  // had, instead of e.g. turning body text invisible.
  function hexLuminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  // Builds a full dt_cc_* settings object — covering every row in every
  // CUSTOM_COLOR_SECTIONS section, live or scaffold-only alike — from one
  // theme's 4-color palette: [dark1, dark2, accent1, accent2]. Same generic
  // rule for any row shape found in this project, so a future section's
  // rows pick up a theme correctly with zero extra code here:
  //   - fill+border+text rows (the 10 format-panel rows): fill/border
  //     alternate accent1/accent2 (opacity unchanged) for variety across
  //     panels, text always uses dark1 for reliable contrast against a
  //     light fill.
  //   - fill+border rows with no text (Deck/Mode/Filter-Sort/Host-a-Duel):
  //     fill uses dark2 (opacity unchanged — stays a subtle low-opacity
  //     tint, just tinted toward this theme instead of plain black),
  //     border alternates accent1/accent2.
  //   - plain color+opacity rows: kept on whichever side of light/dark the
  //     row's OWN original default already was (so e.g. deckPanelTextColors,
  //     which defaults to black because it sits on a light native button,
  //     stays dark1/dark2 — while roomPanelTitles, defaulting to white,
  //     stays accent1/accent2), alternating for variety; an `image` key, if
  //     present, is left unset (themes are colors only, never backgrounds).
  function buildThemeColors(palette) {
    const dark1 = palette[0], dark2 = palette[1], accent1 = palette[2], accent2 = palette[3];
    const out = {};
    let i = 0;
    CUSTOM_COLOR_SECTIONS.forEach((section) => {
      section.rows.forEach((row) => {
        const even = i % 2 === 0;
        if (row.border && row.text) {
          out['dt_cc_' + row.id + '_color'] = even ? accent1 : accent2;
          out['dt_cc_' + row.id + '_opacity'] = row.opacity;
          out['dt_cc_' + row.id + '_fillTransparent'] = false;
          out['dt_cc_' + row.id + '_borderColor'] = even ? accent2 : accent1;
          out['dt_cc_' + row.id + '_borderOpacity'] = 100;
          out['dt_cc_' + row.id + '_borderTransparent'] = false;
          out['dt_cc_' + row.id + '_textColor'] = dark1;
        } else if (row.border) {
          out['dt_cc_' + row.id + '_color'] = dark2;
          out['dt_cc_' + row.id + '_opacity'] = row.opacity;
          out['dt_cc_' + row.id + '_fillTransparent'] = false;
          out['dt_cc_' + row.id + '_borderColor'] = even ? accent1 : accent2;
          out['dt_cc_' + row.id + '_borderOpacity'] = 100;
          out['dt_cc_' + row.id + '_borderTransparent'] = false;
        } else if (row.widgetAccent) {
          // Native widget-accent rows (dropdown/button/radio fills) are
          // always a vivid accent, regardless of how dark DuelingBook's own
          // default happens to be — unlike text rows, luminance here says
          // nothing about legibility, so skip that check entirely.
          out['dt_cc_' + row.id + '_color'] = even ? accent1 : accent2;
          out['dt_cc_' + row.id + '_opacity'] = row.opacity;
        } else {
          const origDark = hexLuminance(row.color) < 0.5;
          out['dt_cc_' + row.id + '_color'] = origDark ? (even ? dark1 : dark2) : (even ? accent1 : accent2);
          out['dt_cc_' + row.id + '_opacity'] = row.opacity;
        }
        i++;
      });
    });
    return out;
  }

  // Shared by the dropdown trigger (one theme) and every row in its open
  // menu (one theme each) — a run of small color chips, or an italic
  // placeholder for "Default" (palette: null, since that's just this
  // extension's own built-in colors, nothing to preview).
  function themeSwatchHtml(theme) {
    return theme && theme.palette
      ? theme.palette.map((c) => '<span class="dt-ts-swatchchip" style="background:' + c + ';"></span>').join('')
      : '<span class="dt-ts-swatchchip-empty">—</span>';
  }

  function renderThemeSelectorFeature(container) {
    container.innerHTML =
      '<div class="dt-note">Pick one of the built-in Default Themes below for an instant full-palette recolor, or save your own from the "Save as New Theme" button over in Custom Colors — up to ' + CUSTOM_THEMES_MAX + ' of those at a time. Either way nothing is permanent until you hit Save at the bottom of this page.</div>' +
      '<div class="dt-ts-builtin">' +
        '<div class="dt-ts-dropdown" id="ts-builtin-dropdown">' +
          '<button type="button" class="dt-ts-trigger" id="ts-builtin-trigger">' +
            '<span class="dt-ts-swatchpreview" id="ts-builtin-trigger-swatch"></span>' +
            '<span class="dt-ts-trigger-name" id="ts-builtin-trigger-name">Default</span>' +
            '<span class="dt-ts-chevron"></span>' +
          '</button>' +
          '<div class="dt-ts-menu" id="ts-builtin-menu" hidden>' +
            DEFAULT_THEMES.map((t) =>
              '<div class="dt-ts-menurow" data-theme-id="' + t.id + '">' +
                '<span class="dt-ts-menurow-name">' + t.name + '</span>' +
                '<span class="dt-ts-swatchpreview">' + themeSwatchHtml(t) + '</span>' +
              '</div>'
            ).join('') +
          '</div>' +
        '</div>' +
        '<button type="button" class="dt-cc-reset-theme" id="ts-builtin-apply">Apply Theme</button>' +
      '</div>' +
      '<div class="dt-ccolor-section-title" style="margin-top:14px;">Your Saved Themes</div>' +
      '<div id="ts-list"></div>';

    let selectedId = 'default';
    const dropdown = container.querySelector('#ts-builtin-dropdown');
    const trigger = container.querySelector('#ts-builtin-trigger');
    const triggerName = container.querySelector('#ts-builtin-trigger-name');
    const triggerSwatch = container.querySelector('#ts-builtin-trigger-swatch');
    const menu = container.querySelector('#ts-builtin-menu');

    function paintTrigger() {
      const theme = DEFAULT_THEMES_MAP[selectedId];
      triggerName.textContent = theme ? theme.name : 'Default';
      triggerSwatch.innerHTML = themeSwatchHtml(theme);
      menu.querySelectorAll('.dt-ts-menurow').forEach((row) => {
        row.classList.toggle('selected', row.dataset.themeId === selectedId);
      });
    }
    paintTrigger();

    trigger.addEventListener('click', () => { menu.hidden = !menu.hidden; });
    menu.addEventListener('click', (e) => {
      const row = e.target.closest('[data-theme-id]');
      if (!row) return;
      selectedId = row.dataset.themeId;
      paintTrigger();
      menu.hidden = true;
    });
    // Closing on an outside click — guarded by isConnected so a stale
    // listener left over from a previous time this tab was opened (its own
    // dropdown long since replaced by a fresh container.innerHTML) is a
    // harmless no-op instead of touching a detached node.
    document.addEventListener('click', function onDocClick(e) {
      if (!dropdown.isConnected) { document.removeEventListener('click', onDocClick); return; }
      if (!dropdown.contains(e.target)) menu.hidden = true;
    });

    container.querySelector('#ts-builtin-apply').addEventListener('click', () => {
      const theme = DEFAULT_THEMES_MAP[selectedId];
      if (!theme) return;
      if (!window.confirm('Apply "' + theme.name + '"? This overwrites your current Custom Colors settings.')) return;
      setSetting(theme.palette ? buildThemeColors(theme.palette) : Object.assign({}, CUSTOM_COLORS_ROW_DEFAULTS));
      flashStatus('Theme "' + theme.name + '" applied — click Save below to keep it.');
    });

    const list = container.querySelector('#ts-list');

    function render() {
      getSettings(CUSTOM_THEMES_LIST_DEFAULTS, (s) => {
        const themes = s.dt_custom_themes_list || [];
        if (!themes.length) {
          list.innerHTML = '<div class="dt-note">No saved themes yet.</div>';
          return;
        }
        list.innerHTML = themes.map((t) =>
          '<div class="dt-row">' +
            '<div class="dt-row-label"><b>' + t.name + '</b></div>' +
            '<div class="dt-ts-actions">' +
              '<button type="button" class="dt-cc-reset-theme" data-load="' + t.id + '">Load</button>' +
              '<button type="button" class="dt-cc-reset-theme dt-ts-delete" data-delete="' + t.id + '">Delete</button>' +
            '</div>' +
          '</div>'
        ).join('') + '<div class="dt-ts-count">' + themes.length + '/' + CUSTOM_THEMES_MAX + ' themes saved</div>';
      });
    }

    list.addEventListener('click', (e) => {
      const loadBtn = e.target.closest('[data-load]');
      const delBtn = e.target.closest('[data-delete]');
      if (loadBtn) {
        getSettings(CUSTOM_THEMES_LIST_DEFAULTS, (s) => {
          const theme = (s.dt_custom_themes_list || []).find((t) => t.id === loadBtn.dataset.load);
          if (!theme) return;
          if (!window.confirm('Load theme "' + theme.name + '"? This overwrites your current Custom Colors settings.')) return;
          setSetting(Object.assign({}, theme.colors));
          flashStatus('Theme "' + theme.name + '" loaded — click Save below to apply it.');
        });
      } else if (delBtn) {
        if (!window.confirm('Delete this theme? This can\'t be undone.')) return;
        getSettings(CUSTOM_THEMES_LIST_DEFAULTS, (s) => {
          const next = (s.dt_custom_themes_list || []).filter((t) => t.id !== delBtn.dataset.delete);
          setSetting({ dt_custom_themes_list: next });
          render();
        });
      }
    });

    render();
  }

  function ccRowHtml(row) {
    let html = '<div class="dt-cc-row">' +
      '<div class="dt-cc-row-top">' +
        '<div class="dt-cc-row-label">' + row.label + (row.detail ? '<div class="dt-row-detail">' + row.detail + '</div>' : '') + '</div>' +
        '<div class="dt-cc-swatchwrap">' +
          '<input type="color" class="dt-cc-swatch" id="cc-' + row.id + '-swatch">' +
          '<input type="text" class="dt-cc-rgbtext" id="cc-' + row.id + '-text">' +
        '</div>' +
      '</div>' +
      '<div class="dt-cc-opacity-row">' +
        '<span class="dt-cc-opacity-label">Opacity</span>' +
        '<input type="range" min="0" max="100" class="dt-cc-opacity-slider" id="cc-' + row.id + '-slider">' +
        '<input type="number" min="0" max="100" class="dt-cc-opacity-num" id="cc-' + row.id + '-num">' +
        '<span class="dt-cc-pct">%</span>' +
      '</div>' +
      '<div class="dt-cc-row-bottom">';
    if (row.image) {
      html +=
        '<label class="dt-cc-load-btn">Load image · ' + row.image +
          '<input type="file" accept="image/*" id="cc-' + row.id + '-file" style="display:none">' +
        '</label>' +
        '<span class="dt-cc-img-status" id="cc-' + row.id + '-imgstatus"></span>';
    }
    html +=
        '<button type="button" class="dt-cc-reset" id="cc-' + row.id + '-reset">Reset</button>' +
      '</div>' +
    '</div>';
    return html;
  }

  function ccWireRow(scope, row) {
    const colorKey = 'dt_cc_' + row.id + '_color';
    const opacityKey = 'dt_cc_' + row.id + '_opacity';
    const imageKey = 'dt_cc_' + row.id + '_image';
    const swatch = scope.querySelector('#cc-' + row.id + '-swatch');
    const text = scope.querySelector('#cc-' + row.id + '-text');
    const slider = scope.querySelector('#cc-' + row.id + '-slider');
    const num = scope.querySelector('#cc-' + row.id + '-num');
    const resetBtn = scope.querySelector('#cc-' + row.id + '-reset');
    const fileInput = row.image ? scope.querySelector('#cc-' + row.id + '-file') : null;
    const imgStatus = row.image ? scope.querySelector('#cc-' + row.id + '-imgstatus') : null;

    const defaults = { [colorKey]: row.color, [opacityKey]: row.opacity };
    if (row.image) defaults[imageKey] = null;

    function paintImgStatus(hasImage) {
      if (!imgStatus) return;
      imgStatus.innerHTML = hasImage ? '✓ image set <button type="button" class="dt-cc-img-clear">×</button>' : '';
    }

    getSettings(defaults, (s) => {
      swatch.value = s[colorKey];
      text.value = hexToRgbStr(s[colorKey]);
      slider.value = s[opacityKey];
      num.value = s[opacityKey];
      if (row.image) paintImgStatus(!!s[imageKey]);
    });

    swatch.addEventListener('input', (e) => {
      text.value = hexToRgbStr(e.target.value);
      setSetting({ [colorKey]: e.target.value });
    });
    text.addEventListener('change', (e) => {
      const hex = rgbStrToHex(e.target.value);
      if (!hex) { getSettings(defaults, (s) => { text.value = hexToRgbStr(s[colorKey]); }); return; }
      swatch.value = hex;
      text.value = hexToRgbStr(hex);
      setSetting({ [colorKey]: hex });
    });
    function setOpacity(v) {
      v = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
      slider.value = v; num.value = v;
      setSetting({ [opacityKey]: v });
    }
    slider.addEventListener('input', (e) => setOpacity(e.target.value));
    num.addEventListener('change', (e) => setOpacity(e.target.value));

    if (row.image) {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        if (file.size > CUSTOM_COLORS_MAX_FILE_BYTES) {
          alert('That image is ' + (file.size / (1024 * 1024)).toFixed(1) + 'MB — please use one under ' + (CUSTOM_COLORS_MAX_FILE_BYTES / (1024 * 1024)) + 'MB.');
          return;
        }
        ceReadFileAsDataUrl(file, (dataUrl) => {
          setSetting({ [imageKey]: dataUrl });
          paintImgStatus(true);
        });
      });
      imgStatus.addEventListener('click', (e) => {
        if (!e.target.closest('.dt-cc-img-clear')) return;
        setSetting({ [imageKey]: null });
        paintImgStatus(false);
      });
    }

    resetBtn.addEventListener('click', () => {
      setSetting(Object.assign({}, defaults));
      swatch.value = row.color;
      text.value = hexToRgbStr(row.color);
      slider.value = row.opacity; num.value = row.opacity;
      if (row.image) paintImgStatus(false);
    });
  }

  // ── Room panels row — richer than every other Custom Colors row, per the
  // user's explicit follow-up: Panel Fill (color/opacity/image, same as
  // before, plus a Fully Transparent quick toggle), a whole separate
  // Border (color/opacity/Fully Transparent), and one flat Text Color
  // covering every text element the panel shows. Kept as its own
  // html/wire pair rather than extending ccRowHtml/ccWireRow, since every
  // OTHER Custom Colors section (Main interface, Navigation accents, etc.)
  // still uses the simple single-color model those were built for.
  function ccRoomRowHtml(row) {
    return '<div class="dt-cc-room-row">' +
      '<div class="dt-cc-room-row-label"><b>' + row.label + '</b>' + (row.detail ? '<div class="dt-row-detail">' + row.detail + '</div>' : '') + '</div>' +

      '<div class="dt-cc-room-group">' +
        '<div class="dt-cc-room-group-title">Panel Fill</div>' +
        '<div class="dt-cc-swatchwrap">' +
          '<input type="color" class="dt-cc-swatch" id="cc-' + row.id + '-fill-swatch">' +
          '<input type="text" class="dt-cc-rgbtext" id="cc-' + row.id + '-fill-text">' +
        '</div>' +
        '<div class="dt-cc-opacity-row">' +
          '<span class="dt-cc-opacity-label">Opacity</span>' +
          '<input type="range" min="0" max="100" class="dt-cc-opacity-slider" id="cc-' + row.id + '-fill-slider">' +
          '<input type="number" min="0" max="100" class="dt-cc-opacity-num" id="cc-' + row.id + '-fill-num">' +
          '<span class="dt-cc-pct">%</span>' +
        '</div>' +
        '<label class="dt-cc-transparent-toggle"><input type="checkbox" id="cc-' + row.id + '-fill-transparent"> Fully Transparent</label>' +
        (row.image !== undefined ?
        '<div class="dt-cc-row-bottom">' +
          '<label class="dt-cc-load-btn">Load image · ' + row.image + '<input type="file" accept="image/*" id="cc-' + row.id + '-file" style="display:none"></label>' +
          '<span class="dt-cc-img-status" id="cc-' + row.id + '-imgstatus"></span>' +
        '</div>' : '') +
      '</div>' +

      '<div class="dt-cc-room-group">' +
        '<div class="dt-cc-room-group-title">Border</div>' +
        '<div class="dt-cc-swatchwrap">' +
          '<input type="color" class="dt-cc-swatch" id="cc-' + row.id + '-border-swatch">' +
          '<input type="text" class="dt-cc-rgbtext" id="cc-' + row.id + '-border-text">' +
        '</div>' +
        '<div class="dt-cc-opacity-row">' +
          '<span class="dt-cc-opacity-label">Opacity</span>' +
          '<input type="range" min="0" max="100" class="dt-cc-opacity-slider" id="cc-' + row.id + '-border-slider">' +
          '<input type="number" min="0" max="100" class="dt-cc-opacity-num" id="cc-' + row.id + '-border-num">' +
          '<span class="dt-cc-pct">%</span>' +
        '</div>' +
        '<label class="dt-cc-transparent-toggle"><input type="checkbox" id="cc-' + row.id + '-border-transparent"> Fully Transparent</label>' +
        '<div class="dt-note" style="margin-top:4px">Replaces DuelingBook\'s own two-tone border with this one flat color.</div>' +
      '</div>' +

      (row.text !== undefined ?
      '<div class="dt-cc-room-group">' +
        '<div class="dt-cc-room-group-title">Text Color</div>' +
        '<div class="dt-cc-swatchwrap">' +
          '<input type="color" class="dt-cc-swatch" id="cc-' + row.id + '-text-swatch">' +
          '<input type="text" class="dt-cc-rgbtext" id="cc-' + row.id + '-text-text">' +
        '</div>' +
        '<div class="dt-note" style="margin-top:4px">Covers the player/elo/match-status text (and, on the Ranked panel only, its join-pool form text) — no opacity, this one\'s never transparent.</div>' +
      '</div>' : '') +

      '<div class="dt-cc-row-bottom"><button type="button" class="dt-cc-reset" id="cc-' + row.id + '-reset">Reset</button></div>' +
    '</div>';
  }

  function ccWireRoomRow(scope, row) {
    const fillColorKey = 'dt_cc_' + row.id + '_color';
    const fillOpacityKey = 'dt_cc_' + row.id + '_opacity';
    const fillTransparentKey = 'dt_cc_' + row.id + '_fillTransparent';
    const imageKey = 'dt_cc_' + row.id + '_image';
    const borderColorKey = 'dt_cc_' + row.id + '_borderColor';
    const borderOpacityKey = 'dt_cc_' + row.id + '_borderOpacity';
    const borderTransparentKey = 'dt_cc_' + row.id + '_borderTransparent';
    const textColorKey = 'dt_cc_' + row.id + '_textColor';

    const hasText = row.text !== undefined;
    const rowHasImage = row.image !== undefined;
    const defaults = {
      [fillColorKey]: row.color, [fillOpacityKey]: row.opacity, [fillTransparentKey]: false, [imageKey]: null,
      [borderColorKey]: row.border, [borderOpacityKey]: 100, [borderTransparentKey]: false
    };
    if (hasText) defaults[textColorKey] = row.text;

    const fillSwatch = scope.querySelector('#cc-' + row.id + '-fill-swatch');
    const fillText = scope.querySelector('#cc-' + row.id + '-fill-text');
    const fillSlider = scope.querySelector('#cc-' + row.id + '-fill-slider');
    const fillNum = scope.querySelector('#cc-' + row.id + '-fill-num');
    const fillTransparent = scope.querySelector('#cc-' + row.id + '-fill-transparent');
    const fileInput = scope.querySelector('#cc-' + row.id + '-file');
    const imgStatus = scope.querySelector('#cc-' + row.id + '-imgstatus');

    const borderSwatch = scope.querySelector('#cc-' + row.id + '-border-swatch');
    const borderText = scope.querySelector('#cc-' + row.id + '-border-text');
    const borderSlider = scope.querySelector('#cc-' + row.id + '-border-slider');
    const borderNum = scope.querySelector('#cc-' + row.id + '-border-num');
    const borderTransparent = scope.querySelector('#cc-' + row.id + '-border-transparent');

    const textSwatch = scope.querySelector('#cc-' + row.id + '-text-swatch');
    const textText = scope.querySelector('#cc-' + row.id + '-text-text');

    const resetBtn = scope.querySelector('#cc-' + row.id + '-reset');

    function paintImgStatus(hasImage) {
      if (!rowHasImage) return;
      imgStatus.innerHTML = hasImage ? '✓ image set <button type="button" class="dt-cc-img-clear">×</button>' : '';
    }

    getSettings(defaults, (s) => {
      fillSwatch.value = s[fillColorKey];
      fillText.value = hexToRgbStr(s[fillColorKey]);
      fillSlider.value = s[fillOpacityKey]; fillNum.value = s[fillOpacityKey];
      fillTransparent.checked = !!s[fillTransparentKey];
      paintImgStatus(!!s[imageKey]);

      borderSwatch.value = s[borderColorKey];
      borderText.value = hexToRgbStr(s[borderColorKey]);
      borderSlider.value = s[borderOpacityKey]; borderNum.value = s[borderOpacityKey];
      borderTransparent.checked = !!s[borderTransparentKey];

      if (hasText) {
        textSwatch.value = s[textColorKey];
        textText.value = hexToRgbStr(s[textColorKey]);
      }
    });

    fillSwatch.addEventListener('input', (e) => { fillText.value = hexToRgbStr(e.target.value); setSetting({ [fillColorKey]: e.target.value }); });
    fillText.addEventListener('change', (e) => {
      const hex = rgbStrToHex(e.target.value);
      if (!hex) { getSettings(defaults, (s) => { fillText.value = hexToRgbStr(s[fillColorKey]); }); return; }
      fillSwatch.value = hex; fillText.value = hexToRgbStr(hex);
      setSetting({ [fillColorKey]: hex });
    });
    function setFillOpacity(v) { v = Math.max(0, Math.min(100, Math.round(Number(v) || 0))); fillSlider.value = v; fillNum.value = v; setSetting({ [fillOpacityKey]: v }); }
    fillSlider.addEventListener('input', (e) => setFillOpacity(e.target.value));
    fillNum.addEventListener('change', (e) => setFillOpacity(e.target.value));
    fillTransparent.addEventListener('change', (e) => setSetting({ [fillTransparentKey]: e.target.checked }));

    if (rowHasImage) {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        if (file.size > CUSTOM_COLORS_MAX_FILE_BYTES) {
          alert('That image is ' + (file.size / (1024 * 1024)).toFixed(1) + 'MB — please use one under ' + (CUSTOM_COLORS_MAX_FILE_BYTES / (1024 * 1024)) + 'MB.');
          return;
        }
        ceReadFileAsDataUrl(file, (dataUrl) => { setSetting({ [imageKey]: dataUrl }); paintImgStatus(true); });
      });
      imgStatus.addEventListener('click', (e) => {
        if (!e.target.closest('.dt-cc-img-clear')) return;
        setSetting({ [imageKey]: null }); paintImgStatus(false);
      });
    }

    borderSwatch.addEventListener('input', (e) => { borderText.value = hexToRgbStr(e.target.value); setSetting({ [borderColorKey]: e.target.value }); });
    borderText.addEventListener('change', (e) => {
      const hex = rgbStrToHex(e.target.value);
      if (!hex) { getSettings(defaults, (s) => { borderText.value = hexToRgbStr(s[borderColorKey]); }); return; }
      borderSwatch.value = hex; borderText.value = hexToRgbStr(hex);
      setSetting({ [borderColorKey]: hex });
    });
    function setBorderOpacity(v) { v = Math.max(0, Math.min(100, Math.round(Number(v) || 0))); borderSlider.value = v; borderNum.value = v; setSetting({ [borderOpacityKey]: v }); }
    borderSlider.addEventListener('input', (e) => setBorderOpacity(e.target.value));
    borderNum.addEventListener('change', (e) => setBorderOpacity(e.target.value));
    borderTransparent.addEventListener('change', (e) => setSetting({ [borderTransparentKey]: e.target.checked }));

    if (hasText) {
      textSwatch.addEventListener('input', (e) => { textText.value = hexToRgbStr(e.target.value); setSetting({ [textColorKey]: e.target.value }); });
      textText.addEventListener('change', (e) => {
        const hex = rgbStrToHex(e.target.value);
        if (!hex) { getSettings(defaults, (s) => { textText.value = hexToRgbStr(s[textColorKey]); }); return; }
        textSwatch.value = hex; textText.value = hexToRgbStr(hex);
        setSetting({ [textColorKey]: hex });
      });
    }

    resetBtn.addEventListener('click', () => {
      setSetting(Object.assign({}, defaults));
      fillSwatch.value = row.color; fillText.value = hexToRgbStr(row.color);
      fillSlider.value = row.opacity; fillNum.value = row.opacity;
      fillTransparent.checked = false;
      paintImgStatus(false);
      borderSwatch.value = row.border; borderText.value = hexToRgbStr(row.border);
      borderSlider.value = 100; borderNum.value = 100;
      borderTransparent.checked = false;
      if (hasText) { textSwatch.value = row.text; textText.value = hexToRgbStr(row.text); }
    });
  }

  function renderCustomColorsFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Custom Colors</b><div class="dt-row-detail">Master switch for every color/opacity/background-image override below.</div></div>' +
        switchHtml('cc-master') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label">Show Background Grid Lines<div class="dt-row-detail">DuelingBook\'s own circuit-pattern background grid, independent of every color override below.</div></div>' +
        switchHtml('cc-gridlines') +
      '</div>' +
      '<div class="dt-row">' +
        '<div class="dt-row-label">Remove Red Glow on Match-Type Labels<div class="dt-row-detail">DuelingBook puts a red text-shadow glow behind the "MATCH (2 out of 3)" / "SINGLE (w/ siding)" text on every hosted duel in the lobby. Off restores DuelingBook\'s native red glow.</div></div>' +
        switchHtml('cc-removeglow') +
      '</div>' +
      '<div class="dt-cc-save-theme-row">' +
        '<button type="button" class="dt-cc-reset-theme" id="cc-save-theme">💾 Save as New Theme</button>' +
        '<span class="dt-cc-img-status">Snapshots every row below (color/opacity/image) into Theme Selector, so you can Load it again later.</span>' +
      '</div>' +
      '<div class="dt-note warn">LIVE so far: Show Background Grid Lines, Remove Red Glow on Match-Type Labels, the Duel Room Customization section in full, all 4 new Main Menu sections (Front Page, Nav Buttons, Status Feed, Side Panels), and Deck Constructor — those apply on the splash screen, the post-"DUEL!" Main Menu, and the Deck Constructor page. Duel interface — the active-phase highlight, both Life Points boxes, the player avatar border, and now the duel zone grid itself (your side and your opponent\'s, separately) plus the Hide Pendulum Zones toggle in Playing — is confirmed against a real live duel: the zone grid turned out to be one image DuelingBook loads per duel (not page CSS), recolored here by rebuilding that image with your chosen colors in its two gradients, and the Pendulum Zone markers are hidden the same way. Rankings is still scaffold only. We wire each remaining section to the live page one at a time and verify it before moving to the next.</div>' +
      '<div id="cc-sections"></div>';

    const master = container.querySelector('#cc-master input');
    const gridlines = container.querySelector('#cc-gridlines input');
    const removeglow = container.querySelector('#cc-removeglow input');
    getSettings({ dt_custom_colors_enabled: false, dt_custom_colors_grid_lines: true, dt_custom_colors_remove_glow: true }, (s) => {
      master.checked = !!s.dt_custom_colors_enabled;
      gridlines.checked = !!s.dt_custom_colors_grid_lines;
      removeglow.checked = !!s.dt_custom_colors_remove_glow;
    });
    master.addEventListener('change', (e) => setSetting({ dt_custom_colors_enabled: e.target.checked }));
    gridlines.addEventListener('change', (e) => setSetting({ dt_custom_colors_grid_lines: e.target.checked }));
    removeglow.addEventListener('change', (e) => setSetting({ dt_custom_colors_remove_glow: e.target.checked }));

    container.querySelector('#cc-save-theme').addEventListener('click', () => {
      getSettings(CUSTOM_THEMES_LIST_DEFAULTS, (ts) => {
        const existing = ts.dt_custom_themes_list || [];
        if (existing.length >= CUSTOM_THEMES_MAX) {
          alert('You can save up to ' + CUSTOM_THEMES_MAX + ' themes — delete one in Theme Selector first.');
          return;
        }
        const name = window.prompt('Name this theme:', '');
        if (!name || !name.trim()) return;
        ctSnapshotCurrentColors((snap) => {
          const theme = {
            id: 'th_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            name: name.trim(),
            colors: snap
          };
          setSetting({ dt_custom_themes_list: existing.concat([theme]) });
          flashStatus('Saved theme "' + theme.name + '" — click Save below to keep it, then find it in Theme Selector.');
        });
      });
    });

    // Every default key for one row, same shape CUSTOM_COLORS_ROW_DEFAULTS
    // builds for all of them — scoped to a single section so "Reset All"
    // can stage every row in that section back to its shipped default in
    // one click, instead of clicking each row's own Reset one at a time.
    function sectionRowDefaults(section) {
      const defaults = {};
      section.rows.forEach((row) => {
        defaults['dt_cc_' + row.id + '_color'] = row.color;
        defaults['dt_cc_' + row.id + '_opacity'] = row.opacity;
        if (row.image) defaults['dt_cc_' + row.id + '_image'] = null;
        if (row.border !== undefined) {
          defaults['dt_cc_' + row.id + '_fillTransparent'] = false;
          defaults['dt_cc_' + row.id + '_borderColor'] = row.border;
          defaults['dt_cc_' + row.id + '_borderOpacity'] = 100;
          defaults['dt_cc_' + row.id + '_borderTransparent'] = false;
        }
        if (row.text !== undefined) defaults['dt_cc_' + row.id + '_textColor'] = row.text;
      });
      return defaults;
    }

    function renderSectionBody(section, body) {
      // Per-row, not per-section: Duel Room Customization now mixes the 10
      // rich panel-fill/border/text rows (each has a `border` field) with
      // plain color+opacity rows merged in from the old "Duel Room"
      // section (carousel arrows, panel titles, Host a Duel/Filter-Sort/
      // Mode/Deck text colors), so the renderer choice has to be decided
      // per row instead of per section.
      body.innerHTML = section.rows.map((row) => row.border !== undefined ? ccRoomRowHtml(row) : ccRowHtml(row)).join('');
      section.rows.forEach((row) => (row.border !== undefined ? ccWireRoomRow : ccWireRow)(body, row));
    }

    const sectionsEl = container.querySelector('#cc-sections');
    CUSTOM_COLOR_SECTIONS.forEach((section) => {
      const block = document.createElement('div');
      block.className = 'dt-ccolor-section';
      block.innerHTML =
        '<div class="dt-ccolor-section-head">' +
          '<div class="dt-ccolor-section-title">' + section.label + '</div>' +
          '<button type="button" class="dt-cc-reset-section-btn" id="cc-reset-section-' + section.id + '">Reset All</button>' +
          '<div class="dt-chevron"></div>' +
        '</div>' +
        '<div class="dt-ccolor-section-body"></div>';
      block.querySelector('.dt-ccolor-section-head').addEventListener('click', (e) => {
        if (e.target.closest('.dt-cc-reset-section-btn')) return; // don't toggle the accordion when the click was on Reset All
        block.classList.toggle('open');
      });
      sectionsEl.appendChild(block);
      const body = block.querySelector('.dt-ccolor-section-body');
      renderSectionBody(section, body);

      block.querySelector('#cc-reset-section-' + section.id).addEventListener('click', () => {
        if (!window.confirm('Reset every row in "' + section.label + '" back to its default color/opacity/border? This stays staged until you hit Save below.')) return;
        setSetting(sectionRowDefaults(section));
        renderSectionBody(section, body); // re-render so every input reflects the just-staged defaults immediately
        flashStatus('"' + section.label + '" reset to defaults — click Save below to keep it.');
      });
    });
  }

  // ── Custom Token Images (sub-feature) ───────────────────────────────────
  // Per the user's explicit request, with one hard technical limit disclosed
  // up front and confirmed by reading DuelingBook's own duel.js/main.js
  // directly (not guessed): when a Token is summoned, the only thing that
  // ever crosses the network is a plain number — the receiving client (your
  // opponent, any spectators) rebuilds the picture itself from that number
  // against DuelingBook's OWN image server (images.duelingbook.com/
  // card-tokens/ for the ~192 built-in arts, images.duelingbook.com/tokens/
  // for anything uploaded through DuelingBook's own native "Browse" button
  // inside that same picker). There is no way for an image that only lives
  // in this extension's local storage to ever reach anyone else's screen.
  // The user explicitly chose to build this anyway as a LOCAL-ONLY cosmetic
  // override — it reskins what the uploader personally sees, on BOTH sides
  // of the field (their own Tokens and their opponent's alike), since
  // neither side of it ever touches the real summon or the network. The
  // 1st/2nd/3rd… slot assignment, though, IS tracked separately per
  // controller, per the user's own follow-up: your own 3rd Token always
  // gets slot 3 regardless of how many Tokens your opponent has out, and
  // vice versa — the two counts don't share or borrow from each other,
  // they just both draw from the same 5 slot images. Library cap is 11
  // per the user's own spec;
  // every upload is auto-cropped to a center square and resized so it
  // always fits the native ~45x45 grid cell cleanly regardless of the
  // source image's shape.
  const CUSTOM_TOKEN_IMAGES_DEFAULTS = {
    dt_custom_tokens_enabled: false,
    dt_custom_tokens_library: [], // [{id, dataUrl}], cap 11
    dt_custom_tokens_slot1: null,
    dt_custom_tokens_slot2: null,
    dt_custom_tokens_slot3: null,
    dt_custom_tokens_slot4: null,
    dt_custom_tokens_slot5: null,
    dt_custom_tokens_use_slot1_for_all: false
  };
  Object.assign(ALL_DEFAULTS, CUSTOM_TOKEN_IMAGES_DEFAULTS);
  const CUSTOM_TOKENS_LIBRARY_CAP = 11;
  const CUSTOM_TOKENS_MAX_FILE_BYTES = 5 * 1024 * 1024;
  const CUSTOM_TOKENS_OUTPUT_SIZE = 180; // square px — crisp at the native ~45x45 cell at any zoom/DPI

  function ctiReadFileAsSquareDataUrl(file, cb) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - size) / 2;
        const sy = (img.naturalHeight - size) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = CUSTOM_TOKENS_OUTPUT_SIZE;
        canvas.height = CUSTOM_TOKENS_OUTPUT_SIZE;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, size, size, 0, 0, CUSTOM_TOKENS_OUTPUT_SIZE, CUSTOM_TOKENS_OUTPUT_SIZE);
        cb(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  const CTI_ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];
  const CTI_SLOT_KEYS = ['dt_custom_tokens_slot1', 'dt_custom_tokens_slot2', 'dt_custom_tokens_slot3', 'dt_custom_tokens_slot4', 'dt_custom_tokens_slot5'];

  function renderCustomTokenImagesFeature(container) {
    let slotRows = '';
    for (let i = 0; i < 5; i++) {
      slotRows +=
        '<div class="dt-row dt-cti-slot-row" data-slot="' + i + '">' +
          '<div class="dt-row-label"><b>' + CTI_ORDINALS[i] + ' Token</b>' + (i === 0 ? '' : '<div class="dt-row-detail" id="cti-slot-' + i + '-samenote" style="display:none;">Same as 1st Token (checkbox below is on)</div>') + '</div>' +
          '<div class="dt-cti-slot-preview" id="cti-slot-' + i + '-preview"></div>' +
          '<select class="dt-cti-select" id="cti-slot-' + i + '-select"><option value="">DuelingBook default (no override)</option></select>' +
        '</div>';
    }
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Custom Token Images</b><div class="dt-row-detail">Upload your own art for DuelingBook\'s "Token" monster and assign it to 1st through 5th — covers EVERY Token on the field, yours and your opponent\'s alike. Each side is counted separately: your own 3rd Token always gets slot 3 no matter how many your opponent has out, and theirs works the same way — the two counts don\'t share, they just both use the same 5 slot images. <b>Local only:</b> DuelingBook only ever sends a plain number over the network when a Token is summoned, never an image — so this changes what YOU see on your own screen only. Your opponent and any spectators still see DuelingBook\'s own default Token art, on both sides of the field, on their screens. Not a real synced skin, just a personal view.</div></div>' +
        switchHtml('cti-master') +
      '</div>' +
      '<div class="dt-ce-slots">' +
        '<div class="dt-ce-slot">' +
          '<div class="dt-ce-slot-label">Uploaded art <span class="dt-ce-slot-count" id="cti-count"></span></div>' +
          '<div class="dt-ce-gallery" id="cti-gallery"></div>' +
          '<label class="dt-ce-upload-btn">+ Add Image<input type="file" accept="image/*" id="cti-file" style="display:none"></label>' +
        '</div>' +
      '</div>' +
      '<div class="dt-note">Any image works — it\'s auto-cropped to a center square and resized to fit the grid cell cleanly, no exact size required. Up to 11 saved here. Numbered badges show which Token slot(s) each one is currently assigned to.</div>' +
      '<div class="dt-row" style="margin-top:14px; border-top:1px solid var(--border2); padding-top:14px;">' +
        '<div class="dt-row-label"><b>Assign Token Slots</b><div class="dt-row-detail">Pick which uploaded image is your 1st Token, 2nd Token, and so on. Leave a slot on "DuelingBook default" to leave that one alone.</div></div>' +
      '</div>' +
      slotRows +
      '<div class="dt-row" style="gap:10px; align-items:center;">' +
        '<div class="dt-row-label"><b>1st Token art for all 5</b><div class="dt-row-detail">On: every Token you summon uses your 1st Token image, no matter how many you already have out — slots 2nd-5th are ignored while this is on (their own picks stay saved underneath, untouched).</div></div>' +
        switchHtml('cti-use-all') +
      '</div>';

    const masterInput = container.querySelector('#cti-master input');
    const useAllInput = container.querySelector('#cti-use-all input');
    const gallery = container.querySelector('#cti-gallery');
    const countEl = container.querySelector('#cti-count');
    const fileInput = container.querySelector('#cti-file');
    const slotSelects = [0, 1, 2, 3, 4].map((i) => container.querySelector('#cti-slot-' + i + '-select'));
    const slotPreviews = [0, 1, 2, 3, 4].map((i) => container.querySelector('#cti-slot-' + i + '-preview'));
    const slotSameNotes = [1, 2, 3, 4].map((i) => container.querySelector('#cti-slot-' + i + '-samenote'));
    const state = { library: [], slots: [null, null, null, null, null], useAllSlot1: false };

    function persist() {
      const payload = { dt_custom_tokens_library: state.library, dt_custom_tokens_use_slot1_for_all: state.useAllSlot1 };
      CTI_SLOT_KEYS.forEach((key, i) => { payload[key] = state.slots[i]; });
      setSetting(payload);
    }

    function slotsAssignedTo(entryId) {
      const nums = [];
      state.slots.forEach((val, i) => { if (val === entryId) nums.push(i + 1); });
      return nums;
    }

    function renderGallery() {
      let html = '';
      if (!state.library.length) {
        html = '<div class="dt-ce-thumb-empty">No images added yet.</div>';
      } else {
        state.library.forEach((entry) => {
          const badges = slotsAssignedTo(entry.id);
          html +=
            '<div class="dt-ce-thumb" data-key="' + entry.id + '" title="Remove this image">' +
              '<img src="' + entry.dataUrl + '">' +
              (badges.length ? '<span class="dt-cti-badge">' + badges.join(',') + '</span>' : '') +
              '<button type="button" class="dt-ce-thumb-del" data-key="' + entry.id + '" title="Remove this image">×</button>' +
            '</div>';
        });
      }
      gallery.innerHTML = html;
      countEl.textContent = '(' + state.library.length + '/' + CUSTOM_TOKENS_LIBRARY_CAP + ' added)';
    }

    function renderSlotOptions() {
      slotSelects.forEach((sel, i) => {
        const current = state.slots[i];
        let html = '<option value="">DuelingBook default (no override)</option>';
        state.library.forEach((entry, idx) => {
          html += '<option value="' + entry.id + '"' + (current === entry.id ? ' selected' : '') + '>Custom Image ' + (idx + 1) + '</option>';
        });
        sel.innerHTML = html;
        sel.value = current || '';
      });
    }

    function renderSlotPreviews() {
      [0, 1, 2, 3, 4].forEach((i) => {
        const effective = (i > 0 && state.useAllSlot1) ? state.slots[0] : state.slots[i];
        const entry = state.library.find((e) => e.id === effective);
        slotPreviews[i].innerHTML = entry ? '<img src="' + entry.dataUrl + '">' : '<div class="dt-cti-preview-empty">—</div>';
      });
    }

    function renderSlotDisabled() {
      [1, 2, 3, 4].forEach((i, idx) => {
        slotSelects[i].disabled = state.useAllSlot1;
        slotSameNotes[idx].style.display = state.useAllSlot1 ? '' : 'none';
      });
    }

    function renderAll() {
      renderGallery();
      renderSlotOptions();
      renderSlotPreviews();
      renderSlotDisabled();
    }

    getSettings(CUSTOM_TOKEN_IMAGES_DEFAULTS, (s) => {
      masterInput.checked = !!s.dt_custom_tokens_enabled;
      useAllInput.checked = !!s.dt_custom_tokens_use_slot1_for_all;
      state.library = (s.dt_custom_tokens_library || []).slice();
      state.slots = CTI_SLOT_KEYS.map((key) => s[key] || null);
      state.useAllSlot1 = !!s.dt_custom_tokens_use_slot1_for_all;
      renderAll();
    });
    masterInput.addEventListener('change', (e) => setSetting({ dt_custom_tokens_enabled: e.target.checked }));
    useAllInput.addEventListener('change', (e) => {
      state.useAllSlot1 = e.target.checked;
      persist();
      renderAll();
    });

    gallery.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.dt-ce-thumb-del');
      if (!delBtn) return;
      const key = delBtn.getAttribute('data-key');
      state.library = state.library.filter((entry) => entry.id !== key);
      state.slots = state.slots.map((val) => (val === key ? null : val));
      persist();
      renderAll();
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (state.library.length >= CUSTOM_TOKENS_LIBRARY_CAP) {
        alert('You can save up to ' + CUSTOM_TOKENS_LIBRARY_CAP + ' images here — delete one first to add another.');
        return;
      }
      if (file.size > CUSTOM_TOKENS_MAX_FILE_BYTES) {
        alert('That image is ' + (file.size / (1024 * 1024)).toFixed(1) + 'MB — please use one under ' + (CUSTOM_TOKENS_MAX_FILE_BYTES / (1024 * 1024)) + 'MB.');
        return;
      }
      ctiReadFileAsSquareDataUrl(file, (dataUrl) => {
        const newId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        state.library.push({ id: newId, dataUrl: dataUrl });
        persist();
        renderAll();
      });
    });

    slotSelects.forEach((sel, i) => {
      sel.addEventListener('change', () => {
        state.slots[i] = sel.value || null;
        persist();
        renderAll();
      });
    });
  }

  // ── DuelingBook Language feature (Language Appearance sub-feature) ─────
  // Unlike Card Language, DuelingBook's own site chrome (menus, buttons,
  // chat, modals, labels) has never been officially localized by
  // DuelingBook themselves — there's no Konami-style "official" source to
  // pull from, so every language here is machine-translated via Google
  // Translate, same mechanism/endpoint as Card Language's unofficial tier.
  // Kept as a flat list (no Official/Machine split) since that distinction
  // doesn't apply here. Off by default; dt-duelingbook-language.user.js
  // deliberately never touches card rules text (.cardfront_content) or
  // this extension's own Settings UI — see that file's header.
  const DUELINGBOOK_LANGUAGE_DEFAULTS = { dt_duelingbook_language_enabled: false, dt_duelingbook_language: 'en' };
  Object.assign(ALL_DEFAULTS, DUELINGBOOK_LANGUAGE_DEFAULTS);
  const DUELINGBOOK_LANGUAGE_OPTIONS = [
    { id: 'en', label: 'English (default)' },
    { id: 'fr', label: 'French' },
    { id: 'de', label: 'German' },
    { id: 'it', label: 'Italian' },
    { id: 'pt', label: 'Portuguese' },
    { id: 'es', label: 'Spanish' },
    { id: 'ar', label: 'Arabic' },
    { id: 'tr', label: 'Turkish' },
    { id: 'hr', label: 'Croatian' },
    { id: 'ru', label: 'Russian' },
    { id: 'sr', label: 'Serbian' },
    { id: 'el', label: 'Greek' }
  ];
  function renderDuelingBookLanguageFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable DuelingBook Language</b><div class="dt-row-detail">Translates DuelingBook\'s own site text — menus, buttons, chat, modals, settings labels and the like — everywhere on the site. This is separate from Card Language: it never touches a card\'s own name or rules text. Off by default (site stays in DuelingBook\'s native English).</div></div>' +
        switchHtml('dbl-master') +
      '</div>' +
      '<div class="dt-radio-group" id="dbl-group">' +
        DUELINGBOOK_LANGUAGE_OPTIONS.map((o) => '<label class="dt-radio-pill" id="dbl-' + o.id + '"><input type="radio" name="dbl-choice" value="' + o.id + '"/> ' + o.label + '</label>').join('') +
      '</div>' +
      '<div class="dt-note">DuelingBook has never officially published the site itself in any other language, so every option here — including Spanish — is machine-translated from the native English text via Google Translate, on the fly, as text appears. Treat it as a reading aid for navigating the site, not a precise translation: phrasing can be rough, especially for shorter button/menu labels. Flip back to English any time to instantly see DuelingBook\'s real, untouched text again.</div>';

    const master = container.querySelector('#dbl-master input');
    getSettings(DUELINGBOOK_LANGUAGE_DEFAULTS, (s) => {
      master.checked = !!s.dt_duelingbook_language_enabled;
      const sel = s.dt_duelingbook_language || 'en';
      const pill = container.querySelector('#dbl-' + sel);
      if (pill) { pill.classList.add('selected'); pill.querySelector('input').checked = true; }
    });
    master.addEventListener('change', (e) => setSetting({ dt_duelingbook_language_enabled: e.target.checked }));
    container.querySelectorAll('input[name="dbl-choice"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        container.querySelectorAll('#dbl-group .dt-radio-pill').forEach((p) => p.classList.remove('selected'));
        radio.closest('.dt-radio-pill').classList.add('selected');
        setSetting({ dt_duelingbook_language: radio.value });
      });
    });
  }

  // ── Language Appearance (top-level feature; wraps the two sub-features
  // above the same way Add Custom Images/Themes/Colors/Emotes wraps its
  // own sub-feature list, see CUSTOM_APPEARANCE_SUBFEATURES below) ───────
  const LANGUAGE_APPEARANCE_SUBFEATURES = [
    { id: 'cardLanguage', label: 'Card Language', render: renderCardLanguageFeature },
    { id: 'duelingbookLanguage', label: 'DuelingBook Language', render: renderDuelingBookLanguageFeature }
  ];
  function renderLanguageAppearanceFeature(container) {
    container.innerHTML =
      '<div class="dt-note">Two independent on/off switches — both start off. Card Language only translates card rules text; DuelingBook Language only translates the site\'s own menus/buttons/chat/UI. Turn on either, both, or neither.</div>' +
      '<div id="lang-sub-list"></div>';
    const list = container.querySelector('#lang-sub-list');
    LANGUAGE_APPEARANCE_SUBFEATURES.forEach((sf) => {
      const block = document.createElement('div');
      block.className = 'dt-feature dt-subfeature';
      block.innerHTML =
        '<div class="dt-feature-head">' +
          '<div class="dt-chevron"></div>' +
          '<div class="dt-feature-title">' + sf.label + '</div>' +
          '<div class="dt-feature-configure">configure</div>' +
        '</div>' +
        '<div class="dt-feature-body"></div>';
      block.querySelector('.dt-feature-head').addEventListener('click', () => block.classList.toggle('open'));
      list.appendChild(block);
      sf.render(block.querySelector('.dt-feature-body'));
    });
  }

  const CUSTOM_APPEARANCE_SUBFEATURES = [
    { id: 'themeSelector', label: 'Theme Selector', render: renderThemeSelectorFeature },
    { id: 'customImages', label: 'Custom Images', render: renderCustomImagesFeature },
    { id: 'customColors', label: 'Custom Colors', render: renderCustomColorsFeature },
    { id: 'customEmotes', label: 'Custom Emotes', render: renderCustomEmotesFeature },
    { id: 'customTokenImages', label: 'Custom Token Images', render: renderCustomTokenImagesFeature }
  ];
  function renderCustomAppearanceFeature(container) {
    container.innerHTML =
      '<div class="dt-note">Each option below is its own independent on/off switch — all start off. Turning one on only changes that one thing; everything else here stays exactly as DuelingBook already looks until you opt into it too.</div>' +
      '<div id="cat-sub-list"></div>';
    const list = container.querySelector('#cat-sub-list');
    CUSTOM_APPEARANCE_SUBFEATURES.forEach((sf) => {
      const block = document.createElement('div');
      block.className = 'dt-feature dt-subfeature';
      block.innerHTML =
        '<div class="dt-feature-head">' +
          '<div class="dt-chevron"></div>' +
          '<div class="dt-feature-title">' + sf.label + '</div>' +
          '<div class="dt-feature-configure">configure</div>' +
        '</div>' +
        '<div class="dt-feature-body"></div>';
      block.querySelector('.dt-feature-head').addEventListener('click', () => block.classList.toggle('open'));
      list.appendChild(block);
      sf.render(block.querySelector('.dt-feature-body'));
    });
  }

  // ── Routing — plain hash-based, no framework needed for this ────────────
  function currentRoute() {
    const h = (location.hash || '#overview').slice(1);
    const parts = h.split('/');
    return { page: parts[0] || 'overview', catId: parts[1] || null, featureId: parts[2] || null };
  }
  function go(hash) { location.hash = hash; }

  function renderSidebar() {
    const sb = document.getElementById('dt-sidebar');
    const route = currentRoute();
    let html = '<div class="dt-sb-item' + (route.page === 'overview' ? ' active' : '') + '" data-go="#overview">📋 Overview</div>';
    CATEGORIES.forEach((cat) => {
      html += '<div class="dt-sb-item' + (route.catId === cat.id ? ' active' : '') + '" data-go="#category/' + cat.id + '">' +
        cat.icon + ' ' + cat.label +
        '<span class="dt-sb-count">' + cat.features.length + '</span>' +
      '</div>';
    });
    sb.innerHTML = html;
    sb.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => go(el.dataset.go)));
  }

  function renderOverview() {
    const main = document.getElementById('dt-main');
    main.innerHTML =
      '<h1>Settings Overview</h1>' +
      '<p class="dt-subtitle">Every feature this version of Kerem Duel Tools offers, grouped by category. Click a category or a feature to configure it.</p>' +
      '<input class="dt-search" id="dt-overview-search" placeholder="Search settings…"/>' +
      '<div class="dt-cat-grid" id="dt-cat-grid"></div>';

    function renderGrid(filter) {
      const f = (filter || '').toLowerCase().trim();
      const grid = document.getElementById('dt-cat-grid');
      grid.innerHTML = CATEGORIES.map((cat) => {
        const feats = cat.features.filter((ft) => !f || ft.label.toLowerCase().includes(f) || cat.label.toLowerCase().includes(f));
        if (f && !feats.length) return '';
        return '<div class="dt-cat-card" data-go="#category/' + cat.id + '">' +
          '<div class="dt-cat-card-title">' + cat.icon + ' ' + cat.label + '</div>' +
          '<div class="dt-cat-card-scope">' + cat.scope + '</div>' +
          '<div class="dt-cat-card-list">' +
            (f ? feats : cat.features).map((ft) =>
              '<a data-go="#category/' + cat.id + '/' + ft.id + '">' + ft.label + '</a>'
            ).join('<br/>') +
          '</div>' +
        '</div>';
      }).join('');
      grid.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); go(el.dataset.go); }));
    }
    renderGrid('');
    document.getElementById('dt-overview-search').addEventListener('input', (e) => renderGrid(e.target.value));
  }

  function renderCategory(catId, openFeatureId) {
    const cat = CATEGORIES.find((c) => c.id === catId);
    const main = document.getElementById('dt-main');
    if (!cat) { main.innerHTML = '<p>Unknown category.</p>'; return; }
    main.innerHTML =
      '<div class="dt-breadcrumb"><a data-go="#overview">Overview</a> / ' + cat.label + '</div>' +
      '<h1>' + cat.icon + ' ' + cat.label + '</h1>' +
      '<div class="dt-scope-pill">Scope: ' + cat.scope + '</div>' +
      '<div id="dt-feature-list"></div>';
    main.querySelector('[data-go]').addEventListener('click', (e) => go(e.target.dataset.go));

    const list = document.getElementById('dt-feature-list');
    cat.features.forEach((ft) => {
      const block = document.createElement('div');
      block.className = 'dt-feature' + (ft.id === openFeatureId ? ' open' : '');
      block.innerHTML =
        '<div class="dt-feature-head">' +
          '<div class="dt-chevron"></div>' +
          '<div class="dt-feature-title">' + ft.label + '</div>' +
          '<div class="dt-feature-configure">configure</div>' +
        '</div>' +
        '<div class="dt-feature-body"></div>';
      block.querySelector('.dt-feature-head').addEventListener('click', () => {
        block.classList.toggle('open');
      });
      list.appendChild(block);
      ft.render(block.querySelector('.dt-feature-body'));
    });
  }

  function render() {
    renderSidebar();
    const route = currentRoute();
    if (route.page === 'category' && route.catId) renderCategory(route.catId, route.featureId);
    else renderOverview();
  }

  window.addEventListener('hashchange', render);
  render();

  // ── Footer bar: Reset Everything / Save / Save & Close ──────────────────
  // Reset Everything is its own fully-committed action, separate from the
  // staged Save flow above — it already gates behind its own explicit
  // confirmation, so it writes ALL_DEFAULTS straight to storage immediately
  // (and drops any other staged edits, since a full reset supersedes them)
  // rather than requiring a second Save click on top of that confirmation.
  function flashStatus(text) {
    const bar = document.getElementById('dt-footer-status');
    if (!bar) return;
    bar.textContent = text;
    setTimeout(() => { if (!isDirty()) bar.textContent = ''; }, 1500);
  }
  document.getElementById('dt-reset-everything').addEventListener('click', () => {
    if (!window.confirm('This will reset every Duel Tools setting to its default. Are you sure?')) return;
    pendingChanges = {};
    STORAGE.set(ALL_DEFAULTS, () => {
      markDirty();
      flashStatus('Everything reset to defaults');
      render(); // re-render whatever's open so its toggles reflect the reset immediately
    });
  });
  document.getElementById('dt-save').addEventListener('click', () => {
    flushPending(() => flashStatus('Saved'));
  });
  document.getElementById('dt-save-close').addEventListener('click', () => {
    flushPending(() => {
      // This page can run two ways now: its own real tab (options_ui, or
      // the toolbar popup's "Open Settings" button — window.close() works
      // there), or embedded in the on-page overlay's iframe (dt-unlock
      // .user.js's openSettingsOverlay) — window.close() is a no-op on a
      // plain iframe since it was never window.open()'d, so instead this
      // asks the parent page to hide the overlay.
      if (window.self !== window.top) {
        try { window.parent.postMessage({ source: 'dt-settings-overlay', type: 'DT_SETTINGS_CLOSE' }, '*'); } catch (e) {}
      } else {
        window.close();
      }
    });
  });
  // Closing/navigating away with unsaved edits discards them per the
  // staged-save model above — warn before that happens, same as any other
  // page with an unsaved-edits guard.
  window.addEventListener('beforeunload', (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  // The embedded overlay (dt-unlock.user.js) can't rely on beforeunload —
  // hiding an iframe never fires it — so when its X button or a backdrop
  // click wants to close the overlay, it asks THIS page to close itself
  // instead of just hiding the iframe from outside. Route that exactly like
  // clicking "Save & Close" so no staged edit can be lost just by closing
  // the panel some other way.
  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.source !== 'dt-unlock-overlay' || ev.data.type !== 'DT_REQUEST_CLOSE') return;
    document.getElementById('dt-save-close').click();
  });
})();
