const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement(id) {
  const element = {
    id,
    tagName: id,
    value: '',
    textContent: '',
    _innerHTML: '',
    style: {},
    options: [],
    children: [],
    classList: {
      add() {}
    },
    appendChild(child) {
      this.children.push(child);
      this.textContent += child.textContent || '';
      if (id === 'skill-id' || id === 'job-select') {
        this.options.push(child);
      }
      return child;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    focus() {},
    listeners: {}
  };
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return this._innerHTML;
    },
    set(value) {
      this._innerHTML = value;
      this.children = [];
      if (id === 'skill-id' || id === 'job-select') {
        this.options = [];
      }
    }
  });
  return element;
}

function loadChatPage(overrides = {}) {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/chat.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map();
  const documentListeners = {};
  const posts = [];
  const alerts = [];
  const userAttributes = overrides.userAttributes || {
    job: 'Novice',
    level: 1,
    gold: 0,
    effectiveStats: {
      health: 100,
      maxHealth: 100,
      stamina: 100,
      maxStamina: 100,
      speed: 1,
      strength: 1,
      intelligence: 1
    },
    skill: { id: 'scrounge', label: 'Scrounge' }
  };
  const roomEcology = overrides.roomEcology || {
    room: { row: 1, col: 1 },
    event: null,
    features: [],
    traceSummary: { labels: [] },
    effects: [],
    presence: [],
    stock: [],
    commands: [],
    description: 'A room.',
    nextResetAt: '2026-05-29T00:00:00.000Z'
  };

  function getElement(id) {
    if (!elements.has(id)) {
      elements.set(id, createElement(id));
    }
    return elements.get(id);
  }

  const context = {
    URL,
    clearInterval() {},
    console,
    document: {
      addEventListener(type, handler) {
        documentListeners[type] = handler;
      },
      createElement(tagName) {
        return createElement(tagName);
      },
      getElementById: getElement
    },
    fetch(endpoint, options = {}) {
      if (options.method === 'POST') {
        posts.push({ endpoint, body: options.body || '' });
        if (overrides.postResponse) {
          return Promise.resolve(overrides.postResponse);
        }
      }
      return Promise.resolve({
        ok: true,
        redirected: false,
        status: 200,
        url: `http://localhost:8787${endpoint}`,
        json: async () => {
          if (endpoint === '/messages/1/1') {
            return [];
          }
          if (endpoint === '/user-attributes') {
            return userAttributes;
          }
          if (endpoint === '/tick') {
            return { tick: 1 };
          }
          if (endpoint === '/room-ecology/1/1') {
            return roomEcology;
          }
          return {};
        },
        text: async () => ''
      });
    },
    setInterval() {
      return 1;
    },
    WebSocket: function WebSocket() {
      return {};
    },
    window: {
      alert(message) {
        alerts.push(message);
      },
      location: {
        host: 'localhost:8787',
        href: '',
        pathname: '/chat/1/1',
        protocol: 'http:'
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(script, context);

  getElement('skill-id').value = 'scrounge';
  documentListeners.DOMContentLoaded();

  return {
    context,
    getElement,
    alerts,
    posts
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test('Shift+Command+Enter uses the current skill from the chat input', () => {
  const page = loadChatPage();
  const message = page.getElement('message');
  let prevented = false;

  message.value = 'forage here';
  message.listeners.keydown({
    key: 'Enter',
    metaKey: true,
    shiftKey: true,
    altKey: false,
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, true);
  assert.equal(page.posts.at(-1).endpoint, '/skill/1/1');
  assert.equal(page.posts.at(-1).body, 'skillId=scrounge&targetUsername=');
});

test('chat header combines job and level and moves gold into the right-side status group', async () => {
  const page = loadChatPage({
    userAttributes: {
      job: 'Chemist',
      level: 3,
      gold: 2,
      effectiveStats: {
        health: 12,
        maxHealth: 12,
        stamina: 107,
        maxStamina: 140,
        speed: 3,
        strength: 4,
        intelligence: 5
      },
      skill: { id: 'dose', label: 'Dose' }
    }
  });

  await page.context.loadUserAttributes();
  await flushPromises();

  assert.match(page.getElement('attributes').innerHTML, /Job: Chemist • Level 3/);
  assert.doesNotMatch(page.getElement('attributes').innerHTML, /<p>Level:/);
  assert.doesNotMatch(page.getElement('attributes').innerHTML, /<p>Gold:/);
  assert.equal(page.getElement('gold').textContent, 'Gold: 2');
});

test('room prose is appended to reset without repeating the room coordinate prefix', async () => {
  const page = loadChatPage({
    roomEcology: {
      room: { row: 14, col: 7 },
      features: [{ label: 'Guild' }, { label: 'Safe' }],
      traceSummary: { labels: [] },
      effects: [{ type: 'guild', label: 'Guild' }],
      presence: [],
      stock: [],
      commands: [],
      description: 'Room 14, 7. Old banners and tally marks make this place feel claimed.',
      nextResetAt: '2026-05-29T00:00:00.000Z'
    }
  });

  await page.context.loadRoomEcology();
  await flushPromises();

  const toolbarText = page.getElement('room-ecology-toolbar').children
    .map(child => child.textContent)
    .join(' ');

  assert.match(toolbarText, /Room: 14, 7/);
  assert.match(toolbarText, /Reset: Fri, 29 May 2026 00:00:00 GMT Old banners/);
  assert.doesNotMatch(toolbarText, /Room 14, 7\. Old banners/);
});

test('room toolbar renders present players as quick target buttons', async () => {
  const page = loadChatPage({
    roomEcology: {
      room: { row: 1, col: 1 },
      event: { eventType: 'raid', title: 'Frost Wyrm Den', status: 'active' },
      features: [],
      traceSummary: { labels: [] },
      effects: [],
      presence: [
        { username: 'angel', displayName: 'angel' },
        { username: 'raid_boss_20260529', displayName: 'Frost Wyrm', npcKind: 'raid_boss' }
      ],
      stock: [],
      commands: [],
      description: 'A room.',
      nextResetAt: '2026-05-29T00:00:00.000Z'
    }
  });

  await page.context.loadRoomEcology();
  await flushPromises();

  const presentLine = page.getElement('room-ecology-toolbar').children
    .find(child => child.textContent.startsWith('Present:'));
  const eventLine = page.getElement('room-ecology-toolbar').children
    .find(child => child.textContent.startsWith('Event:'));
  const targetButton = presentLine.children.find(child => child.textContent === 'Frost Wyrm');

  assert.equal(eventLine.textContent, 'Event: Frost Wyrm Den (raid)');
  assert.ok(targetButton);
  targetButton.listeners.click();

  assert.equal(page.getElement('message').placeholder, 'Currently targeting raid_boss_20260529');
  assert.equal(page.getElement('clear-target').textContent, 'Untarget');
});

test('target button keeps a fixed untarget label when a player is selected', () => {
  const page = loadChatPage();

  page.context.selectTarget('angel');

  assert.equal(page.getElement('message').placeholder, 'Currently targeting angel');
  assert.equal(page.getElement('clear-target').textContent, 'Untarget');
});

test('chat actions route death responses to the death interstitial without alerting', async () => {
  const page = loadChatPage({
    postResponse: {
      ok: false,
      redirected: false,
      status: 410,
      json: async () => ({ error: 'You died', redirect: '/you-died' }),
      text: async () => '{"error":"You died","redirect":"/you-died"}'
    }
  });

  page.context.postForm('/attack/1/1', 'message=%40angel');
  await flushPromises();

  assert.equal(page.context.window.location.href, '/you-died');
  assert.deepEqual(page.alerts, []);
});
