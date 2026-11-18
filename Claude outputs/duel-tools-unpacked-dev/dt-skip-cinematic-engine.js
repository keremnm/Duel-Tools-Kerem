// Duel Tools — Automatically Skip Opening Cinematic engine (MAIN world)
//
// Confirmed live: DuelingBook's own "Skip Intro" button (#skip_intro_btn)
// is wired straight to a real page function, window.skipIntro() — it hides
// the intro's elements, kills its TweenMax animations, and calls
// DuelingBook's own gotoFrontPage() + loadGuild(), exactly what a real
// click on that button does. Calling it directly here is equivalent to,
// and simpler than, synthesizing a click on the button element.
//
// Needs MAIN world because skipIntro (like every other page-global
// function this extension calls directly — shuffleHandE, the RPS/
// Transparent-Facedowns engines, etc.) only exists there; the isolated-
// world companion (dt-skip-opening-cinematic.user.js) owns the setting
// read (chrome.storage-only) and just posts a bare request over once.
//
// v1.1 — root-caused a bug where enabling this feature left the front page
// showing only its background (no logo/Duel button/login panel): calling
// skipIntro() too early (right at document-idle, before DuelingBook's own
// front-page init has reached the point the intro is actually interruptible)
// let the call run with NO thrown error, yet window.gotoFrontPage() silently
// failed to take effect — window.currentLabel stayed 'start' and #front_page
// stayed display:none. Confirmed live that calling window.skipIntro() again
// a moment later always completes correctly (currentLabel -> 'front_page',
// #front_page -> visible). So instead of a single fire-and-forget call, this
// now VERIFIES the result and retries until it actually sticks, which is
// robust regardless of the exact race: skipIntro() is cheap/idempotent to
// call again (every step it performs — hide/remove already-gone elements,
// clearInterval, TweenMax.killTweensOf — is a harmless no-op on a repeat
// call; only gotoFrontPage()'s effect is the part that needs to land).
//
// v1.2 — user report: "sometimes on refresh the main menu doesn't load",
// reproduced as the v1.1 retry loop exhausting its original 20 attempts @
// 250ms (~5s total) and giving up for good, leaving the page permanently
// stuck mid-intro (background + Welcome/Forum/Rules only — no logo, no
// Duel button, no login panel — since skipIntro() had already torn down
// the intro's own intervals/tweens on earlier attempts, so DuelingBook's
// native intro can't recover on its own either; only re-running
// gotoFrontPage() can, and a plain manual refresh always fixed it when
// this happened, confirmed live). Two changes:
//   1) Two-phase retry instead of one: the original fast phase (250ms x20,
//      ~5s — unchanged, covers the common quick race) now falls through to
//      a slow phase (1000ms x24, ~24s more) for a slower/degraded load
//      instead of giving up at 5s.
//   2) If BOTH phases exhaust (~29s total) without window.currentLabel
//      ever reaching 'front_page', self-heal with exactly the fix that
//      always worked by hand: location.reload() once. Guarded by a
//      sessionStorage flag (not localStorage) so this can only fire once
//      per browser tab session — if a reload genuinely doesn't help
//      (meaning the real problem is something else entirely), it won't
//      reload-loop forever, it just logs and stops, same as v1.1's old
//      give-up behavior.
(function () {
  'use strict';

  // [{delay between attempts in this phase (ms), attempts in this phase}]
  const PHASES = [
    { delay: 250, attempts: 20 }, // ~5s — unchanged from v1.1, handles the common case
    { delay: 1000, attempts: 24 } // ~24s more — extra runway for a slower/degraded load
  ];
  const RELOAD_GUARD_KEY = 'dt_skip_intro_auto_reload_attempted';

  let totalAttempts = 0;
  let phaseIdx = 0;
  let attemptInPhase = 0;
  let done = false;

  function skipSucceeded() {
    // currentLabel is DuelingBook's own page-router state (set inside its
    // goto() helper, which gotoFrontPage() calls) — 'front_page' is the
    // ground truth that the skip actually landed, not just that skipIntro()
    // ran without throwing.
    try {
      return window.currentLabel === 'front_page';
    } catch (e) {
      return false;
    }
  }

  function clearReloadGuard() {
    try { sessionStorage.removeItem(RELOAD_GUARD_KEY); } catch (e) { /* ignore */ }
  }

  function selfHealWithReload() {
    try {
      if (sessionStorage.getItem(RELOAD_GUARD_KEY) === '1') {
        console.log('[Duel Tools] Skip Opening Cinematic engine: front page never confirmed after ' + totalAttempts + ' attempt(s), and an auto-reload was already tried this tab session — giving up (please refresh manually).');
        return;
      }
      sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
    } catch (e) {
      // sessionStorage inaccessible (rare/private-mode edge case) — fall
      // through and still reload once; worst case is one extra reload with
      // no loop guard, never a loop (the page is navigating away anyway).
    }
    console.log('[Duel Tools] Skip Opening Cinematic engine: front page never confirmed after ' + totalAttempts + ' attempt(s) — auto-reloading once to recover (this always fixed it by hand).');
    location.reload();
  }

  function attempt() {
    if (done) return;
    totalAttempts++;
    attemptInPhase++;
    try {
      if (typeof window.skipIntro === 'function') window.skipIntro();
    } catch (e) {
      console.log('[Duel Tools] Skip Opening Cinematic engine: skipIntro() call failed (attempt ' + totalAttempts + '):', e);
    }
    const phase = PHASES[phaseIdx];
    setTimeout(function () {
      if (skipSucceeded()) {
        done = true;
        clearReloadGuard();
        console.log('[Duel Tools] Skip Opening Cinematic engine: confirmed front page loaded after ' + totalAttempts + ' attempt(s).');
        return;
      }
      if (attemptInPhase < phase.attempts) {
        attempt();
        return;
      }
      // This phase is exhausted — move to the next phase, if any.
      phaseIdx++;
      attemptInPhase = 0;
      if (phaseIdx < PHASES.length) {
        attempt();
        return;
      }
      done = true;
      selfHealWithReload();
    }, phase.delay);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return; // same-tab only, never a cross-frame/opponent message
    const data = ev.data;
    if (!data || data.source !== 'dt-skip-opening-cinematic' || data.type !== 'DT_SKIP_INTRO_REQUEST') return;
    if (totalAttempts > 0) return; // one skip sequence per page load
    attempt();
  });

  console.log('[Duel Tools] Skip Opening Cinematic engine (MAIN world) ready');
})();
