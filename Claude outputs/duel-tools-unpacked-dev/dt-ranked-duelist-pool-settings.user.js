// ==UserScript==
// @name         Duel Tools — Ranked Duelist Pool Settings
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Pre-fills DuelingBook's own Duelist Pool box (Format, Rules, Type) the moment the Duel Lobby loads, per Settings → Lobby Customization → Ranked Duelist Pool Settings. Never auto-clicks Join Pool.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Same mechanic as dt-hosted-duel-settings.user.js and Default Card Pool:
// sets DuelingBook's own real form controls and fires the real change
// events, once, the moment the Duel Lobby's Duelist Pool box (#ar,
// confirmed live) exists — never maintains any UI of its own on the page.
//
// Confirmed live: #ar's own Format/Rules/Type dropdowns are a DIFFERENT,
// narrower option set than Host a Duel's #host_bg equivalents — Format
// offers 13 choices (4 Rated + 9 Unrated, no Solo Mode), Rules offers only
// TCG/OCG (no combined "TCG + OCG"), Type offers only Match/Single (with
// siding) (no "Single, no siding"). Per the user's explicit call, this
// never touches the real "Join Pool" button — joining stays a deliberate
// action the person takes themselves.
(function () {
  'use strict';

  const ENABLED_KEY = 'dt_ranked_duelist_pool_settings_enabled';
  const FORMAT_KEY = 'dt_ranked_duelist_pool_format';
  const RULES_KEY = 'dt_ranked_duelist_pool_rules';
  const TYPE_KEY = 'dt_ranked_duelist_pool_type';

  function isOnDuelLobby() {
    const el = document.getElementById('duel_room');
    return !!(el && el.offsetParent !== null);
  }

  function getDuelistPoolBox() {
    const el = document.getElementById('ar');
    return el && el.offsetParent !== null ? el : null;
  }

  function getSettings(cb) {
    chrome.storage.local.get(
      { [ENABLED_KEY]: false, [FORMAT_KEY]: 'ar', [RULES_KEY]: 'TCG', [TYPE_KEY]: 'm' },
      (s) => {
        cb({
          enabled: !!s[ENABLED_KEY],
          format: s[FORMAT_KEY] || 'ar',
          rules: s[RULES_KEY] || 'TCG',
          type: s[TYPE_KEY] || 'm'
        });
      }
    );
  }

  // Only these two format values leave Rules/Type as real, user-changeable
  // dropdowns — every other format (Goat, Edison, Genesys, Unlimited,
  // Speed Duels, Rush Duels, Traditional, Custom Cards...) comes with a
  // fixed ruleset, and DuelingBook's own native format_cb change handler
  // greys out (disables) Rules/Type and resets them the instant a
  // non-Advanced format is selected.
  const ADVANCED_FORMAT_VALUES = ['ar', 'au'];

  function setSelectValue(sel, value) {
    if (!sel || sel.value === value) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // BUG FIX (confirmed live): the old code always set Rules and Type right
  // after Format, regardless of which format was picked. Setting Format to
  // a fixed-ruleset format (e.g. "gr" / Goat Format (Rated)) correctly
  // fires DuelingBook's own handler, which disables Rules/Type and resets
  // Rules to its locked value — confirmed live: rules.disabled/type.
  // disabled both flip to true right there. But our code's very next two
  // lines then forced Rules/Type back to an inline value and fired their
  // own 'change' events on those now-should-be-locked controls, which
  // un-does that locked state — the two dropdowns end up NOT greyed out
  // (exactly what the user saw), and DuelingBook's Join Pool then rejects
  // the mismatched Rules/Type for a fixed-ruleset format. Confirmed live
  // (format "ar" → "gr" with Rules/Type left untouched): Rules/Type
  // disable correctly on their own, no extra steps needed. Fix: only ever
  // touch Rules/Type ourselves when the chosen format is Advanced
  // (Rated/Unrated) — the one case where they're real, independent
  // choices — letting every other format's own native handler fully own
  // locking (and resetting) those two controls.
  function applyOnce(box, format, rules, type) {
    setSelectValue(box.querySelector('select.format_cb'), format);
    if (ADVANCED_FORMAT_VALUES.indexOf(format) !== -1) {
      setSelectValue(box.querySelector('select.rules_cb'), rules);
      setSelectValue(box.querySelector('select.type_cb'), type);
    }
  }

  // Same "once per lobby visit" model as dt-hosted-duel-settings.user.js —
  // re-applies on a fresh arrival at the lobby, but never fights the
  // person's own later edits for the rest of that visit.
  let appliedThisVisit = false;

  function tick() {
    if (!isOnDuelLobby()) {
      appliedThisVisit = false;
      return;
    }
    const box = getDuelistPoolBox();
    if (!box) return;
    if (appliedThisVisit) return;

    getSettings(({ enabled, format, rules, type }) => {
      if (!enabled) return;
      appliedThisVisit = true;
      applyOnce(box, format, rules, type);
    });
  }

  setInterval(tick, 500);
  tick();
})();
