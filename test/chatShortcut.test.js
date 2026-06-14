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
      values: [],
      add(className) {
        this.values.push(className);
      }
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
      this.textContent = '';
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
  const gets = [];
  const alerts = [];
  const intervals = [];
  const userAttributes = overrides.userAttributes || {
    username: 'test_player',
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
      } else {
        gets.push(endpoint);
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
          if (endpoint === '/room-state/1/1') {
            return {
              room: roomEcology,
              messages: [],
              user: userAttributes,
              tick: 1
            };
          }
          return {};
        },
        text: async () => ''
      });
    },
    setInterval(handler) {
      intervals.push(handler);
      return 1;
    },
    // Run timers synchronously so the room-state debounce and socket-reconnect
    // backoff are observable in tests without real time passing.
    setTimeout(handler) {
      handler();
      return 1;
    },
    clearTimeout() {},
    WebSocket: overrides.WebSocket || function WebSocket() {
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
    gets,
    intervals,
    posts
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test('Shift+Command+Enter fires the first ability on the hotbar', async () => {
  const page = loadChatPage();
  await page.context.loadUserAttributes();
  await flushPromises();
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
      username: 'chemist',
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
      skill: {
        id: 'dose',
        label: 'Dose',
        description: 'Patch someone up by day, poison them by night.',
        effects: ['Day: heals the target.', 'Night: poisons the target.']
      }
    }
  });

  await page.context.loadUserAttributes();
  await flushPromises();

  assert.equal(page.getElement('character-link').textContent, 'chemist');
  assert.match(page.getElement('attributes').innerHTML, /Chemist ~ Level 3/);
  assert.doesNotMatch(page.getElement('attributes').innerHTML, /Job:/);
  assert.doesNotMatch(page.getElement('attributes').innerHTML, /<p>Level:/);
  assert.doesNotMatch(page.getElement('attributes').innerHTML, /<p>Gold:/);
  assert.equal(page.getElement('gold').textContent, 'Gold: 2');
  assert.equal(
    page.getElement('skill-bar').children[0].title,
    'Dose: Patch someone up by day, poison them by night.\n- Day: heals the target.\n- Night: poisons the target.'
  );
});

test('the skill hotbar renders a button per ability and fires it on click (plan 017)', async () => {
  const page = loadChatPage();
  await page.context.loadUserAttributes();
  await flushPromises();

  const bar = page.getElement('skill-bar');
  assert.equal(bar.children.length, 1, 'one button for the default single-skill class');
  assert.equal(bar.children[0].textContent, 'Scrounge');

  bar.children[0].listeners.click();
  assert.equal(page.posts.at(-1).endpoint, '/skill/1/1');
  assert.equal(page.posts.at(-1).body, 'skillId=scrounge&targetUsername=');
});

test('the stance toggle marks the active stance and issues /stance on click (plan 017)', async () => {
  const page = loadChatPage({
    userAttributes: {
      username: 'u', job: 'Novice', level: 1, gold: 0, stance: 'guarding',
      effectiveStats: { health: 10, maxHealth: 10, stamina: 10, maxStamina: 10, speed: 1, strength: 1, intelligence: 1 },
      skill: { id: 'scrounge', label: 'Scrounge' }
    }
  });
  await page.context.loadUserAttributes();
  await flushPromises();

  const buttons = page.getElement('stance-bar').children.filter(ch => ch.className && ch.className.includes('stance-slot'));
  assert.equal(buttons.length, 4, 'four stance buttons');
  assert.equal(buttons.find(b => b.className.includes('stance-active')).textContent, 'Guarding', 'current stance highlighted');

  buttons.find(b => b.textContent === 'Aggressive').listeners.click();
  assert.equal(page.posts.at(-1).endpoint, '/chat/1/1');
  assert.equal(page.posts.at(-1).body, 'message=' + encodeURIComponent('/stance aggressive'));
});

test('chat startup fetches one room state payload', async () => {
  const page = loadChatPage();

  await flushPromises();

  assert.ok(page.gets.includes('/room-state/1/1'));
  assert.equal(page.gets.includes('/messages/1/1'), false);
  assert.equal(page.gets.includes('/room-ecology/1/1'), false);
  assert.equal(page.gets.includes('/user-attributes'), false);
  assert.equal(page.gets.includes('/tick'), false);
});

test('idle heartbeat refreshes the full room state', async () => {
  const page = loadChatPage();
  await flushPromises();
  page.posts.length = 0;
  page.gets.length = 0;

  page.intervals[0]();
  await flushPromises();

  assert.ok(page.posts.some(post => post.endpoint === '/room-presence/1/1'));
  assert.ok(page.gets.includes('/room-state/1/1'));
});

