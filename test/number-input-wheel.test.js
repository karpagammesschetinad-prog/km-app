const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/main.js'), 'utf8');
const handler = source.slice(source.indexOf('function preventNumberInputWheel'), source.indexOf('// Load config'));

function page() {
  const listeners = [];
  const document = { activeElement: null, addEventListener: (...args) => listeners.push(args) };
  const context = vm.createContext({ document });
  vm.runInContext(handler, context);
  return { context, document, listeners };
}

test('wheel does not change focused numeric inputs, including dynamically added inputs', () => {
  const { context, document, listeners } = page();
  assert.equal(listeners[0][0], 'wheel');
  assert.equal(listeners[0][2].passive, false);
  assert.equal(listeners[0][2].capture, true);
  const input = { matches: selector => selector === 'input[type="number"]' };
  document.activeElement = input;
  let prevented = false;
  context.preventNumberInputWheel({ target: input, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, input);
});

test('wheel scrolling elsewhere and over unfocused or text inputs remains available', () => {
  const { context, document } = page();
  for (const target of [{}, { matches: () => false }, { matches: () => true }]) {
    document.activeElement = target.matches?.() === false ? target : null;
    let prevented = false;
    context.preventNumberInputWheel({ target, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
  }
});