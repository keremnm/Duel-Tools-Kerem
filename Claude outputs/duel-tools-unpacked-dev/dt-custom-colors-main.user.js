// ==UserScript==
// @name         Duel Tools — Custom Colors: Main Menu
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Recolors DuelingBook's own pre-"DUEL!" splash screen and post-"DUEL!" Main Menu — nav buttons, links, the status feed, and the Official Tourneys/Streams/Discord side panels — per Settings → Appearance Customization → Add Custom Images/Themes/Colors/Emotes → Custom Colors → the 4 "Main Menu — ..." sections.
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Confirmed live this pass (session investigating the Main Menu DOM):
//   - The pre-"DUEL!" splash screen is #front_page (NOT #start, which is
//     an unrelated/empty frame — an earlier assumption in this project
//     was wrong). It holds the logo, #welcome_buttons (Welcome/Forum/
//     Rules/Blog/Skip Intro — plain <span> ids, no wrapping <a>),
//     #bulletin_txt (the white news box), and #login_box (the gray
//     "Logged in as" box, whose real fill is a `.background` sibling div,
//     rgb(212,212,212) — same fill/overlay convention used everywhere
//     else in this extension).
//   - Clicking DUEL! reveals #main_menu: a heading (.arial_black2.title1),
//     a left nav of .menu_btn divs (each one a transparent button whose
//     visible cyan/gold/red border+outline lives on a DIRECT CHILD
//     `.content` div — `.menu_btn .content` has `border: 4px solid
//     <accent>` as a plain, non-!important CSS rule, so a plain inline
//     style override beats it for free, same technique as every other
//     native-widget-accent row in this extension), a 3-page carousel
//     (#main_menu_circles .main_menu_circle .background are the 3 dots),
//     and a center/right pairing that swaps with the dots: status feed +
//     Official Tourneys (#tourney_sidebar) on dot 1, a video grid +
//     Streams (#streams) on dot 2, and a real (non-iframe — confirmed
//     live, it's plain DOM built from the Discord widget API, not an
//     embedded frame) Discord member list (#widget) on dot 3.
//   - Status feed: #statuses_content holds repeated .status blocks, each
//     with .username_txt (poster name), .date_txt (timestamp), .like_btn/
//     .dislike_btn + .likes/.dislikes (counts), .status_txt (body), and
//     .reply_btn. ".username_txt" is ALSO reused, unscoped, inside
//     #login_box for your own name — every selector below that targets
//     one is scoped to its own container so the two settings don't
//     collide.
//   - "All Statuses" (#status_cb) and the Post Status modal's Post button
//     (.post_btn) are both PLAIN NATIVE form controls here (a real
//     <select> with its own white background, a real <input
//     type="button">) — unlike the Duel Room's glossy DB-drawn dropdowns/
//     buttons, there's no separate `.combobox_background`/`.button.proxy`
//     overlay to work around; a plain inline backgroundColor on the
//     control itself is the whole story.
(function () {
  'use strict';

  // ── Front Page (mainInterface section) ──────────────────────────────
  const FRONT_PAGE_OVERLAY_ID = 'dt-cc-main-frontpage-overlay';

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

  // One full-viewport overlay, inserted once as the first child of
  // #frames (the shared container for #front_page/#main_menu/etc. —
  // confirmed live, see dt-custom-colors-rooms.user.js's sibling
  // investigation of this same element for precedent). Being the FIRST
  // child means every real panel — which DuelingBook stacks after it in
  // the same container — paints on top in normal document order, so this
  // sits behind the actual UI and only tints DuelingBook's own animated
  // circuit-pattern background. pointer-events:none keeps it from
  // blocking clicks on anything above it.
  function ensureFrontPageOverlay() {
    let el = document.getElementById(FRONT_PAGE_OVERLAY_ID);
    if (el) return el;
    const frames = document.getElementById('frames');
    if (!frames) return null;
    el = document.createElement('div');
    el.id = FRONT_PAGE_OVERLAY_ID;
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '0';
    frames.insertBefore(el, frames.firstChild);
    return el;
  }
  function applyFrontPageBg(enabled, color, opacityPct, imageDataUrl) {
    const el = ensureFrontPageOverlay();
    if (!el) return;
    if (!enabled) {
      el.style.background = 'none';
      return;
    }
    const { r, g, b } = hexToRgb(color);
    const alpha = Math.max(0, Math.min(100, opacityPct)) / 100;
    if (imageDataUrl) {
      el.style.background =
        'linear-gradient(rgba(' + r + ',' + g + ',' + b + ',' + alpha + '), rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')), ' +
        'center / cover no-repeat url("' + imageDataUrl + '")';
    } else {
      el.style.background = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
  }

  // `prop` defaults to 'color' — pass 'backgroundColor'/'borderColor' for
  // the fill/accent rows. Same helper shape as
  // dt-custom-colors-rooms.user.js's applySimpleTextColor, duplicated here
  // (not imported — every Custom Colors content script in this extension
  // is a standalone, independently-crash-isolated file by design).
  function applySimple(selectors, enabled, color, opacityPct, scopeEl, prop) {
    const root = scopeEl || document;
    const cssProp = prop || 'color';
    selectors.forEach((sel) => {
      root.querySelectorAll(sel).forEach((el) => {
        el.style[cssProp] = enabled && color ? rgba(color, opacityPct) : '';
      });
    });
  }

  const SIMPLE_ROW_DEFAULTS = {
    // mainInterface — Front Page
    welcomeBulletinBg: { color: '#ffffff', opacity: 100 },
    welcomeBulletinText: { color: '#000000', opacity: 100 },
    loggedInBoxBg: { color: '#d4d4d4', opacity: 100 },
    loggedInText: { color: '#ffffff', opacity: 100 },
    mainMenuHeading: { color: '#ffffff', opacity: 100 },
    // navAccents — Nav Buttons
    navButtonBorder: { color: '#00ffff', opacity: 100 },
    navButtonFill: { color: '#00ffff', opacity: 12 },
    navButtonText: { color: '#ffffff', opacity: 100 },
    welcomeLink: { color: '#ffaadd', opacity: 100 },
    forumLink: { color: '#66ccff', opacity: 100 },
    rulesLink: { color: '#90fc98', opacity: 100 },
    blogLink: { color: '#ff9933', opacity: 100 },
    skipIntroText: { color: '#ffffff', opacity: 100 },
    privacyPolicyLink: { color: '#0077ff', opacity: 100 },
    // mainMenuFeed — Status Feed
    statusUsernameText: { color: '#ffffcc', opacity: 100 },
    statusDateText: { color: '#ffffff', opacity: 100 },
    statusBodyText: { color: '#ffffff', opacity: 100 },
    statusReplyText: { color: '#0077ff', opacity: 100 },
    statusLikeDislikeText: { color: '#ffffff', opacity: 100 },
    statusDropdownWidget: { color: '#0099ff', opacity: 75 },
    postStatusWidget: { color: '#36cc00', opacity: 75 },
    postStatusLink: { color: '#0077ff', opacity: 100 },
    // mainMenuPanels — Side Panels
    carouselDots: { color: '#ffffff', opacity: 80 },
    tourneyHeadingText: { color: '#ffffff', opacity: 100 },
    tourneyBodyText: { color: '#ffffff', opacity: 100 },
    tourneyLinkText: { color: '#0077ff', opacity: 100 },
    streamsHeadingText: { color: '#ffffff', opacity: 100 },
    videoLinkText: { color: '#0077ff', opacity: 100 },
    discordPanelText: { color: '#ffffff', opacity: 100 }
  };
  const SIMPLE_ROW_IDS = Object.keys(SIMPLE_ROW_DEFAULTS);
  const FRONT_PAGE_BG_DEFAULT = { color: '#000000', opacity: 25 };

  // "Privacy Policy" has no id/class of its own (confirmed live) — the
  // only <a> under #front_page's content wrapper with this exact text,
  // so matching on textContent is the reliable selector here.
  function applyPrivacyLink(enabled, color, opacityPct) {
    const links = Array.from(document.querySelectorAll('a')).filter((el) => el.textContent.trim() === 'Privacy Policy');
    links.forEach((el) => { el.style.color = enabled && color ? rgba(color, opacityPct) : ''; });
  }

  function readAndApply() {
    const keys = { dt_custom_colors_enabled: false };
    keys.dt_cc_frontPageBg_color = FRONT_PAGE_BG_DEFAULT.color;
    keys.dt_cc_frontPageBg_opacity = FRONT_PAGE_BG_DEFAULT.opacity;
    keys.dt_cc_frontPageBg_image = null;
    SIMPLE_ROW_IDS.forEach((id) => {
      keys['dt_cc_' + id + '_color'] = SIMPLE_ROW_DEFAULTS[id].color;
      keys['dt_cc_' + id + '_opacity'] = SIMPLE_ROW_DEFAULTS[id].opacity;
    });

    chrome.storage.local.get(keys, (s) => {
      const enabled = !!s.dt_custom_colors_enabled;

      // Front Page
      applyFrontPageBg(enabled, s.dt_cc_frontPageBg_color, s.dt_cc_frontPageBg_opacity, s.dt_cc_frontPageBg_image);
      applySimple(['#bulletin_txt'], enabled, s.dt_cc_welcomeBulletinBg_color, s.dt_cc_welcomeBulletinBg_opacity, document, 'backgroundColor');
      applySimple(['#bulletin_txt', '#bulletin_txt *'], enabled, s.dt_cc_welcomeBulletinText_color, s.dt_cc_welcomeBulletinText_opacity, document, 'color');
      const loginBox = document.getElementById('login_box');
      if (loginBox) {
        applySimple(['.background'], enabled, s.dt_cc_loggedInBoxBg_color, s.dt_cc_loggedInBoxBg_opacity, loginBox, 'backgroundColor');
        applySimple(['#logged_in_as_lbl', '.username_txt'], enabled, s.dt_cc_loggedInText_color, s.dt_cc_loggedInText_opacity, loginBox, 'color');
      }
      applySimple(['.arial_black2.title1'], enabled, s.dt_cc_mainMenuHeading_color, s.dt_cc_mainMenuHeading_opacity, document, 'color');

      // Nav Buttons
      applySimple(['.menu_btn .content'], enabled, s.dt_cc_navButtonBorder_color, s.dt_cc_navButtonBorder_opacity, document, 'borderColor');
      applySimple(['.menu_btn .content'], enabled, s.dt_cc_navButtonFill_color, s.dt_cc_navButtonFill_opacity, document, 'backgroundColor');
      applySimple(['.menu_btn > span'], enabled, s.dt_cc_navButtonText_color, s.dt_cc_navButtonText_opacity, document, 'color');
      applySimple(['#welcome_btn'], enabled, s.dt_cc_welcomeLink_color, s.dt_cc_welcomeLink_opacity, document, 'color');
      applySimple(['#forum_btn'], enabled, s.dt_cc_forumLink_color, s.dt_cc_forumLink_opacity, document, 'color');
      applySimple(['#rules_btn'], enabled, s.dt_cc_rulesLink_color, s.dt_cc_rulesLink_opacity, document, 'color');
      applySimple(['#blog_btn'], enabled, s.dt_cc_blogLink_color, s.dt_cc_blogLink_opacity, document, 'color');
      applySimple(['#skip_intro_btn'], enabled, s.dt_cc_skipIntroText_color, s.dt_cc_skipIntroText_opacity, document, 'color');
      applyPrivacyLink(enabled, s.dt_cc_privacyPolicyLink_color, s.dt_cc_privacyPolicyLink_opacity);

      // Status Feed
      const statusesContent = document.getElementById('statuses_content');
      if (statusesContent) {
        applySimple(['.username_txt'], enabled, s.dt_cc_statusUsernameText_color, s.dt_cc_statusUsernameText_opacity, statusesContent, 'color');
        applySimple(['.date_txt'], enabled, s.dt_cc_statusDateText_color, s.dt_cc_statusDateText_opacity, statusesContent, 'color');
        applySimple(['.status_txt'], enabled, s.dt_cc_statusBodyText_color, s.dt_cc_statusBodyText_opacity, statusesContent, 'color');
        applySimple(['.reply_btn'], enabled, s.dt_cc_statusReplyText_color, s.dt_cc_statusReplyText_opacity, statusesContent, 'color');
        applySimple(['.likes', '.dislikes'], enabled, s.dt_cc_statusLikeDislikeText_color, s.dt_cc_statusLikeDislikeText_opacity, statusesContent, 'color');
      }
      const statusCb = document.getElementById('status_cb');
      if (statusCb) statusCb.style.backgroundColor = enabled && s.dt_cc_statusDropdownWidget_color ? rgba(s.dt_cc_statusDropdownWidget_color, s.dt_cc_statusDropdownWidget_opacity) : '';
      applySimple(['.post_btn'], enabled, s.dt_cc_postStatusWidget_color, s.dt_cc_postStatusWidget_opacity, document, 'backgroundColor');
      applySimple(['#post_status_btn'], enabled, s.dt_cc_postStatusLink_color, s.dt_cc_postStatusLink_opacity, document, 'color');

      // Side Panels
      applySimple(['.main_menu_circle .background'], enabled, s.dt_cc_carouselDots_color, s.dt_cc_carouselDots_opacity, document, 'backgroundColor');
      const tourneySidebar = document.getElementById('tourney_sidebar');
      if (tourneySidebar) {
        // Body text: every div/span in the sidebar except the heading
        // itself — applied first so the heading/link rows below always
        // win on their own more-specific elements.
        applySimple(['div:not(.subtitle_txt)', 'span:not(.subtitle_txt)'], enabled, s.dt_cc_tourneyBodyText_color, s.dt_cc_tourneyBodyText_opacity, tourneySidebar, 'color');
        applySimple(['.subtitle_txt'], enabled, s.dt_cc_tourneyHeadingText_color, s.dt_cc_tourneyHeadingText_opacity, tourneySidebar, 'color');
        applySimple(['a'], enabled, s.dt_cc_tourneyLinkText_color, s.dt_cc_tourneyLinkText_opacity, tourneySidebar, 'color');
      }
      const streamsPanel = document.getElementById('streams');
      if (streamsPanel) applySimple(['.subtitle_txt'], enabled, s.dt_cc_streamsHeadingText_color, s.dt_cc_streamsHeadingText_opacity, streamsPanel, 'color');
      applySimple(['.video .title_txt a'], enabled, s.dt_cc_videoLinkText_color, s.dt_cc_videoLinkText_opacity, document, 'color');
      const discordWidget = document.getElementById('widget');
      if (discordWidget) applySimple(['div', 'span'], enabled, s.dt_cc_discordPanelText_color, s.dt_cc_discordPanelText_opacity, discordWidget, 'color');
    });
  }

  readAndApply();
  // Same convention as every other Custom Colors content script in this
  // extension: poll (cheap, robust against a full lobby/menu rebuild) plus
  // a debounced MutationObserver for near-instant re-apply when the status
  // feed/video grid/panels re-render their content (new post, page switch,
  // carousel dot change, etc.).
  setInterval(readAndApply, 1500);

  let mutationDebounce = null;
  function onMenuMutation() {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => { mutationDebounce = null; readAndApply(); }, 80);
  }
  function observeMenu() {
    const frames = document.getElementById('frames');
    if (!frames) { setTimeout(observeMenu, 1000); return; }
    new MutationObserver(onMenuMutation).observe(frames, { childList: true, subtree: true });
  }
  observeMenu();

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const relevant = Object.keys(changes).some((k) => k === 'dt_custom_colors_enabled' || k.indexOf('dt_cc_') === 0);
      if (relevant) readAndApply();
    });
  }

  console.log('[Duel Tools] Custom Colors: Main Menu ready');
})();
