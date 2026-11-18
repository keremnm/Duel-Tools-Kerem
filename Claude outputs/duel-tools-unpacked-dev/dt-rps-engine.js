// Duel Tools — RPS Automation engine (MAIN world)
//
// CONFIRMED LIVE, repeatedly: dispatching the mousedown -> mouseup ->
// click sequence that actually registers a Rock/Paper/Scissors pick on
// DuelingBook's own #rps_start .rps_card elements is 100% reliable when
// done from the PAGE's own MAIN-world JS context, but was unreliable when
// the exact same dispatchEvent calls were made from the extension's
// ISOLATED-world content script — even though both target the very same
// shared DOM nodes. So the actual click has always happened here.
//
// WHY THE WHOLE DECIDE-AND-CLICK LOOP LIVES HERE NOW (not just the click):
// the isolated-world script (dt-rps-automation.user.js) can't see the
// page's own `pickedRPS` global at all. dt-rps-automation.user.js now only
// reads the GM_getValue settings (not available in MAIN world) and relays
// the current "Automated RPS" on/off state to this file via postMessage;
// everything about WHEN a round is fresh, WHAT to pick, and clicking it is
// owned here instead.
//
// ROUND-FRESHNESS DETECTION, round 2: an earlier version here reset its
// "already decided" flag ONLY on `window.pickedRPS` being true. That
// regressed HARD — the symptom went from "same pick 3-4 times then
// switches" to "same pick forever, never switches" — which means
// `window.pickedRPS` was never actually observed true from here, so the
// reset path never fired even once and the very first roll ever made got
// stuck and re-clicked on every later round. Most likely cause: the page
// may declare `pickedRPS` as a top-level `let`/`const` rather than `var`,
// which is readable as a bare identifier by other scripts sharing the
// same realm but is NOT a property of `window` — so `window.pickedRPS` is
// silently always undefined even though the page's own value is very
// much alive and changing. (Before that, the isolated-world script used a
// DOM-inferred signal instead — chooseRPS sets inline `pointer-events:
// none` on the 3 cards the instant a pick registers — which worked often
// enough to eventually self-correct, just not every single time.)
//
// Fix: don't bet everything on one signal. Reset on EITHER signal firing
// — `window.pickedRPS` (in case it does work after all) OR the DOM
// inference (which this engine can also read directly, so there's no
// reason to drop it just because pickedRPS was supposed to be better).
// Whichever one actually fires in practice is now logged (throttled) so
// this can be confirmed from the console.
(function () {
  'use strict';

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // CONFIRMED LIVE (the actual, definitive root cause of "it always picks
  // Rock" — not probabilistic, not a timing race, happened on literally
  // every card every time): each card's own name lives in a dedicated
  // `.name_txt` span ("Rock"/"Paper"/"Scissors", nothing else), but this
  // function used to regex-match against the card's WHOLE textContent,
  // which also includes its `.effect_txt` flavor line — and that flavor
  // line explicitly names all 3 moves on every single card ("Rock beats
  // scissors but loses to paper" / "Paper beats rock but loses to
  // scissors" / "Scissors beats paper but loses to rock"). Checking
  // /Rock/i first against that whole blob matched "Rock" on every card,
  // every time, with 100% certainty — not a rare bad-luck streak. The
  // "fresh round detected... (rolled index 1 of ["Rock","Rock","Rock"])"
  // log line that proved this: all 3 "names" were "Rock" because this
  // function itself was broken, not because the DOM was ever showing
  // duplicate cards. Fix: read only the dedicated `.name_txt` span.
  //
  // Matching by the move's own name instead of DOM position/index is
  // still correct and kept: a live test once caught the decided pick
  // logged as "Rock" while the round actually resolved as "Scissors" for
  // us, meaning index-based targeting can drift between deciding and
  // clicking (or between retries) if the 3 cards ever reorder.
  function cardChoice(cardEl) {
    const nameEl = cardEl.querySelector('.name_txt');
    const t = (nameEl ? nameEl.textContent : cardEl.textContent) || '';
    if (/Rock/i.test(t)) return 'Rock';
    if (/Paper/i.test(t)) return 'Paper';
    if (/Scissors/i.test(t)) return 'Scissors';
    return null;
  }

  function liveRpsCards() {
    const el = document.getElementById('rps_start');
    if (!el) return [];
    const cards = Array.from(el.querySelectorAll('.rps_card')).filter((c) => c.offsetParent !== null);
    return cards.length === 3 ? cards : []; // only treat a full, real round as "live" — partial renders are ignored
  }

  // DOM-inferred "did a pick just register" signal — chooseRPS always
  // writes this inline style the instant a click lands. Transient in the
  // sense that it may not be the FIRST tick to observe a resolved round,
  // but it reliably becomes observable at some point while the resolved
  // cards are still the ones on screen, so it's a safe fallback/co-signal
  // here (unlike relying on it from the isolated world, where it was the
  // ONLY signal available and DOM-node reuse across rounds made misses
  // costlier).
  function domSaysPicked(cards) {
    return cards.some((c) => c.style.pointerEvents === 'none');
  }

  let autoEnabled = false;
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return; // same-tab only, never a cross-frame/opponent message
    const data = ev.data;
    if (!data || data.source !== 'dt-rps-automation' || data.type !== 'DT_RPS_SETTINGS') return;
    autoEnabled = !!data.auto;
  });

  // "Has THIS round already been decided" — a plain variable, never a DOM
  // marker (DuelingBook can and does reuse the same 3 .rps_card elements
  // across rounds, including across a brand-new duel after a draw, so a
  // marker written on the nodes themselves would wrongly survive into the
  // next round). Reset the instant EITHER freshness signal above confirms
  // the CURRENT round actually resolved.
  let roundDecided = false;
  let currentPickName = null;

  function enginePoll() {
    if (!autoEnabled) {
      roundDecided = false;
      currentPickName = null;
      return;
    }

    const cards = liveRpsCards();
    if (!cards.length) {
      // Nothing on screen — whatever round comes next must be treated as
      // fresh.
      roundDecided = false;
      currentPickName = null;
      return;
    }

    const pageFlag = !!window.pickedRPS;
    const domFlag = domSaysPicked(cards);

    if (pageFlag || domFlag) {
      // Either signal confirming this round is already picked is enough.
      // Reset so the NEXT round — even if DuelingBook recycles these
      // exact nodes — is recognized as fresh and gets its own brand-new
      // random roll the moment both signals clear for it.
      roundDecided = false;
      currentPickName = null;
      return;
    }

    if (!roundDecided) {
      // CONFIRMED LIVE, with the exact smoking-gun log line: "fresh round
      // detected, pick=Rock (rolled index 1 of ["Rock","Rock","Rock"])".
      // The random index itself WAS uniformly random — the bug is that
      // all 3 cards were read back with the SAME move name. Right after a
      // round resolves, there's a brief window where pointer-events
      // clears and pickedRPS flips back to false (both looking like "a
      // fresh round!") before DuelingBook has actually re-rendered the 3
      // card faces to the real Rock/Paper/Scissors trio — they can still
      // be showing stale leftover text from the round that just ended.
      // Landing a poll tick in that gap meant "rolling randomly" across 3
      // cards that all currently say the same thing, so whichever index
      // got picked, the result was always whatever was last revealed —
      // and since that stale text is itself last round's RESULT, this
      // silently became a self-perpetuating loop once it ever happened to
      // land on Rock. Fix: only ever decide once the 3 live cards
      // genuinely show 3 DISTINCT moves (a real Rock+Paper+Scissors set).
      // If they don't yet, don't decide — leave roundDecided false and
      // just recheck next tick, however many ticks that takes.
      const names = cards.map((c) => cardChoice(c));
      const distinct = new Set(names);
      if (!(names.some((n) => !n) || distinct.size !== 3)) {
        roundDecided = true;
        // A genuinely fresh Math.random() roll, uniform across the 3
        // real, verified-distinct cards actually present, every single
        // time a new, undecided round is detected — this is the ONLY
        // place a pick is ever decided, and it only runs once per round
        // (gated by roundDecided above, which is only ever cleared by
        // the freshness signals, never guessed).
        const idx = Math.floor(Math.random() * names.length);
        currentPickName = names[idx];
      }
    }

    if (currentPickName !== null) {
      // Re-find the card by NAME on every tick (never by stored index —
      // see cardChoice note above) and retry the click every 300ms for as
      // long as pickedRPS stays false, bounded only by the round's own
      // lifetime, never by a guessed attempt count or delay.
      const target = cards.find((c) => cardChoice(c) === currentPickName);
      if (target) {
        try {
          realClick(target);
        } catch (e) {
          console.log('[Duel Tools] RPS engine click failed:', e);
        }
      }
    }
  }

  setInterval(enginePoll, 300);
  console.log('[Duel Tools] RPS Automation engine (MAIN world) ready');
})();
