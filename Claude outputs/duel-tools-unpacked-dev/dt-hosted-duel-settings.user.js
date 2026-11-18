// ==UserScript==
// @name         Duel Tools — Hosted Duel Settings
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Pre-fills DuelingBook's own "Host a Duel" form (Format, Type, Rules, Duel Note, Duel Password, Watching, Classic, Tag Duel, Watch Note, Watch Password) the moment the Duel Lobby loads, per Settings → Lobby Customization → Hosted Duel Settings.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── Mechanic ───────────────────────────────────────────────────────────
// Same approach as Default Card Pool (dt-default-card-pool.user.js): this
// never maintains its own UI on the page — it just sets DuelingBook's own
// real form controls to the saved values and fires the same events a real
// pick/type would, once, the moment the Duel Lobby's "Host a Duel" form
// (#host_bg, confirmed live) exists. Per the user's explicit call, this
// never re-triggers just because the real Format dropdown gets changed
// afterward — only a fresh arrival at the lobby (leaving and coming back,
// including a full page reload) re-applies it.
//
// Confirmed live against the real #host_bg form: its own Format dropdown
// (select.format_cb) offers exactly 10 values — au (Advanced Unrated), yu
// (Genesys), cu (Custom Cards), gu (Goat), eu (Edison), uu (Unlimited), su
// (Speed Duels), ru (Rush Duels), tu (Traditional), so (Solo Mode) — and
// every one of those keeps the exact same 9 other fields (Type, Rules,
// Duel Note, Duel Password, Watching, Classic, Tag Duel, Watch Note,
// Watch Password) regardless of which format is picked, Solo Mode
// included. Settings → Hosted Duel Settings stores a "Default" profile
// (which carries the Format choice too) plus one "Override" profile per
// format EXCEPT Advanced (Unrated) — so the format Default says to open
// with gets selected, and then the other 9 fields come from THAT format's
// own Override profile if one exists, or from Default's own fields when
// the selected format is Advanced (Unrated) (the one format with no
// Override of its own).
(function () {
  'use strict';

  const ENABLED_KEY = 'dt_hosted_duel_settings_enabled';
  const DEFAULT_KEY = 'dt_hosted_duel_default';
  const OVERRIDES_KEY = 'dt_hosted_duel_overrides';

  const BLANK_FIELDS = {
    type: 's', rules: '*', duelNote: '', duelPassword: '',
    watching: true, classic: false, tagDuel: false,
    watchNote: '', watchPassword: ''
  };
  const DEFAULT_PROFILE = Object.assign({ format: 'au' }, BLANK_FIELDS);

  function isOnDuelLobby() {
    const el = document.getElementById('duel_room');
    return !!(el && el.offsetParent !== null);
  }

  function getHostBg() {
    const el = document.getElementById('host_bg');
    return el && el.offsetParent !== null ? el : null;
  }

  function getSettings(cb) {
    chrome.storage.local.get(
      { [ENABLED_KEY]: false, [DEFAULT_KEY]: DEFAULT_PROFILE, [OVERRIDES_KEY]: {} },
      (s) => {
        cb({
          enabled: !!s[ENABLED_KEY],
          defaultProfile: Object.assign({}, DEFAULT_PROFILE, s[DEFAULT_KEY] || {}),
          overrides: s[OVERRIDES_KEY] || {}
        });
      }
    );
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setSelectValue(sel, value) {
    if (!sel || sel.value === value) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setCheckbox(cb, checked) {
    if (!cb || cb.checked === !!checked) return;
    cb.checked = !!checked;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyFields(host, fields) {
    setSelectValue(host.querySelector('select.type_cb'), fields.type);
    setSelectValue(host.querySelector('select.rules_cb'), fields.rules);
    setNativeValue(host.querySelector('input.duel_note_txt'), fields.duelNote || '');
    setNativeValue(host.querySelector('input.duel_password_txt'), fields.duelPassword || '');
    setCheckbox(host.querySelector('input.watching_cb'), fields.watching);
    setCheckbox(host.querySelector('input.classic_cb'), fields.classic);
    setCheckbox(host.querySelector('input.tag_duel_cb'), fields.tagDuel);
    setNativeValue(host.querySelector('input.watch_note_txt'), fields.watchNote || '');
    setNativeValue(host.querySelector('input.watch_password_txt'), fields.watchPassword || '');
  }

  function applyOnce(host, defaultProfile, overrides) {
    const targetFormat = defaultProfile.format || 'au';
    const formatSel = host.querySelector('select.format_cb');
    setSelectValue(formatSel, targetFormat);

    const fields = (targetFormat !== 'au' && overrides[targetFormat])
      ? Object.assign({}, BLANK_FIELDS, overrides[targetFormat])
      : defaultProfile;

    // A tick after the format change settles — DuelingBook's own change
    // handler on select.format_cb may rebuild/reset the rest of the form
    // for the newly-selected format before we get to set our own values.
    setTimeout(() => applyFields(host, fields), 50);
  }

  // Tracks whether we've already applied this "visit" to the lobby, so a
  // fresh arrival (leaving and coming back, or a full reload) re-applies,
  // but we don't re-fight the user's own later edits to the same form for
  // as long as they stay on this one visit.
  let appliedThisVisit = false;

  function tick() {
    if (!isOnDuelLobby()) {
      appliedThisVisit = false;
      return;
    }
    const host = getHostBg();
    if (!host) return;
    if (appliedThisVisit) return;

    getSettings(({ enabled, defaultProfile, overrides }) => {
      if (!enabled) return;
      appliedThisVisit = true;
      applyOnce(host, defaultProfile, overrides);
    });
  }

  setInterval(tick, 500);
  tick();
})();
