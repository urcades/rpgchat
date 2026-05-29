const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('world map renders active event room coordinates in red', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../worker/static/success.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const gridContainer = {
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    }
  };

  const context = {
    document: {
      querySelector(selector) {
        return selector === '.grid-container' ? gridContainer : null;
      },
      createElement(tagName) {
        return {
          tagName,
          classList: {
            values: [],
            add(value) {
              this.values.push(value);
            }
          },
          dataset: {},
          href: '',
          textContent: ''
        };
      }
    },
    fetch(endpoint) {
      assert.equal(endpoint, '/world-events');
      return Promise.resolve({
        json: async () => [{ eventType: 'raid', row: 3, col: 4 }]
      });
    }
  };

  vm.createContext(context);
  vm.runInContext(script, context);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const raidRoom = gridContainer.children.find(child => child.textContent === '3, 4');
  const normalRoom = gridContainer.children.find(child => child.textContent === '3, 5');

  assert.ok(raidRoom.classList.values.includes('world-event-room'));
  assert.equal(raidRoom.dataset.eventType, 'raid');
  assert.equal(normalRoom.classList.values.includes('world-event-room'), false);
});
