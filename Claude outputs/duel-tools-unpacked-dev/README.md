# Duel Tools — DuelingBook Companion (Chrome extension)

This is the same Duel Tools tooling that used to run as four separate
Tampermonkey userscripts (Live Tracker, Save Prompt, Unlock, Relay), packaged
as one self-contained Chrome extension instead. The actual tracker logic is
**byte-for-byte unchanged** — `dt-live-tracker.user.js` and the other three
files in this folder are exact copies of the userscripts. What's new is a
small shim (`background.js` + `page-bridge.js`) that stands in for what
Tampermonkey used to provide (`GM_getValue`/`GM_setValue`, `GM_xmlhttpRequest`,
`unsafeWindow`), so none of that logic had to be rewritten.

Why this exists: it doesn't depend on Tampermonkey at all, so a Tampermonkey
crash or update can't wipe your scripts out again the way it just did.

## Installing (self-hosted — not on the Chrome Web Store)

Since this isn't published to the Web Store, Chrome requires Developer Mode
to load it. That's a one-time setting, not a security warning to worry about
— it's the same mechanism any local/unpublished extension uses.

1. Download this whole `extension` folder (as a zip, then unzip it
   somewhere you'll keep it — Chrome loads the extension from that folder
   directly, so don't delete it afterward).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped `extension` folder.
5. You should see "Duel Tools — DuelingBook Companion" appear in your
   extensions list with the Duel Tools icon. Make sure it's enabled.
6. Go to duelingbook.com (or reload the tab if it was already open) — the
   Live Tracker should appear exactly like it used to under Tampermonkey.

If you already have the Tampermonkey versions installed, you can disable
those scripts (or remove Tampermonkey entirely) — this extension does the
same job on its own.

## Updating

When a new version is sent, replace the contents of your unpacked
`extension` folder with the new files, then go to `chrome://extensions` and
click the refresh icon on the Duel Tools card (or toggle it off and on).
Existing saved data (your deck, your username, etc.) is kept — it lives in
`chrome.storage`, not in the extension files themselves.

## For other people installing this

Send them this whole folder (zipped). They follow the same steps above on
their own Chrome. Nothing needs to be published or reviewed by Google for
this to work — "Developer mode + Load unpacked" is a normal, supported way
to run an extension that isn't in the Web Store; it just means Chrome shows
a small "Developer mode extensions" note on the extensions page, which is
expected and not an error.

## What actually changed under the hood

If you're curious rather than just installing this: `background.js` is a
service worker that (1) injects the shim before the tracker file runs on
every DuelingBook page load, since the tracker calls `GM_getValue`
synchronously the instant it starts, and (2) relays `GM_xmlhttpRequest`
calls as real cross-origin fetches, since a page's own content script fetch
can still be limited by that page's CSP the way Tampermonkey's own request
API wasn't. `page-bridge.js` runs directly in DuelingBook's own page context
(something a normal content script can't do) purely to read the page's own
`deck_filled_arr`/`side_filled_arr`/`initializeDeckCards` globals — the
in-page siding screen — and relay them back in, which is what
`unsafeWindow` used to give Tampermonkey scripts for free.
