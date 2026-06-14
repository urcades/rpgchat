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

test('chat header separates global toolbar from player status toolbar', () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/chat.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../worker/static/styles.css'), 'utf8');

  assert.match(html, /class="hud global-hud"/);
  assert.match(html, /class="hud top-hud"/);
  assert.match(html, /id="global-status"/);
  assert.match(html, /id="hud-status"/);
  assert.match(html, /<div class="hud global-hud">[\s\S]*href="\/success"[\s\S]*id="tick"[\s\S]*id="phase"[\s\S]*<div class="hud top-hud">/);
  assert.match(html, /<div class="hud top-hud">[\s\S]*href="\/character"[\s\S]*id="attributes"[\s\S]*id="gold"[\s\S]*<\/div>\s*<\/div>\s*<div class="hud" id="room-ecology-toolbar"/);
  assert.doesNotMatch(html, /<div class="hud top-hud">[\s\S]*href="\/success"/);
  assert.match(css, /\.global-hud\s*\{[^}]*padding:\s*1em \.5em/s);
  assert.match(css, /#room-ecology-toolbar\s*\{[^}]*padding:\s*1em \.5em/s);
  assert.match(css, /#global-status,\s*#hud-status\s*\{[^}]*margin-left:\s*auto/s);
});

test('death interstitial is a full red screen with a proceed action', () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/you-died.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../worker/static/styles.css'), 'utf8');

  assert.match(html, /YOU DIED/);
  assert.match(html, /href="\/death"/);
  assert.match(css, /\.death-interstitial\s*\{[^}]*background:\s*#ff0000/s);
  assert.match(css, /\.death-interstitial\s*\{[^}]*min-height:\s*100vh/s);
  assert.match(css, /\.death-interstitial\s*\{[^}]*display:\s*grid/s);
  assert.doesNotMatch(css, /\.death-interstitial-content p\s*\{[^}]*font-size/s);
});

test('character page lays out attributes and history as readable sections', () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/character.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../worker/static/styles.css'), 'utf8');

  assert.match(html, /id="attributes" class="character-sheet"/);
  assert.match(html, /<h2>Skill<\/h2>/);
  assert.match(html, /<h2>Base Stats<\/h2>/);
  assert.match(html, /<h2>Job Bonus<\/h2>/);
  assert.match(html, /<h2>Achievements<\/h2>/);
  assert.match(html, /<h2>Kills<\/h2>/);
  assert.match(css, /#attributes\.character-sheet\s*\{[^}]*display:\s*block/s);
  assert.match(css, /\.character-row\s*\{[^}]*grid-template-columns:\s*9rem minmax\(0, 1fr\)/s);
});

test('chat page puts active skill details on the hotbar button tooltip (plan 017)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/chat.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../worker/static/styles.css'), 'utf8');

  assert.doesNotMatch(html, /id="skill-details"/);
  assert.match(html, /function getSkillTooltip/);
  // Plan 017: the tooltip now lives on each hotbar button, not a dropdown.
  assert.match(html, /button\.title = getSkillTooltip\(skill\)/);
  assert.doesNotMatch(html, /<select id="skill-id"/);
  assert.match(css, /\.skill-slot/);
  assert.doesNotMatch(css, /\.skill-details\s*\{/);
});

test('chat message colors distinguish support, attack, speed, and death text', () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/chat.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../worker/static/styles.css'), 'utf8');

  assert.match(html, /function isSupportSystemMessage/);
  assert.match(html, /function isSpeedContestSystemMessage/);
  assert.match(html, /function isDeathSystemMessage/);
  assert.match(html, /'attack-result'/);
  assert.match(html, /'speed-result'/);
  assert.match(css, /\.support-message\s*\{[^}]*color:\s*#008000/s);
  assert.match(css, /\.attack-result\s*\{[^}]*color:\s*#b00020/s);
  assert.match(css, /\.speed-message,\s*\.speed-result\s*\{[^}]*color:\s*#6f4aa5/s);
  assert.match(css, /\.death-message\s*\{[^}]*color:\s*#b00020/s);
});
