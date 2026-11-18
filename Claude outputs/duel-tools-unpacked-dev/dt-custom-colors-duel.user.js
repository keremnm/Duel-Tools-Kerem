// ==UserScript==
// @name         Duel Tools — Custom Colors: Duel Interface
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Recolors the live duel screen — the phase bar's active-phase highlight, both players' Life Points boxes, the player avatar panel border, the duel zone grid itself (as two gradient sweeps, yours and your opponent's), the Deck/Extra Deck/GY/Banished zone corner boxes (nudged to actually hug the real card art, since DuelingBook's own artwork doesn't quite line up there), and the Token picker's modal background — plus a separate toggle to hide the Pendulum Zones entirely, icon AND border box, on both sides. Per Settings → Appearance Customization → Custom Colors → Duel interface (colors) and → Playing → Hide Pendulum Zones (the toggle).
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── v2.3 — Hide Pendulum Zones now removes the border box, not just the icon ─
// The v2.0 note below ("the zone's outline is part of the one continuous row
// path... there's no separate 'Pendulum Zone cell' to remove") was WRONG —
// confirmed live this pass by actually parsing the stroke paths' raw `d`
// geometry instead of reasoning from the bounding box of one naive regex
// split. Each row's stroke path is really 15 small rounded-rect subpaths —
// 10 for the normal 5x2 monster/spell-trap grid, plus 2-3 more per side for
// that side's Pendulum Zone border (it's drawn in 2-3 stacked pieces, not
// one rect). They're cleanly separable by position: every subpath whose
// bounding box falls left of the main grid's leftmost column (x < 288) or
// right of its rightmost column's far edge (x > 751, in the SVG's own
// 1024x640 coordinate space) is a Pendulum Zone piece and nothing else —
// verified live that this rule captures exactly the pendulum pieces and
// none of the 10 real grid cells on either row, for both the opponent's
// path and mine. (The catch that made this take two passes: naively
// splitting the `d` string only on uppercase "M" undercounts badly, since
// most subpaths after the first continue with a lowercase relative "m" —
// splitting on `(?=[Mm])` while tracking the running absolute cursor
// position, as `stripPendulumZoneBoxes` below does, is what actually
// separates them correctly.) With this in hand, Hide Pendulum Zones now
// strips those subpaths out of the geometry entirely (in addition to still
// hiding the 4 diamond icons) — the cell truly disappears into the
// background rather than just losing its marker.
//
// ── v2.2 — Deck/Extra Deck zone corner boxes ─────────────────────────────────
// User asked for these (both sides) to be color customizeable, pointing at
// the single bordered box in each of the field's 4 corners — confirmed live
// these are NOT part of field_zones.svg at all (searched its full text,
// nothing there), but a second, separate <img class="field_decks"> sitting
// at the exact same position/size, with the exact same two-gradient-per-
// side structure (id="linear-gradient" = opponent, green->orange;
// id="linear-gradient-2" = mine, red->purple). Confirmed by a live test
// recolor (magenta/cyan) that visibly changed exactly those 4 boxes and
// nothing else, then reverted before shipping. One color per side, not
// per zone — Deck and Extra Deck share one continuous outline, same as
// how the main grid fuses monster/spell-trap/pendulum into one path.
//
// ── v2.1 — Token menu background row ─────────────────────────────────────────
// Added right after building Custom Token Images, per the user's own
// follow-up. Target: #token_select .background_inner > .background —
// confirmed live as a real, non-transparent element (native rgb(153,51,204))
// while investigating that same modal for the Custom Token Images feature,
// but the DuelingBook tab's connection dropped ("Lost Connection!") right
// as a second confirmation pass was underway, so the color VALUE is solid
// (read twice, consistent) but the element's effective size/visibility
// through a full open→close→reopen cycle hasn't been re-watched end to end
// yet. Worth a quick look the next time this modal gets opened live.
//
// ── v2.0 — now actually confirmed against a live duel ───────────────────────
// v1's zone-grid/pendulum code (climbing up from the Pendulum Scale counter
// ids, #pendulum_left_counter etc., to guess at a "zone cell" element) was
// wrong: confirmed live this pass that those counters sit in a completely
// unrelated #counters container, nowhere near the zone grid in the DOM —
// climbing from them would always fail and silently do nothing. Caught by
// actually getting into the user's live duel this time and checking.
//
// What the zone grid REALLY is, confirmed live by fetching and reading the
// actual asset: the whole grid — every monster zone, every spell/trap zone,
// both Pendulum Zones, for one full player row — is ONE external image,
// <img id="field_zones" src="https://images.duelingbook.com/svg/
// field_zones.svg">, not individual DOM cells at all (confirmed by probing
// with document.elementFromPoint() across the whole field — nothing zone-
// shaped was ever there, just this one big img and a couple of oversized
// invisible hit-targets underneath it). That explains why NOTHING turned up
// searching DuelingBook's stylesheet for zone/grid/cell selectors, both
// tonight and last pass — there was never a CSS class to find.
//
// The good news: field_zones.svg is a real SVG document (fetched and read
// directly — same-origin-enough that no new host_permission was even
// needed, confirmed live), not a flattened raster image, so its actual
// structure is readable and editable as text:
//   - The grid's colored outlines are drawn by exactly two <path>s, each
//     stroked with a <linearGradient>: #linear-gradient (id, 2 stops
//     #00b400 green → #ff8f00 orange) draws the FAR row, #linear-gradient-2
//     (stops red → #9900ff purple) draws the NEAR row. Confirmed live these
//     match the screenshot exactly — green-to-orange across the top,
//     red-to-purple across the bottom. Every zone in a row (monster AND
//     spell/trap AND both Pendulum Zones) shares that one continuous
//     gradient sweep — there's no separate per-zone-type path to recolor
//     independently, which is why this offers one color for "your side"
//     and one for "opponent's side" rather than a color per zone type.
//     (DuelingBook always renders the viewer's own row as the near/bottom
//     one, so "near" = you, "far" = opponent, consistently.)
//   - The Pendulum Zone diamond icons are 4 separate <use> elements —
//     red_pendulum_scale_png, blue_pendulum_scale_png, and each one's "-2"
//     counterpart (yours and your opponent's, left and right) — confirmed
//     live by id, matching the two diamonds the user's own reference image
//     zoomed in on. These are independently hideable. The zone's border box
//     IS also independently removable, despite what an earlier pass of this
//     file claimed — see the v2.3 note above for how that was confirmed and
//     fixed.
//
// How this is actually applied: the fetched SVG's raw text is cached once,
// then on every settings change this builds a fresh copy with the two
// gradients' stop-color values swapped to the chosen colors (and, if Hide
// Pendulum Zones is on, a `display:none` style spliced onto those 4 <use>
// tags), and sets it as a data: URI on the SAME <img id="field_zones">
// element — its tag, id, and position never change, so nothing else that
// might reference #field_zones is disturbed. "Color inherited" (set no
// override): the ORIGINAL unmodified SVG text is restored.
//
// ── Confirmed live (unchanged from before) ──────────────────────────────────
//   - Phase bar: `#dp`/`#sp`/`#m1`/`#bp`/`#m2`/`#ep`, each `.phase`, with
//     `.phase.active .phase_inner.red` / `.phase.active .phase_inner.blue`.
//   - Life Points: `.lifepoints` (one player) / `#lifepoints2` (the other),
//     each with `.life_bar` (the fill), `.life_border` (the frame).
//   - Player avatar panel: `.duel_avatar` — the "color by the player's
//     name/profile picture" row — given a colored ring via `box-shadow`.
(function () {
  'use strict';

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
  function applySimple(selectors, enabled, color, opacityPct, scopeEl, prop) {
    const root = scopeEl || document;
    const cssProp = prop || 'color';
    selectors.forEach((sel) => {
      root.querySelectorAll(sel).forEach((el) => {
        el.style[cssProp] = enabled && color ? rgba(color, opacityPct) : '';
      });
    });
  }

  const ROW_DEFAULTS = {
    phaseButtons: { color: '#ff0000', opacity: 100 },
    lifePointsBorder: { color: '#000000', opacity: 100 },
    lifePointsBar: { color: '#ffffff', opacity: 100 },
    avatarBorder: { color: '#ff0000', opacity: 100 },
    zoneGridMine: { color: '#9900ff', opacity: 100 },
    zoneGridOpponent: { color: '#00b400', opacity: 100 },
    tokenMenuBg: { color: '#9933cc', opacity: 100 },
    deckZoneMine: { color: '#9900ff', opacity: 100 },
    deckZoneOpponent: { color: '#00b400', opacity: 100 }
  };
  const ROW_IDS = Object.keys(ROW_DEFAULTS);

  const FIELD_ZONES_SVG_URL = 'https://images.duelingbook.com/svg/field_zones.svg';
  const PENDULUM_USE_IDS = ['red_pendulum_scale_png', 'blue_pendulum_scale_png', 'blue_pendulum_scale_png-2', 'red_pendulum_scale_png-2'];

  // The Deck Zone and Extra Deck Zone corner boxes (top-left/top-right for
  // the opponent, bottom-left/bottom-right for you) are a SEPARATE little
  // SVG, not part of field_zones.svg at all — confirmed live by searching
  // field_zones.svg's own text for any trace of them (none) and then
  // finding this second <img class="field_decks"> sitting at the exact
  // same position/size, fetching IT, and recoloring it as a live test
  // (magenta/cyan) which visibly changed exactly those 4 corner boxes and
  // nothing else. Same architecture as field_zones.svg: one continuous
  // gradient-stroked path per side (id="linear-gradient" = opponent,
  // green->orange; id="linear-gradient-2" = mine, red->purple) covering
  // BOTH that side's Deck and Extra Deck zone outlines together — they
  // can't be colored independently of each other, only mine vs opponent's.
  // `.field_decks` (not `#field_decks`) is used as the selector so the
  // hidden `#field_decks2` variant (0x0 in a normal 1v1 duel — maybe used
  // for another mode) gets the same treatment for free if it's ever the
  // one actually shown.
  const FIELD_DECKS_SVG_URL = 'https://images.duelingbook.com/svg/field_decks.svg';

  // Fetched once, cached forever (the asset itself never changes mid-session).
  let baseSvgText = null;
  let baseSvgFetching = false;
  let baseDecksSvgText = null;
  let baseDecksSvgFetching = false;

  // CONFIRMED LIVE BUG (field_decks specifically — reported with screenshots
  // of the deck/extra-deck corner art rendering oversized and spilling into
  // the monster-zone row): neither field_zones.svg nor field_decks.svg
  // declares an explicit width/height on its <svg> root — only a viewBox
  // (confirmed by fetching and reading field_decks.svg directly: viewBox="0
  // 0 1024 640", no width/height attribute at all). Loaded via its real
  // network URL, Chrome correctly derives a 1024×640 natural size from that
  // viewBox — confirmed live (img.naturalWidth/Height = 1024/640 for the
  // untouched field_zones image). But re-encoded as a data: URI (which is
  // how this feature applies its recoloring — see buildAndApplyField*Svg
  // below), Chrome computes a DIFFERENT, much smaller natural size instead
  // (confirmed live: 240×150 for an identical, uncorrupted SVG loaded only
  // as a data: URI instead of over the network) — a real Chromium quirk in
  // how it sizes a viewBox-only SVG depending on load method, not something
  // introduced by the recoloring regex itself (byte-for-byte path/tag counts
  // confirmed identical before/after). Giving the SVG an explicit width/
  // height up front — matching its own viewBox, so nothing else about it
  // changes — makes natural-size computation identical regardless of how
  // it's loaded, which is what this does before any further modification.
  function ensureExplicitSvgDimensions(svgText) {
    const tagMatch = /<svg\b[^>]*>/.exec(svgText);
    if (!tagMatch) return svgText;
    const tag = tagMatch[0];
    if (/\swidth="/.test(tag) && /\sheight="/.test(tag)) return svgText; // already explicit — nothing to do
    const vb = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(tag);
    if (!vb) return svgText; // no viewBox to derive a size from — leave it alone rather than guess
    const sizedTag = tag.replace('<svg', '<svg width="' + vb[1] + '" height="' + vb[2] + '"');
    return svgText.slice(0, tagMatch.index) + sizedTag + svgText.slice(tagMatch.index + tag.length);
  }

  function setGradientStops(svgText, gradientId, color) {
    const re = new RegExp('(<linearGradient id="' + gradientId + '"[^>]*>)([\\s\\S]*?)(<\\/linearGradient>)');
    return svgText.replace(re, (m, open, body, close) => {
      const newBody = body.replace(/stop-color="[^"]*"/g, 'stop-color="' + color + '"');
      return open + newBody + close;
    });
  }

  function hidePendulumIcons(svgText) {
    let out = svgText;
    PENDULUM_USE_IDS.forEach((id) => {
      const re = new RegExp('(<use id="' + id + '"[^>]*)(\\/>)');
      out = out.replace(re, '$1 style="display:none"$2');
    });
    return out;
  }

  // Both row stroke paths' geometry sits in this SVG's own 1024x640
  // coordinate space, where the main 5x2 grid's columns run from x=288 to
  // x=751 on both rows — confirmed live against the real path data (see
  // the v2.3 header note). Anything outside that span belongs to a
  // Pendulum Zone's border, not the regular grid.
  const PENDULUM_ZONE_MAIN_GRID_X_MIN = 288;
  const PENDULUM_ZONE_MAIN_GRID_X_MAX = 751;

  // This asset's stroke paths only ever use M/m H/h V/v Q/q Z/z — enough
  // to hand-parse. Splits a path's `d` string into its individual rounded-
  // rect subpaths, tracking the running absolute cursor so each piece's
  // bounding box can be computed correctly even though most subpaths after
  // the first continue with a lowercase (relative) "m" rather than a fresh
  // absolute "M" — naively splitting on uppercase "M" alone misses most of
  // them and produces nonsense bounding boxes (confirmed live, the hard
  // way, before landing on this).
  function parsePathIntoAbsoluteSubpaths(d) {
    const tokens = [];
    const tokenRe = /([MmHhVvQqZz])|(-?\d*\.?\d+)/g;
    let tm;
    while ((tm = tokenRe.exec(d))) tokens.push(tm[1] || parseFloat(tm[2]));

    let i = 0, cx = 0, cy = 0, startx = 0, starty = 0;
    const subpaths = [];
    let cur = null;
    while (i < tokens.length) {
      const cmd = tokens[i++];
      if (cmd === 'M' || cmd === 'm') {
        const x = tokens[i++], y = tokens[i++];
        if (cmd === 'm' && cur !== null) { cx += x; cy += y; } else { cx = x; cy = y; }
        startx = cx; starty = cy;
        if (cur) subpaths.push(cur);
        cur = { d: 'M' + cx + ',' + cy, minX: cx, maxX: cx };
      } else if (cmd === 'H' || cmd === 'h') {
        const x = tokens[i++];
        cx = (cmd === 'h') ? cx + x : x;
        cur.d += 'H' + cx; cur.minX = Math.min(cur.minX, cx); cur.maxX = Math.max(cur.maxX, cx);
      } else if (cmd === 'V' || cmd === 'v') {
        const y = tokens[i++];
        cy = (cmd === 'v') ? cy + y : y;
        cur.d += 'V' + cy;
      } else if (cmd === 'Q' || cmd === 'q') {
        const x1 = tokens[i++], y1 = tokens[i++], x = tokens[i++], y = tokens[i++];
        if (cmd === 'q') { cur.d += 'Q' + (cx + x1) + ',' + (cy + y1) + ' ' + (cx + x) + ',' + (cy + y); cx += x; cy += y; }
        else { cur.d += 'Q' + x1 + ',' + y1 + ' ' + x + ',' + y; cx = x; cy = y; }
        cur.minX = Math.min(cur.minX, cx); cur.maxX = Math.max(cur.maxX, cx);
      } else if (cmd === 'Z' || cmd === 'z') {
        cur.d += 'Z';
        cx = startx; cy = starty;
      }
    }
    if (cur) subpaths.push(cur);
    return subpaths;
  }

  function stripPendulumZoneBoxes(svgText, pathId) {
    const re = new RegExp('(<path id="' + pathId + '"[^>]*\\sd=")([^"]*)("[^>]*/>)');
    return svgText.replace(re, (m, open, d, close) => {
      const subpaths = parsePathIntoAbsoluteSubpaths(d);
      const kept = subpaths.filter((sp) => sp.minX >= PENDULUM_ZONE_MAIN_GRID_X_MIN && sp.maxX <= PENDULUM_ZONE_MAIN_GRID_X_MAX);
      return open + kept.map((sp) => sp.d).join('') + close;
    });
  }

  // ── v2.4 — Deck/Extra/GY/Banished corner boxes nudged to actually hug the
  // card art ────────────────────────────────────────────────────────────────
  // User reported the colored corner boxes not lining up with the real
  // card-back art, then (after a live A/B check) that the gap wasn't new —
  // DuelingBook's own field_decks.svg / field_zones.svg artwork has simply
  // never been drawn in quite the right spot relative to the actual
  // #*_hidden pile elements, on every corner except the opponent's Deck.
  // Confirmed live with document.elementFromPoint() binary-searching the
  // real hit-test boundary of each pile (not just comparing bounding boxes,
  // which can be thrown off by a pile's own box being padded out to fit its
  // card-count badge): the opponent's Extra Deck box sits ~21-28 screen px
  // (≈16-21 SVG units at this duel's scale) above the real card; both of
  // *my* corners (Deck and Extra) sit ~30 screen px (≈22 SVG units) below
  // theirs; the opponent's Deck box was close (~7-10px) but that corner's
  // pile element is itself widened by its count badge in a way that likely
  // overstates how aligned it really is, so it gets the same correction as
  // its row-mate rather than being left alone. Graveyard/Banished (drawn in
  // field_zones.svg, not field_decks.svg — confirmed by fetching and reading
  // both files fresh, since the user separately flagged the Graveyard boxes
  // too) showed the same kind of gap, consistently ~46 SVG units, opponent's
  // side too high and mine too low.
  //
  // This only touches the <path> geometry of our OWN recolored copy — never
  // DuelingBook's original asset, and never applied at all when Custom
  // Colors is off (the "no override" branches below still restore
  // DuelingBook's own untouched src, gap and all, same as live play without
  // this extension).
  //
  // NOT a uniform "top row down, bottom row up" — confirmed live, the hard
  // way, after a first pass that assumed it was and made the opponent's
  // Deck corner (top row, x=207) visibly worse: that one specific corner's
  // native gap runs the OPPOSITE direction from its row-mate, the
  // opponent's Extra Deck (top row, x=769) — re-confirmed with the same
  // elementFromPoint boundary search after applying each candidate fix, not
  // just before. Every other corner's correction held up under that same
  // re-check (within ~2px) on the first try.
  const DECK_ZONE_TOP_ROW_Y = 7;
  const DECK_ZONE_BOTTOM_ROW_Y = 486;
  const DECK_ZONE_OPPONENT_X = 207;
  const DECK_ZONE_NUDGE = 22; // SVG units — opponent's Extra Deck (down) and both of mine (up)
  const DECK_ZONE_OPP_DECK_NUDGE = -7; // SVG units — opponent's Deck corner only, much smaller and the opposite direction from its row-mate
  const GY_BANISH_OPPONENT_X = 207; // field_zones.svg: opponent's GY + Banished boxes
  const GY_BANISH_MINE_X = 769; // field_zones.svg: my GY + Banished boxes
  const GY_BANISH_Y_MIN = 190; // bounds that catch only the GY/Banished boxes, not the
  const GY_BANISH_Y_MAX = 300; // main 5x2 grid cells or the Pendulum Zone pieces
  const GY_BANISH_NUDGE = 46; // SVG units: opponent's side shifts up, mine shifts down

  // Same M/m H/h V/v Q/q Z/z command set as parsePathIntoAbsoluteSubpaths
  // above, but keeping each absolute coordinate as its own number (not
  // baked into a string) so a subpath's points can actually be shifted,
  // not just measured and filtered.
  function parsePathIntoAbsoluteOps(d) {
    const tokens = [];
    const tokenRe = /([MmHhVvQqZz])|(-?\d*\.?\d+)/g;
    let tm;
    while ((tm = tokenRe.exec(d))) tokens.push(tm[1] || parseFloat(tm[2]));
    let i = 0, cx = 0, cy = 0, startx = 0, starty = 0;
    const subpaths = [];
    let cur = null;
    while (i < tokens.length) {
      const cmd = tokens[i++];
      if (cmd === 'M' || cmd === 'm') {
        const x = tokens[i++], y = tokens[i++];
        if (cmd === 'm' && cur !== null) { cx += x; cy += y; } else { cx = x; cy = y; }
        startx = cx; starty = cy;
        if (cur) subpaths.push(cur);
        cur = { ops: [{ c: 'M', x: cx, y: cy }], minX: cx, maxX: cx, minY: cy, maxY: cy };
      } else if (cmd === 'H' || cmd === 'h') {
        const x = tokens[i++];
        cx = (cmd === 'h') ? cx + x : x;
        cur.ops.push({ c: 'H', x: cx });
        cur.minX = Math.min(cur.minX, cx); cur.maxX = Math.max(cur.maxX, cx);
      } else if (cmd === 'V' || cmd === 'v') {
        const y = tokens[i++];
        cy = (cmd === 'v') ? cy + y : y;
        cur.ops.push({ c: 'V', y: cy });
        cur.minY = Math.min(cur.minY, cy); cur.maxY = Math.max(cur.maxY, cy);
      } else if (cmd === 'Q' || cmd === 'q') {
        const x1 = tokens[i++], y1 = tokens[i++], x = tokens[i++], y = tokens[i++];
        let ax1, ay1, ax, ay;
        if (cmd === 'q') { ax1 = cx + x1; ay1 = cy + y1; ax = cx + x; ay = cy + y; }
        else { ax1 = x1; ay1 = y1; ax = x; ay = y; }
        cur.ops.push({ c: 'Q', x1: ax1, y1: ay1, x: ax, y: ay });
        cx = ax; cy = ay;
        cur.minX = Math.min(cur.minX, cx); cur.maxX = Math.max(cur.maxX, cx);
        cur.minY = Math.min(cur.minY, cy); cur.maxY = Math.max(cur.maxY, cy);
      } else if (cmd === 'Z' || cmd === 'z') {
        cur.ops.push({ c: 'Z' });
        cx = startx; cy = starty;
      }
    }
    if (cur) subpaths.push(cur);
    return subpaths;
  }

  function serializeAbsoluteOps(ops) {
    return ops.map((op) => {
      if (op.c === 'M') return 'M' + op.x + ',' + op.y;
      if (op.c === 'H') return 'H' + op.x;
      if (op.c === 'V') return 'V' + op.y;
      if (op.c === 'Q') return 'Q' + op.x1 + ',' + op.y1 + ' ' + op.x + ',' + op.y;
      return 'Z';
    }).join('');
  }

  // Shifts whichever subpaths of the path matched by `re` satisfy
  // `deltaFn(minX, minY)` (returning the Y delta to apply, or 0 to leave a
  // subpath untouched) — every other subpath in the same path is re-emitted
  // byte-for-byte unchanged. Used for both field_decks.svg's single
  // Deck+Extra-Deck-per-side path and field_zones.svg's combined grid path,
  // where the cells that need nudging share a `<path>` with cells (the
  // monster/spell-trap grid, the Pendulum Zone pieces) that must NOT move.
  function nudgeBoxesInPath(svgText, re, deltaFn) {
    return svgText.replace(re, (m, open, d, close) => {
      const subpaths = parsePathIntoAbsoluteOps(d);
      subpaths.forEach((sp) => {
        const dy = deltaFn(sp.minX, sp.minY);
        if (!dy) return;
        sp.ops.forEach((op) => { if ('y' in op) op.y += dy; if ('y1' in op) op.y1 += dy; });
      });
      return open + subpaths.map((sp) => serializeAbsoluteOps(sp.ops)).join('') + close;
    });
  }

  function deckZoneNudgeDelta(minX, minY) {
    const isTopRow = Math.abs(minY - DECK_ZONE_TOP_ROW_Y) < 5;
    const isBottomRow = Math.abs(minY - DECK_ZONE_BOTTOM_ROW_Y) < 5;
    if (isTopRow && Math.abs(minX - DECK_ZONE_OPPONENT_X) < 5) return DECK_ZONE_OPP_DECK_NUDGE; // opponent's Deck corner only
    if (isTopRow) return DECK_ZONE_NUDGE;
    if (isBottomRow) return -DECK_ZONE_NUDGE;
    return 0;
  }

  function nudgeDeckZoneBoxes(svgText) {
    let out = svgText;
    out = nudgeBoxesInPath(out, /(<g id="field_decks_mc_0_Layer0_0_FILL"[^>]*><path\s+class="[^"]*"\sd=")([^"]*)("\/>)/, deckZoneNudgeDelta);
    out = nudgeBoxesInPath(out, /(<path id="field_decks_mc_0_Layer0_0_1_STROKES"[^>]*\sd=")([^"]*)("\/>)/, deckZoneNudgeDelta);
    out = nudgeBoxesInPath(out, /(<path id="field_decks_mc_0_Layer0_0_2_STROKES"[^>]*\sd=")([^"]*)("\/>)/, deckZoneNudgeDelta);
    return out;
  }

  function graveyardBanishedNudgeDelta(minX, minY) {
    if (minY <= GY_BANISH_Y_MIN || minY >= GY_BANISH_Y_MAX) return 0; // a grid/pendulum cell, not GY/Banished
    if (Math.abs(minX - GY_BANISH_OPPONENT_X) < 5) return -GY_BANISH_NUDGE;
    if (Math.abs(minX - GY_BANISH_MINE_X) < 5) return GY_BANISH_NUDGE;
    return 0;
  }

  function nudgeGraveyardBanishedBoxes(svgText) {
    let out = svgText;
    out = nudgeBoxesInPath(out, /(<g id="field_zones_mc_0_Layer10_0_FILL"[^>]*><path\s+class="[^"]*"\sd=")([^"]*)("\/>)/, graveyardBanishedNudgeDelta);
    out = nudgeBoxesInPath(out, /(<path id="field_zones_mc_0_Layer8_0_1_STROKES"[^>]*\sd=")([^"]*)("\/>)/, graveyardBanishedNudgeDelta);
    out = nudgeBoxesInPath(out, /(<path id="field_zones_mc_0_Layer8_0_2_STROKES"[^>]*\sd=")([^"]*)("\/>)/, graveyardBanishedNudgeDelta);
    return out;
  }

  function buildAndApplyFieldZonesSvg(s) {
    const img = document.getElementById('field_zones');
    if (!img) return; // not in a duel right now
    if (baseSvgFetching) return; // a fetch is already in flight; the next poll tick will pick it up once it lands
    if (!baseSvgText) {
      baseSvgFetching = true;
      fetch(FIELD_ZONES_SVG_URL).then((r) => r.text()).then((text) => {
        baseSvgText = ensureExplicitSvgDimensions(text);
        baseSvgFetching = false;
      }).catch(() => { baseSvgFetching = false; });
      return; // apply on the next tick, once the fetch above has landed
    }

    const enabled = !!s.dt_custom_colors_enabled;
    const hidePendulum = !!s.dt_hide_pendulum_zones_enabled;
    const mineColor = s.dt_cc_zoneGridMine_color;
    const oppColor = s.dt_cc_zoneGridOpponent_color;
    const noOverride = !(enabled && (mineColor || oppColor)) && !hidePendulum;

    // dataset marker — skip the rebuild/re-encode entirely when nothing
    // about the desired result has actually changed since last time AND
    // the image's actual current src still reflects that (not just what
    // we last asked for). Confirmed live this session: something can reset
    // img.src back to DuelingBook's own plain URL out of band (seen right
    // after an extension/page reload) without going through this function,
    // which used to leave the signature pointing at a result that no
    // longer matched reality — this function would then skip forever,
    // since from its point of view nothing had "changed". Checking the
    // actual src, not just the cached signature, makes it self-heal.
    const currentlyIsOverride = img.src.indexOf('data:') === 0;
    const signature = [enabled, hidePendulum, mineColor, oppColor].join('|');
    if (img.dataset.dtZonesSig === signature && currentlyIsOverride === !noOverride) return;
    img.dataset.dtZonesSig = signature;

    if (noOverride) {
      // Nothing to override — leave DuelingBook's own original src alone
      // (only touch it if it's currently showing our override).
      if (currentlyIsOverride) {
        img.src = FIELD_ZONES_SVG_URL;
        img.dataset.dtZonesModified = '0';
      }
      return;
    }

    let svg = baseSvgText;
    if (enabled && oppColor) svg = setGradientStops(svg, 'linear-gradient', oppColor);
    if (enabled && mineColor) svg = setGradientStops(svg, 'linear-gradient-2', mineColor);
    if (hidePendulum) {
      svg = hidePendulumIcons(svg);
      svg = stripPendulumZoneBoxes(svg, 'field_zones_mc_0_Layer8_0_1_STROKES');
      svg = stripPendulumZoneBoxes(svg, 'field_zones_mc_0_Layer8_0_2_STROKES');
    }
    svg = nudgeGraveyardBanishedBoxes(svg);

    try {
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      img.dataset.dtZonesModified = '1';
    } catch (e) {
      // Leave DuelingBook's own image showing rather than break it on an encode error.
    }
  }

  function buildAndApplyFieldDecksSvg(s) {
    const imgs = document.querySelectorAll('.field_decks');
    if (!imgs.length) return; // not in a duel right now
    if (baseDecksSvgFetching) return;
    if (!baseDecksSvgText) {
      baseDecksSvgFetching = true;
      fetch(FIELD_DECKS_SVG_URL).then((r) => r.text()).then((text) => {
        baseDecksSvgText = ensureExplicitSvgDimensions(text);
        baseDecksSvgFetching = false;
      }).catch(() => { baseDecksSvgFetching = false; });
      return; // apply on the next tick, once the fetch above has landed
    }

    const enabled = !!s.dt_custom_colors_enabled;
    const mineColor = s.dt_cc_deckZoneMine_color;
    const oppColor = s.dt_cc_deckZoneOpponent_color;
    const noOverride = !(enabled && (mineColor || oppColor));

    const signature = [enabled, mineColor, oppColor].join('|');

    let svg = null;
    if (!noOverride) {
      svg = baseDecksSvgText;
      if (enabled && oppColor) svg = setGradientStops(svg, 'linear-gradient', oppColor);
      if (enabled && mineColor) svg = setGradientStops(svg, 'linear-gradient-2', mineColor);
      svg = nudgeDeckZoneBoxes(svg);
    }

    imgs.forEach((img) => {
      // Capture each image's own real URL (field_decks.svg vs
      // field_decks2.svg) the first time it's seen, before we ever touch
      // it, so a reset restores the right one rather than assuming both
      // elements share field_decks.svg's URL.
      if (!img.dataset.dtDecksOriginalUrl) img.dataset.dtDecksOriginalUrl = img.src.indexOf('data:') === 0 ? FIELD_DECKS_SVG_URL : img.src;

      // Same self-healing check as the main zone grid above: don't trust
      // the cached signature alone — confirm the image's actual current
      // src still reflects it, in case something reset it out of band
      // (seen live right after an extension/page reload).
      const currentlyIsOverride = img.src.indexOf('data:') === 0;
      if (img.dataset.dtDecksSig === signature && currentlyIsOverride === !noOverride) return;
      img.dataset.dtDecksSig = signature;

      if (noOverride) {
        if (currentlyIsOverride) {
          img.src = img.dataset.dtDecksOriginalUrl;
          img.dataset.dtDecksModified = '0';
        }
        return;
      }

      try {
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
        img.dataset.dtDecksModified = '1';
      } catch (e) {
        // Leave DuelingBook's own image showing rather than break it on an encode error.
      }
    });
  }

  function readAndApply() {
    const keys = { dt_custom_colors_enabled: false, dt_hide_pendulum_zones_enabled: false };
    ROW_IDS.forEach((id) => {
      keys['dt_cc_' + id + '_color'] = ROW_DEFAULTS[id].color;
      keys['dt_cc_' + id + '_opacity'] = ROW_DEFAULTS[id].opacity;
    });

    chrome.storage.local.get(keys, (s) => {
      const enabled = !!s.dt_custom_colors_enabled;

      applySimple(['.phase.active .phase_inner.red', '.phase.active .phase_inner.blue'], enabled, s.dt_cc_phaseButtons_color, s.dt_cc_phaseButtons_opacity, document, 'backgroundColor');
      applySimple(['.lifepoints .life_border', '#lifepoints2 .life_border'], enabled, s.dt_cc_lifePointsBorder_color, s.dt_cc_lifePointsBorder_opacity, document, 'backgroundColor');
      applySimple(['.lifepoints .life_bar', '#lifepoints2 .life_bar'], enabled, s.dt_cc_lifePointsBar_color, s.dt_cc_lifePointsBar_opacity, document, 'backgroundColor');

      document.querySelectorAll('.duel_avatar').forEach((el) => {
        if (!enabled || !s.dt_cc_avatarBorder_color) { el.style.boxShadow = ''; return; }
        el.style.boxShadow = 'inset 0 0 0 3px ' + rgba(s.dt_cc_avatarBorder_color, s.dt_cc_avatarBorder_opacity);
      });

      // Token picker modal — same #token_select used from both the Deck
      // Constructor's Token button and a live duel's Token button
      // (click-and-hold). Only present in the DOM while the modal is open;
      // harmless no-op otherwise. See this file's own header for the "not
      // fully re-confirmed after the connection dropped mid-check" note.
      applySimple(['#token_select .background_inner > .background'], enabled, s.dt_cc_tokenMenuBg_color, s.dt_cc_tokenMenuBg_opacity, document, 'backgroundColor');

      buildAndApplyFieldZonesSvg(s);
      buildAndApplyFieldDecksSvg(s);
    });
  }

  readAndApply();
  setInterval(readAndApply, 1500);

  let mutationDebounce = null;
  function onMutation() {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => { mutationDebounce = null; readAndApply(); }, 80);
  }
  function observe() {
    const frames = document.getElementById('frames');
    if (!frames) { setTimeout(observe, 1000); return; }
    new MutationObserver(onMutation).observe(frames, { childList: true, subtree: true });
  }
  observe();

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const relevant = Object.keys(changes).some((k) => k === 'dt_custom_colors_enabled' || k === 'dt_hide_pendulum_zones_enabled' || ROW_IDS.some((id) => k === 'dt_cc_' + id + '_color' || k === 'dt_cc_' + id + '_opacity'));
      if (relevant) readAndApply();
    });
  }

  console.log('[Duel Tools] Custom Colors: Duel Interface ready');
})();
