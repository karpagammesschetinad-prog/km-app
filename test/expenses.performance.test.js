const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page() {
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    document: { addEventListener() {}, activeElement: null },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/expenses.js'), 'utf8'), context);
  vm.runInContext(`
    allCategories = [{ id: 'cat', name: 'Milk', typeId: 'type' }];
    allExpenses = [{ id: 'expense', date: '2026-01-01', category: 'Milk', typeId: 'type', amount: 100 }];
    allExpenseQuantities = [{ expenseId: 'expense', amount: 10, unitPrice: 50 }];
  `, context);
  return { context, timers };
}

test('balance indexes and results are reused across repeated badge renders', () => {
  const { context } = page();
  const index = context.getCategoryLedgerIndex();
  const result = context.categoryLedger('type', 'Milk', false);
  for (let i = 0; i < 50; i++) {
    assert.equal(context.getCategoryLedgerIndex(), index);
    assert.equal(context.categoryLedger('type', 'Milk', false), result);
  }
  assert.equal(result.balance, 400);
});

test('changing any balance dataset invalidates indexes and cached balance values', () => {
  const { context } = page();
  let prior = context.getCategoryLedgerIndex();
  for (const name of ['allExpenses', 'allCategories', 'allExpenseQuantities', 'allUnpaidQuantities']) {
    vm.runInContext(`${name} = ${name}.slice();`, context);
    const updated = context.getCategoryLedgerIndex();
    assert.notEqual(prior, updated);
    prior = updated;
  }
  vm.runInContext('allExpenses = [{ ...allExpenses[0], amount: 250 }];', context);
  assert.equal(context.categoryLedger('type', 'Milk', false).balance, 250);
});

test('draft link edits and historical end dates have separate cache results', () => {
  const { context } = page();
  vm.runInContext(`allUnpaidQuantities = [{ id: 'r', category: 'Milk', typeId: 'type', receivedDate: '2026-01-01', totalAmount: 100, paidAmount: 0 }];`, context);
  assert.equal(context.categoryLedger('type', 'Milk', true).balance, 500);
  vm.runInContext("pendingUnpaidLinks.set('r::row', { receiptId: 'r', amount: 50 });", context);
  assert.equal(context.categoryLedger('type', 'Milk', true).balance, 450);
  assert.equal(context.categoryLedger('type', 'Milk', false).balance, 500);
  assert.equal(context.categoryLedger('type', 'Milk', false, { to: '2025-12-31' }), null);
});

test('rapid typing schedules only one quantity rerender and save can flush it immediately', () => {
  const { context, timers } = page();
  let renders = 0;
  context.renderQuantityInputs = () => { renders++; };
  for (let i = 0; i < 20; i++) context.scheduleQuantityInputsRender();
  assert.equal(timers.size, 1);
  assert.equal(renders, 0);
  context.flushQuantityInputsRender();
  assert.equal(timers.size, 0);
  assert.equal(renders, 1);
});