// Tiny popup shown when the pinned toolbar icon is clicked — per spec, this
// is just a confirm/prompt step ("asks us to open settings"), not the
// settings UI itself. The real settings live in dt-settings.html, opened as
// a full tab via the extension's options page (chrome.runtime.openOptionsPage
// honors options_ui.open_in_tab in manifest.json).
document.getElementById('dt-open-settings').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
  window.close();
});
