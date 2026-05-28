const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement(id) {
  return {
    id,
    disabled: false,
    textContent: '',
    className: '',
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    listeners: {}
  };
}

async function loadDeathPage(grave) {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/death.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map();

  function getElement(id) {
    if (!elements.has(id)) {
      elements.set(id, createElement(id));
    }
    return elements.get(id);
  }

  const context = {
    URL,
    console,
    document: {
      getElementById: getElement
    },
    fetch(endpoint) {
      if (endpoint === '/death-data') {
        return Promise.resolve({
          ok: true,
          json: async () => grave
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ url: '/resurrect' })
      });
    },
    window: {
      alert() {},
      location: {
        href: ''
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(script, context);
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }

  return {
    getElement
  };
}

test('death headline calls out a self-targeted attack', async () => {
  const page = await loadDeathPage({
    username: 'angel',
    job: 'Chemist',
    level: 0,
    gold: 2,
    roomRow: 6,
    roomCol: 4,
    cause: 'attack by angel',
    diedAt: '2026-05-28 18:35:28',
    kills: 0,
    achievements: []
  });

  assert.equal(page.getElement('grave-name').textContent, 'angel killed themself.');
});

test('death headline references skill deaths and environmental deaths', async () => {
  const skillDeath = await loadDeathPage({
    username: 'moss',
    cause: 'power strike by angel'
  });
  const poisonDeath = await loadDeathPage({
    username: 'moss',
    cause: 'dose by angel'
  });
  const environmentalDeath = await loadDeathPage({
    username: 'moss',
    cause: 'poison marsh'
  });

  assert.equal(skillDeath.getElement('grave-name').textContent, 'moss was felled by angel\'s Power Strike.');
  assert.equal(poisonDeath.getElement('grave-name').textContent, 'moss died from angel\'s poisoned dose.');
  assert.equal(environmentalDeath.getElement('grave-name').textContent, 'moss was claimed by the poison marsh.');
});

test('resurrection action uses link styling like the other death actions', () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/death.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../worker/static/styles.css'), 'utf8');

  assert.match(html, /id="resurrect-button"[^>]*class="link-button"/);
  assert.match(css, /\.link-button\s*\{[^}]*background:\s*none/s);
});
