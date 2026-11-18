// ==UserScript==
// @name         Duel Tools — Organize Decklists
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds an "Organize Decklists" button next to the deck dropdown in the constructor — mass delete, rename, or apply a label (prefix/suffix) to several saved decks at once.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── The hard constraint this whole file is built around ─────────────────
// Rename Deck opens DuelingBook's #input dialog (.input_txt field,
// .ok_btn/.cancel_btn). Delete Deck opens a DIFFERENT component, #confirm
// (.yes_btn/.no_btn, a styled "Are you sure?" popup — not #input at all).
//
// For BOTH: the thing that actually receives the real click is the
// hidden <input id="rename_btn">/<input id="delete_btn"> element itself —
// NOT the "button proxy unselectable" text div that sits as its SIBLING at
// the exact same on-screen position. Confirmed live multiple ways: the two
// are siblings under #deck_constructor, not ancestor/descendant;
// elementFromPoint() at the button's own visual center returns the
// <input>, never the div; and a synthetic click dispatched on the <input>
// reliably opens the real dialog, while the same click dispatched on the
// proxy div (what earlier versions of this file used, via
// findByExactText()) does nothing at all — which is exactly why neither
// dialog ever used to pop up. So OPENING both dialogs is fully
// automatable once you target the right element, and filling
// .input_txt synthetically works fine too.
//
// Only committing (clicking .ok_btn or .yes_btn) requires a genuinely
// trusted click — confirmed live: a synthetic click on either silently
// closes the dialog WITHOUT applying the change (no rename, no delete),
// while a real click applies whatever was already filled in, even if
// that value was set synthetically. Cancelling (.cancel_btn/.no_btn) is
// NOT trust-gated — a synthetic click on either works fine.
//
// This commit-only boundary is a real browser security feature (isTrusted),
// not a selector bug — no content-script code can fake it (the only way
// around it at all is chrome.debugger, which the user explicitly declined
// for this feature: it needs the "debugger" permission and shows a
// persistent "this browser is being debugged" banner the whole time). So
// the design here is: this script does EVERYTHING except the one real
// commit click per deck — selects the deck, opens the real dialog, fills
// in the computed name for rename — and the person doing a mass action
// just clicks the same real OK/Yes button every time, auto-advancing to
// the next deck the instant it detects the previous one landed.
//
// Reads/writes chrome.storage.local DIRECTLY (not the GM_* shim) for the
// same reason as dt-deck-version-history.user.js: needs a fresh read of
// the enabled flag and the backup bank every time, not a stale per-tab-
// load snapshot.
(function () {
  'use strict';

  const ENABLED_KEY = 'dt_organize_decklists_enabled';
  const BANK_KEY = 'dt_deck_version_bank';

  function isEnabled(cb) {
    chrome.storage.local.get({ [ENABLED_KEY]: false }, (s) => cb(!!s[ENABLED_KEY]));
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function findByExactText(label) {
    const all = document.querySelectorAll('div, span, button');
    for (const el of all) {
      if ((el.textContent || '').trim() !== label) continue;
      let isLeaf = true;
      for (const child of el.children) {
        if ((child.textContent || '').trim() === label) { isLeaf = false; break; }
      }
      if (isLeaf && el.offsetParent !== null) return el;
    }
    return null;
  }
  function realClick(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function escHtmlOd(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function isOnDeckConstructor() {
    // #decklist_cb is NOT constructor-only — confirmed live 2026-11-16 that
    // DuelingBook reuses that same dropdown on the Duel Lobby page too (it's
    // how you pick which deck to queue/host with there), so checking it
    // alone made this button leak onto the Lobby. #export_btn only exists
    // (and is only visible) on the actual Deck Constructor — confirmed live
    // the same way: visible on the constructor, offsetParent null on Lobby.
    const el = document.getElementById('export_btn');
    return !!(el && el.offsetParent !== null);
  }
  // {value, name} pairs, in dropdown order — matching by the option's own
  // `value` (its real deck id) rather than its visible text throughout
  // this file, since DuelingBook allows two decks with the exact same
  // (or same-looking, different-case) name — confirmed live in this
  // account's own decklist — and text matching would risk operating on
  // the wrong one.
  function listDecks() {
    const sel = document.getElementById('decklist_cb');
    if (!sel) return [];
    return Array.from(sel.options).map((o) => ({ value: o.value, name: o.textContent.trim() }));
  }
  function selectDeckByValue(value) {
    const sel = document.getElementById('decklist_cb');
    if (!sel) return false;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function deckExistsByValue(value) {
    const sel = document.getElementById('decklist_cb');
    if (!sel) return false;
    return Array.from(sel.options).some((o) => o.value === value);
  }
  function deckNameByValue(value) {
    const sel = document.getElementById('decklist_cb');
    if (!sel) return null;
    const opt = Array.from(sel.options).find((o) => o.value === value);
    return opt ? opt.textContent.trim() : null;
  }

  // ── The "Organize Decklists" button ──────────────────────────────────────
  // v1.1 tracked #decklist_cb's own live rect and sat directly ABOVE the
  // dropdown, but the user's screenshot showed it landing on top of the
  // real Import Deck/Export Deck buttons.
  // v1.2 moved it to a fixed top-left screen corner instead — but that
  // corner is where the Live Tracker panel itself renders, and the user
  // explicitly corrected it back: "it should be next to the drop down of
  // decklists."
  // v1.3 placed it directly above the dropdown, in the real gap between it
  // and the Import/Export Deck row — technically didn't overlap either one,
  // but the user's follow-up screenshot (with an arrow pointing at the dead
  // space to the LEFT of the whole Import/Export/dropdown column) asked for
  // it to move there instead, plus reported it "covering buttons again" —
  // root-caused to isOnDeckConstructor() checking #decklist_cb, which
  // DuelingBook reuses (confirmed live) on the Duel Lobby page too, where
  // the button was landing right on top of that page's own "Deck" header.
  // v1.4 (current): isOnDeckConstructor() now checks #export_btn instead
  // (constructor-only, confirmed live). Button sits in the actual blank
  // margin to the left of the dropdown/Import/Export column, same row as
  // the dropdown, left-pinned like Deck Folders' own panel (left:4px) —
  // confirmed live 2026-11-16 that this region (x:4–270, same y range as
  // the dropdown) is empty background on the constructor the whole time,
  // clear of Deck Folders (which sits lower, top:716) and the chat/friends
  // icons (which sit lower still).
  // IMPORTANT: this is a position:fixed element, so use the rect's
  // viewport-relative top/left straight from getBoundingClientRect() —
  // do NOT add window.scrollX/scrollY, which would double-offset it.
  let buttonEl = null;
  function buildButton() {
    const btn = document.createElement('div');
    btn.id = 'dt-organize-button';
    btn.textContent = 'Organize Decklists';
    btn.style.cssText = [
      'position:fixed', 'z-index:2147483600', 'display:none', 'text-align:center',
      'left:4px', 'width:170px',
      'background:#1a1a28', 'color:#00e596', 'border:1px solid #252538', 'border-radius:5px',
      'font-family:monospace', 'font-size:12px', 'font-weight:bold', 'cursor:pointer',
      'box-sizing:border-box'
    ].join(';');
    btn.onclick = function () { openModal(); };
    document.body.appendChild(btn);
    buttonEl = btn;
    return btn;
  }
  function repositionButton() {
    isEnabled((on) => {
      const dropdown = document.getElementById('decklist_cb');
      if (!on || !isOnDeckConstructor() || !dropdown) {
        if (buttonEl) buttonEl.style.display = 'none';
        forceCloseModalForNavigation();
        return;
      }
      if (!buttonEl) buildButton();
      const r = dropdown.getBoundingClientRect();
      buttonEl.style.top = r.top + 'px';
      buttonEl.style.height = r.height + 'px';
      buttonEl.style.lineHeight = r.height + 'px';
      // Hidden while the modal is open — no need to show the "open"
      // trigger while it's already open (clicking it again would just be
      // a no-op openModal() call). The modal itself is right-anchored
      // (see ensureStyle()'s CSS), so this is just decluttering, not
      // overlap-avoidance — the two no longer share any screen region.
      const modalOpen = modalEl && modalEl.style.display !== 'none';
      buttonEl.style.display = modalOpen ? 'none' : 'block';
    });
  }
  setInterval(repositionButton, 500);

  // ── The modal ──────────────────────────────────────────────────────────
  let modalEl = null;
  let checkedValues = new Set(); // selected deck `value`s, persists across re-renders/search
  let batchCancelled = false;
  let batchRunning = false;

  function ensureStyle() {
    if (document.getElementById('dt-od-styles')) return;
    const style = document.createElement('style');
    style.id = 'dt-od-styles';
    style.textContent =
      // CONFIRMED LIVE BUG this replaces: centered + maxed z-index + a
      // click-outside-closes backdrop meant this modal sat directly on top
      // of DuelingBook's OWN centered OK/Cancel dialog, completely covering
      // it — there was no way to ever click the real OK button, which left
      // every batch stuck forever (and every other button looking "dead"
      // while disabled for a batch that could never finish). Per the
      // user's explicit correction: no backdrop at all, and closes ONLY via
      // the ✕ — never by clicking OK in the native dialog, never by
      // clicking elsewhere on the page.
      // Tried left-anchored in the blank column next to the card preview
      // panel next, but the user found it too tight there (264px was
      // cramped for deck names + the badge) and asked to move it back to
      // the right — while making sure it clears #dt-unlock-tab (the
      // "Kerem Duel Tools" logo button that opens Settings, fixed at
      // top:20px;right:20px, ~42x42px incl. padding/border — confirmed
      // live that the ORIGINAL right-anchored version at top:40 did
      // overlap its bottom ~22px). So: right-anchored again, same 360px
      // width as before, but starting at top:68px (20+42+6px clearance)
      // instead of 40px, comfortably below the tab.
      '#dt-od-modal{position:fixed;top:68px;right:8px;z-index:2147483600;' +
        'width:360px;max-width:92vw;max-height:calc(100vh - 88px);display:flex;flex-direction:column;' +
        'background:#111;color:#eee;border:1px solid #333;border-radius:10px;font-family:monospace;' +
        'box-shadow:0 12px 48px rgba(0,0,0,.7)}' +
      '#dt-od-modal .dt-od-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #2a2a2a}' +
      '#dt-od-modal .dt-od-head span{font-weight:bold;font-size:15px}' +
      '#dt-od-close{cursor:pointer;color:#888;font-size:16px}' +
      '#dt-od-close:hover{color:#eee}' +
      '#dt-od-body{padding:12px 16px;overflow-y:auto;flex:1}' +
      '#dt-od-search{width:100%;box-sizing:border-box;background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:5px;padding:7px 9px;font-family:monospace;font-size:12px;margin-bottom:8px}' +
      '.dt-od-selectrow{display:flex;gap:10px;font-size:11px;color:#888;margin-bottom:8px}' +
      '.dt-od-selectrow a{color:#6699ff;cursor:pointer;text-decoration:none}' +
      '.dt-od-selectrow a:hover{text-decoration:underline}' +
      '.dt-od-row{display:flex;align-items:center;gap:8px;padding:5px 2px;border-bottom:1px solid #1e1e1e;font-size:12px}' +
      '.dt-od-row input[type=checkbox]{flex-shrink:0}' +
      '.dt-od-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dt-od-badge{font-size:9.5px;color:#00e596;background:rgba(0,229,150,.12);border:1px solid rgba(0,229,150,.35);border-radius:10px;padding:1px 7px;flex-shrink:0;white-space:nowrap}' +
      '#dt-od-empty{color:#888;font-size:12px;padding:10px 2px}' +
      '#dt-od-footer{border-top:1px solid #2a2a2a;padding:12px 16px;display:flex;flex-direction:column;gap:8px}' +
      '.dt-od-actionrow{display:flex;gap:8px;align-items:center}' +
      '.dt-od-actionrow input[type=text]{flex:1;box-sizing:border-box;background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:5px;padding:6px 8px;font-family:monospace;font-size:12px}' +
      '.dt-od-btn{font-family:monospace;font-size:11.5px;font-weight:bold;border-radius:5px;padding:7px 10px;cursor:pointer;border:1px solid #333;background:#1a1a1a;color:#eee;white-space:nowrap}' +
      '.dt-od-btn:hover{border-color:#555}' +
      '.dt-od-btn:disabled{opacity:.4;cursor:default}' +
      '.dt-od-btn-primary{background:#00e596;border-color:#00e596;color:#050508}' +
      '.dt-od-btn-danger{background:transparent;border-color:#ff5555;color:#ff5555}' +
      '.dt-od-btn-danger:hover{background:rgba(255,85,85,.12)}' +
      '.dt-od-seg{display:flex;border:1px solid #333;border-radius:5px;overflow:hidden}' +
      '.dt-od-seg div{padding:6px 10px;font-size:11px;cursor:pointer;color:#888}' +
      '.dt-od-seg div.sel{background:#00e596;color:#050508;font-weight:bold}' +
      '#dt-od-status{font-size:11px;color:#ffbb44;min-height:14px}';
    document.head.appendChild(style);
  }

  function getBank(cb) {
    chrome.storage.local.get({ [BANK_KEY]: [] }, (s) => cb(s[BANK_KEY] || []));
  }

  function openModal() {
    ensureStyle();
    if (modalEl) { modalEl.style.display = 'flex'; renderList(); return; }

    const modal = document.createElement('div');
    modal.id = 'dt-od-modal';
    modal.innerHTML =
      '<div class="dt-od-head"><span>Organize Decklists</span><span id="dt-od-close">✕</span></div>' +
      '<div id="dt-od-body">' +
        '<input id="dt-od-search" type="text" placeholder="Search your decks..."/>' +
        '<div class="dt-od-selectrow"><a id="dt-od-selall">Select all</a><a id="dt-od-selnone">Select none</a><span id="dt-od-count" style="margin-left:auto"></span></div>' +
        '<div id="dt-od-list"></div>' +
      '</div>' +
      '<div id="dt-od-footer">' +
        '<div id="dt-od-status"></div>' +
        '<div class="dt-od-actionrow">' +
          '<input id="dt-od-rename-input" type="text" placeholder="New name for the one selected deck"/>' +
          '<button class="dt-od-btn" id="dt-od-rename-go">Rename</button>' +
        '</div>' +
        '<div class="dt-od-actionrow">' +
          '<input id="dt-od-label-input" type="text" placeholder="Label text, e.g. FL"/>' +
          '<div class="dt-od-seg" id="dt-od-label-pos"><div data-pos="prefix" class="sel">Prefix</div><div data-pos="suffix">Suffix</div></div>' +
          '<button class="dt-od-btn dt-od-btn-primary" id="dt-od-label-go">Apply Label</button>' +
        '</div>' +
        '<div class="dt-od-actionrow">' +
          '<button class="dt-od-btn dt-od-btn-danger" id="dt-od-delete-go" style="flex:1">Delete Selected</button>' +
          '<button class="dt-od-btn" id="dt-od-cancel-batch" style="display:none">Cancel batch</button>' +
        '</div>' +
        '<div class="dt-od-note" style="font-size:10px;color:#666">This selects each deck and opens DuelingBook\'s own dialog for you — you just click the real "OK" (Rename/Apply Label) or "Yes" (Delete) button each time, same spot, and it auto-advances to the next deck.</div>' +
      '</div>';
    document.body.appendChild(modal);
    modalEl = modal;

    document.getElementById('dt-od-close').onclick = closeModal;
    document.getElementById('dt-od-search').addEventListener('input', () => renderList());
    document.getElementById('dt-od-selall').onclick = () => { setAllChecked(true); };
    document.getElementById('dt-od-selnone').onclick = () => { setAllChecked(false); };
    document.getElementById('dt-od-label-pos').addEventListener('click', (e) => {
      const d = e.target.closest('[data-pos]');
      if (!d) return;
      modal.querySelectorAll('#dt-od-label-pos div').forEach((x) => x.classList.remove('sel'));
      d.classList.add('sel');
    });
    document.getElementById('dt-od-rename-go').onclick = onRenameClick;
    document.getElementById('dt-od-label-go').onclick = onApplyLabelClick;
    document.getElementById('dt-od-delete-go').onclick = onDeleteClick;
    document.getElementById('dt-od-cancel-batch').onclick = () => { batchCancelled = true; };

    renderList();
  }
  function closeModal() {
    // Only ever called from the ✕ click handler — per the user's explicit
    // instruction, clicking OK in DuelingBook's native dialog or clicking
    // elsewhere on the page must never close this.
    if (modalEl) modalEl.style.display = 'none';
  }
  // Called only from repositionButton's interval when the person has
  // actually left the Deck Constructor entirely (Main Menu, Duel Lobby,
  // etc.) — per the user's explicit request, this modal has no business
  // staying open outside the constructor. Different case from closeModal()
  // above: that one guards against DuelingBook's own dialogs/clicks
  // closing it while still ON the constructor; this is about leaving the
  // page. Also cancels any batch in progress so it doesn't keep polling
  // for a click that can no longer happen.
  function forceCloseModalForNavigation() {
    if (modalEl && modalEl.style.display !== 'none') {
      batchCancelled = true;
      modalEl.style.display = 'none';
    }
  }
  function setAllChecked(val) {
    if (!val) {
      // "Select none" means none, full stop — not just the rows currently
      // rendered under whatever search filter happens to be active. Using
      // the Set directly (rather than only the visible <input>s) is also
      // what actually clears stale entries left over from deleted decks —
      // see pruneStaleCheckedValues() below for why those can exist.
      checkedValues.clear();
    } else {
      const visible = modalEl.querySelectorAll('#dt-od-list [data-value]');
      visible.forEach((row) => checkedValues.add(row.getAttribute('data-value')));
    }
    renderList(document.getElementById('dt-od-search').value);
  }

  // checkedValues can otherwise accumulate stale entries forever: a deck
  // that gets deleted (by this batch or any other way) stops appearing as
  // a row at all, so nothing ever un-checks it — it just silently stays
  // in the Set, inflating "N selected" and making "Select none" look like
  // it doesn't work (confirmed live: deleted/renamed decks from a
  // finished batch were still counted after it completed). Called at the
  // top of every render so the count and "Select none" always reflect
  // decks that actually still exist.
  function pruneStaleCheckedValues(currentDecks) {
    const liveValues = new Set(currentDecks.map((d) => d.value));
    for (const v of Array.from(checkedValues)) {
      if (!liveValues.has(v)) checkedValues.delete(v);
    }
  }

  function renderList(filterOverride) {
    const filter = (filterOverride !== undefined ? filterOverride : (document.getElementById('dt-od-search') || {}).value || '').toLowerCase();
    const decks = listDecks();
    pruneStaleCheckedValues(decks);
    getBank((bank) => {
      const backedUpNames = new Set(bank.map((b) => b.deckName));
      const filtered = decks.filter((d) => d.name.toLowerCase().includes(filter));
      const list = document.getElementById('dt-od-list');
      if (!list) return;
      if (!filtered.length) {
        list.innerHTML = '<div id="dt-od-empty">No decks match.</div>';
      } else {
        list.innerHTML = filtered.map((d) => {
          const checked = checkedValues.has(d.value);
          const badge = backedUpNames.has(d.name) ? '<span class="dt-od-badge">✓ Saved Deck Version</span>' : '';
          return '<label class="dt-od-row" data-value="' + escHtmlOd(d.value) + '">' +
            '<input type="checkbox" ' + (checked ? 'checked' : '') + '/>' +
            '<span class="dt-od-name">' + escHtmlOd(d.name) + '</span>' + badge +
          '</label>';
        }).join('');
        list.querySelectorAll('.dt-od-row input[type=checkbox]').forEach((cb) => {
          cb.addEventListener('change', (e) => {
            const row = e.target.closest('[data-value]');
            const v = row.getAttribute('data-value');
            if (e.target.checked) checkedValues.add(v); else checkedValues.delete(v);
            updateCount();
          });
        });
      }
      updateCount();
    });
  }
  function updateCount() {
    const el = document.getElementById('dt-od-count');
    if (el) el.textContent = checkedValues.size + ' selected';
    const renameBtn = document.getElementById('dt-od-rename-go');
    if (renameBtn) renameBtn.disabled = checkedValues.size !== 1;
    const labelBtn = document.getElementById('dt-od-label-go');
    if (labelBtn) labelBtn.disabled = checkedValues.size < 1;
    const delBtn = document.getElementById('dt-od-delete-go');
    if (delBtn) delBtn.disabled = checkedValues.size < 1;
  }

  function setStatus(text) {
    const el = document.getElementById('dt-od-status');
    if (el) el.textContent = text || '';
  }
  function setBatchUiRunning(running) {
    batchRunning = running;
    document.getElementById('dt-od-cancel-batch').style.display = running ? 'inline-block' : 'none';
    ['dt-od-rename-go', 'dt-od-label-go', 'dt-od-delete-go', 'dt-od-selall', 'dt-od-selnone'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = running;
    });
  }

  // Status during a batch renders inline in the modal's own #dt-od-status
  // line (set via setStatus() above) — safe to do now that the modal is
  // anchored to the right edge rather than centered, so it never overlaps
  // DuelingBook's own centered OK/Cancel dialog. The modal also stays open
  // the whole time (see closeModal()'s comment) rather than hiding itself
  // during the wait.

  // ── Single rename (exactly one checked) ──────────────────────────────────
  function onRenameClick() {
    if (checkedValues.size !== 1 || batchRunning) return;
    const newName = document.getElementById('dt-od-rename-input').value.trim();
    if (!newName) { setStatus('Type a new name first.'); return; }
    const value = Array.from(checkedValues)[0];
    runBatch([value], 'rename', { newNameFor: () => newName });
  }

  // ── Apply Label (prefix/suffix, one or more checked) ─────────────────────
  function onApplyLabelClick() {
    if (checkedValues.size < 1 || batchRunning) return;
    const label = document.getElementById('dt-od-label-input').value.trim();
    if (!label) { setStatus('Type a label first.'); return; }
    const pos = modalEl.querySelector('#dt-od-label-pos .sel').getAttribute('data-pos');
    const values = Array.from(checkedValues);
    runBatch(values, 'rename', {
      newNameFor: (currentName) => (pos === 'prefix' ? label + ' ' + currentName : currentName + ' ' + label)
    });
  }

  // ── Delete Selected ───────────────────────────────────────────────────────
  function onDeleteClick() {
    if (checkedValues.size < 1 || batchRunning) return;
    const values = Array.from(checkedValues);
    const names = values.map((v) => deckNameByValue(v)).filter(Boolean);
    const preview = names.slice(0, 5).join(', ') + (names.length > 5 ? ', and ' + (names.length - 5) + ' more' : '');
    if (!window.confirm('Permanently delete ' + names.length + ' deck(s) from your DuelingBook account?\n\n' + preview + '\n\nAny deck already backed up in Deck Version History stays recoverable from there.')) return;
    runBatch(values, 'delete', {});
  }

  // ── Shared batch runner ───────────────────────────────────────────────────
  // kind: 'delete' | 'rename'. For 'rename', opts.newNameFor(currentName)
  // computes each deck's own new name (so Apply Label can give every deck a
  // DIFFERENT result built from its own current name, while single Rename
  // just returns the one typed name).
  async function runBatch(values, kind, opts) {
    batchCancelled = false;
    setBatchUiRunning(true);
    if (kind === 'delete') window.__dtOrganizeBatchDeleting = true; // tells dt-deck-version-history.user.js's live recovery popup to stay quiet — this was already a deliberate, informed choice made right here
    let done = 0;
    for (const value of values) {
      if (batchCancelled) break;
      if (!deckExistsByValue(value)) { done++; continue; } // already gone (e.g. deleted earlier in this same batch by name collision — shouldn't happen since we match by value, but harmless either way)
      const currentName = deckNameByValue(value);
      selectDeckByValue(value);
      await sleep(350);

      if (kind === 'delete') {
        // CORRECTED 2026-11-16: earlier versions of this file opened the
        // dialog by finding the "Delete Deck"/"Rename Deck" TEXT PROXY DIV
        // (findByExactText) and clicking that — but confirmed live that
        // div is a decorative SIBLING of the real clickable element, not
        // an ancestor of it, so a synthetic click on it never reached
        // DuelingBook's actual handler at all (that's why nothing ever
        // popped up, for either Delete or Rename). The REAL element is the
        // hidden #delete_btn / #rename_btn <input> itself — confirmed live
        // elementFromPoint() at the button's own on-screen center returns
        // that input, not the proxy div, and a synthetic click directly on
        // it opens the real dialog every time. So this auto-opens fine;
        // only the commit click (.yes_btn) still needs to be the user's
        // own real click — confirmed live a synthetic click on .yes_btn/
        // .ok_btn closes the dialog but does NOT actually apply the change.
        realClick(document.getElementById('delete_btn'));
        await sleep(400);
        if (!document.getElementById('confirm') || document.getElementById('confirm').offsetParent === null) {
          setStatus('Delete Deck dialog did not open for "' + currentName + '" — stopping.'); break;
        }

        setStatus('Click the real "Yes" button above to delete "' + currentName + '"  (' + (done + 1) + ' of ' + values.length + ')');
        const landed = await waitForOutcome(value, kind, null);
        if (!landed) { setStatus('Stopped — "' + currentName + '" was not confirmed.'); break; }
        done++;
        checkedValues.delete(value); // deleted decks get pruned on render anyway, but do it now so the count updates immediately
        renderList(document.getElementById('dt-od-search').value);
        continue;
      }

      // ── Rename / Apply Label: same fix as Delete above — auto-open via
      // the real #rename_btn input (not the decorative proxy div), then
      // fill in the computed name, then wait for the person's own real
      // click on the native OK button to commit it.
      const targetName = opts.newNameFor(currentName);
      realClick(document.getElementById('rename_btn'));
      await sleep(400);
      const dialog = document.getElementById('input');
      if (!dialog || dialog.offsetParent === null) {
        setStatus('Rename Deck dialog did not open for "' + currentName + '" — stopping.'); break;
      }
      const input = dialog.querySelector('.input_txt');
      if (input) setNativeValue(input, targetName);

      setStatus('Click the real OK button above to rename "' + currentName + '" → "' + targetName + '"  (' + (done + 1) + ' of ' + values.length + ')');

      // Wait for the user's own real click on the native dialog to land —
      // detected by watching #decklist_cb itself change shape, exactly the
      // same idiom dt-deck-version-history.user.js's Save As handler uses.
      const landed = await waitForOutcome(value, kind, targetName);
      if (!landed) { setStatus('Stopped — "' + currentName + '" was not confirmed.'); break; }
      done++;
      // Per the user's explicit request: once a deck is renamed/labeled,
      // uncheck it — its `value` doesn't change on a rename, so without
      // this it would otherwise stay checked (and counted) forever.
      checkedValues.delete(value);
      renderList(document.getElementById('dt-od-search').value);
    }
    window.__dtOrganizeBatchDeleting = false;
    setBatchUiRunning(false);
    setStatus(batchCancelled ? 'Batch cancelled — ' + done + ' of ' + values.length + ' completed.' : done + ' of ' + values.length + ' completed.');
    renderList(document.getElementById('dt-od-search').value);
  }

  // Polls up to ~2 minutes (plenty of time to notice and click) for the
  // real dialog commit to land; a "Cancel batch" click or clicking the
  // dialog's own Cancel/No both end this the same way — nothing more
  // happens to this item, and the batch stops rather than guessing what
  // the user meant.
  function waitForOutcome(value, kind, targetName) {
    return new Promise((resolve) => {
      let tries = 0;
      const MAX_TRIES = 400; // ~2 minutes at 300ms
      const timer = setInterval(() => {
        tries++;
        if (batchCancelled) { clearInterval(timer); resolve(false); return; }
        if (kind === 'delete') {
          if (!deckExistsByValue(value)) { clearInterval(timer); resolve(true); return; }
        } else {
          if (deckNameByValue(value) === targetName) { clearInterval(timer); resolve(true); return; }
        }
        if (tries >= MAX_TRIES) { clearInterval(timer); resolve(false); }
      }, 300);
    });
  }

  console.log('[Duel Tools] Organize Decklists ready');
})();
