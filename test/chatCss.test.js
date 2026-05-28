const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('chat compose toolbar is visually separated from messages', () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/chat.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../worker/static/styles.css'), 'utf8');

  assert.match(html, /class="hud chat-input-toolbar"/);
  assert.match(css, /\.chat-input-toolbar\s*\{[^}]*border-top:\s*1px solid #d9d9d9/s);
});

test('chat header has a right-aligned status cluster', () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/chat.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../worker/static/styles.css'), 'utf8');

  assert.match(html, /class="hud top-hud"/);
  assert.match(html, /id="hud-status"/);
  assert.match(css, /#hud-status\s*\{[^}]*margin-left:\s*auto/s);
});

test('death interstitial is a full red screen with a proceed action', () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/you-died.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../worker/static/styles.css'), 'utf8');

  assert.match(html, /YOU DIED/);
  assert.match(html, /href="\/death"/);
  assert.match(css, /\.death-interstitial\s*\{[^}]*background:\s*#ff0000/s);
  assert.match(css, /\.death-interstitial\s*\{[^}]*min-height:\s*100vh/s);
  assert.match(css, /\.death-interstitial\s*\{[^}]*display:\s*grid/s);
});
