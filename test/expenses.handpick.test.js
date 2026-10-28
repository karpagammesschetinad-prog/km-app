const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page() {
  const elements = {};
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: id => elements[id] || (elements[id] = { value: '' }), querySelectorAll: () => [] },
    canAccess: () => true,
    formatCurrency: amount => String(amount),
    bootstrap: { Modal: { getOrCreateInstance: () => ({ show() {} }), getInstance: () => ({ hide() {} }) } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/expenses.js'), 'utf8'), context);
  return { context, elements };
}

test('handpick categories start with saved quantities selected, while other categories keep all fields', () => {
  const { context } = page();
  assert.equal(context.selectedQuantityFields({ handpickQuantities: false }, 'normal', []), null);
  assert.equal(context.selectedQuantityFields({ handpickQuantities: true }, 'new', []).size, 0);
  const selected = context.selectedQuantityFields({ handpickQuantities: true }, 'saved', [
    { quantityCategoryId: 'milk', amount: 10 },
    { quantityCategoryId: 'empty', amount: 0 },
    { quantityCategoryId: 'linked', amount: 10, sourceReceiptId: 'receipt' }
  ]);
  assert.equal(selected.size, 1);
  assert.equal(selected.has('milk'), true);
});

test('picker lists all quantity names and units with current selection', () => {
  const { context, elements } = page();
  const groups = [
    { hidden: false, querySelector: () => ({ dataset: { quantityCategoryId: 'a', name: 'Milk', unit: 'Litre' } }) },
    { hidden: true, querySelector: () => ({ dataset: { quantityCategoryId: 'b', name: '<Spices>', unit: 'Grams' } }) }
  ];
  context.openQuantityPicker({ dataset: { pickerCategory: 'Groceries' }, querySelectorAll: () => groups });
  assert.match(elements.quantityPickerOptions.innerHTML, /value="a" checked/);
  assert.doesNotMatch(elements.quantityPickerOptions.innerHTML, /value="b" checked/);
  assert.match(elements.quantityPickerOptions.innerHTML, /&lt;Spices&gt; \(Grams\)/);
  assert.equal(elements.quantityPickerCategory.textContent, 'Groceries');
});

test('applying picker shows selected fields and persists choices over rerender', () => {
  const { context } = page();
  const groups = ['a', 'b'].map(id => ({ hidden: true, querySelector: () => ({ dataset: { quantityCategoryId: id } }) }));
  const row = { isConnected: true, dataset: { pickerKey: 'key' }, querySelectorAll: () => groups };
  context.testRow = row;
  vm.runInContext('quantityPickerRow = testRow; expenseAutoSaveEnabled = false;', context);
  context.document.querySelectorAll = () => [{ value: 'b' }];
  context.refreshQuantityValues = () => {};
  context.updateQuantityRowSummary = () => {};
  context.applyQuantityPicker();
  assert.equal(groups[0].hidden, true);
  assert.equal(groups[1].hidden, false);
  const selected = context.selectedQuantityFields({ handpickQuantities: true }, 'key', []);
  assert.equal(selected.size, 1);
  assert.equal(selected.has('b'), true);
});

test('unselected fields are excluded from expense save payloads', () => {
  const { context } = page();
  context.CSS = { escape: value => value };
  const input = (id, hidden) => ({
    value: '10', dataset: { quantityCategoryId: id, name: id, unit: 'KG' },
    closest: selector => selector === '.configured-quantity-field' ? { hidden } : null
  });
  context.document.querySelector = () => ({ querySelectorAll: () => [input('selected', false), input('unchecked', true)] });
  const saved = context.collectQuantitiesFor({ dataset: { type: 'type', category: 'Groceries' } });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].quantityCategoryId, 'selected');
});

test('picker only appears for handpick categories and is disabled for approved expenses', () => {
  const { context } = page();
  assert.equal(context.quantityPickerButton({ handpickQuantities: false }, false), '');
  assert.match(context.quantityPickerButton({ handpickQuantities: true }, false), /Choose quantities/);
  assert.match(context.quantityPickerButton({ handpickQuantities: true }, true), /disabled/);
});

test('clear selection unchecks every quantity including hidden search results', () => {
  const { context } = page();
  const checks = [{ checked: true }, { checked: true }, { checked: false }];
  context.document.querySelectorAll = () => checks;
  context.clearQuantityPickerSelection();
  assert.ok(checks.every(input => !input.checked));
});

test('applying an empty selection clears numeric values and keeps selection empty on rerender', () => {
  const { context } = page();
  const amount = { value: '10' }, price = { value: '50' }, total = { value: '500' };
  const group = { hidden: false, dataset: { calculatedField: 'totalAmount' },
    querySelector: () => ({ dataset: { quantityCategoryId: 'milk' } }),
    querySelectorAll: () => [amount, price, total] };
  const row = { isConnected: true, dataset: { pickerKey: 'clear-key' }, querySelectorAll: () => [group] };
  context.testRow = row;
  vm.runInContext('quantityPickerRow = testRow; expenseAutoSaveEnabled = false;', context);
  context.refreshQuantityValues = () => {};
  context.updateQuantityRowSummary = () => {};
  context.applyQuantityPicker();
  assert.equal(group.hidden, true);
  assert.equal(amount.value, '');
  assert.equal(price.value, '');
  assert.equal(total.value, '');
  assert.equal(group.dataset.calculatedField, undefined);
  assert.equal(context.selectedQuantityFields({ handpickQuantities: true }, 'clear-key', [{ quantityCategoryId: 'milk', amount: 10 }]).size, 0);
});