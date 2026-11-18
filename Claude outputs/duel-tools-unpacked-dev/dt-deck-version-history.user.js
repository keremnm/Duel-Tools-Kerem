// ==UserScript==
// @name         Duel Tools — Deck Version History
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  While enabled, backs up every YDK saved via DuelingBook's own Save Deck / Save Deck As in the deck constructor — permanently, even after it's deleted or overwritten on DuelingBook's side. Restore/Delete Forever happen from the Settings page.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Per spec: "if a deck is saved while this setting is enabled, it stays in
// the extension's Deck Version bank. If that deck is deleted [on
// DuelingBook], you can go to Settings under this feature and find the
// saved file backup and restore it or permanently delete it forever."
// This is a running HISTORY — every save appends a new backup, it never
// overwrites a previous one for the same deck name.
//
// CONFIRMED LIVE (deck constructor, 2026-11-16) real selectors, found by
// inspecting the actual DOM rather than guessing (same discipline as every
// other feature in this project):
//   #save_btn      <input type="submit" value="Save Deck">   — saves under
//                  whatever name is already selected in #decklist_cb, no
//                  dialog, so the name/content are both already final the
//                  moment it's clicked.
//   #save_as_btn   <input type="submit" value="Save Deck As"> — opens a
//                  real dialog (a text input pre-filled with the current
//                  name + OK/Cancel) asking for a name. The OK/Cancel
//                  controls in that dialog are NOT plain queryable DOM
//                  (confirmed: a direct querySelector scan for them came up
//                  empty while the dialog was visibly open) — rather than
//                  fight that, this just watches #decklist_cb itself for
//                  the save actually landing (see pollForSaveAsCompletion
//                  below), the same "poll for the real effect instead of
//                  the exact UI mechanics" idiom already used elsewhere in
//                  this project (Replay Hand View, Live Tracker's
//                  checkbox-drift correction).
//   #decklist_cb   <select> of every deck name you have saved — its
//                  currently selected <option> is the deck currently
//                  loaded/being worked on.
//   #upload_ydk_btn <input type="file" accept=".ydk,...">    — same real
//                  "Import Deck" file input dt-deck-folders.user.js already
//                  uses to load a YDK back in; Restore reuses that exact
//                  mechanism.
//
// Reads/writes chrome.storage.local DIRECTLY, not through the GM_* shim —
// same reasoning as dt-replay-hand-view.user.js: the shim's GM_getValue
// only ever reads a ONE-TIME snapshot cached at this tab's injection, but
// this script both READS and WRITES a growing array (the bank) that the
// Settings page (a different context) also mutates (Delete Forever,
// Restore). Going straight to chrome.storage.local for every read keeps
// this script from ever reading its own stale cached copy of the bank and
// clobbering a deletion that happened meanwhile in Settings.
(function () {
  'use strict';

  const BANK_KEY = 'dt_deck_version_bank';
  const ENABLED_KEY = 'dt_deck_version_history_enabled';
  const RESTORE_PENDING_KEY = 'dt_deck_version_restore_pending';
  const BANK_CAP = 500; // generous — oldest dropped first once hit, see appendBackup()
  const RESTORE_STALE_MS = 5 * 60 * 1000; // ignore a Restore click from Settings older than this

  function isEnabled(cb) {
    chrome.storage.local.get({ [ENABLED_KEY]: false }, (s) => cb(!!s[ENABLED_KEY]));
  }

  // ── Reading the current deck off the real board ─────────────────────────
  // Identical approach to dt-deck-folders.user.js's buildYdkFromCurrentDeck
  // — reads the board directly (.deck_bg/.extra_bg/.side_bg → [class*=
  // "_cards"] → .cardfront_content .passcode_txt) rather than DuelingBook's
  // own internal arrays, so it reflects exactly what's on screen right now.
  function collectPasscodes(bgSelector) {
    const bg = document.querySelector(bgSelector);
    if (!bg) return [];
    const cardsDiv = bg.querySelector('[class*="_cards"]');
    if (!cardsDiv) return [];
    return Array.from(cardsDiv.querySelectorAll('.cardfront_content .passcode_txt'))
      .map((p) => (p.textContent || '').trim())
      .filter(Boolean);
  }
  function buildYdkFromCurrentDeck() {
    const main = collectPasscodes('.deck_bg');
    const extra = collectPasscodes('.extra_bg');
    const side = collectPasscodes('.side_bg');
    return '#created by Duel Tools\n#main\n' + main.join('\n') +
      (main.length ? '\n' : '') + '#extra\n' + extra.join('\n') +
      (extra.length ? '\n' : '') + '!side\n' + side.join('\n') + (side.length ? '\n' : '');
  }

  function currentDeckName() {
    const sel = document.getElementById('decklist_cb');
    if (!sel || sel.selectedIndex < 0) return '';
    const opt = sel.options[sel.selectedIndex];
    return opt ? opt.textContent.trim() : '';
  }
  function decklistSignature() {
    const sel = document.getElementById('decklist_cb');
    if (!sel) return null;
    return sel.options.length + '|' + currentDeckName();
  }

  function isOnDeckConstructor() {
    const el = document.getElementById('decklist_cb');
    return !!(el && el.offsetParent !== null);
  }

  function uid() {
    return 'dvh_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // Fresh read-modify-write every time (see header comment for why this
  // skips the GM_* shim's cache) — appends, never overwrites, oldest
  // dropped once BANK_CAP is hit.
  function appendBackup(entry, done) {
    chrome.storage.local.get({ [BANK_KEY]: [] }, (s) => {
      const bank = s[BANK_KEY] || [];
      bank.push(entry);
      while (bank.length > BANK_CAP) bank.shift();
      chrome.storage.local.set({ [BANK_KEY]: bank }, () => { if (done) done(); });
    });
  }

  function showToast(text) {
    let toast = document.getElementById('dt-dvh-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'dt-dvh-toast';
      toast.style.cssText = [
        'position:fixed', 'right:10px', 'bottom:10px', 'z-index:2147483000',
        'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
        'font-family:monospace', 'font-size:11px', 'padding:8px 12px',
        'box-shadow:0 6px 24px rgba(0,0,0,.5)', 'transition:opacity .25s', 'opacity:0'
      ].join(';');
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toast._dtTimer);
    toast._dtTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3200);
  }

  // ── Capturing a backup on Save Deck ──────────────────────────────────────
  // No dialog involved — name and board content are both already final the
  // instant this is clicked, so capture immediately. Listener is capture-
  // phase but never calls preventDefault/stopPropagation — purely observes,
  // never interferes with DuelingBook's own real save.
  document.addEventListener('click', function (e) {
    const el = e.target.closest && e.target.closest('#save_btn');
    if (!el) return;
    isEnabled((on) => {
      if (!on) return;
      const deckName = currentDeckName();
      if (!deckName) return;
      appendBackup({ id: uid(), deckName, ydk: buildYdkFromCurrentDeck(), savedAt: Date.now(), source: 'save' }, () => {
        showToast('Duel Tools: backed up "' + deckName + '"');
      });
    });
  }, true);

  // ── Capturing a backup on Save Deck As ───────────────────────────────────
  // The name isn't known yet at click time (the dialog hasn't been filled
  // in), and the user might Cancel instead of confirming — so this captures
  // the board content now (it can't change while a modal dialog is up) and
  // then polls #decklist_cb for the save actually landing: either a brand
  // new option appears (new name) or the existing selection/option-count
  // otherwise changes (overwrite of a different existing name). If nothing
  // changes within the timeout, this assumes Cancel was clicked and writes
  // nothing — never records a phantom backup for a save that didn't happen.
  document.addEventListener('click', function (e) {
    const el = e.target.closest && e.target.closest('#save_as_btn');
    if (!el) return;
    isEnabled((on) => {
      if (!on) return;
      const ydk = buildYdkFromCurrentDeck();
      const before = decklistSignature();
      let tries = 0;
      const MAX_TRIES = 100; // ~30s at 300ms — plenty of time to type a name and click OK
      const timer = setInterval(() => {
        tries++;
        const now = decklistSignature();
        if (now !== null && now !== before) {
          clearInterval(timer);
          const deckName = currentDeckName();
          if (!deckName) return;
          appendBackup({ id: uid(), deckName, ydk, savedAt: Date.now(), source: 'save_as' }, () => {
            showToast('Duel Tools: backed up "' + deckName + '"');
          });
          return;
        }
        if (tries >= MAX_TRIES) clearInterval(timer); // assume Cancel — write nothing
      }, 300);
    });
  }, true);

  // ── Restore (triggered from the Settings page) ───────────────────────────
  // Settings writes dt_deck_version_restore_pending directly to
  // chrome.storage.local (see dt-settings.js's renderDvhBankList) rather
  // than through the staged pendingChanges model, since this is an action
  // to perform, not a preference. This tab picks it up either via
  // chrome.storage.onChanged (if already open on the constructor) or by
  // polling once at startup (in case Restore was clicked before this tab
  // ever got here) — same "poll until the right page is showing" idiom as
  // dt-deck-folders.user.js's buildPanel(). A request older than
  // RESTORE_STALE_MS is dropped rather than silently applied long after
  // the user forgot they clicked it.
  // Shared by both restore paths (Settings' queued restore, and the live
  // "this deck was deleted but we backed it up" popup below) — reuses the
  // exact real #upload_ydk_btn file-input trick dt-deck-folders.user.js
  // already proved works, so this is DuelingBook's own real YDK import
  // path, not a reimplementation of it.
  function restoreYdkIntoConstructor(ydk, deckName) {
    const input = document.getElementById('upload_ydk_btn');
    if (!input) return false;
    try {
      const file = new File([ydk], (deckName || 'deck') + '.ydk', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      console.warn('[Duel Tools] Deck Version History: restore failed:', e);
      return false;
    }
  }

  function applyPendingRestore() {
    chrome.storage.local.get({ [RESTORE_PENDING_KEY]: null }, (s) => {
      const pending = s[RESTORE_PENDING_KEY];
      if (!pending) return;
      if (Date.now() - (pending.requestedAt || 0) > RESTORE_STALE_MS) {
        chrome.storage.local.remove(RESTORE_PENDING_KEY);
        return;
      }
      if (!isOnDeckConstructor()) return; // wait for the right page
      if (!document.getElementById('upload_ydk_btn')) return;
      if (restoreYdkIntoConstructor(pending.ydk, pending.deckName)) {
        showToast('Duel Tools: restored "' + pending.deckName + '" — Save Deck to keep it.');
      }
      chrome.storage.local.remove(RESTORE_PENDING_KEY);
    });
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes[RESTORE_PENDING_KEY] && changes[RESTORE_PENDING_KEY].newValue) {
        applyPendingRestore();
      }
    });
  }

  // ── Live recovery popup when a backed-up deck gets deleted ───────────────
  // Per the user's own spec: "when the deck is deleted and it was saved to
  // the database a UI here should pop up with that deck's name, ydk file
  // and a Restore or Delete option with it worded that this was saved to
  // your database to protect against lost decklists." This does NOT
  // interfere with DuelingBook's own Delete Deck flow (capture-phase,
  // passive, never preventDefault) — it only watches for the deletion
  // actually landing before deciding whether to show anything.
  //
  // DuelingBook's Delete Deck almost certainly shows its own "are you
  // sure?" confirm first (same dialog shape as Save Deck As's naming
  // dialog, confirmed earlier not to be plain queryable DOM) — rather than
  // try to detect/skip that dialog, this captures the deck's identity at
  // click time, then polls #decklist_cb the same way the Save As handler
  // above does, but watching for that name to DISAPPEAR from the options
  // list. If the user cancels DuelingBook's own confirm, nothing changes
  // and this times out doing nothing — exactly like Save As's own Cancel
  // case.
  document.addEventListener('click', function (e) {
    const el = e.target.closest && e.target.closest('#delete_btn');
    if (!el) return;
    const deckName = currentDeckName();
    if (!deckName) return;
    const sel = document.getElementById('decklist_cb');
    const beforeCount = sel ? sel.options.length : -1;
    let tries = 0;
    const MAX_TRIES = 100; // ~30s, matching the Save As confirm-detection window
    const timer = setInterval(() => {
      tries++;
      const stillThere = sel && Array.from(sel.options).some((o) => o.textContent.trim() === deckName);
      const countDropped = sel && sel.options.length < beforeCount;
      if (!stillThere && countDropped) {
        clearInterval(timer);
        maybeShowRecoveryPopup(deckName);
        return;
      }
      if (tries >= MAX_TRIES) clearInterval(timer); // assume Cancel — do nothing
    }, 300);
  }, true);

  function maybeShowRecoveryPopup(deckName) {
    // Stay quiet during an Organize Decklists-driven mass delete — that was
    // already a deliberate, informed choice made right in that tool's own
    // UI (which shows the same "Saved In Deck Version Library" status
    // before you ever click Delete), so popping this up once per deck in
    // a 20-deck batch would just be noise on top of a decision already
    // made. See dt-organize-decklists.user.js's runBatch().
    if (window.__dtOrganizeBatchDeleting) return;
    chrome.storage.local.get({ [BANK_KEY]: [] }, (s) => {
      const matches = (s[BANK_KEY] || []).filter((x) => x.deckName === deckName).sort((a, b) => b.savedAt - a.savedAt);
      if (!matches.length) return; // nothing backed up for this name — nothing to offer
      showRecoveryPopup(deckName, matches);
    });
  }

  function showRecoveryPopup(deckName, matches) {
    const latest = matches[0];
    const existing = document.getElementById('dt-dvh-recovery');
    if (existing) existing.remove();

    const box = document.createElement('div');
    box.id = 'dt-dvh-recovery';
    // Same fixed-corner system as every other Duel Tools panel — bottom-
    // right is free on the deck constructor (Save Prompt only ever shows
    // on a live duel/replay page, never here). Pinned tight to the actual
    // corner (4px, matching Deck Folders' own corner-pinning on this same
    // page) per the user's explicit correction — a bigger offset (the
    // 16/20px Save Prompt uses elsewhere) read as floating in the empty
    // black margin rather than snapped into the corner.
    box.style.cssText = [
      'position:fixed', 'right:4px', 'bottom:4px', 'z-index:2147483647',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:12px', 'width:230px', 'padding:14px',
      'box-sizing:border-box', 'box-shadow:0 6px 24px rgba(0,0,0,.5)'
    ].join(';');

    const extraNote = matches.length > 1
      ? '<div style="color:#888;font-size:10.5px;margin-top:6px">' + (matches.length - 1) + ' earlier version(s) also saved — manage them in Settings → Deck Version History.</div>'
      : '';

    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">' +
        '<span style="font-weight:bold">🛟 Deck deleted</span>' +
        '<span id="dt-dvh-rec-close" style="cursor:pointer;color:#888">✕</span>' +
      '</div>' +
      '<div style="margin-bottom:8px">"' + escHtmlDvh(deckName) + '" was saved to your Duel Tools database to protect against lost decklists.</div>' +
      '<div style="color:#888;font-size:10.5px;margin-bottom:10px">Last backed up ' + new Date(latest.savedAt).toLocaleString() + '</div>' +
      extraNote +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button id="dt-dvh-rec-restore" style="flex:1;background:#00e596;color:#050508;border:none;border-radius:5px;padding:7px;font-weight:bold;cursor:pointer;font-family:monospace">Restore</button>' +
        '<button id="dt-dvh-rec-delete" style="flex:1;background:transparent;color:#ff5555;border:1px solid #ff5555;border-radius:5px;padding:7px;cursor:pointer;font-family:monospace">Delete Forever</button>' +
      '</div>';

    document.body.appendChild(box);

    box.querySelector('#dt-dvh-rec-close').onclick = () => box.remove();
    box.querySelector('#dt-dvh-rec-restore').onclick = () => {
      if (restoreYdkIntoConstructor(latest.ydk, latest.deckName)) {
        showToast('Duel Tools: restored "' + deckName + '" — Save Deck to keep it.');
      }
      box.remove();
    };
    box.querySelector('#dt-dvh-rec-delete').onclick = () => {
      if (!window.confirm('Permanently delete all ' + matches.length + ' saved backup(s) of "' + deckName + '"? This cannot be undone.')) return;
      const ids = new Set(matches.map((m) => m.id));
      chrome.storage.local.get({ [BANK_KEY]: [] }, (s2) => {
        const next = (s2[BANK_KEY] || []).filter((x) => !ids.has(x.id));
        chrome.storage.local.set({ [BANK_KEY]: next }, () => {
          showToast('Duel Tools: backups for "' + deckName + '" deleted forever');
        });
      });
      box.remove();
    };
  }

  function escHtmlDvh(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  // Catch a restore that was queued before this tab/page was on the
  // constructor yet — same retry-until-ready shape as buildPanel() in
  // dt-deck-folders.user.js.
  (function pollForReadiness() {
    if (isOnDeckConstructor()) { applyPendingRestore(); return; }
    setTimeout(pollForReadiness, 500);
  })();

  console.log('[Duel Tools] Deck Version History ready');
})();
