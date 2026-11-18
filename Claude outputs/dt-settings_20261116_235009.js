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
    dt_card_tracking_track_revealed: true
  };
  Object.assign(ALL_DEFAULTS, CARD_TRACKING_DEFAULTS);
  function renderCardTrackingFeature(container) {
    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Card Tracking</b><div class="dt-row-detail">Shows card art for every opponent card currently known to be in their hand, in unused screen space.</div></div>' +
        switchHtml('ct-master') +
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
      '<div class="dt-note warn">Log-line matching for this feature is not yet verified against a real live duel — flag it if a card doesn\'t appear or disappear when it should.</div>';

    const master = container.querySelector('#ct-master input');
    const added = container.querySelector('#ct-added input');
    const revealed = container.querySelector('#ct-revealed input');

    getSettings(CARD_TRACKING_DEFAULTS, (s) => {
      master.checked = !!s.dt_card_tracking_enabled;
      added.checked = !!s.dt_card_tracking_track_added;
      revealed.checked = !!s.dt_card_tracking_track_revealed;
    });
    master.addEventListener('change', (e) => setSetting({ dt_card_tracking_enabled: e.target.checked }));
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
    dt_room_visibility_hidden: []
  };
  Object.assign(ALL_DEFAULTS, ROOM_VISIBILITY_DEFAULT_SETTINGS);

  function renderRoomVisibilityFeature(container) {
    const labelById = {};
    ROOM_VISIBILITY_POOLS.forEach((p) => { labelById[p.id] = p.label; });

    container.innerHTML =
      '<div class="dt-row">' +
        '<div class="dt-row-label"><b>Enable Room Visibility</b><div class="dt-row-detail">Reorders and/or hides the format/pool panels on the Duel Lobby to match the list below, left to right.</div></div>' +
        switchHtml('rv-master') +
      '</div>' +
      '<div class="dt-rv-toolbar"><button type="button" class="dt-rv-reset" id="rv-reset">Reset to Default Order</button></div>' +
      '<ul class="dt-rv-list" id="rv-list"></ul>' +
      '<div class="dt-note">Drag a row by its handle (or use the arrows) to change the order the panels appear left-to-right on the Duel Lobby — the first one in your order sits right next to the Duelist Pool. The eye icon hides a panel entirely.</div>' +
      '<div class="dt-note">Live — see dt-room-visibility.user.js. Confirmed live that DuelingBook positions each pool panel with its own CSS left offset, independent of where it sits in the page\'s HTML, so this works by reassigning those offsets directly instead of fighting DuelingBook\'s own layout code.</div>';

    const master = container.querySelector('#rv-master input');
    const listEl = container.querySelector('#rv-list');
    const resetBtn = container.querySelector('#rv-reset');

    let order = ROOM_VISIBILITY_DEFAULT_ORDER.slice();
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
      setSetting({ dt_room_visibility_order: order.slice(), dt_room_visibility_hidden: hidden.slice() });
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
      order = ROOM_VISIBILITY_DEFAULT_ORDER.slice();
      hidden = [];
      renderList();
      persist();
    });

    getSettings(ROOM_VISIBILITY_DEFAULT_SETTINGS, (s) => {
      master.checked = !!s.dt_room_visibility_enabled;
      order = (Array.isArray(s.dt_room_visibility_order) && s.dt_room_visibility_order.length)
        ? s.dt_room_visibility_order.slice() : ROOM_VISIBILITY_DEFAULT_ORDER.slice();
      // Guard against a saved order that's stale/short (missing a pool id,
      // e.g. saved before this list grew) — append anything missing at the
      // end so nothing silently vanishes from the lobby.
      const have = {};
      order.forEach((id) => { have[id] = true; });
      ROOM_VISIBILITY_DEFAULT_ORDER.forEach((id) => { if (!have[id]) order.push(id); });
      hidden = Array.isArray(s.dt_room_visibility_hidden) ? s.dt_room_visibility_hidden.slice() : [];
      renderList();
    });
    master.addEventListener('change', (e) => setSetting({ dt_room_visibility_enabled: e.target.checked }));
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
        { id: 'defaultHandView', label: 'Default Replay Hand View', render: renderDefaultReplayHandViewFeature }
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
          id: 'cardLanguages', label: 'Card Languages',
          render: renderSimpleToggleFeature(
            'dt_card_languages_enabled', false,
            'Card Languages',
            'Details not yet spec\'d out.',
            'Stub — off by default, not yet wired to anything. Full behavior still being spec\'d out.'
          )
        },
        {
          id: 'cardTextSize', label: 'Card Text Size',
          render: renderSimpleToggleFeature(
            'dt_card_text_size_enabled', false,
            'Card Text Size',
            'Details not yet spec\'d out.',
            'Stub — off by default, not yet wired to anything. Full behavior still being spec\'d out.'
          )
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
          id: 'mainMenuSectionVisibility', label: 'Main Menu Section Visibility',
          render: renderSimpleToggleFeature(
            'dt_main_menu_section_visibility_enabled', false,
            'Main Menu Section Visibility',
            'Details not yet spec\'d out.',
            'Stub — off by default, not yet wired to anything. Full behavior still being spec\'d out.'
          )
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
  const renderCustomImagesStub = renderSimpleToggleFeature(
    'dt_custom_images_enabled', false,
    'Custom Images',
    'Details not yet spec\'d out.',
    'Stub — off by default, not yet wired to anything. Full behavior still being spec\'d out.'
  );
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
      id: 'roomPanels', label: 'Room panels',
      rows: [
        { id: 'rankedRoom', label: 'Ranked room panel', color: '#b7daff', opacity: 80, image: '4:3' },
        { id: 'advancedRoom', label: 'Advanced (Unrated) room panel', color: '#a6edd6', opacity: 80, image: '4:3' },
        { id: 'genesysRoom', label: 'Genesys Format room panel', color: '#ffd0b7', opacity: 80, image: '4:3' },
        { id: 'goatRoom', label: 'Goat Format room panel', color: '#d5b9ff', opacity: 80, image: '4:3' },
        { id: 'edisonRoom', label: 'Edison Format room panel', color: '#fff4a1', opacity: 80, image: '4:3' },
        { id: 'customCardsRoom', label: 'Custom Cards room panel', color: '#b7daff', opacity: 80, image: '4:3' },
        { id: 'speedDuelsRoom', label: 'Speed Duels room panel', color: '#cefae1', opacity: 80, image: '4:3' },
        { id: 'rushDuelsRoom', label: 'Rush Duels room panel', color: '#ffdbc4', opacity: 80, image: '4:3' },
        { id: 'unlimitedRoom', label: 'Unlimited room panel', color: '#efefef', opacity: 80, image: '4:3' },
        { id: 'traditionalRoom', label: 'Traditional room panel', color: '#ffc8de', opacity: 80, image: '4:3' }
      ]
    },
    {
      id: 'mainInterface', label: 'Main interface',
      rows: [
        { id: 'mainPageBg', label: 'Main page background', color: '#070707', opacity: 100, image: '16:10' },
        { id: 'circuitTint', label: 'Circuit-pattern dark tint', color: '#070707', opacity: 30, image: '16:10' },
        { id: 'welcomeBulletinBg', label: 'Welcome bulletin background', color: '#ffffff', opacity: 100, image: '8:3' },
        { id: 'welcomeBulletinText', label: 'Welcome bulletin text', color: '#000000', opacity: 100 },
        { id: 'mainMenuText', label: 'Main menu text', color: '#ffffff', opacity: 100 },
        { id: 'chatOnlineText', label: 'Chat and online-users text', color: '#ffffff', opacity: 100 }
      ]
    },
    {
      id: 'navAccents', label: 'Navigation accents',
      rows: [
        { id: 'welcomeLink', label: 'Welcome link', color: '#ff476e', opacity: 100 },
        { id: 'forumLink', label: 'Forum link', color: '#66ccff', opacity: 100 },
        { id: 'rulesLink', label: 'Rules link', color: '#90fc98', opacity: 100 },
        { id: 'postStatusLink', label: 'Post Status link', color: '#0077ff', opacity: 100 }
      ]
    },
    {
      id: 'duelRoom', label: 'Duel Room',
      rows: [
        { id: 'carouselArrows', label: 'Room carousel arrow buttons', color: '#cccccc', opacity: 100 },
        { id: 'roomPanelTitles', label: 'Room panel titles', color: '#ffffff', opacity: 100 },
        { id: 'roomPanelBodyText', label: 'Room panel body text', color: '#000000', opacity: 100 },
        { id: 'hostDuelHeading', label: 'Host a Duel heading', color: '#ffffff', opacity: 100 },
        { id: 'hostDuelFormLabels', label: 'Host a Duel form labels', color: '#ffffff', opacity: 100 }
      ]
    },
    {
      id: 'deckConstructor', label: 'Deck Constructor',
      rows: [
        { id: 'deckLabels', label: 'Deck Constructor labels', color: '#000000', opacity: 100 },
        { id: 'deckDropdownBg', label: 'Deck Constructor dropdown backgrounds', color: '#efefef', opacity: 100 },
        { id: 'mainDeckGrid', label: 'Main Deck grid lines', color: '#8601b3', opacity: 100 },
        { id: 'sideDeckGrid', label: 'Side Deck grid lines', color: '#0099ff', opacity: 100 },
        { id: 'extraDeckGrid', label: 'Extra Deck grid lines', color: '#ff7500', opacity: 100 }
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
        { id: 'watchersPanelBg', label: 'Watchers panel background', color: '#ffffff', opacity: 100 }
      ]
    }
  ];

  const CUSTOM_COLORS_MASTER_DEFAULTS = {
    dt_custom_colors_enabled: false,
    dt_custom_colors_grid_lines: true
  };
  const CUSTOM_COLORS_ROW_DEFAULTS = {};
  CUSTOM_COLOR_SECTIONS.forEach((sec) => sec.rows.forEach((row) => {
    CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_color'] = row.color;
    CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_opacity'] = row.opacity;
    if (row.image) CUSTOM_COLORS_ROW_DEFAULTS['dt_cc_' + row.id + '_image'] = null;
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

  function renderThemeSelectorFeature(container) {
    container.innerHTML =
      '<div class="dt-note">Save your current Custom Colors setup from the "Save as New Theme" button over in Custom Colors to build a list here — up to ' + CUSTOM_THEMES_MAX + ' at a time. <b>Load</b> applies a saved theme\'s colors/opacity/images; <b>Delete</b> removes it from this list for good.</div>' +
      '<div id="ts-list"></div>';
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
        '<div class="dt-cc-row-label">' + row.label + '</div>' +
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
      '<div class="dt-cc-save-theme-row">' +
        '<button type="button" class="dt-cc-reset-theme" id="cc-save-theme">💾 Save as New Theme</button>' +
        '<span class="dt-cc-img-status">Snapshots every row below (color/opacity/image) into Theme Selector, so you can Load it again later.</span>' +
      '</div>' +
      '<div class="dt-note warn">Show Background Grid Lines is LIVE — see dt-custom-colors-grid.user.js. Everything else below is still scaffold only; nothing else changes DuelingBook\'s actual look yet. Once a section looks right, we wire it to the live page one at a time and verify it before moving to the next.</div>' +
      '<div id="cc-sections"></div>';

    const master = container.querySelector('#cc-master input');
    const gridlines = container.querySelector('#cc-gridlines input');
    getSettings({ dt_custom_colors_enabled: false, dt_custom_colors_grid_lines: true }, (s) => {
      master.checked = !!s.dt_custom_colors_enabled;
      gridlines.checked = !!s.dt_custom_colors_grid_lines;
    });
    master.addEventListener('change', (e) => setSetting({ dt_custom_colors_enabled: e.target.checked }));
    gridlines.addEventListener('change', (e) => setSetting({ dt_custom_colors_grid_lines: e.target.checked }));

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

    const sectionsEl = container.querySelector('#cc-sections');
    CUSTOM_COLOR_SECTIONS.forEach((section) => {
      const block = document.createElement('div');
      block.className = 'dt-ccolor-section';
      block.innerHTML =
        '<div class="dt-ccolor-section-head">' +
          '<div class="dt-ccolor-section-title">' + section.label + '</div>' +
          '<div class="dt-chevron"></div>' +
        '</div>' +
        '<div class="dt-ccolor-section-body"></div>';
      block.querySelector('.dt-ccolor-section-head').addEventListener('click', () => block.classList.toggle('open'));
      sectionsEl.appendChild(block);
      const body = block.querySelector('.dt-ccolor-section-body');
      body.innerHTML = section.rows.map(ccRowHtml).join('');
      section.rows.forEach((row) => ccWireRow(body, row));
    });
  }

  const CUSTOM_APPEARANCE_SUBFEATURES = [
    { id: 'themeSelector', label: 'Theme Selector', render: renderThemeSelectorFeature },
    { id: 'customImages', label: 'Custom Images', render: renderCustomImagesStub },
    { id: 'customColors', label: 'Custom Colors', render: renderCustomColorsFeature },
    { id: 'customEmotes', label: 'Custom Emotes', render: renderCustomEmotesFeature }
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
