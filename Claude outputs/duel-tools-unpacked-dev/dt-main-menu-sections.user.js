// ==UserScript==
// @name         Duel Tools — Main Menu Section Visibility
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  Reorders and/or hides the Main Menu's carousel (Chat / Videos & Streams / Tournaments / Kerem Duel Tools) per the order saved in Settings → Appearance Customization → Main Menu Section Visibility. The Kerem Duel Tools panel renders its iframe at a generic 1920×1080 desktop size and shrinks that down to fit, so every part of the page (including grid-based sidebars) lays out proportionately to every other part, and stretches out to use the real window's right edge instead of stopping at the native carousel card's own (narrower) box. Its overall transparency is also adjustable (same settings page) — see applyKeremOpacity() for why that's a whole-panel fade rather than a background-only one.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── How DuelingBook actually drives this carousel ────────────────────────
// Confirmed live: #main_menu_circles holds exactly 3 `.main_menu_circle`
// dots (each with a `.background` child whose `opacity` DuelingBook
// animates between 0 and 1 to show which one is "active"), laid out via
// plain inline-block flow + margin (NOT fixed per-dot offsets, and NOT
// flexbox either) — important below. #circle_content holds 3 fixed-id
// pages — #statuses0 (Chat + the Official Tourneys sidebar), #videos0
// (video grid + Streams sidebar), #tourneys0 (tournament list + Discord
// widget) — each `position:absolute; width:100%; height:100%` of
// #circle_content (968×656px), shown/hidden via plain display:none/block.
//
// Tried and DISPROVED live: reordering either the 3 dots OR the 3 content
// pages in the DOM does NOT reorder what a given dot shows. Moving a dot
// to a new position still shows the SAME content it always did when
// clicked (confirmed: swapping dot 0 and dot 2, then clicking the
// now-leftmost dot, still showed Chat/#statuses0 — and also left
// #tourneys0 visible at the same time, a genuine break in DuelingBook's
// own hide-the-others logic once the dots/content are out of their
// expected 1:1 position pairing). In short: DuelingBook's click handlers
// are bound to fixed content by closure/identity, not derived from live
// DOM position of either side — so there is no DOM-reordering trick
// available here, unlike Room Visibility's absolute-`left`-offset panels.
//
// What DOES work, confirmed live: a capture-phase click listener on
// #main_menu_circles, calling stopImmediatePropagation(), fully prevents
// DuelingBook's own (bubble-phase) click handling from ever running for
// that click — capture fires on an ancestor before the event ever reaches
// the target element's own bubble-phase listeners. With DuelingBook's
// handler fully out of the picture, this file owns the whole interaction
// itself: which dot maps to which content (driven by the saved order),
// whether a dot is even shown (driven by the saved hidden list), and the
// active-dot opacity indicator (snapped instantly to 0/1 — DuelingBook's
// own version eases it with a jQuery animation; replicating that
// animation exactly wasn't worth the complexity for a cosmetic nicety).
//
// ── v2.0: a 4th, synthetic page — "Kerem Duel Tools" ──────────────────────
// Per the user's own follow-up: a 4th carousel entry that ISN'T one of
// DuelingBook's own 3 pages at all. There's no native 4th dot or page to
// repurpose, so this file creates both itself, the moment keremTools is
// anywhere in a visible (non-hidden) position:
//   - A 4th dot: confirmed live the 3 real ones are laid out via normal
//     inline-block flow (not fixed offsets), so cloning one and appending
//     it to #main_menu_circles just slots in correctly on its own, no
//     manual positioning math needed (unlike the Lobby's format panels).
//   - A 4th content panel, holding an
//     <iframe src="https://duel-tools-kerem-production.up.railway.app/">
//     — confirmed live that URL has no X-Frame-Options/CSP block on being
//     framed, and it's the user's own separate web app (a duel/deck
//     tracker — "Live Tracker"), so logging into it inside this iframe is
//     exactly the point.
// Both are created once and only hidden (never removed) afterward, so the
// iframe's own login session survives switching away in the carousel, or
// even disabling this whole feature and re-enabling it later — there's no
// "native" state to restore them to the way there is for the real 3
// pages, so restoreNative() below hides them explicitly instead.
//
// ── v2.2: the panel lives OUTSIDE #circle_content, not inside it ─────────
// v2.0/2.1 sized the panel 100%/100% of #circle_content, matching
// #statuses0's own box exactly. Per the user's own follow-up screenshot,
// though, that box doesn't actually reach the edge of the window on a wide
// screen — there's a strip of plain parallax background visible to its
// right (same root cause as the Background Image feature's old
// "black bars": DuelingBook's own carousel card isn't full-width, it just
// happens to sit on top of a wider decorative background). The user wants
// that strip used, not left empty.
//
// Getting there means the panel can't be a descendant of #circle_content
// (or of #content at all) any more — the same "position:fixed containing-
// block trap" documented in dt-main-menu-image.user.js applies: anything
// nested inside #content's own CSS transform can only ever size itself
// relative to #content's own (sometimes short) box, never the TRUE
// viewport. So the panel is now a plain `position:fixed` element appended
// as the LAST child of <body> (paints on top of #content and everything
// in it via DOM order alone, same reasoning used for the Background Image
// layer being body's FIRST child to paint underneath). Its real on-screen
// left/top/height are set every time it's shown to match #circle_content's
// own rendered box exactly (so Chat/Tournaments/Videos still "line up"
// with where Kerem Duel Tools starts) — but its WIDTH is stretched out to
// the real window's right edge instead of stopping at #circle_content's
// own edge, via positionKeremPanel() below. Because this element is now
// genuinely outside #content's transformed subtree, these coordinates are
// real/fixed viewport px, not the LOCAL pre-transform px the rest of this
// file otherwise deals in — see positionKeremPanel()'s own comment.
//
// One side effect of being body-level now, not a descendant of #main_menu:
// it no longer automatically disappears just because #main_menu itself
// goes display:none (e.g. the user leaves the Main Menu for a duel room).
// showPosition() below explicitly force-hides it whenever #main_menu isn't
// visible, regardless of the saved carousel position, so it can never get
// stuck floating on top of some other page.
(function () {
  'use strict';

  const NATIVE_CONTENT_IDS = ['statuses0', 'videos0', 'tourneys0'];
  const KEREM_TOOLS_ID = 'keremTools';
  const KEREM_PANEL_ELEMENT_ID = 'dt-keremtools-panel';
  const KEREM_DOT_ATTR = 'data-dt-kerem-dot';
  const KEREM_IFRAME_URL = 'https://duel-tools-kerem-production.up.railway.app/';
  const ALL_SECTION_IDS = NATIVE_CONTENT_IDS.concat([KEREM_TOOLS_ID]);
  // The Kerem Duel Tools app's own CSS only has two responsive
  // breakpoints — 420px (phone) and 768px (tablet); confirmed live by
  // reading its stylesheets' @media rules — so ANY width at or above
  // 768px renders its full desktop layout (sidebars, tables, everything
  // the user's own reference screenshot showed). The carousel panel
  // itself, though, is #circle_content's fixed LOCAL width — confirmed
  // live as 968px — which is comfortably above that 768px line, so in
  // principle the iframe could just be sized 100%/100% and be done. In
  // practice a dashboard built for a real desktop window still has fixed
  // px gaps/paddings/column widths tuned for something wider than 968px,
  // so simply handing it a 968px-wide box renders the full desktop layout
  // CRUSHED into less room than it was designed for — overlapping or
  // barely-clickable controls, not a clean "zoomed out" look. Per the
  // user's own ask ("keep the same scale... if it's too zoomed in it's
  // unusable"): render the iframe at a comfortable native desktop width
  // (KEREM_NATURAL_W/H below) so the app lays itself out exactly like the
  // reference screenshot, then shrink that whole rendered page down with
  // a CSS transform: scale() to fit the panel's actual box exactly. A
  // transform preserves every element's proportions AND DuelingBook's own
  // click coordinates translate through it correctly (confirmed general
  // CSS behavior — a transformed iframe's input events are remapped by
  // the browser itself), so the embed looks like the full site shrunk
  // down uniformly, not reflowed into a cramped alternate layout.
  // v2.3 tried narrowing this to 1100 to stop the top nav bar wrapping —
  // confirmed live (per the user's own follow-up screenshot) that this
  // backfired on the RIGHT sidebar specifically: its GFWL Teams/Event
  // Decklists cards rendered noticeably BIGGER relative to the left
  // sidebar's own (unaffected) batch list — exactly the signature of a
  // CSS grid with a fixed/limited column count being squeezed into less
  // width, which just makes each remaining cell bigger rather than
  // wrapping to fewer columns gracefully. Less width wasn't the fix.
  //
  // The reference point that's actually known-good is the user's own
  // original full-screen screenshot of this same app — at their own
  // monitor's width, left and right sides were already proportionate to
  // each other. So rather than guess at a width this app's CSS happens to
  // like, this renders at a generic, comfortably-large desktop size
  // (1920×1080) so every part of the page — including whatever grid the
  // right sidebar uses — gets as much room as it would on an ordinary
  // desktop monitor, then the WHOLE thing shrinks down uniformly from
  // there. A bigger natural canvas means a smaller scale factor (more
  // shrinking), so text/art ends up a little smaller throughout, but
  // nothing on either side should be disproportionate to the other.
  const KEREM_NATURAL_W = 1920;
  const KEREM_NATURAL_H = 1080;
  const KEREM_SCALE_WRAP_CLASS = 'dt-kerem-scale-wrap';
  const KEREM_RIGHT_MARGIN = 16; // real px gap left between the panel and the true window edge — see positionKeremPanel()

  const DEFAULTS = {
    dt_main_menu_sections_enabled: false,
    dt_main_menu_sections_order: ALL_SECTION_IDS.slice(),
    dt_main_menu_sections_hidden: [],
    dt_keremtools_opacity: 100
  };

  let enabled = false;
  let visibleOrder = ALL_SECTION_IDS.slice();
  let currentPosIdx = 0;
  let seeded = false;
  let listenersAttached = false;

  function getContentEls() {
    const map = {};
    NATIVE_CONTENT_IDS.forEach((id) => { map[id] = document.getElementById(id); });
    map[KEREM_TOOLS_ID] = document.getElementById(KEREM_PANEL_ELEMENT_ID);
    return map;
  }
  function getDots() {
    const circles = document.getElementById('main_menu_circles');
    return circles ? Array.from(circles.children) : [];
  }
  function dotBackground(dot) {
    return dot.querySelector('.background');
  }
  function isMainMenuVisible() {
    const mm = document.getElementById('main_menu');
    return !!mm && getComputedStyle(mm).display !== 'none';
  }

  // Creates the synthetic 4th dot + content panel the first time either is
  // needed, idempotently. Only called once keremTools is actually in a
  // visible position — never loads the iframe at all for a page load
  // where the user hasn't enabled it.
  function ensureKeremToolsElements() {
    const circles = document.getElementById('main_menu_circles');
    if (!circles) return;

    if (!document.getElementById(KEREM_PANEL_ELEMENT_ID)) {
      const panel = document.createElement('div');
      panel.id = KEREM_PANEL_ELEMENT_ID;
      // position:fixed, appended to <body> below — NOT sized 100%/100% of
      // any ancestor; its real left/top/width/height are computed and set
      // by positionKeremPanel() every time it's shown. overflow is 'auto'
      // rather than 'hidden' so if the scaled-down page is ever taller
      // than the panel it can still be scrolled to, rather than silently
      // clipping content off the bottom.
      Object.assign(panel.style, {
        position: 'fixed', display: 'none', overflow: 'auto'
      });
      // The scale wrapper is sized to the NATURAL (pre-scale) dimensions —
      // this is what actually gets the transform — so the iframe inside it
      // always lays out the same full desktop page no matter how small the
      // panel itself ends up being. See the KEREM_NATURAL_W/H comment.
      const scaleWrap = document.createElement('div');
      scaleWrap.className = KEREM_SCALE_WRAP_CLASS;
      Object.assign(scaleWrap.style, {
        position: 'absolute', top: '0', left: '0',
        width: KEREM_NATURAL_W + 'px', height: KEREM_NATURAL_H + 'px',
        transformOrigin: 'top left'
      });
      const iframe = document.createElement('iframe');
      iframe.src = KEREM_IFRAME_URL;
      Object.assign(iframe.style, { width: '100%', height: '100%', border: '0' });
      scaleWrap.appendChild(iframe);
      panel.appendChild(scaleWrap);
      // Last child of <body> — see header comment on why this has to live
      // outside #content's transformed subtree, and why DOM-order alone
      // (no z-index) is enough to paint it on top of everything.
      document.body.appendChild(panel);
    }

    if (!circles.querySelector('.main_menu_circle[' + KEREM_DOT_ATTR + ']')) {
      const nativeDot = circles.querySelector('.main_menu_circle');
      if (nativeDot) {
        const dot = nativeDot.cloneNode(true);
        dot.setAttribute(KEREM_DOT_ATTR, '1');
        dot.style.display = ''; // don't inherit whatever hidden state the native dot being cloned happened to have
        const bg = dotBackground(dot);
        if (bg) bg.style.opacity = '0';
        circles.appendChild(dot);
      }
    }
  }

  // Sizes/positions the (now body-level, position:fixed) Kerem Duel Tools
  // panel every time it's shown: left/top/height are taken straight from
  // #circle_content's own real rendered box (so it still visually "starts"
  // in the same place Chat/Videos/Tournaments do), but width is stretched
  // out to the real window's right edge instead of stopping at
  // #circle_content's own — that's the "use the red box" part. These are
  // real/fixed viewport px (this element is outside #content's transform
  // now), NOT the local pre-transform px the rest of this file deals in,
  // so no further scale-correction is needed or wanted here — unlike the
  // viewport-space math in dt-main-menu-image.user.js, which converts
  // real mouse/rect px back INTO local px to write as a style on an
  // element that IS inside #content. This one just uses real px directly,
  // because the element it's styling genuinely lives in real px space.
  function positionKeremPanel() {
    const panel = document.getElementById(KEREM_PANEL_ELEMENT_ID);
    const cc = document.getElementById('circle_content');
    if (!panel || !cc) return;
    const r = cc.getBoundingClientRect();
    if (!r.width || !r.height) return; // not laid out right now — nothing sane to anchor to; showPosition()'s own mmVisible check keeps the panel hidden in that case anyway
    const left = r.left;
    const top = r.top;
    const width = Math.max(200, window.innerWidth - left - KEREM_RIGHT_MARGIN);
    const height = r.height;
    const next = { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' };
    Object.keys(next).forEach((prop) => { if (panel.style[prop] !== next[prop]) panel.style[prop] = next[prop]; });
    applyKeremScale();
  }

  // Recomputes and (re)applies the Kerem Duel Tools iframe's scale so its
  // natural-width render exactly fills the panel's actual (real-px) width,
  // however big or small positionKeremPanel() above just made it.
  function applyKeremScale() {
    const panel = document.getElementById(KEREM_PANEL_ELEMENT_ID);
    if (!panel) return;
    const wrap = panel.querySelector('.' + KEREM_SCALE_WRAP_CLASS);
    if (!wrap) return;
    const w = panel.clientWidth;
    if (!w) return; // panel isn't laid out yet (still display:none) — nothing to measure
    const scale = w / KEREM_NATURAL_W;
    const want = 'scale(' + scale + ')';
    if (wrap.style.transform !== want) wrap.style.transform = want;
  }

  function showPosition(posIdx) {
    const dots = getDots();
    if (posIdx < 0 || posIdx >= visibleOrder.length) posIdx = 0;
    currentPosIdx = posIdx;
    const targetId = visibleOrder[posIdx];
    const contentEls = getContentEls();
    const mmVisible = isMainMenuVisible();
    ALL_SECTION_IDS.forEach((id) => {
      const el = contentEls[id];
      if (!el) return;
      let want = id === targetId ? 'block' : 'none';
      // The Kerem panel is body-level now (see header comment), so it
      // won't auto-hide just because #main_menu does — force it closed
      // whenever the Main Menu itself isn't on screen, regardless of
      // which carousel position was last saved as "current".
      if (id === KEREM_TOOLS_ID && !mmVisible) want = 'none';
      if (el.style.display !== want) el.style.display = want;
    });
    dots.forEach((dot, i) => {
      const bg = dotBackground(dot);
      if (!bg) return;
      const want = i === posIdx ? '1' : '0';
      if (bg.style.opacity !== want) bg.style.opacity = want;
    });
    if (targetId === KEREM_TOOLS_ID && mmVisible) positionKeremPanel();
  }

  // Seeds from whatever is ALREADY showing natively (rather than always
  // forcing the first visible section) so turning this feature on
  // mid-session doesn't yank the user off a page they're already looking
  // at.
  function seedCurrentFromLiveState() {
    const contentEls = getContentEls();
    for (let i = 0; i < visibleOrder.length; i++) {
      const el = contentEls[visibleOrder[i]];
      if (el && getComputedStyle(el).display !== 'none') return i;
    }
    return 0;
  }

  function applyLayout() {
    if (visibleOrder.indexOf(KEREM_TOOLS_ID) !== -1) ensureKeremToolsElements();
    const dots = getDots();
    if (!dots.length) return;
    dots.forEach((dot, i) => {
      const want = i < visibleOrder.length ? '' : 'none';
      if (dot.style.display !== want) dot.style.display = want;
    });
    showPosition(currentPosIdx);
  }

  // Kerem Duel Tools is a cross-origin iframe (a separate site, not a
  // regular DuelingBook element) — the extension can't reach INSIDE it to
  // recolor or fade just its own background, so this is a flat CSS
  // `opacity` on the whole panel div (background, sign-in form, and text
  // all fade together as one unit). Floored at 10% rather than allowing
  // all the way to 0 so the panel can never become fully invisible/
  // unclickable by accident — it's a real sign-in form someone may still
  // need to interact with, not purely decorative.
  function applyKeremOpacity(opacityPct) {
    const panel = document.getElementById(KEREM_PANEL_ELEMENT_ID);
    if (!panel) return;
    const op = Math.max(10, Math.min(100, opacityPct == null ? 100 : opacityPct)) / 100;
    const want = String(op);
    if (panel.style.opacity !== want) panel.style.opacity = want;
  }

  function restoreNative() {
    getDots().forEach((dot) => {
      dot.style.display = '';
      const bg = dotBackground(dot);
      if (bg) bg.style.opacity = '';
    });
    NATIVE_CONTENT_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = '';
    });
    // No "native" state exists for the synthetic Kerem Tools dot/panel —
    // hide them (never remove, so the iframe's own login session survives
    // this feature being toggled off and back on) rather than resetting
    // to '' like the real elements above.
    const keremDot = document.querySelector('#main_menu_circles .main_menu_circle[' + KEREM_DOT_ATTR + ']');
    if (keremDot) {
      keremDot.style.display = 'none';
      const bg = dotBackground(keremDot);
      if (bg) bg.style.opacity = '0';
    }
    const keremPanel = document.getElementById(KEREM_PANEL_ELEMENT_ID);
    if (keremPanel) keremPanel.style.display = 'none';
  }

  function onDotClick(e) {
    if (!enabled) return; // not intercepting — let DuelingBook's own handler run normally
    const dot = e.target.closest ? e.target.closest('.main_menu_circle') : null;
    if (!dot) return;
    const posIdx = getDots().indexOf(dot);
    if (posIdx === -1 || posIdx >= visibleOrder.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showPosition(posIdx);
  }

  function attachListeners() {
    if (listenersAttached) return;
    const circles = document.getElementById('main_menu_circles');
    if (!circles) { setTimeout(attachListeners, 1000); return; }
    circles.addEventListener('click', onDotClick, true); // capture phase — see header comment
    listenersAttached = true;
  }

  function readAndApply() {
    chrome.storage.local.get(DEFAULTS, (s) => {
      enabled = !!s.dt_main_menu_sections_enabled;
      if (!enabled) {
        if (seeded) { restoreNative(); seeded = false; }
        return;
      }
      const savedOrder = Array.isArray(s.dt_main_menu_sections_order) && s.dt_main_menu_sections_order.length ? s.dt_main_menu_sections_order : ALL_SECTION_IDS.slice();
      const hidden = Array.isArray(s.dt_main_menu_sections_hidden) ? s.dt_main_menu_sections_hidden : [];
      // Same staleness guard as every other order+hidden pair in this
      // extension: fold in anything missing from a saved order (this is
      // also what gives a pre-v2.0 saved order, which predates
      // keremTools existing at all, its 4th entry automatically), and
      // never let every section end up hidden (the settings UI already
      // disables hiding the last visible one, but double-guard here too).
      const have = {};
      savedOrder.forEach((id) => { have[id] = true; });
      const fullOrder = savedOrder.concat(ALL_SECTION_IDS.filter((id) => !have[id]));
      let vis = fullOrder.filter((id) => hidden.indexOf(id) === -1);
      if (!vis.length) vis = fullOrder.slice();
      visibleOrder = vis;

      attachListeners();
      if (!document.getElementById('main_menu_circles')) return; // not on the Main Menu right now — nothing to do yet
      if (!seeded) { currentPosIdx = seedCurrentFromLiveState(); seeded = true; }
      applyLayout();
      applyKeremOpacity(s.dt_keremtools_opacity);
    });
  }

  readAndApply();
  setInterval(readAndApply, 1000);

  let mutationDebounce = null;
  function onMutate() {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => { mutationDebounce = null; readAndApply(); }, 80);
  }
  function observeFrames() {
    const frames = document.getElementById('frames');
    if (!frames) { setTimeout(observeFrames, 1000); return; }
    new MutationObserver(onMutate).observe(frames, { childList: true, subtree: true });
  }
  observeFrames();

  // The Kerem panel is real/fixed viewport px now (see header comment), so
  // unlike everything else in this file, its box genuinely does change
  // with the real window size — this is load-bearing, not just defensive.
  // rAF-throttled, and a no-op whenever the panel isn't currently shown.
  let keremResizeQueued = false;
  window.addEventListener('resize', () => {
    if (keremResizeQueued) return;
    keremResizeQueued = true;
    requestAnimationFrame(() => {
      keremResizeQueued = false;
      const panel = document.getElementById(KEREM_PANEL_ELEMENT_ID);
      if (panel && panel.style.display !== 'none') positionKeremPanel();
    });
  });

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.dt_main_menu_sections_enabled || changes.dt_main_menu_sections_order || changes.dt_main_menu_sections_hidden) {
        seeded = false; // the mapping itself changed — reseed from live state next tick
        readAndApply();
      } else if (changes.dt_keremtools_opacity) {
        readAndApply();
      }
    });
  }

  console.log('[Duel Tools] Main Menu Section Visibility ready');
})();
