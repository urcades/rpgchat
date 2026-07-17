// Shared page helpers (adv ARCH-07). Plain script — no build step, no modules:
// pages include it with <script src="/shared.js"></script> before their inline
// script. Add here anything that would otherwise be copy-pasted per page.

// The one HTML-escaper. Any page that interpolates server data into innerHTML
// must route it through this (pages that use textContent don't need it).
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}
