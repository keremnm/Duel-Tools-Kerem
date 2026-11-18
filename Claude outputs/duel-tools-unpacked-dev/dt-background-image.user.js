// ==UserScript==
// @name         Duel Tools — Background Image
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Replaces DuelingBook's own circuit-board background with a user-uploaded image, stretched edge-to-edge across the real browser window (no black bars), everywhere on the site, with a brightness slider (100% = as uploaded, fading to solid black at 0%). Settings → Appearance Customization → Add Custom Images/Themes/Colors/Emotes → Custom Images.
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── v1.0's approach, and why it wasn't enough ─────────────────────────────
// v1.0 just swapped the src of img#circuit_board, DuelingBook's own
// circuit-board backdrop image. That worked, but only inside #content's
// own box — confirmed live, #content carries a CSS
// `transform: scale(1.42344...)` (a responsive zoom; the exact factor
// varies with window size) that makes it render SMALLER than the real
// browser window at wide aspect ratios, leaving plain black margins
// ("black bars") on the sides — body's own plain background-color, not
// anything #content draws. The user's follow-up screenshot showed exactly
// that: the custom image filling the center, black bars still down both
// sides. Swapping circuit_board's src can only ever fill #content's own
// (sometimes-letterboxed) box, never the real window.
//
// ── v2.0: a real, separate full-viewport layer ────────────────────────────
// Confirmed live: body and html carry no transform of their own, so a
// plain `position: fixed` element that's a DIRECT CHILD OF BODY (not
// nested inside #content) sizes/positions itself against the TRUE
// viewport, unaffected by #content's zoom — exactly what's needed to
// cover the whole window including the margins. This file creates exactly
// one such div (#dt-bg-image-layer), inserted as body's very FIRST child
// so normal DOM-order painting keeps it behind everything else (#content
// and all its real foreground UI — menus, panels, text — are later
// siblings, so they paint on top, untouched).
//
// For our layer's image to show through in the CENTER too — where
// #content's own box overlaps it — the native background elements that
// would otherwise opaquely cover it need to go transparent: confirmed
// live, #content's relevant children, in DOM order, are #circuit_board
// (the image), #circuit_cover (a ~30%-opacity dark tint over it),
// #greenlines (no visible rendering of its own, found empty when
// inspected directly — harmless to neutralize anyway), and #dark (a huge
// solid near-black fallback layer). Setting all four to opacity:0 while
// this feature is enabled makes #content's background area fully
// see-through there too, so our one full-viewport layer shows through
// uniformly across the ENTIRE window — center and margins alike — as one
// continuous image with no seam, rather than two independently-scaled
// copies meeting at a visible boundary (the alternative this file
// deliberately avoids: layering a second image onto body's own
// background would crop/zoom differently than the inner one and visibly
// seam at #content's edge).
//
// Per the user's own follow-up spec: up to 5 images, but — unlike the
// Splash Image feature's "always random" — the DEFAULT here is to always
// show one specific chosen image (dt_bg_image_active_id), with an
// OPTIONAL "Cycle Randomly" toggle (dt_bg_image_cycle_enabled) that
// switches to a random pick, re-rolled once per real page load, same
// mechanism as the Splash Image feature.
(function () {
  'use strict';

  const DEFAULTS = {
    dt_bg_image_enabled: false,
    dt_bg_images_library: [],
    dt_bg_image_active_id: null,
    dt_bg_image_cycle_enabled: false,
    dt_bg_image_brightness: 100
  };

  // The native elements whose own visuals have to go transparent for our
  // full-viewport layer to show through where #content overlaps it — see
  // header comment. Each entry's opacity is captured once (native.opacity)
  // so disabling restores EXACTLY what it was before (DuelingBook doesn't
  // appear to set opacity on any of these, but better safe than hardcoding
  // '1').
  const NATIVE_LAYER_IDS = ['circuit_board', 'circuit_cover', 'greenlines', 'dark'];
  const capturedNativeOpacity = {};

  let bgLayerEl = null;
  let resolved = false; // whether chosenDataUrl has been rolled for this page load yet (cycle mode only)
  let chosenDataUrl = null;

  function ensureBgLayer() {
    if (bgLayerEl && bgLayerEl.isConnected) return bgLayerEl;
    bgLayerEl = document.getElementById('dt-bg-image-layer');
    if (bgLayerEl) return bgLayerEl;
    bgLayerEl = document.createElement('div');
    bgLayerEl.id = 'dt-bg-image-layer';
    Object.assign(bgLayerEl.style, {
      position: 'fixed',
      top: '0', left: '0', width: '100vw', height: '100vh',
      // Deliberately no z-index: a negative value risks landing behind
      // body's own root paint if body doesn't establish its own stacking
      // context (it doesn't, by default). Being body's first child is
      // already enough — DOM order alone puts it behind #content and
      // everything else, with no z-index needed.
      pointerEvents: 'none',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat'
    });
    // First child of body (not of #content — see header), so it's outside
    // #content's own transformed/zoomed box and spans the REAL window.
    if (document.body.firstChild) document.body.insertBefore(bgLayerEl, document.body.firstChild);
    else document.body.appendChild(bgLayerEl);
    return bgLayerEl;
  }

  function setNativeLayersHidden(hidden) {
    NATIVE_LAYER_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (hidden) {
        if (!(id in capturedNativeOpacity)) capturedNativeOpacity[id] = el.style.opacity || '';
        if (el.style.opacity !== '0') el.style.opacity = '0';
      } else if (id in capturedNativeOpacity) {
        if (el.style.opacity !== capturedNativeOpacity[id]) el.style.opacity = capturedNativeOpacity[id];
      }
    });
  }

  function pickImage(s) {
    const lib = s.dt_bg_images_library || [];
    if (!lib.length) return null;
    if (s.dt_bg_image_cycle_enabled) {
      if (!resolved) { chosenDataUrl = lib[Math.floor(Math.random() * lib.length)].dataUrl; resolved = true; }
      return chosenDataUrl;
    }
    resolved = false; // not in cycle mode right now — nothing to keep re-rolled, always resolve fresh below
    const active = lib.find((e) => e.id === s.dt_bg_image_active_id);
    // Fall back to the first saved image if the active one ever goes stale
    // (e.g. it was the one just deleted) rather than silently showing
    // nothing.
    return active ? active.dataUrl : lib[0].dataUrl;
  }

  function applyBackground() {
    if (!document.body) return;

    chrome.storage.local.get(DEFAULTS, (s) => {
      if (!document.body) return;
      const dataUrl = s.dt_bg_image_enabled ? pickImage(s) : null;

      if (!dataUrl) {
        setNativeLayersHidden(false);
        if (bgLayerEl) bgLayerEl.style.backgroundImage = '';
        return;
      }
      const layer = ensureBgLayer();
      const cssUrl = 'url("' + dataUrl + '")';
      if (layer.style.backgroundImage !== cssUrl) layer.style.backgroundImage = cssUrl;
      // Brightness slider: 100% is the image as uploaded, 0% fades it to
      // solid black. CSS brightness() scales every pixel toward black as
      // it approaches 0 and does exactly nothing at 1 — a direct match for
      // the user's own "100% how it is now, 0% nothing, grading to black"
      // spec, with no separate darkening overlay needed.
      const pct = typeof s.dt_bg_image_brightness === 'number' ? s.dt_bg_image_brightness : 100;
      const cssFilter = 'brightness(' + Math.max(0, Math.min(100, pct)) / 100 + ')';
      if (layer.style.filter !== cssFilter) layer.style.filter = cssFilter;
      setNativeLayersHidden(true);
    });
  }

  applyBackground();
  setInterval(applyBackground, 1500);

  // Re-assert if DuelingBook's own JS ever touches these specific native
  // elements' style/attributes directly (attributes-only — no need to
  // watch all of #content's deep subtree just for this).
  let mutationDebounce = null;
  function onNativeLayerMutation() {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => { mutationDebounce = null; applyBackground(); }, 80);
  }
  function observeNativeLayers() {
    const content = document.getElementById('content');
    if (!content) { setTimeout(observeNativeLayers, 1000); return; }
    const observer = new MutationObserver(onNativeLayerMutation);
    NATIVE_LAYER_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    });
    // Also watch #content's own direct children in case one of these gets
    // removed/replaced outright (defensive — same reasoning as every other
    // feature in this project that polls AND observes).
    observer.observe(content, { childList: true });
  }
  observeNativeLayers();

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (
        changes.dt_bg_image_enabled ||
        changes.dt_bg_images_library ||
        changes.dt_bg_image_active_id ||
        changes.dt_bg_image_cycle_enabled ||
        changes.dt_bg_image_brightness
      ) {
        if (changes.dt_bg_image_cycle_enabled) resolved = false; // mode just changed — don't keep a stale cycle pick around
        applyBackground();
      }
    });
  }

  console.log('[Duel Tools] Background Image ready');
})();
