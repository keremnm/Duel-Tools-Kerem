// ==UserScript==
// @name         Duel Tools — Custom Colors: Duel Room Customization
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Recolors DuelingBook's own Duel Lobby — format panels, the Deck/Mode/Filter-Sort/Host-a-Duel panels (fill+border), carousel arrows, the shared panel-titles color, and the Host a Duel/Filter-Sort/Mode/Deck text colors — per Settings → Appearance Customization → Add Custom Images/Themes/Colors/Emotes → Custom Colors → Duel Room Customization.
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Confirmed live, in the Duel Lobby (#duel_room): each format panel is a
// <div id="ar|au|yu|gu|eu|cu|su|ru|uu|tu" class="format"> with three
// independently-colorable parts (per the user's explicit follow-up spec):
//   - .format_inner — the fill (v1.0; unchanged here). Plain inline style
//     beats DuelingBook's own non-!important CSS rule, so no stylesheet
//     needed for this part.
//   - .border::before — a two-color gradient, DuelingBook's own per-panel
//     CSS (e.g. "#ar > .border::before { background: linear-gradient(to
//     right bottom, #0066cc, #00ffff); }"). A pseudo-element's background
//     can't be reached by element.style, so this file injects/rewrites ONE
//     <style> tag with one flat-color !important rule per panel instead —
//     simplifying DuelingBook's two-tone gradient down to the one color
//     the settings panel offers.
//   - text — confirmed live: every panel's own duel list uses
//     .username_txt / .rating_txt / .game_type per entry; the Ranked
//     panel (#ar) ALSO has its own join-pool form, confirmed live as
//     .desc_txt / .format_lbl / .rules_lbl / .type_lbl / .join_btn — none
//     of which exist on the other panels, so those five selectors are
//     only ever applied to #ar. All of this recolors via plain inline
//     style (these are ordinary elements, not pseudo-elements).
//
// v3.0 added the rows merged in from the old standalone "Duel Room"
// section (per the user's explicit "all of the features should be added
// to Room panels" request); its 5th row, "Room panel body text", was
// dropped on the user's own call since it duplicated the per-panel Text
// Color above (the same .username_txt/.rating_txt/.game_type content):
//   - Carousel arrow buttons — confirmed live as #pools_prev_btn /
//     #pools_next_btn, each a <div> holding one <img> of a DuelingBook SVG
//     icon (next_btn_up.svg / prev_btn_up.svg). Confirmed by rendering that
//     SVG at full size: it's a light-gray disc with a solid BLACK triangle
//     on top — i.e. the whole icon is opaque, so a plain CSS mask (which
//     only reads alpha) can't isolate the triangle from the disc; tested
//     live and it just produces a solid colored blob, losing the arrow
//     shape entirely. What DOES work, confirmed live: leave the <img>
//     alone, set mix-blend-mode:multiply on it, and recolor the BUTTON's
//     OWN existing CSS background (already the disc's own matching gray,
//     confirmed via computed style, so this introduces no new edge
//     artifacts) to the chosen rgba. Multiply keeps true-black pixels
//     black (the triangle stays crisp and visible) while tinting the
//     lighter disc toward the chosen color — this is an approximation,
//     not a pixel-exact hex match (same kind of tradeoff as the border
//     flattening above), but it looks clean at every color/opacity tested.
//   - Room panel titles — confirmed live as one <span class="format_txt">
//     per format panel ("Duelist Pool", "Goat Format", etc.) and one plain
//     <span class="arial_black2"> direct child for Deck/Mode/Filter-Sort/
//     Host a Duel ("Deck"/"Mode"/"Filter/Sort"/"Host a Duel" — the last of
//     these is #host_lbl, whose text DuelingBook itself swaps to "Joining
//     Duel" while joining, confirmed live, so that state is covered for
//     free). ONE color setting applied identically across all 14 panels —
//     the user's explicit follow-up asked for this, and asked the
//     previously-separate "Host a Duel heading" row to be folded into it.
//
// v4.0 adds, per the user's explicit follow-up with annotated screenshots:
//   - 4 new fill+border rows for the Deck/Mode/Filter-Sort/Host-a-Duel
//     panels. Confirmed live: #decklist / #mode / #filter / #host_bg each
//     have the exact same structure as a format panel's wrapper — a
//     direct-child .border div whose OWN background-color (not a separate
//     .format_inner-style element — there isn't one here) is the
//     translucent "inside" fill the mockup shows (DuelingBook's own default
//     is rgba(0,0,0,0.2) on every one of them), and whose ::before carries
//     the same two-tone gradient, flattened to one flat color the same way
//     as the 10 format-panel borders above.
//   - "Host a Duel Text Colors" — replaces the old, narrower "Host a Duel
//     form labels": now covers every text element confirmed live inside
//     #host_bg, in all three of its states (idle host form, the
//     hosting-side Accept/Reject/Cancel-Duel waiting screen, and the
//     joining-side "Waiting for response from host..."/Ready/Leave
//     screens) — every *_lbl label, every .button.proxy button's text, and
//     .waiting_txt/.status_txt. Still excludes the heading (now covered by
//     the shared Room panel titles color above).
//   - "Filter/Sort text colors" (#filter: Username:/Search Card:/Match
//     Type:/Sort By:/the rating+experience range labels/Rules:/Style:) and
//     "Mode text colors" (#mode: Duel/Watch) — same one-flat-color
//     treatment, scoped so the reused .rules_lbl class here doesn't bleed
//     into the Ranked panel's or Host a Duel's own .rules_lbl elements.
//   - "Deck panel text colors" (#decklist: the selected-deck-name text and
//     the "Set as Default" button). The deck list's own dropdown options
//     (card-type tag filters, every saved deck name) are left as DB's
//     native <option> styling — not practically worth recoloring and not
//     part of what was asked for.
(function () {
  'use strict';

  const ROW_SELECTOR = {
    rankedRoom: '#ar', advancedRoom: '#au', genesysRoom: '#yu', goatRoom: '#gu',
    edisonRoom: '#eu', customCardsRoom: '#cu', speedDuelsRoom: '#su',
    rushDuelsRoom: '#ru', unlimitedRoom: '#uu', traditionalRoom: '#tu'
  };
  // Confirmed live: only the Ranked panel has this join-pool form content.
  const RANKED_ONLY_TEXT_SELECTORS = ['.desc_txt', '.format_lbl', '.rules_lbl', '.type_lbl', '.join_btn'];
  const LIST_TEXT_SELECTORS = ['.username_txt', '.rating_txt', '.game_type'];

  // v3.0 additions — merged in from the old "Duel Room" section.
  const CAROUSEL_BUTTON_SELECTORS = ['#pools_prev_btn', '#pools_next_btn'];

  // v4.0 additions.
  // The 4 new fill+border panels — same .border-child convention as the 10
  // format panels above, confirmed live (see header comment).
  const PANEL2_SELECTOR = {
    deckPanel: '#decklist', modePanel: '#mode', filterSortPanel: '#filter', hostADuelPanel: '#host_bg'
  };
  // Every panel's title, for the one shared "Room panel titles" color.
  // Format panels: <span class="format_txt"> somewhere inside. The 4 new
  // panels: one plain <span class="arial_black2"> DIRECT child — confirmed
  // live there's exactly one per panel, so ":scope > .arial_black2" is
  // unambiguous and doesn't need the #host_lbl-style id selectors anymore.
  const TITLE_TARGETS = Object.keys(ROW_SELECTOR).map((id) => ({ root: ROW_SELECTOR[id], childSel: '.format_txt' }))
    .concat(Object.keys(PANEL2_SELECTOR).map((id) => ({ root: PANEL2_SELECTOR[id], childSel: ':scope > .arial_black2' })));

  // "Host a Duel Text Colors" — every text element confirmed live inside
  // #host_bg across all three of its states (idle host form / hosting-side
  // waiting screen / joining-side waiting screen), EXCLUDING the heading
  // (#host_lbl — covered by the shared Room panel titles color instead).
  // .format_lbl/.type_lbl/.rules_lbl are reused on the Ranked panel's own
  // join-pool form inside #ar (handled separately, above) — scoping every
  // selector here to #host_bg keeps the two from bleeding into each other.
  const HOST_TEXT_SELECTORS = [
    '.format_lbl', '.type_lbl', '.rules_lbl', '.expert_lbl', '.duel_note_lbl',
    '.duel_password_lbl', '.watching_lbl', '.classic_lbl', '.tag_duel_lbl',
    '.watch_note_lbl', '.watch_password_lbl', '.button.proxy', '.waiting_txt', '.status_txt'
  ];
  // "Filter/Sort text colors" — confirmed live inside #filter. .rules_lbl
  // is reused on the Ranked panel's join-pool form AND inside #host_bg;
  // scoping to #filter keeps this independent of both.
  const FILTER_TEXT_SELECTORS = [
    '.username_lbl', '.name_lbl', '.match_type_lbl', '.sort_lbl',
    '.rating_lbl', '.rep_lbl', '.rules_lbl', '.style_lbl'
  ];
  // "Mode text colors" — confirmed live inside #mode.
  const MODE_TEXT_SELECTORS = ['.duel_lbl', '.watch_lbl'];
  // "Deck panel text colors" — confirmed live inside #decklist: the
  // selected-deck-name span (no distinguishing class of its own, hence the
  // parent-scoped selector) and the "Set as Default" button.
  const DECK_TEXT_SELECTORS = ['.combobox.proxy.unselectable > span', '.button.proxy.unselectable'];

  // v4.2 additions — DuelingBook's own native "widget accent" color behind
  // every dropdown/button in these 4 panels, confirmed live as a plain
  // inline (non-!important) background-color on a `.combobox_background`
  // sibling div sitting between the panel's own fill and the glossy
  // .combobox.proxy/.button.proxy overlay on top — same override technique
  // as everything else here. One flat color per panel, uniform across every
  // dropdown/button inside it (confirmed live: every .combobox_background
  // in a given panel carries the exact same rgba value) — e.g. Host a Duel
  // is solid green (54,204,0), Filter/Sort solid blue (0,153,255), Deck
  // solid orange (255,51,0). Mode's radio-button fill is the one exception:
  // it's a `.radiobutton_background` div instead, solid purple (102,0,204),
  // same technique.
  const HOST_WIDGET_SELECTORS = ['.combobox_background'];
  const FILTER_WIDGET_SELECTORS = ['.combobox_background'];
  const MODE_WIDGET_SELECTORS = ['.radiobutton_background'];
  const DECK_WIDGET_SELECTORS = ['.combobox_background'];

  function hexToRgb(hex) {
    const h = (hex || '#000000').replace('#', '');
    return {
      r: parseInt(h.substring(0, 2), 16) || 0,
      g: parseInt(h.substring(2, 4), 16) || 0,
      b: parseInt(h.substring(4, 6), 16) || 0
    };
  }
  function rgba(hex, alphaPct) {
    const { r, g, b } = hexToRgb(hex);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (Math.max(0, Math.min(100, alphaPct)) / 100) + ')';
  }

  function applyFill(selector, enabled, color, opacityPct, transparent, imageDataUrl) {
    const el = document.querySelector(selector + ' .format_inner');
    if (!el) return;
    if (!enabled) {
      el.style.backgroundColor = '';
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      return;
    }
    if (transparent) {
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      el.style.backgroundColor = 'rgba(0,0,0,0)';
      return;
    }
    const { r, g, b } = hexToRgb(color);
    const alpha = Math.max(0, Math.min(100, opacityPct)) / 100;
    if (imageDataUrl) {
      // Tint the uploaded image by the same color/opacity instead of using
      // element.style.opacity (which would also fade the panel's own
      // dropdowns/buttons/text, not just its background).
      el.style.backgroundColor = '';
      el.style.backgroundImage =
        'linear-gradient(rgba(' + r + ',' + g + ',' + b + ',' + (1 - alpha) + '), rgba(' + r + ',' + g + ',' + b + ',' + (1 - alpha) + ')), ' +
        'url("' + imageDataUrl + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    } else {
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      el.style.backgroundColor = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
  }

  function applyText(id, selector, enabled, color, removeGlow) {
    const panel = document.querySelector(selector);
    if (!panel) return;
    const selectors = LIST_TEXT_SELECTORS.concat(id === 'rankedRoom' ? RANKED_ONLY_TEXT_SELECTORS : []);
    selectors.forEach((sel) => {
      panel.querySelectorAll(sel).forEach((el) => {
        el.style.color = enabled ? color : ''; // works the same for the .join_btn <input> as for any other text element
        // v4.1: DuelingBook's own stylesheet puts a red text-shadow "glow" on
        // .game_type specifically (confirmed live — rgb(255,0,0) 0 0 2px x4,
        // NOT !important, so a plain inline override beats it for free,
        // same technique as everything else here). The other LIST_TEXT_
        // SELECTORS (.username_txt/.rating_txt) don't have one, so this is
        // scoped to .game_type only; harmless no-op on the rest.
        if (sel === '.game_type') el.style.textShadow = enabled && removeGlow ? 'none' : '';
      });
    });
  }

  function applyCarouselArrows(enabled, color, opacityPct) {
    CAROUSEL_BUTTON_SELECTORS.forEach((sel) => {
      const btn = document.querySelector(sel);
      if (!btn) return; // #pools_prev_btn is display:none at the start of the carousel — confirmed live, not an error
      const img = btn.querySelector('img');
      if (!enabled || !color) {
        btn.style.backgroundColor = '';
        btn.style.isolation = '';
        if (img) { img.style.mixBlendMode = ''; }
        return;
      }
      btn.style.isolation = 'isolate'; // confines the multiply blend to this button's own background, not the page behind it
      btn.style.backgroundColor = rgba(color, opacityPct);
      if (img) { img.style.mixBlendMode = 'multiply'; }
    });
  }

  // `prop` defaults to 'color' (every pre-v4.2 caller) — v4.2 also calls this
  // with 'backgroundColor' for the native widget-accent layers below
  // (.combobox_background / .radiobutton_background), same technique,
  // different CSS property.
  function applySimpleTextColor(selectors, enabled, color, opacityPct, scopeEl, prop) {
    const root = scopeEl || document;
    const cssProp = prop || 'color';
    selectors.forEach((sel) => {
      root.querySelectorAll(sel).forEach((el) => {
        el.style[cssProp] = enabled && color ? rgba(color, opacityPct) : '';
      });
    });
  }

  let borderStyleEl = null;
  function ensureBorderStyleEl() {
    if (borderStyleEl && document.head.contains(borderStyleEl)) return borderStyleEl;
    borderStyleEl = document.getElementById('dt-cc-room-border-style');
    if (!borderStyleEl) {
      borderStyleEl = document.createElement('style');
      borderStyleEl.id = 'dt-cc-room-border-style';
      document.head.appendChild(borderStyleEl);
    }
    return borderStyleEl;
  }

  // Combined selector map for every panel that has a border row — the 10
  // format panels plus the 4 v4.0 panels — since the border technique
  // (one shared <style> tag, one !important rule per customized panel on
  // its own "<selector> > .border::before") is identical for both groups.
  const ALL_PANEL_SELECTOR = Object.assign({}, ROW_SELECTOR, PANEL2_SELECTOR);

  function applyBorders(enabledByRow) {
    const styleEl = ensureBorderStyleEl();
    let css = '';
    Object.keys(ALL_PANEL_SELECTOR).forEach((id) => {
      const row = enabledByRow[id];
      if (!row || !row.enabled) return; // master off, or nothing stored for this row yet — leave DuelingBook's own gradient alone
      const bg = row.transparent ? 'rgba(0,0,0,0)' : rgba(row.color, row.opacity);
      css += ALL_PANEL_SELECTOR[id] + ' > .border::before { background: ' + bg + ' !important; }\n';
    });
    styleEl.textContent = css;
  }

  // v4.0: the Deck/Mode/Filter-Sort/Host-a-Duel panels have no separate
  // .format_inner-style fill element — confirmed live, their direct-child
  // .border div's OWN background-color is the "inside" fill the mockup
  // shows, so this sets that directly instead of a descendant element.
  function applyPanelBoxFill(selector, enabled, color, opacityPct, transparent, imageDataUrl) {
    const el = document.querySelector(selector + ' > .border');
    if (!el) return;
    if (!enabled) {
      el.style.backgroundColor = '';
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      return;
    }
    if (transparent) {
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      el.style.backgroundColor = 'rgba(0,0,0,0)';
      return;
    }
    const { r, g, b } = hexToRgb(color);
    const alpha = Math.max(0, Math.min(100, opacityPct)) / 100;
    if (imageDataUrl) {
      el.style.backgroundColor = '';
      el.style.backgroundImage =
        'linear-gradient(rgba(' + r + ',' + g + ',' + b + ',' + (1 - alpha) + '), rgba(' + r + ',' + g + ',' + b + ',' + (1 - alpha) + ')), ' +
        'url("' + imageDataUrl + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    } else {
      el.style.backgroundImage = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      el.style.backgroundColor = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
  }

  // chrome.storage.local.get(keys, cb) returns, for any key not yet
  // actually written to storage, WHATEVER VALUE was passed in for it —
  // that's the real Chrome API default-fallback behavior, not a null/false
  // placeholder. This file was passing null/false for every color/opacity
  // key, which is wrong the moment a row hasn't been explicitly edited+
  // saved yet on the settings page (brand new rows, almost always): a
  // never-touched row came back with color=null, and applyFill/applyText/
  // applySimpleTextColor/applyBorders/applyPanelBoxFill all treat a falsy
  // color as "do nothing" — so nothing ever rendered, which is exactly the
  // bug the user reported ("the text options for these panels wont
  // work"). Fixed by mirroring the SAME per-row defaults dt-settings.js
  // registers (CUSTOM_COLOR_SECTIONS' roomPanels rows) here, so a
  // never-touched row reads back its real intended default — which, by
  // design, matches DuelingBook's own native look exactly, same as every
  // other row in this feature.
  const ROOM_PANEL_DEFAULTS = {
    rankedRoom: { color: '#b7daff', opacity: 80, border: '#0066cc', text: '#000000' },
    advancedRoom: { color: '#a6edd6', opacity: 80, border: '#33b801', text: '#000000' },
    genesysRoom: { color: '#ffd0b7', opacity: 80, border: '#0099ff', text: '#000000' },
    goatRoom: { color: '#d5b9ff', opacity: 80, border: '#6600ff', text: '#000000' },
    edisonRoom: { color: '#fff4a1', opacity: 80, border: '#ffb801', text: '#000000' },
    customCardsRoom: { color: '#b7daff', opacity: 80, border: '#0099ff', text: '#000000' },
    speedDuelsRoom: { color: '#cefae1', opacity: 80, border: '#00ff00', text: '#000000' },
    rushDuelsRoom: { color: '#ffdbc4', opacity: 80, border: '#ff6600', text: '#000000' },
    unlimitedRoom: { color: '#efefef', opacity: 80, border: '#666666', text: '#000000' },
    traditionalRoom: { color: '#ffc8de', opacity: 80, border: '#ff3366', text: '#000000' }
  };
  // v4.2 fix: all 4 of these panels' native fill is confirmed live as
  // rgba(40,39,24,0.2) — i.e. #282718 @ 20%, not pure black. Was wrong since
  // v4.0 (an assumption, never actually checked against the live page) —
  // harmless until now since "Reset" never visibly differed much from
  // black at only 20% opacity, but worth correcting while in here.
  const PANEL2_DEFAULTS = {
    deckPanel: { color: '#282718', opacity: 20, border: '#ff6700' },
    modePanel: { color: '#282718', opacity: 20, border: '#6633ff' },
    filterSortPanel: { color: '#282718', opacity: 20, border: '#0066cc' },
    hostADuelPanel: { color: '#282718', opacity: 20, border: '#33b801' }
  };
  const SIMPLE_ROW_DEFAULTS = {
    carouselArrows: { color: '#cccccc', opacity: 100 },
    roomPanelTitles: { color: '#ffffff', opacity: 100 },
    hostDuelTextColors: { color: '#ffffff', opacity: 100 },
    filterSortTextColors: { color: '#ffffff', opacity: 100 },
    modeTextColors: { color: '#ffffff', opacity: 100 },
    deckPanelTextColors: { color: '#000000', opacity: 100 },
    // v4.2 additions — DuelingBook's own native widget-accent colors (see
    // the HOST_WIDGET_SELECTORS comment above for how these are found/set).
    hostDuelWidgetColors: { color: '#36cc00', opacity: 75 },
    filterSortWidgetColors: { color: '#0099ff', opacity: 75 },
    modeWidgetColors: { color: '#6600cc', opacity: 75 },
    deckWidgetColors: { color: '#ff3300', opacity: 75 }
  };
  const SIMPLE_ROW_IDS = Object.keys(SIMPLE_ROW_DEFAULTS);

  function readAndApply() {
    const keys = { dt_custom_colors_enabled: false, dt_custom_colors_remove_glow: true };
    Object.keys(ROW_SELECTOR).forEach((id) => {
      const d = ROOM_PANEL_DEFAULTS[id];
      keys['dt_cc_' + id + '_color'] = d.color;
      keys['dt_cc_' + id + '_opacity'] = d.opacity;
      keys['dt_cc_' + id + '_fillTransparent'] = false;
      keys['dt_cc_' + id + '_image'] = null;
      keys['dt_cc_' + id + '_borderColor'] = d.border;
      keys['dt_cc_' + id + '_borderOpacity'] = 100;
      keys['dt_cc_' + id + '_borderTransparent'] = false;
      keys['dt_cc_' + id + '_textColor'] = d.text;
    });
    Object.keys(PANEL2_SELECTOR).forEach((id) => {
      const d = PANEL2_DEFAULTS[id];
      keys['dt_cc_' + id + '_color'] = d.color;
      keys['dt_cc_' + id + '_opacity'] = d.opacity;
      keys['dt_cc_' + id + '_fillTransparent'] = false;
      keys['dt_cc_' + id + '_borderColor'] = d.border;
      keys['dt_cc_' + id + '_borderOpacity'] = 100;
      keys['dt_cc_' + id + '_borderTransparent'] = false;
    });
    SIMPLE_ROW_IDS.forEach((id) => {
      keys['dt_cc_' + id + '_color'] = SIMPLE_ROW_DEFAULTS[id].color;
      keys['dt_cc_' + id + '_opacity'] = SIMPLE_ROW_DEFAULTS[id].opacity;
    });
    chrome.storage.local.get(keys, (s) => {
      const enabled = !!s.dt_custom_colors_enabled;
      const removeGlow = !!s.dt_custom_colors_remove_glow;
      const borderRows = {};
      Object.keys(ROW_SELECTOR).forEach((id) => {
        applyFill(ROW_SELECTOR[id], enabled, s['dt_cc_' + id + '_color'], s['dt_cc_' + id + '_opacity'], !!s['dt_cc_' + id + '_fillTransparent'], s['dt_cc_' + id + '_image']);
        applyText(id, ROW_SELECTOR[id], enabled, s['dt_cc_' + id + '_textColor'], removeGlow);
        borderRows[id] = {
          enabled,
          color: s['dt_cc_' + id + '_borderColor'],
          opacity: s['dt_cc_' + id + '_borderOpacity'],
          transparent: !!s['dt_cc_' + id + '_borderTransparent']
        };
      });
      Object.keys(PANEL2_SELECTOR).forEach((id) => {
        applyPanelBoxFill(PANEL2_SELECTOR[id], enabled, s['dt_cc_' + id + '_color'], s['dt_cc_' + id + '_opacity'], !!s['dt_cc_' + id + '_fillTransparent'], null);
        borderRows[id] = {
          enabled,
          color: s['dt_cc_' + id + '_borderColor'],
          opacity: s['dt_cc_' + id + '_borderOpacity'],
          transparent: !!s['dt_cc_' + id + '_borderTransparent']
        };
      });
      applyBorders(borderRows);

      applyCarouselArrows(enabled, s.dt_cc_carouselArrows_color, s.dt_cc_carouselArrows_opacity);

      // One shared color across all 14 panel titles.
      TITLE_TARGETS.forEach((t) => {
        const root = document.querySelector(t.root);
        if (root) applySimpleTextColor([t.childSel], enabled, s.dt_cc_roomPanelTitles_color, s.dt_cc_roomPanelTitles_opacity, root);
      });

      const hostBg = document.getElementById('host_bg');
      if (hostBg) {
        applySimpleTextColor(HOST_TEXT_SELECTORS, enabled, s.dt_cc_hostDuelTextColors_color, s.dt_cc_hostDuelTextColors_opacity, hostBg);
        applySimpleTextColor(HOST_WIDGET_SELECTORS, enabled, s.dt_cc_hostDuelWidgetColors_color, s.dt_cc_hostDuelWidgetColors_opacity, hostBg, 'backgroundColor');
      }
      const filterEl = document.getElementById('filter');
      if (filterEl) {
        applySimpleTextColor(FILTER_TEXT_SELECTORS, enabled, s.dt_cc_filterSortTextColors_color, s.dt_cc_filterSortTextColors_opacity, filterEl);
        applySimpleTextColor(FILTER_WIDGET_SELECTORS, enabled, s.dt_cc_filterSortWidgetColors_color, s.dt_cc_filterSortWidgetColors_opacity, filterEl, 'backgroundColor');
      }
      const modeEl = document.getElementById('mode');
      if (modeEl) {
        applySimpleTextColor(MODE_TEXT_SELECTORS, enabled, s.dt_cc_modeTextColors_color, s.dt_cc_modeTextColors_opacity, modeEl);
        applySimpleTextColor(MODE_WIDGET_SELECTORS, enabled, s.dt_cc_modeWidgetColors_color, s.dt_cc_modeWidgetColors_opacity, modeEl, 'backgroundColor');
      }
      const decklistEl = document.getElementById('decklist');
      if (decklistEl) {
        applySimpleTextColor(DECK_TEXT_SELECTORS, enabled, s.dt_cc_deckPanelTextColors_color, s.dt_cc_deckPanelTextColors_opacity, decklistEl);
        applySimpleTextColor(DECK_WIDGET_SELECTORS, enabled, s.dt_cc_deckWidgetColors_color, s.dt_cc_deckWidgetColors_opacity, decklistEl, 'backgroundColor');
      }
    });
  }

  readAndApply();
  // The Duel Lobby's format panels are built once and then just
  // hidden/shown by DuelingBook's own page router (confirmed live — they
  // keep their ids across navigation), but polling is cheap and makes this
  // robust against a lobby rebuild too; same convention as every other
  // Custom Colors/Emotes content script in this extension.
  setInterval(readAndApply, 1500);

  // Confirmed live: DuelingBook sets .game_type/.username_txt/.rating_txt's
  // color as an INLINE style itself (not a stylesheet rule), re-rendering
  // those entries from scratch every time a panel's hosted-duel list
  // changes (a new duel posted, one removed, etc.) — a fresh element means
  // a fresh DuelingBook-colored one, overwriting whatever we set on the
  // element it replaced. The 1500ms poll above would eventually re-catch
  // it, but that's up to 1.5s of it flashing DuelingBook's own color after
  // every list update. A MutationObserver on the whole lobby, debounced,
  // re-applies immediately when that happens instead of waiting on the
  // timer — same readAndApply(), just triggered sooner.
  let mutationDebounce = null;
  function onLobbyMutation() {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => { mutationDebounce = null; readAndApply(); }, 80);
  }
  function observeLobby() {
    const lobby = document.getElementById('duel_room');
    if (!lobby) { setTimeout(observeLobby, 1000); return; }
    new MutationObserver(onLobbyMutation).observe(lobby, { childList: true, subtree: true });
  }
  observeLobby();

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const relevant = Object.keys(changes).some((k) => k === 'dt_custom_colors_enabled' || k.indexOf('dt_cc_') === 0);
      if (relevant) readAndApply();
    });
  }

  console.log('[Duel Tools] Custom Colors: Duel Room Customization ready');
})();
