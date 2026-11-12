const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function createPage(showPicker) {
  const listeners = {};
  const dateInput = {
    showPicker,
    addEventListener: (event, handler) => { listeners[event] = handler; },
    closest: () => ({ classList: { add() {} } })
  };
  let initialize;
  const context = vm.createContext({
    document: {
      addEventListener: (event, handler) => { if (event === 'DOMContentLoaded') initialize = handler; },
      getElementById: id => id === 'salesDate' ? dateInput : null,
      querySelector: () => null,
      body: { classList: { toggle() {} } }
    },
    requireLogin: async () => ({}),
    canAccess: () => true,
    isSuperUser: () => true
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/sales.js'), 'utf8'), context);
  vm.runInContext(`
    loadSalesConfiguration = async () => {};
    ensurePaymentTypeHistoryUI = () => {};
    loadSales = async () => { salesLoads++; };
    loadSummary = async () => { summaryLoads++; };
  `, Object.assign(context, { salesLoads: 0, summaryLoads: 0 }));
  await initialize();
  return { context, dateInput, listeners };
}

test('clicking the sales date input opens its native picker', async () => {
  let pickerCalls = 0;
  const { dateInput, listeners } = await createPage(() => { pickerCalls++; });
  listeners.click();
  assert.equal(pickerCalls, 1);
  assert.equal(dateInput.disabled, false);
  assert.equal(dateInput.value, dateInput.max);
});

test('sales date remains usable when showPicker is unavailable or fails', async () => {
  for (const picker of [undefined, () => { throw new Error('Picker unavailable'); }]) {
    const { context, listeners } = await createPage(picker);
    assert.doesNotThrow(() => listeners.click());
    await listeners.change();
    assert.equal(context.salesLoads, 2);
    assert.equal(context.summaryLoads, 2);
  }
});