test('room socket events refresh one full room state payload', async () => {
  let socket;
  const page = loadChatPage({
    WebSocket: function WebSocket() {
      socket = {};
      return socket;
    }
  });
  await flushPromises();
  page.gets.length = 0;

  socket.onmessage();
  await flushPromises();

  assert.deepEqual(page.gets, ['/room-state/1/1']);
});

test('chat renderer colors support, death, attack, and speed result messages', () => {
  const page = loadChatPage();

  const supportMessage = page.context.renderMessage({
    username: 'System',
    timestamp: '2026-05-28 17:03:50',
    message: 'angel patches up angel for 3 health.'
  });
  const attackMessage = page.context.renderMessage({
    username: 'angel',
    timestamp: '2026-05-28 17:04:10',
    message: 'oops i mean stabbing myself now @angel (angel attacked angel for 2 damage)'
  });
  const dodgeMessage = page.context.renderMessage({
    username: 'ed',
    timestamp: '2026-05-29 15:25:19',
    message: '@ed (ed dodged ed\'s attack)'
  });
  const deathMessage = page.context.renderMessage({
    username: 'System',
    timestamp: '2026-05-29 15:25:21',
    message: 'ed has died from attack by ed.'
  });

  assert.ok(supportMessage.classList.values.includes('system-message'));
  assert.ok(supportMessage.classList.values.includes('skill-message'));
  assert.ok(supportMessage.classList.values.includes('support-message'));
  assert.ok(deathMessage.classList.values.includes('system-message'));
  assert.ok(deathMessage.classList.values.includes('death-message'));

  const attackResult = attackMessage.children.find(child => child.className === 'attack-result');
  assert.ok(attackResult);
  assert.equal(attackResult.textContent, '(angel attacked angel for 2 damage)');
  assert.equal(attackMessage.textContent, '2026-05-28 17:04:10 - angel: oops i mean stabbing myself now @angel (angel attacked angel for 2 damage)');

  const speedResult = dodgeMessage.children.find(child => child.className === 'speed-result');
  assert.ok(speedResult);
  assert.equal(speedResult.textContent, '(ed dodged ed\'s attack)');
  assert.equal(dodgeMessage.textContent, '2026-05-29 15:25:19 - ed: @ed (ed dodged ed\'s attack)');
});

test('chat renderer styles by message kind, not prose (plan 008)', () => {
  const page = loadChatPage();

  // A typed kind picks the class directly — note the message text 'xyz' matches
  // none of the legacy prose regexes.
  const death = page.context.renderMessage({ username: 'System', timestamp: 't', message: 'xyz', kind: 'death' });
  assert.ok(death.classList.values.includes('death-message'), 'kind=death -> death-message without prose');

  const support = page.context.renderMessage({ username: 'System', timestamp: 't', message: 'xyz', kind: 'support' });
  assert.ok(support.classList.values.includes('support-message'));
  assert.ok(!support.classList.values.includes('skill-message'), 'a typed kind adds exactly one styling class');

  const combat = page.context.renderMessage({ username: 'System', timestamp: 't', message: 'xyz', kind: 'combat' });
  assert.ok(combat.classList.values.includes('speed-message'), 'kind=combat -> speed-message');
});

test('chat renderer falls back to prose for rows without a styled kind (plan 008)', () => {
  const page = loadChatPage();

  // Legacy/system rows (no styled kind) are still classified by their prose.
  const legacy = page.context.renderMessage({ username: 'System', timestamp: 't', message: 'ed has died from a fall.', kind: 'system' });
  assert.ok(legacy.classList.values.includes('death-message'), 'legacy system row classified by prose fallback');

  const undefinedKind = page.context.renderMessage({ username: 'System', timestamp: 't', message: 'ed wards ed for 5 ticks.' });
  assert.ok(undefinedKind.classList.values.includes('support-message'), 'undefined kind also falls back to prose');
});

test('chat socket reconnects after the connection closes (plan 008)', async () => {
  let constructed = 0;
  let socket;
  const page = loadChatPage({
    WebSocket: function WebSocket() {
      constructed += 1;
      socket = {};
      return socket;
    }
  });
  await flushPromises();
  assert.equal(constructed, 1, 'one socket constructed on load');

  // Harness setTimeout runs synchronously, so the backoff reconnect fires now.
  socket.onclose();
  assert.equal(constructed, 2, 'a fresh socket is constructed after a close');
  assert.ok(page.gets.length >= 0);
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
