// Duel Tools — minimal ZIP writer (STORE method, no compression)
//
// Used by Settings → Downloads → Replay Viewer to bundle replay-viewer.html
// + a freshly-fetched cardinfo.json into one .zip the user downloads. No
// external dependency (no bundled JSZip or similar library) — the ZIP
// format's STORE (uncompressed) mode is simple and well-specified enough to
// write correctly by hand, and skipping compression isn't a real loss here:
// cardinfo.json (the only large file) is already a one-time multi-MB
// download regardless, straight from DuelingBook's/YGOPRODeck's own servers
// with no compression asked for either.
//
// Runs on the extension's own options page (dt-settings.html), loaded via a
// plain <script> tag before dt-settings.js — not a content script, so no
// @match/world concerns here, just a plain browser global.
(function (global) {
  'use strict';

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return new TextEncoder().encode(data);
    throw new Error('DTZip.build: each file\'s data must be a string or Uint8Array');
  }

  // DOS date/time fields are cosmetic here (no real per-file mtime to
  // preserve) — a fixed, spec-valid timestamp (1980-01-01, the DOS epoch's
  // earliest legal date) is fine; nothing reads it back meaningfully.
  const DOS_TIME = 0;
  const DOS_DATE = 0x21;

  // files: [{ name: 'a.txt', data: string|Uint8Array }, ...]
  // Returns a Blob (type: 'application/zip'), ready for
  // URL.createObjectURL + an <a download> click.
  function build(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    let centralSize = 0;

    for (const f of files) {
      const nameBytes = new TextEncoder().encode(f.name);
      const dataBytes = toBytes(f.data);
      const crc = crc32(dataBytes);
      const size = dataBytes.length;

      const localHeader = new Uint8Array(30);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);  // local file header signature
      lv.setUint16(4, 20, true);          // version needed to extract
      lv.setUint16(6, 0, true);           // general purpose bit flag
      lv.setUint16(8, 0, true);           // compression method: 0 = store
      lv.setUint16(10, DOS_TIME, true);   // last mod file time
      lv.setUint16(12, DOS_DATE, true);   // last mod file date
      lv.setUint32(14, crc, true);        // crc-32
      lv.setUint32(18, size, true);       // compressed size
      lv.setUint32(22, size, true);       // uncompressed size
      lv.setUint16(26, nameBytes.length, true); // file name length
      lv.setUint16(28, 0, true);          // extra field length
      localParts.push(localHeader, nameBytes, dataBytes);

      const centralHeader = new Uint8Array(46);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);  // central directory file header signature
      cv.setUint16(4, 20, true);          // version made by
      cv.setUint16(6, 20, true);          // version needed to extract
      cv.setUint16(8, 0, true);           // general purpose bit flag
      cv.setUint16(10, 0, true);          // compression method: 0 = store
      cv.setUint16(12, DOS_TIME, true);   // last mod file time
      cv.setUint16(14, DOS_DATE, true);   // last mod file date
      cv.setUint32(16, crc, true);        // crc-32
      cv.setUint32(20, size, true);       // compressed size
      cv.setUint32(24, size, true);       // uncompressed size
      cv.setUint16(28, nameBytes.length, true); // file name length
      cv.setUint16(30, 0, true);          // extra field length
      cv.setUint16(32, 0, true);          // file comment length
      cv.setUint16(34, 0, true);          // disk number start
      cv.setUint16(36, 0, true);          // internal file attributes
      cv.setUint32(38, 0, true);          // external file attributes
      cv.setUint32(42, offset, true);     // relative offset of local header
      centralParts.push(centralHeader, nameBytes);
      centralSize += centralHeader.length + nameBytes.length;

      offset += localHeader.length + nameBytes.length + dataBytes.length;
    }

    const centralStart = offset; // local-file section's total size = where the central directory begins

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);  // end of central directory signature
    ev.setUint16(4, 0, true);           // this disk number
    ev.setUint16(6, 0, true);           // disk with the start of the CD
    ev.setUint16(8, files.length, true);  // entries on this disk
    ev.setUint16(10, files.length, true); // total entries
    ev.setUint32(12, centralSize, true);  // central directory size
    ev.setUint32(16, centralStart, true); // central directory offset
    ev.setUint16(20, 0, true);          // comment length

    return new Blob([].concat(localParts, centralParts, [eocd]), { type: 'application/zip' });
  }

  global.DTZip = { build };
})(window);
