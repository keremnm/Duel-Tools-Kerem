// ==UserScript==
// @name         Duel Tools — Relay
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Relays Duelingbook replay data to Duel Tools app
// @author       nedhmn/duel-tools port
// @match        https://www.duelingbook.com/replay*
// @grant        none
// @run-at       document-start
// ==/UserScript==
(function () {
  'use strict';
  if (window.parent === window) return;
  const id = new URLSearchParams(window.location.search).get('id');
  if (!id) return;
  let sent = false;

  function send(rawData) {
    if (sent) return; sent = true;
    // Send full raw replay object — player1, player2, plays[] with log/owner intact
    const plays = rawData.plays || rawData;
    const rps = Array.isArray(plays) ? plays.filter(p => p.play === 'RPS') : [];
    window.parent.postMessage({
      type: 'rps-relay',
      id,
      plays: rps,
      allPlays: Array.isArray(plays) ? plays : [],
      // Pass full metadata needed by the nedhmn parser
      player1: rawData.player1 || null,
      player2: rawData.player2 || null,
      date:    rawData.date    || null,
      format:  rawData.format  || null,
    }, '*');
  }

  function isReplay(v) {
    return v && typeof v === 'object' && !Array.isArray(v) &&
      Array.isArray(v.plays) && v.plays.length > 0 && 'play' in v.plays[0];
  }

  function isPlays(arr) {
    return Array.isArray(arr) && arr.length > 0 && arr[0] &&
      typeof arr[0] === 'object' && 'play' in arr[0];
  }

  function tryValue(v) {
    if (sent) return false;
    // Full replay object with player1/player2/plays
    if (isReplay(v)) { send(v); return true; }
    // Raw plays array
    if (isPlays(v)) { send({ plays: v }); return true; }
    // JSON string
    if (typeof v === 'string' && v.length > 100) {
      try {
        const i = v.indexOf('{');
        if (i >= 0) {
          const p = JSON.parse(v.slice(i));
          if (isReplay(p)) { send(p); return true; }
          if (isPlays(p.plays)) { send(p); return true; }
        }
      } catch(e) {}
    }
    return false;
  }

  const origLog = console.log.bind(console);
  console.log = function(...a) {
    origLog(...a);
    if (!sent) for (const x of a) if (tryValue(x)) return;
  };

  const OO = XMLHttpRequest.prototype.open;
  const OS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) {
    this._url = String(u || '');
    return OO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      if (!sent && this._url && this._url.includes('duelingbook'))
        tryValue(this.responseText);
    });
    return OS.apply(this, arguments);
  };

  const oF = window.fetch;
  window.fetch = function(inp, init) {
    const url = typeof inp === 'string' ? inp : (inp && inp.url) || '';
    const p = oF.apply(this, arguments);
    if (url.includes('duelingbook'))
      p.then(r => r.clone().text().then(tryValue).catch(() => {})).catch(() => {});
    return p;
  };

  // Poll window globals
  const t = setInterval(() => {
    if (sent) { clearInterval(t); return; }
    try {
      for (const k of Object.keys(window)) {
        const v = window[k];
        if (isReplay(v) && v.plays.length > 2) {
          clearInterval(t); send(v); return;
        }
        if (v && typeof v === 'object' && isPlays(v.plays) && v.plays.length > 2) {
          clearInterval(t); send(v); return;
        }
      }
    } catch(e) {}
  }, 300);

  setTimeout(() => {
    clearInterval(t);
    if (!sent) {
      sent = true;
      window.parent.postMessage({
        type: 'rps-relay', id, plays: [], allPlays: [], timedOut: true,
        player1: null, player2: null
      }, '*');
    }
  }, 35000);
})();
