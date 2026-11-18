// ==UserScript==
// @name         Duel Tools — Main Menu Splash Image
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Replaces the big monster artwork on DuelingBook's pre-"DUEL!" splash screen with a random pick among up to 5 user-uploaded images, fitted into a safe open area of the screen by default — or dragged/resized to an exact spot of your own via Settings' "Edit Positioning". Settings → Appearance Customization → Add Custom Images/Themes/Colors/Emotes → Custom Images.
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Confirmed live (two consecutive full page reloads): the splash artwork
// is one stable element, img#brionac_large (src brionac_small.webp, inside
// #front_page) — not a randomized pick among several BUILT-IN images,
// which an earlier pass in this project briefly assumed before a clean
// reload disproved it.
//
// Per the user's explicit follow-up: picking between the user's OWN
// uploaded images is random (Math.random(), re-rolled once per real page
// load — this whole file is re-injected fresh on every
// chrome.webNavigation.onCommitted, per background.js), not a sequential
// cycle.
//
// ── Automatic placement (v1.3) ────────────────────────────────────────────
// Earlier versions (v1.1/v1.2) capped the custom image to the native
// artwork's own on-screen box, then shrank it and centered it on that same
// box's center point. A follow-up with an annotated screenshot (a hand-
// drawn rectangle marking the "acceptable" area) showed that spot still
// wasn't right. v1.3 replaced it with a safe box computed LIVE each cycle
// from real anchor elements: right edge stops before #welcome_btn (the
// Welcome/Forum/Rules nav column), bottom edge stops before whichever is
// higher up of #duel_btn and #bulletin_txt, small insets off #front_page's
// own top/left otherwise. See computeSafeBox() below.
//
// ── Exact placement (v1.4) ────────────────────────────────────────────────
// Per the user's own follow-up idea: rather than keep guessing coordinates
// from a described or hand-drawn box, Settings now has an "Edit
// Positioning" button. Clicking it writes dt_main_splash_position_edit_mode
// = true straight to chrome.storage.local (see dt-settings.js — that one
// control deliberately bypasses the Settings page's normal staged-save
// model, since it has to reach THIS tab immediately, not after a Save
// click). This file polls for that flag; when it's true, enterEditMode()
// below takes over the splash image entirely: drag it anywhere (mousedown
// + mousemove/mouseup on the image itself), resize it via a small on-
// screen handle pinned to its bottom-right corner, and a floating toolbar
// with Save Position / Cancel. Save converts the image's current on-screen
// box into fractions of #front_page's own box (leftFrac/topFrac/sizeFrac —
// not raw px, so it survives a window resize the same way the automatic
// box does) and writes dt_main_splash_position_mode:'custom' +
// dt_main_splash_custom_position straight to storage; Cancel just clears
// the edit-mode flag and leaves whatever was there before untouched.
// Either way it flips dt_main_splash_position_edit_mode back to false
// itself, which is what lets Settings' own status line know editing ended.
// A custom position, once saved, takes over from the automatic box for
// good — Settings' "Reset to Automatic" clears it back.
(function () {
  'use strict';

  const DEFAULTS = {
    dt_custom_images_enabled: false,
    dt_main_splash_images_library: [],
    dt_main_splash_position_mode: 'auto',
    dt_main_splash_custom_position: null,
    dt_main_splash_position_edit_mode: false
  };

  let originalSrc = null; // captured the first time we see the real element, so "disable" / "empty library" can restore it exactly
  // Native size only (not position) — used purely as a last-resort fallback
  // cap if the safe-box computation below ever can't find its anchors.
  let nativeWidth = null;
  let nativeHeight = null;
  let resolved = false; // whether chosenDataUrl has been rolled for this page load yet
  let chosenDataUrl = null;

  function captureNativeSize(img) {
    if (nativeWidth !== null) return;
    const cs = getComputedStyle(img);
    const w = parseFloat(cs.width) || 0;
    const h = parseFloat(cs.height) || 0;
    if (w && h) { nativeWidth = w; nativeHeight = h; }
  }

  // Computed fresh every apply cycle (cheap — a handful of
  // getBoundingClientRect calls), not cached, so it tracks window resizes
  // automatically. Returns null if the anchor elements aren't available
  // right now, or if what's left over is too small to be worth using.
  function computeSafeBox(img) {
    const fp = document.getElementById('front_page');
    const welcomeBtn = document.getElementById('welcome_btn');
    const duelBtn = document.getElementById('duel_btn');
    const bulletin = document.getElementById('bulletin_txt');
    if (!fp || !welcomeBtn || !duelBtn || !bulletin) return null;

    const TOP_LEFT_MARGIN = 20;
    const RIGHT_MARGIN = 32; // a bit more breathing room from the nav text column
    const BOTTOM_MARGIN = 20;

    const fpRect = fp.getBoundingClientRect();
    const wRect = welcomeBtn.getBoundingClientRect();
    const dRect = duelBtn.getBoundingClientRect();
    const bRect = bulletin.getBoundingClientRect();

    const leftBound = fpRect.left + TOP_LEFT_MARGIN;
    const topBound = fpRect.top + TOP_LEFT_MARGIN;
    const rightBound = wRect.left - RIGHT_MARGIN;
    const bottomBound = Math.min(dRect.top, bRect.top) - BOTTOM_MARGIN;

    const availW = rightBound - leftBound;
    const availH = bottomBound - topBound;
    if (availW < 60 || availH < 60) return null; // degenerate layout — bail, let the caller fall back to the native-size cap

    const size = Math.min(availW, availH);
    return viewportBoxToImgBox(img, fp, { left: leftBound, top: topBound, width: size, height: size });
  }

  // Confirmed live: DuelingBook renders its whole front-page canvas through
  // a responsive CSS scale (no rotation involved here, just a uniform
  // zoom) — #front_page's own unscaled layout width (offsetWidth) is a
  // fixed 1024px, but its RENDERED width (getBoundingClientRect(), what
  // every viewport-space measurement in this file is based on) varies with
  // the window — ~1458px in one measurement (a ~1.42x scale), it'll differ
  // at other sizes. That scale only applies to RENDERING, not to the CSS
  // box model a position:absolute child's own top/left/width/height are
  // interpreted in — those stay in #front_page's local, PRE-scale units.
  // So every value this file derives from a getBoundingClientRect() (an
  // anchor element's position, or a real mouse event's clientX/clientY)
  // has to be divided by this scale before being written to the image's
  // own style.top/left/width/height, or the browser's own scale ends up
  // applied a second time on render — confirmed live as exactly why a real
  // drag/resize gesture didn't track 1:1 with the cursor.
  function getCanvasScale() {
    const fp = document.getElementById('front_page');
    if (!fp || !fp.offsetWidth) return 1;
    const s = fp.getBoundingClientRect().width / fp.offsetWidth;
    return (isFinite(s) && s > 0) ? s : 1;
  }

  // img is position:absolute — translate a box given in VIEWPORT
  // coordinates into coordinates relative to img's own positioning context
  // (its offsetParent), AND out of rendered/scaled px into the local,
  // pre-scale units style.top/left/width/height actually need (see
  // getCanvasScale above), before handing back plain top/left px.
  function viewportBoxToImgBox(img, fp, viewportBox) {
    const parent = img.offsetParent || fp;
    const pRect = parent.getBoundingClientRect();
    const S = getCanvasScale();
    return {
      left: (viewportBox.left - pRect.left) / S,
      top: (viewportBox.top - pRect.top) / S,
      width: viewportBox.width / S,
      height: viewportBox.height / S
    };
  }

  // A saved custom position is stored as fractions of #front_page's own
  // box (not raw px) so it stays put proportionally across window sizes,
  // the same reasoning as the automatic box above.
  function customFracToBox(img, pos) {
    const fp = document.getElementById('front_page');
    if (!fp || !pos) return null;
    const fpRect = fp.getBoundingClientRect();
    const viewportBox = {
      left: fpRect.left + pos.leftFrac * fpRect.width,
      top: fpRect.top + pos.topFrac * fpRect.height,
      width: pos.sizeFrac * fpRect.width,
      height: pos.sizeFrac * fpRect.width
    };
    return viewportBoxToImgBox(img, fp, viewportBox);
  }

  // Inverse of the above — used when Save Position is clicked, to turn the
  // image's current live on-screen box (box.* are LOCAL, pre-scale units,
  // read straight from img.style) back into storable fractions of
  // #front_page's own RENDERED box. Multiplies by the scale getCanvasScale
  // divides out above, to undo it going the other direction.
  function imgBoxToCustomFrac(img, box) {
    const fp = document.getElementById('front_page');
    if (!fp) return null;
    const parent = img.offsetParent || fp;
    const fpRect = fp.getBoundingClientRect();
    const pRect = parent.getBoundingClientRect();
    const S = getCanvasScale();
    const viewportLeft = pRect.left + box.left * S;
    const viewportTop = pRect.top + box.top * S;
    const viewportWidth = box.width * S;
    return {
      leftFrac: (viewportLeft - fpRect.left) / fpRect.width,
      topFrac: (viewportTop - fpRect.top) / fpRect.height,
      sizeFrac: viewportWidth / fpRect.width
    };
  }

  function setImgBox(img, box) {
    img.style.width = box.width + 'px';
    img.style.height = box.height + 'px';
    img.style.maxWidth = box.width + 'px';
    img.style.maxHeight = box.height + 'px';
    img.style.top = box.top + 'px';
    img.style.left = box.left + 'px';
  }

  function restoreNative(liveImg) {
    if (originalSrc && liveImg.getAttribute('src') !== originalSrc) liveImg.setAttribute('src', originalSrc);
    liveImg.style.width = '';
    liveImg.style.height = '';
    liveImg.style.maxWidth = '';
    liveImg.style.maxHeight = '';
    liveImg.style.top = '';
    liveImg.style.left = '';
    liveImg.style.transform = '';
    liveImg.style.objectFit = '';
  }

  function showCustomImage(liveImg, dataUrl, s) {
    if (liveImg.src !== dataUrl) liveImg.src = dataUrl;
    liveImg.style.objectFit = 'contain';
    liveImg.style.transform = 'none'; // the native rotation only makes sense for DuelingBook's own diagonal artwork
    let box = null;
    if (s.dt_main_splash_position_mode === 'custom' && s.dt_main_splash_custom_position) {
      box = customFracToBox(liveImg, s.dt_main_splash_custom_position);
    }
    if (!box) box = computeSafeBox(liveImg);
    if (box) {
      setImgBox(liveImg, box);
    } else if (nativeWidth) {
      // Fallback: no usable box at all — just cap to native size, don't
      // guess a position.
      liveImg.style.width = nativeWidth + 'px';
      liveImg.style.height = nativeHeight + 'px';
      liveImg.style.maxWidth = nativeWidth + 'px';
      liveImg.style.maxHeight = nativeHeight + 'px';
    }
  }

  // ── Edit Positioning (drag/resize) ───────────────────────────────────────
  let editMode = false;
  let editImg = null;
  let editHandleEl = null;
  let editToolbarEl = null;
  let editDragging = null;
  let editResizing = null;

  function currentBoxFromStyle(img) {
    return {
      left: parseFloat(img.style.left) || 0,
      top: parseFloat(img.style.top) || 0,
      width: parseFloat(img.style.width) || 0,
      height: parseFloat(img.style.height) || 0
    };
  }

  function positionHandleAndToolbar() {
    if (!editHandleEl || !editImg) return;
    const r = editImg.getBoundingClientRect();
    editHandleEl.style.left = (r.right - 10) + 'px';
    editHandleEl.style.top = (r.bottom - 10) + 'px';
  }

  // <img> elements are draggable by the browser's native HTML5 drag-and-
  // drop by default — confirmed live as exactly why resizing worked but
  // dragging didn't: a mousedown-then-move on the image was kicking off a
  // native "drag a ghost thumbnail" gesture instead of ever reaching
  // mousemove, while the resize handle (a plain <div>, no such built-in
  // behavior) worked fine. preventNativeImgDrag + img.draggable = false
  // below both exist belt-and-suspenders to shut that off for good.
  function preventNativeImgDrag(e) { e.preventDefault(); }

  function onImgMouseDown(e) {
    e.preventDefault();
    const box = currentBoxFromStyle(editImg);
    editDragging = { startX: e.clientX, startY: e.clientY, startLeft: box.left, startTop: box.top };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
  }
  function onDragMove(e) {
    if (!editDragging) return;
    // e.clientX/Y deltas are real, on-screen (rendered) px; style.left/top
    // are local pre-scale units — divide by the canvas scale so the image
    // tracks the cursor 1:1 instead of drifting away from it.
    const S = getCanvasScale();
    editImg.style.left = (editDragging.startLeft + (e.clientX - editDragging.startX) / S) + 'px';
    editImg.style.top = (editDragging.startTop + (e.clientY - editDragging.startY) / S) + 'px';
    positionHandleAndToolbar();
  }
  function onDragUp() {
    editDragging = null;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
  }

  function onResizeMouseDown(e) {
    e.preventDefault();
    e.stopPropagation(); // don't let this bubble into onImgMouseDown's territory
    const box = currentBoxFromStyle(editImg);
    editResizing = { startX: e.clientX, startY: e.clientY, startSize: box.width };
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup', onResizeUp);
  }
  function onResizeMove(e) {
    if (!editResizing) return;
    const S = getCanvasScale(); // same rendered-px → local-px correction as onDragMove
    const delta = Math.max(e.clientX - editResizing.startX, e.clientY - editResizing.startY) / S;
    const newSize = Math.max(60, editResizing.startSize + delta);
    editImg.style.width = newSize + 'px';
    editImg.style.height = newSize + 'px';
    editImg.style.maxWidth = newSize + 'px';
    editImg.style.maxHeight = newSize + 'px';
    positionHandleAndToolbar();
  }
  function onResizeUp() {
    editResizing = null;
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeUp);
  }

  function teardownEditUI() {
    if (editImg) {
      editImg.removeEventListener('mousedown', onImgMouseDown);
      editImg.removeEventListener('dragstart', preventNativeImgDrag);
      editImg.removeAttribute('draggable');
      editImg.style.cursor = '';
      editImg.style.outline = '';
      editImg.style.outlineOffset = '';
      editImg.style.zIndex = '';
      editImg.style.webkitUserDrag = '';
      editImg.style.pointerEvents = '';
    }
    if (editHandleEl) { editHandleEl.remove(); editHandleEl = null; }
    if (editToolbarEl) { editToolbarEl.remove(); editToolbarEl = null; }
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeUp);
    editDragging = null;
    editResizing = null;
    editMode = false;
    editImg = null;
  }

  function onSavePosition() {
    const box = currentBoxFromStyle(editImg);
    const frac = imgBoxToCustomFrac(editImg, box);
    const toSave = { dt_main_splash_position_edit_mode: false };
    if (frac) {
      toSave.dt_main_splash_position_mode = 'custom';
      toSave.dt_main_splash_custom_position = frac;
    }
    chrome.storage.local.set(toSave, () => {
      teardownEditUI();
      resolved = false;
      applyImage();
    });
  }
  function onCancelPosition() {
    chrome.storage.local.set({ dt_main_splash_position_edit_mode: false }, () => {
      teardownEditUI();
      resolved = false;
      applyImage();
    });
  }

  function enterEditMode(img, s) {
    if (editMode) { positionHandleAndToolbar(); return; } // already active — just keep the handle/toolbar tracking the live box
    const lib = s.dt_main_splash_images_library || [];
    if (!lib.length) {
      // Nothing to edit (shouldn't normally happen — Settings disables the
      // button in this case) — bail back out immediately rather than
      // leaving the flag stuck on.
      chrome.storage.local.set({ dt_main_splash_position_edit_mode: false });
      return;
    }
    editMode = true;
    editImg = img;
    img.src = lib[0].dataUrl; // a fixed, deterministic image while editing — no random re-rolling mid-edit
    img.style.objectFit = 'contain';
    img.style.transform = 'none';

    let box = (s.dt_main_splash_position_mode === 'custom' && s.dt_main_splash_custom_position)
      ? customFracToBox(img, s.dt_main_splash_custom_position)
      : computeSafeBox(img);
    if (!box) box = { left: 100, top: 100, width: 300, height: 300 };
    setImgBox(img, box);

    img.style.cursor = 'move';
    img.style.outline = '3px dashed #44aaff';
    img.style.outlineOffset = '2px';
    img.style.zIndex = '9999';
    // Confirmed live: DuelingBook's own CSS sets pointer-events:none on
    // this image (it's decorative, never meant to be clicked) — without
    // overriding that, a real mousedown never reaches onImgMouseDown at
    // all, it just passes straight through to #front_page underneath.
    // That's the actual reason dragging did nothing while resizing (a
    // separate <div> we create ourselves, with no such restriction)
    // worked fine.
    img.style.pointerEvents = 'auto';
    img.draggable = false;
    img.style.webkitUserDrag = 'none'; // Chrome-specific; harmless where unsupported
    img.addEventListener('dragstart', preventNativeImgDrag);
    img.addEventListener('mousedown', onImgMouseDown);

    editHandleEl = document.createElement('div');
    editHandleEl.id = 'dt-mm-resize-handle';
    Object.assign(editHandleEl.style, {
      position: 'fixed', width: '20px', height: '20px', background: '#44aaff',
      border: '2px solid #fff', borderRadius: '4px', cursor: 'nwse-resize',
      zIndex: '2147483000', boxShadow: '0 0 6px rgba(0,0,0,0.5)'
    });
    editHandleEl.addEventListener('mousedown', onResizeMouseDown);
    document.body.appendChild(editHandleEl);

    editToolbarEl = document.createElement('div');
    editToolbarEl.id = 'dt-mm-edit-toolbar';
    Object.assign(editToolbarEl.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: '2147483000',
      background: 'rgba(20,20,20,0.92)', color: '#fff', padding: '12px 14px',
      borderRadius: '8px', fontFamily: 'Arial, sans-serif', fontSize: '13px',
      lineHeight: '1.4', boxShadow: '0 2px 12px rgba(0,0,0,0.6)', maxWidth: '240px'
    });
    editToolbarEl.innerHTML =
      '<div style="margin-bottom:8px;">Drag the image to move it. Drag the blue corner handle to resize it.</div>' +
      '<button type="button" id="dt-mm-save-pos" style="margin-right:6px;padding:6px 10px;cursor:pointer;">Save Position</button>' +
      '<button type="button" id="dt-mm-cancel-pos" style="padding:6px 10px;cursor:pointer;">Cancel</button>';
    document.body.appendChild(editToolbarEl);
    editToolbarEl.querySelector('#dt-mm-save-pos').addEventListener('click', onSavePosition);
    editToolbarEl.querySelector('#dt-mm-cancel-pos').addEventListener('click', onCancelPosition);

    positionHandleAndToolbar();
  }

  function applyImage() {
    const img = document.getElementById('brionac_large');
    if (!img) return;
    if (originalSrc === null) { originalSrc = img.getAttribute('src'); captureNativeSize(img); }

    chrome.storage.local.get(DEFAULTS, (s) => {
      const liveImg = document.getElementById('brionac_large'); // re-query: this storage round-trip is async, the element could've been replaced by then
      if (!liveImg) return;

      if (s.dt_main_splash_position_edit_mode) {
        enterEditMode(liveImg, s);
        return;
      }
      if (editMode) teardownEditUI(); // flag went false some other way (e.g. a second tab) without going through our own Save/Cancel

      const lib = s.dt_main_splash_images_library || [];
      if (!s.dt_custom_images_enabled || !lib.length) {
        resolved = false; // so re-enabling / adding an image later re-rolls instead of reusing a stale pick
        restoreNative(liveImg);
        return;
      }
      if (!resolved) { chosenDataUrl = lib[Math.floor(Math.random() * lib.length)].dataUrl; resolved = true; }
      showCustomImage(liveImg, chosenDataUrl, s);
    });
  }

  applyImage();
  setInterval(applyImage, 1500);

  let mutationDebounce = null;
  function onFrontPageMutation() {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => { mutationDebounce = null; applyImage(); }, 80);
  }
  function observeFrontPage() {
    const fp = document.getElementById('front_page');
    if (!fp) { setTimeout(observeFrontPage, 1000); return; }
    new MutationObserver(onFrontPageMutation).observe(fp, { childList: true, subtree: true });
  }
  observeFrontPage();

  // Recompute on resize too — both the automatic box and a saved custom
  // position depend on live element/viewport sizes, so a window resize can
  // legitimately change the right on-screen px even though nothing stored
  // changed.
  window.addEventListener('resize', () => {
    if (editMode) positionHandleAndToolbar();
    else applyImage();
  });

  // Re-check immediately (rather than waiting up to 1500ms) whenever any of
  // this changes — the edit-mode flag flipping on from Settings, a Save/
  // Cancel result, a new/removed library image, or the master toggle.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (
        changes.dt_custom_images_enabled ||
        changes.dt_main_splash_images_library ||
        changes.dt_main_splash_position_edit_mode ||
        changes.dt_main_splash_position_mode ||
        changes.dt_main_splash_custom_position
      ) {
        if (changes.dt_custom_images_enabled || changes.dt_main_splash_images_library) resolved = false;
        applyImage();
      }
    });
  }

  console.log('[Duel Tools] Main Menu Splash Image ready');
})();
