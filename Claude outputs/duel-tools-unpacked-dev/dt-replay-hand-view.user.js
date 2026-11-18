// Duel Tools — Default Replay Hand View (isolated world, injected by
// background.js's injectAll() via TRACKER_FILES — see that array's own
// comment in background.js for why it rides there instead of its own phase)
//
// On a replay page, automatically picks the user's preferred default among
// DuelingBook's own Hide Hands / Show Hand / Show Both options. Off by
// default.
//
// WHY THIS READS chrome.storage.local DIRECTLY (not via the GM_getValue
// shim the other ported userscripts use): this file is a plain isolated-
// world content script, which has native access to chrome.storage.local
// once "storage" is in manifest permissions (already true here) — no shim
// needed. This also sidesteps the shim's documented caching limitation
// (it snapshots chrome.storage.local ONCE per tab-load), so this always
// reads the live, current setting value, even in a tab that was already
// open when the setting was last changed.
//
// CONFIRMED LIVE against a real replay page: DuelingBook's own hand-
// visibility control is a real radio group, name="show", with 3
// <input type="radio"> elements: #show_rb ("Hide Hands"), #show1_rb
// ("Show Hand"), #show2_rb ("Show Both"). Calling the real DOM .click()
// method directly on the radio input correctly flips .checked AND
// triggers DuelingBook's actual hand-show/hide behavior — confirmed via
// screenshot. Dispatching a synthetic MouseEvent sequence at the separate
// VISUAL `.radiobutton` div's own coordinates does nothing at all.
//
// CONFIRMED LIVE, the actual root cause of "the setting is read correctly
// but the wrong radio ends up checked anyway": DuelingBook's own page JS
// re-asserts ITS OWN last-used choice shortly after page load — clicking
// our desired radio once, then stopping, reliably loses that race, because
// our click can land before DuelingBook's own override runs. This project
// already has the idiom for exactly this shape of bug (see dt-live-
// tracker.user.js's checkbox-drift correction, which logs "clicked 1 that
// had drifted back to unchecked") — keep reasserting every tick for the
// whole polling window below instead of stopping after one successful
// click. This does mean a manual change made WITHIN that same ~15s window
// right after page load can get fought; a manual change made any time
// after that window closes (the interval always stops at MAX_TRIES) is
// never touched.
(function () {
  'use strict';

  const DEFAULTS = { dt_replay_hand_view_enabled: false, dt_replay_hand_view_choice: 'hand' };
  const CHOICE_TO_RADIO_ID = { hide: 'show_rb', hand: 'show1_rb', both: 'show2_rb' };

  function getSettings(cb) {
    try {
      chrome.storage.local.get(DEFAULTS, cb);
    } catch (e) {
      cb(DEFAULTS);
    }
  }

  // Calls done() when this tick's check is finished (there's no early-stop
  // signal anymore — see the header comment for why this keeps reasserting
  // on every tick for the whole polling window instead of stopping early).
  function tryApply(done) {
    getSettings((s) => {
      const enabled = !!s.dt_replay_hand_view_enabled;
      if (!enabled) { done(); return; }

      const choice = s.dt_replay_hand_view_choice || 'hand';
      const radioId = CHOICE_TO_RADIO_ID[choice] || 'show1_rb';
      const radio = document.getElementById(radioId);
      if (!radio) { done(); return; } // replay UI not rendered yet

      // Reassert every tick rather than stopping after the first successful
      // click — see the header comment above for why (DuelingBook's own
      // page JS can re-pick its last-used choice shortly after page load,
      // which a one-shot click can't win a race against).
      if (!radio.checked) radio.click();
      done();
    });
  }

  let tries = 0;
  const MAX_TRIES = 50; // ~15s at 300ms — generous, since a replay's full data can take a moment to load, AND long enough to outlast DuelingBook's own delayed re-assertion of its last-used choice
  const timer = setInterval(() => {
    tries++;
    tryApply(() => {
      if (tries >= MAX_TRIES) clearInterval(timer);
    });
  }, 300);
})();
