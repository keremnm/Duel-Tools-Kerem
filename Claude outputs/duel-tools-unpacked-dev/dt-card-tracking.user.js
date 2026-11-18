// ==UserScript==
// @name         Duel Tools — Card Tracking
// @namespace    http://tampermonkey.net/
// @version      0.7
// @description  Shows card art for every opponent card currently known (added to or revealed in their hand from ANY source — Deck, Graveyard, Banish zone, wherever), pulled from DuelingBook's own duel log — now actually watching the real #duel_log DOM (the live lines sit several levels deep inside an inner .os_viewport container, not as #duel_log's own direct children). Each known copy gets its OWN tile with its own card image — 2 known Thunder Dragons show as 2 Thunder Dragon tiles, never a single tile with a count marker. Removes one known copy the moment that copy becomes public some other way (normal/flip/special summoned, set, activated, discarded, sent to GY, banished, or returned to deck) — a name only disappears once it has no known copies left. Correctly re-identifies the opponent across a practice-duel-to-real-match transition on the same tab (DuelingBook never reloads the page for this). The whole list also empties the instant a new game starts (previous hands no longer apply), and every tile has a small × for manually removing that one copy if the automatic parsing ever misses a line. Uses your configured DuelingBook username (set in Settings, shared with Live Tracker) to tell your own duel-log lines apart from your opponent's, instead of guessing from line order — fixes the player's own hand showing up as the opponent's once the Usernames log checkbox is on for both sides.
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      db.ygoprodeck.com
// @run-at       document-idle
// ==/UserScript==
//
// Scope: "Playing" category — duelingbook.com only, NEVER /replay* pages
// (enforced below, as a second safety net — see background.js's
// injectAll() for the actual gating). This is a LIVE DUEL feature, same as
// Hot Keys and Duel Commands.
//
// ── Where the parsing logic comes from ──────────────────────────────────
// Every regex below (parseLine/LINE_RE/LINE_RE_BARE/SELF_LINE_SENTINEL,
// extractRevealedCardName, and the toHand/toGrave/toBanish/toDeck/toField
// classifiers) is copied, not reinvented, from dt-live-tracker.user.js's
// own already-live-tested duel-log parser — that file's comments mark these
// as "confirmed against a real match's console output" for the opponent-
// card-tracking path specifically (addKnownOppCard). This file duplicates
// rather than imports them (same self-contained-per-userscript convention
// as the rest of this extension) so a bug in one can't take down the other.
// If DuelingBook's log wording ever changes, both copies need the fix.
//
// The ONE piece that is NOT yet confirmed for THIS feature specifically:
// loading opponent card art from images.ygoprodeck.com inside a DuelingBook
// content script. The Duel Tools *website* (a separate origin, not this
// extension) already fetches that same URL shape for its own My Tracker
// card art, but an <img> tag injected into duelingbook.com's own page is
// subject to DUELINGBOOK's Content-Security-Policy, not ours — unverified
// whether DuelingBook's CSP allows it. Each tile falls back to a plain
// text-only card below if the image 404s/is blocked, so a CSP block just
// means no art, never a broken layout.
(function () {
  'use strict';

  if (window.location.pathname.indexOf('/replay') === 0) return; // belt-and-suspenders — see background.js

  function safeGetValue(key, def) {
    try { return GM_getValue(key, def); } catch (e) { return def; }
  }
  function safeSetValue(key, val) {
    try { GM_setValue(key, val); } catch (e) { /* non-fatal — tracking just won't persist across reloads */ }
  }

  // ── Log-line parsing (copied from dt-live-tracker.user.js) ──────────────
  const LINE_RE = /^\[(\d+):(\d+)\]\s*([^:]+):\s*(.*)$/;
  const LINE_RE_BARE = /^\[(\d+):(\d+)\]\s*(.*)$/;
  const SELF_LINE_SENTINEL = '__dt_self__';
  function parseLine(rawText) {
    const trimmed = rawText.trim();
    let m = LINE_RE.exec(trimmed);
    if (m) {
      const [, , , username, text] = m;
      const t = text.trim();
      return { username: username.trim(), text: t, isChat: /^".*"$/.test(t) };
    }
    m = LINE_RE_BARE.exec(trimmed);
    if (m) {
      const [, , , text] = m;
      const t = text.trim();
      if (!t) return null;
      return { username: SELF_LINE_SENTINEL, text: t, isChat: /^".*"$/.test(t) };
    }
    return null;
  }

  // Verbs DuelingBook's log uses for a named card changing zones — shared by
  // extractRevealedCardName (to parse out the name) and classify (to spot a
  // leading quantity number right after the verb, e.g. "Added 2 Thunder
  // Dragon from Deck to hand", or "Returned 2 X from Graveyard to hand").
  const MOVE_VERBS = '(?:Set |Activated |Normal Summoned |Special Summoned |Flip Summoned |Flipped |Sent |Discarded |Banished |Removed |Added |Revealed |Declared effect of |Returned |Moved |Changed )';

  // Rejects DuelingBook's own generic, no-name placeholders for a card we
  // (as the opponent) can't actually see — e.g. "Set a card" for a face-down
  // S/T whose identity isn't known, or a generic "2 cards" with no names
  // given. Without this, a bare-verb line like that would get captured as a
  // literal card named "a card"/"cards"/"a Spell/Trap Card" and pollute the
  // known list, instead of correctly extracting nothing (the very case the
  // user flagged: an unidentified set card has to stay unknown to the
  // tracker, never guessed at).
  function isGenericPlaceholderName(n) {
    return /^(?:a )?cards?$/i.test(n) || /^a (?:monster|spell(?:\/trap)? card|trap card)$/i.test(n);
  }
  function extractRevealedCardName(text) {
    const drewM = /^Drew (.+)$/.exec(text);
    if (drewM) { const n = drewM[1].trim(); return isGenericPlaceholderName(n) ? null : n; }
    const revealedM = /^Revealed ([A-Za-z0-9 ,.'\-:]+)$/.exec(text);
    if (revealedM) { const n = revealedM[1].trim(); return isGenericPlaceholderName(n) ? null : n; }
    // (?:\d+\s+)? skips a leading quantity ("Added 2 Thunder Dragon from
    // Deck to hand") so the captured name is "Thunder Dragon", not "2
    // Thunder Dragon" — classify() reads the same quantity separately to
    // know how many copies to add.
    //
    // A single lookahead-based regex, not two separate attempts: the name
    // runs until whichever comes first — " from"/" to"/" in"/" on" (a
    // trailing clause), an opening "(" for a stat block (with OR WITHOUT a
    // space before it — "Normal Summoned Magician of Faith(300/400)" is a
    // real shape DuelingBook can use, and the old two-regex version
    // required a literal space before "(" to match at all, silently
    // failing to extract a name whenever that space was missing), or end of
    // line (a true bare "<Verb> <Name>" with nothing after it at all, e.g.
    // "Banished Thunder Dragon"). Using one pattern instead of a
    // match-then-fallback pair also closes the gap where a REJECTED match
    // (a generic placeholder like "a card") used to fall through to a
    // second, looser pattern that then greedily swallowed the rest of the
    // line as if it were the name.
    const m = new RegExp('^' + MOVE_VERBS + '(?:Set )?(?:\\d+\\s+)?([A-Za-z0-9 ,.\'\\-:]+?)(?=\\s+(?:from|to|in|on)\\b|\\s*\\(|$)').exec(text);
    if (m && m[1]) {
      const n = m[1].trim();
      if (n && !/^card$/i.test(n) && !isGenericPlaceholderName(n)) return n;
    }
    return null;
  }

  // Which destination a line implies — only the two this feature cares
  // about: "hand" (card is now known to be sitting in their hand — either
  // just added, or merely revealed without moving) or one of the explicit
  // disappear triggers from the spec. Deliberately NOT the full
  // classifyCardAction() from dt-live-tracker.user.js (which also tracks
  // per-copy zone counts this feature doesn't need) — just enough to answer
  // "should this name start/stop showing as a known card".
  function classify(text) {
    if (/^Revealed .+ from Deck\b/i.test(text)) return null; // stays in the deck — nothing to show
    if (/^Revealed ([A-Za-z0-9 ,.'\-:]+)$/i.test(text)) return { to: 'hand', reveal: true };

    // A leading quantity can follow ANY of the verbs that land a card in
    // hand — "Added 2 Thunder Dragon from Deck to hand", but just as
    // plausibly "Returned 2 X from Graveyard to hand" or similar, not just
    // "Added" — capture it generically (not anchored to one verb) so
    // handleLine can add that many known copies in one go, rather than
    // silently collapsing a multi-copy add down to 1 (the gap the user hit
    // with Thunder Dragon's own effect: discard the known copy to add 2
    // more from Deck). Defaults to 1 when no leading number is present (the
    // normal case, and every other toHand line).
    const qtyM = new RegExp('^' + MOVE_VERBS + '(\\d+)\\s+').exec(text);
    // "to hand" is the real catch-all here: per the user's own spec, ANY
    // source zone landing a card back in the opponent's hand — Deck,
    // Graveyard, Banish zone, wherever — should track it, not just a
    // "Added" line specifically. Deliberately not anchored to one verb,
    // since different cards' effects word this differently ("Added",
    // "Returned", "Sent" have all been seen moving a card TO hand as well
    // as away from it). "the/your/their" are all accepted articles, plus
    // the bare "to hand" DuelingBook normally uses.
    const toHand = /^Added /i.test(text) || /\bto (?:the |your |their )?hand\b/i.test(text) || /^Drew /i.test(text);
    if (toHand) return { to: 'hand', reveal: false, qty: qtyM ? (parseInt(qtyM[1], 10) || 1) : 1 };

    // Disappear triggers — deliberately an ALLOWLIST matching the spec's
    // exact list (returned to deck, banished, sent to graveyard, discarded,
    // Normal Summoned, Special Summoned, Flip Summoned, Set, Activated).
    // Each matched line means exactly ONE physical copy left the hand —
    // handleLine removes one known copy per line, not the whole entry, so a
    // card known to have 2 copies out correctly drops to 1 rather than
    // vanishing from the list entirely (per the user's own spec: a name
    // should only disappear once it has no known copies left).
    const toDeck = /^Returned .+ to (?:the )?(?:top of |bottom of )?Deck\b/i.test(text) || /\bto (?:the )?(?:top|bottom) of (?:the )?Deck\b/i.test(text);
    const toBanish = /^(?:Banished|Removed) /i.test(text) || /\bto (?:the )?Banish(?:ed)?(?: Zone)?\b/i.test(text) || /\bremoved .+ from (?:play|the field)\b/i.test(text);
    const toGrave = /\bto (?:the )?(?:GY|Graveyard)\b/i.test(text);
    // A plain "Discarded X" line (no trailing "to the Graveyard" clause) is
    // ALWAYS a hand→GY move by the game's own rules — confirmed gap: the
    // user's Thunder Dragon report ("discard it... so it should remove this
    // Thunder Dragon") wasn't clearing before, since toGrave above only
    // matches when the line spells out "to the Graveyard"/"to GY", which a
    // bare discard-as-cost line may not.
    const discarded = /^Discarded /i.test(text);
    const normalSummoned = /^Normal Summoned /i.test(text);
    const specialSummoned = /^Special Summoned /i.test(text);
    // Per the user's own follow-up spec, Set and Flip Summoned/Flipped now
    // ALSO clear a card from this list — v0.1's original reasoning ("a Set
    // card goes face-down, so it should keep showing as known") got
    // overridden: once a card has done ANY of normal/flip/special summon,
    // set, activate, GY, banish, discard, or return-to-deck, it's no longer
    // sitting as an unplayed, hidden-but-known hand card, so it has no
    // reason to keep occupying a slot in this tracker.
    const setCard = /^Set /i.test(text);
    const flipSummoned = /^(?:Flip Summoned|Flipped) /i.test(text);
    const activated = /^Activated /i.test(text);
    if (toDeck || toBanish || toGrave || discarded || normalSummoned || specialSummoned || setCard || flipSummoned || activated) return { to: 'gone', reveal: false };

    return null; // not a line this feature cares about (Attacked, chat, ...)
  }

  // ── Who said it ──────────────────────────────────────────────────────────
  // A bare line (no "Username:" prefix) is always the account owner's own
  // action — but that path is DEAD in practice whenever the "Usernames" log
  // checkbox is checked, which Live Tracker forces on for both players. With
  // it on, EVERY line is prefixed, including the account owner's own, so a
  // bare-line-only self-check never fires and the old fallback below ("the
  // first non-self username seen is the opponent") can lock onto the
  // player's OWN username the first time one of their own prefixed lines
  // shows up first — misreading their own hand as the opponent's for the
  // rest of the duel, and dropping every real opponent line as 'other'
  // (confirmed live: reported as "card tracker is recording my hand" /
  // "missing cards added to my opp hand" — the same bug, both symptoms).
  // myUsername (shared storage key with dt-live-tracker.user.js's own
  // getMyUsername prompt — set once in Settings, read by both features)
  // fixes this the same way that file's own who() does: check the real
  // username against a known-self value FIRST, before ever falling back to
  // the first-seen guess. If myUsername is blank (never configured), this
  // degrades to the old guess-based behavior rather than tracking nothing.
  let myUsername = (safeGetValue('dt_tracker_my_username', '') || '').trim();
  let oppUsername = null;
  function sideOf(username) {
    if (username === SELF_LINE_SENTINEL) return 'me';
    if (myUsername && username.toLowerCase() === myUsername.toLowerCase()) return 'me';
    if (!oppUsername) { oppUsername = username; return 'opp'; }
    return username.toLowerCase() === oppUsername.toLowerCase() ? 'opp' : 'other';
  }

  // ── Known-card state: name -> { count, icon } ───────────────────────────
  // v0.1/early v0.2 tracked presence only (name -> one icon string), so a
  // second known copy of the same name was invisible — marking it "known"
  // twice just overwrote the same Map entry, and clearing it on ANY
  // disappear trigger wiped the whole name even when a second copy was
  // still sitting right there in hand. Per the user's own two reports (the
  // Thunder Dragon discard-1-add-2 case, and a known 2nd copy that should
  // drop to 1, not 0, when only one of the two leaves hand), `count` is now
  // tracked per name so additions/removals move the count up and down
  // instead of just flipping a name on/off.
  const known = new Map();
  let onChange = function () {}; // wired to render() once the panel exists

  // reveal=true means "this line only confirms a card that was already
  // sitting there, it didn't just arrive" (mirrors dt-live-tracker.user.js's
  // addKnownOppCard: a bare reveal only ever creates a new record when NONE
  // already exists — it never bumps the count for a card already known, so
  // the same Trap Dustshoot re-revealing an unchanged hand doesn't inflate
  // the count). qty lets one line add more than one copy at once ("Added 2
  // X from Deck to hand").
  function markKnown(name, icon, reveal, qty) {
    qty = qty || 1;
    const entry = known.get(name);
    if (reveal && entry && entry.count > 0) {
      if (entry.icon !== icon) { entry.icon = icon; onChange(); }
      return;
    }
    if (entry) {
      entry.count += qty;
      entry.icon = icon;
    } else {
      known.set(name, { count: qty, icon });
    }
    onChange();
  }
  // Removes `qty` known copies of `name` (default 1 — one disappear-trigger
  // log line is one physical copy leaving hand). Only drops the name
  // entirely once its count reaches 0, so a card known to have 2 copies out
  // correctly falls to showing 1 rather than disappearing outright.
  function clearKnown(name, qty) {
    qty = qty || 1;
    const entry = known.get(name);
    if (!entry) return;
    entry.count -= qty;
    if (entry.count <= 0) known.delete(name);
    onChange();
  }
  // Ground-truth override for a full hand reveal (see scanRevealedHandPanel)
  // — sets the exact count straight from what's actually visible, rather
  // than incrementally merging guesses from individual log lines.
  function setKnownExact(name, count, icon) {
    if (count <= 0) { known.delete(name); return; }
    known.set(name, { count, icon });
  }

  function handleLine(text, username) {
    if (sideOf(username) !== 'opp') return;
    const action = classify(text);
    if (!action) return;
    const name = extractRevealedCardName(text);
    if (!name) return;
    if (action.to === 'hand') {
      if (!safeGetValue('dt_card_tracking_track_' + (action.reveal ? 'revealed' : 'added'), true)) return;
      markKnown(name, action.reveal ? 'revealed' : 'added', action.reveal, action.qty);
    } else if (action.to === 'gone') {
      clearKnown(name, 1);
    }
  }

  // ── Full-hand reveal (Show Hand button) ─────────────────────────────────
  // Confirmed-live selector, copied from dt-live-tracker.user.js's
  // findViewingHandPanel()/syncKnownHandFromViewingPanel(): the panel with
  // id="view" whose title reads "Viewing Opponent's Hand", card names at
  // .card.target .cardfront_content .name_txt.
  function scanRevealedHandPanel() {
    if (!safeGetValue('dt_card_tracking_track_revealed', true)) return;
    if (!isDuelActuallyActive()) return; // don't let a still-open reveal panel re-mark cards known after you've left the duel
    const panel = document.getElementById('view');
    if (!panel || panel.style.display === 'none') return;
    const title = panel.querySelector('.title_txt');
    if (!title || title.textContent.trim() !== "Viewing Opponent's Hand") return;
    const names = Array.from(panel.querySelectorAll('.card.target .cardfront_content .name_txt'))
      .map((el) => el.textContent.trim())
      .filter(Boolean);
    if (!names.length) return;
    // A full hand view is ground truth: tally how many times each name
    // actually appears (2 physical copies of the same card show up as the
    // same name twice) and set that exact count, rather than calling
    // markKnown once per card — which, pre-count, silently collapsed two
    // visible copies of the same name down to one known entry.
    const freq = new Map();
    names.forEach((n) => freq.set(n, (freq.get(n) || 0) + 1));
    let changed = false;
    freq.forEach((count, name) => {
      const entry = known.get(name);
      if (!entry || entry.count !== count || entry.icon !== 'revealed') {
        setKnownExact(name, count, 'revealed');
        changed = true;
      }
    });
    if (changed) onChange();
  }

  // ── Card art: name -> ygoprodeck passcode -> images.ygoprodeck.com URL ──
  const passcodeCache = {}; // lowercased name -> numeric id, or null if unresolvable
  function resolvePasscode(name, cb) {
    const key = name.trim().toLowerCase();
    if (key in passcodeCache) { cb(passcodeCache[key]); return; }
    if (typeof GM_xmlhttpRequest !== 'function') { cb(null); return; }
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://db.ygoprodeck.com/api/v7/cardinfo.php?name=' + encodeURIComponent(name.trim()),
      onload: function (res) {
        let id = null;
        try {
          const data = JSON.parse(res.responseText);
          id = (data && data.data && data.data[0] && data.data[0].id) || null;
        } catch (e) { /* unresolvable, not fatal */ }
        passcodeCache[key] = id;
        cb(id);
      },
      onerror: function () { passcodeCache[key] = null; cb(null); },
      ontimeout: function () { passcodeCache[key] = null; cb(null); },
      timeout: 8000
    });
  }

  // Same existence-vs-visibility distinction already confirmed live for
  // dt-live-tracker.user.js's own isDuelActuallyActive(): #duel AND
  // #rps_start are both a permanent-but-hidden part of DuelingBook's page
  // template present on every page (lobby, deck constructor, home), not
  // just during a real duel. This file's own v0.1 only checked #rps_start
  // for bare EXISTENCE, not visibility — since it always exists, that made
  // this function return true unconditionally on every page, which in turn
  // meant the "just left the duel" clear a few lines down could never
  // actually fire. Fixed using the same ground-truth check already
  // confirmed live for dt-live-tracker.user.js: offsetParent is null for a
  // genuinely-hidden element even when its OWN display/visibility styles
  // still claim otherwise (confirmed live there: #rps_start reported
  // display:"block" while offsetParent was null).
  function isDuelActuallyActive() {
    const duelEl = document.querySelector('#duel');
    const rpsEl = document.querySelector('#rps_start');
    return (!!duelEl && duelEl.offsetParent !== null) || (!!rpsEl && rpsEl.offsetParent !== null);
  }
  function isRpsVisible() {
    const el = document.querySelector('#rps_start');
    return !!el && el.offsetParent !== null;
  }

  // ── Panel UI — vertically centered on the right edge, in the gap
  // DuelingBook actually leaves open between the opponent's avatar/LP box
  // (top-right) and your own (bottom-right) — confirmed live the old flush
  // bottom-right spot sat right under your own avatar/LP HUD. Much smaller
  // than v0.1: these are a quick glance, not something you need full card
  // art size for, and a minimize toggle (same −/+ convention as the Live
  // Tracker panel) lets you collapse it back down without losing track of
  // the count.
  let panelEl = null;
  let collapsed = false;
  function buildPanel() {
    if (panelEl) return panelEl;
    const el = document.createElement('div');
    el.id = 'dt-card-tracking-panel';
    el.style.cssText = [
      'position:fixed', 'top:50%', 'right:8px', 'transform:translateY(-50%)', 'z-index:2147483000',
      'background:#0e0e1a', 'color:#fff', 'border:1px solid #252538', 'border-radius:7px',
      'font-family:monospace', 'font-size:10px', 'width:72px', 'max-height:70vh',
      'overflow-y:auto', 'padding:5px', 'box-shadow:0 6px 24px rgba(0,0,0,.5)',
      'box-sizing:border-box'
    ].join(';');
    el.innerHTML =
      '<div id="dt-ct-header" style="display:flex;justify-content:space-between;align-items:center;font-weight:bold;margin-bottom:4px;color:#ccccdd;cursor:pointer">' +
        '<span>👁 (<span id="dt-ct-count">0</span>)</span>' +
        '<span id="dt-ct-min" style="color:#888">−</span>' +
      '</div>' +
      '<div id="dt-ct-list"></div>';
    document.body.appendChild(el);
    panelEl = el;
    el.querySelector('#dt-ct-header').onclick = function () {
      collapsed = !collapsed;
      el.querySelector('#dt-ct-list').style.display = collapsed ? 'none' : 'block';
      el.querySelector('#dt-ct-min').textContent = collapsed ? '+' : '−';
    };
    return el;
  }

  function cardTile(name, icon) {
    const tile = document.createElement('div');
    tile.className = 'dt-ct-tile';
    tile.style.cssText = 'position:relative;margin-bottom:4px;background:#131320;border:1px solid #252538;border-radius:4px;overflow:hidden';
    const img = document.createElement('img');
    img.alt = name;
    img.title = name;
    img.style.cssText = 'display:block;width:100%;height:auto';
    const fallback = document.createElement('div');
    fallback.textContent = name;
    fallback.title = name;
    fallback.style.cssText = 'display:none;padding:5px 2px;text-align:center;color:#ccccdd;font-size:8px;line-height:1.15;word-break:break-word';
    img.onerror = function () { img.style.display = 'none'; fallback.style.display = 'block'; };
    resolvePasscode(name, function (id) {
      if (id) img.src = 'https://images.ygoprodeck.com/images/cards/' + id + '.jpg';
      else { img.style.display = 'none'; fallback.style.display = 'block'; }
    });
    const badge = document.createElement('div');
    badge.textContent = icon === 'revealed' ? '👁' : '+';
    badge.title = icon === 'revealed' ? 'Revealed' : 'Added to hand';
    badge.style.cssText = [
      'position:absolute', 'top:1px', 'left:1px', 'width:11px', 'height:11px',
      'border-radius:50%', 'display:flex', 'align-items:center', 'justify-content:center',
      'font-size:7px', 'color:#050508',
      'background:' + (icon === 'revealed' ? '#ffbb44' : '#00e596')
    ].join(';');
    // No count badge — per the user's own call, every known copy gets its
    // OWN tile with its own card image (2 known Thunder Dragons = 2 actual
    // Thunder Dragon tiles stacked in the list), not one tile with a "×2"
    // marker. render() below is what loops `entry.count` times per name to
    // produce that; this function only ever draws a single physical copy.
    //
    // Manual fallback per the user's own ask: if a line's wording ever
    // slips past classify()/extractRevealedCardName (a phrasing this file
    // hasn't seen yet, a ruling undone, etc.), there has to be a way to
    // clear a stuck card without waiting on a fix here. Top-right (badge
    // above moved to top-left to make room) so it's never mistaken for
    // part of the card art. Removes exactly ONE copy (this one tile's
    // worth) — with 2 known copies, closing one tile leaves the other.
    const closeBtn = document.createElement('div');
    closeBtn.textContent = '×';
    closeBtn.title = 'Remove this known copy';
    closeBtn.style.cssText = [
      'position:absolute', 'top:1px', 'right:1px', 'width:11px', 'height:11px',
      'border-radius:50%', 'display:flex', 'align-items:center', 'justify-content:center',
      'font-size:9px', 'line-height:1', 'font-weight:bold', 'color:#ccccdd',
      'background:rgba(0,0,0,.55)', 'cursor:pointer'
    ].join(';');
    closeBtn.onmouseenter = function () { closeBtn.style.background = '#e64545'; closeBtn.style.color = '#fff'; };
    closeBtn.onmouseleave = function () { closeBtn.style.background = 'rgba(0,0,0,.55)'; closeBtn.style.color = '#ccccdd'; };
    closeBtn.onclick = function (e) {
      e.stopPropagation();
      clearKnown(name);
    };
    tile.appendChild(img);
    tile.appendChild(fallback);
    tile.appendChild(badge);
    tile.appendChild(closeBtn);
    return tile;
  }

  function render() {
    if (!safeGetValue('dt_card_tracking_enabled', false)) {
      if (panelEl) panelEl.style.display = 'none';
      return;
    }
    // Confirmed live (same bug class as Live Tracker's panel and Deck
    // Folders before their own fixes this same session): this feature is
    // scoped to "while you're actually in a live duel" — a match ending
    // and going back to the lobby/deck constructor on the same tab, with
    // no reload, used to leave whatever cards were last known sitting on
    // screen indefinitely, since nothing ever told the panel to hide.
    if (!isDuelActuallyActive()) {
      if (panelEl) panelEl.style.display = 'none';
      return;
    }
    const el = buildPanel();
    const countEl = el.querySelector('#dt-ct-count');
    const listEl = el.querySelector('#dt-ct-list');
    if (known.size === 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    listEl.style.display = collapsed ? 'none' : 'block';
    el.querySelector('#dt-ct-min').textContent = collapsed ? '+' : '−';
    let totalCopies = 0;
    known.forEach((entry) => { totalCopies += entry.count; });
    countEl.textContent = String(totalCopies);
    listEl.innerHTML = '';
    // One tile PER KNOWN COPY, not one tile per name — per the user's own
    // call: 2 known Thunder Dragons means 2 separate Thunder Dragon images
    // in the list, not a single tile with a "×2" marker.
    known.forEach((entry, name) => {
      for (let i = 0; i < entry.count; i++) listEl.appendChild(cardTile(name, entry.icon));
    });
  }
  onChange = render;

  // Watches for (a) leaving an active duel, and (b) a new game/match
  // starting, to clear `known` right when either happens — otherwise cards
  // left unresolved (never hit one of classify()'s explicit disappear
  // triggers) would still be sitting in the Map, ready to resurface looking
  // already-known the instant a new game's hands get drawn.
  //
  // (b) is the RPS "choose First/Second" screen appearing — edge-detected
  // (false→true), the same signal dt-live-tracker.user.js already confirmed
  // live marks either a new game within the same match OR a brand-new
  // match. Unlike that file, Card Tracking doesn't need to tell those two
  // apart: either way, nothing previously known about the opponent's hand
  // still applies once a fresh hand gets drawn, so both clear identically
  // — simpler than Live Tracker's match-wide "has this card ever
  // appeared" bookkeeping, which deliberately survives a new game.
  //
  // Only re-renders when something actually changed, not every tick, so
  // this doesn't churn the DOM (and re-fetch card art) while nothing has.
  let wasDuelActive = isDuelActuallyActive();
  let wasRpsVisible = isRpsVisible();
  setInterval(function () {
    const active = isDuelActuallyActive();
    const rpsVisible = isRpsVisible();
    let changed = false;

    if (rpsVisible && !wasRpsVisible) {
      // Confirmed root cause of a real miss (opponent "KereMnM"'s own
      // "Added Thunder Dragon from Deck to hand" lines went untracked) — the
      // same bug CLASS already fixed in Transparent Facedowns' stale
      // localPlayer cache. dt-live-tracker.user.js's own armLogWatcher
      // comment confirms why: "DuelingBook's #duel_log panel is never torn
      // down between duels (it's an SPA)" — so this script's single
      // MutationObserver stays correctly attached across a practice duel ->
      // real match transition on the same tab with no reload, no re-arming
      // needed there. But oppUsername was a module-level value that locked
      // onto the FIRST non-self username ever seen on the page and never
      // let go — so once a genuinely new opponent showed up in a later
      // duel, sideOf() kept comparing their name against the STALE one,
      // classified them as 'other' instead of 'opp', and handleLine's very
      // first check silently dropped every one of their lines. Reset it
      // right here, on the same new-duel boundary (RPS screen appearing)
      // that already clears `known` below — mirrors dt-live-tracker's own
      // per-match identity reset (a fresh tracker/state per match, never
      // reused), just folded into this file's simpler single-state model
      // per the user's own "don't change Live Tracker, just use it for
      // inspiration" instruction.
      //
      // Also re-read myUsername here (not just once at script load): if the
      // user fixes a blank/wrong value in Settings mid-session, the fix
      // should take effect on the very next duel without needing a page
      // reload — cheap (one storage read) and only happens on a real
      // new-duel boundary, never mid-duel.
      oppUsername = null;
      myUsername = (safeGetValue('dt_tracker_my_username', '') || '').trim();
      if (known.size > 0) { known.clear(); changed = true; }
    }
    wasRpsVisible = rpsVisible;

    if (active !== wasDuelActive) {
      if (wasDuelActive && !active) known.clear();
      wasDuelActive = active;
      changed = true; // the panel's own visibility depends on `active` too
    }

    if (changed) render();
  }, 800);

  // ── Watch the duel log for new lines, same waitFor/MutationObserver
  // pattern used throughout this extension (see dt-unlock.user.js /
  // dt-live-tracker.user.js) rather than polling on a timer.
  function waitFor(selector, cb) {
    const existing = document.querySelector(selector);
    if (existing) { cb(existing); return; }
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { obs.disconnect(); cb(el); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Confirmed live (this is the actual root cause behind every "it didn't
  // track X" report against this feature, including a real 3-Thunder-Dragon
  // game where NONE of the 3 "Added Thunder Dragon from Deck to hand" lines
  // got picked up): #duel_log itself has exactly 2 permanent direct
  // children (.chat_top / .chat_background) whose count never changes —
  // every actual log line (e.g. a <font color="#FF0000">[3:37] Battle Ox:
  // Shuffled deck</font>) lives several DOM levels deeper, as a direct
  // child of an inner .os_viewport container. The old version of this
  // function watched #duel_log's own childList (no subtree) and counted
  // logEl.children.length (always 2) — so scan() never had anything new to
  // process, no matter how many real lines were appended. A replay of the
  // exact captured log text through classify()/extractRevealedCardName()
  // confirmed those functions were already correct; this DOM-observation
  // layer was the only thing actually broken.
  //
  // Fixed the same way dt-live-tracker.user.js's own armLogWatcher already
  // does it (read for structure/inspiration only, per the user's own
  // instruction — nothing in that file was changed): search the whole
  // subtree for the actual leaf elements that start with "[m:ss]" rather
  // than assuming any particular nesting depth, and observe with
  // subtree:true so a mutation anywhere inside #duel_log (not just at its
  // own top level) triggers a rescan.
  function getCandidateLogLines(el) {
    return Array.from(el.querySelectorAll('*')).filter((e) => {
      const t = (e.textContent || '').trim();
      return (/^\[\d+:\d+\]/.test(t) && e.children.length === 0) ||
        (e.children.length && /^\[\d+:\d+\]/.test(t) && !Array.from(e.children).some((c) => /^\[\d+:\d+\]/.test((c.textContent || '').trim())));
    });
  }
  function watchDuelLog(logEl) {
    let seen = getCandidateLogLines(logEl).length;
    function scan() {
      const kids = getCandidateLogLines(logEl);
      for (let i = seen; i < kids.length; i++) {
        const parsed = parseLine(kids[i].textContent || '');
        if (parsed && !parsed.isChat) handleLine(parsed.text, parsed.username);
      }
      seen = kids.length;
    }
    let pending = false;
    function schedule() { if (pending) return; pending = true; setTimeout(() => { pending = false; scan(); scanRevealedHandPanel(); }, 250); }
    new MutationObserver(schedule).observe(logEl, { childList: true, subtree: true, characterData: true });
    // Also poll the hand-reveal panel independently of new log lines — its
    // cards appear via DOM population, not a log line, same reasoning as
    // dt-live-tracker.user.js's own installHandViewScan.
    setInterval(scanRevealedHandPanel, 500);
  }

  waitFor('#duel_log', watchDuelLog);
  console.log('[Duel Tools Card Tracking] ready');

  // Exposed for tests only — real page code never reads this.
  if (typeof window !== 'undefined') window.__dtCardTrackingTestHooks = { known, render, markKnown, clearKnown, setKnownExact, classify, extractRevealedCardName, isDuelActuallyActive, isRpsVisible };
})();
