const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPage() {
  const elements = {};
  const slots = [];
  let row = null;
  const context = vm.createContext({
    document: {
      addEventListener() {},
      getElementById: id => elements[id] || (elements[id] = { value: '', style: {}, innerHTML: '', textContent: '' }),
      querySelectorAll: selector => selector === '.category-pending-slot' ? slots : [],
      querySelector: () => row
    },
    CSS: { escape: value => value },
    URLSearchParams,
    formatCurrency: value => `INR ${Number(value || 0).toFixed(2)}`,
    formatDate: value => value,
    emptyRow: (columns, message) => `<tr><td colspan="${columns}">${message}</td></tr>`,
    isSuperUser: () => true,
    canAccess: () => true
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/expenses.js'), 'utf8'), context);
  const set = (name, value) => { context.testValue = value; vm.runInContext(`${name} = testValue;`, context); };
  set('allCategoryTypes', [{ id: 'type-a', name: 'Vendors' }, { id: 'type-b', name: 'Other' }]);
  return { context, elements, slots, set, setRow: value => { row = value; } };
}

const milk = (id, date, amount, extra = {}) => ({ id, date, category: 'Milk', typeId: 'type-a', amount, mode: 'Daily Cash', approvalStatus: 'Approved', ...extra });
const quantity = (expenseId, amount, unitPrice, extra = {}) => ({ expenseId, name: 'Volume', unit: 'Litre', amount, unitPrice, ...extra });

test('pending occasional payments remain visible across dates until an amount is entered', () => {
  const { context, elements, set } = createPage();
  set('allExpenses', [
    milk('old', '2026-01-01', 0, { mode: 'Occasional', approvalStatus: 'Pending', category: '<Repair>' }),
    milk('cash', '2026-01-02', 0, { mode: 'Occasional Cash', approvalStatus: 'Pending' }),
    milk('paid', '2026-01-03', 100, { mode: 'Occasional', approvalStatus: 'Pending' }),
    milk('daily', '2026-01-04', 0)
  ]);
  context.renderPendingOccasionalExpenses(new Map([['type-a', 'Vendor']]), true);
  assert.equal(elements.pendingOccasionalExpenses.hidden, false);
  assert.equal(elements.pendingOccasionalCount.textContent, 2);
  assert.match(elements.pendingOccasionalList.innerHTML, /&lt;Repair&gt;/);
  assert.match(elements.pendingOccasionalList.innerHTML, /2026-01-01/);
  assert.match(elements.pendingOccasionalList.innerHTML, /Enter amount/);
  assert.doesNotMatch(elements.pendingOccasionalList.innerHTML, /'paid'/);
  assert.match(context.pendingOccasionalPaymentBadge({ mode: 'Occasional', amount: 0 }), /Payment pending/);
  assert.equal(context.pendingOccasionalPaymentBadge({ mode: 'Occasional', amount: 100 }), '');
  set('allExpenses', []);
  context.renderPendingOccasionalExpenses(new Map(), true);
  assert.equal(elements.pendingOccasionalExpenses.hidden, true);
});

test('entering an older occasional payment preserves its original date and quantities', async () => {
  const { context, elements } = createPage();
  elements.occasionalExpenseForm = { checkValidity: () => true };
  elements.occasionalExpenseDate = { value: '2026-01-01' };
  elements.expDate = { value: '2026-02-01' };
  elements.occasionalExpenseType = { value: 'type-a' };
  elements.occasionalExpenseCategory = { value: 'Milk' };
  elements.occasionalExpenseAmount = { value: '150' };
  elements.occasionalExpenseRemarks = { value: '' };
  elements.btnSaveOccasionalExpense = {};
  context.bootstrap = { Modal: { getInstance: () => ({ hide() {} }) } };
  context.showNotification = () => {};
  context.renderOccasionalExpenses = () => {};
  const requests = [];
  context.api = async (method, url, payload) => { requests.push({ method, url, payload }); return []; };
  vm.runInContext("editingOccasionalExpenseId = 'old';", context);
  await context.saveOccasionalExpense();
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].payload.date, '2026-01-01');
  assert.equal(requests[0].payload.amount, 150);
  assert.equal('quantities' in requests[0].payload, false);
});

test('occasional quantity fields do not block loading daily expenses on November 2, 2026', () => {
  for (const mode of ['Occasional', 'Occasional Cash']) {
    for (const savedPrice of [0, 75]) {
      const { context, elements, set } = createPage();
      const date = '2026-11-02';
      elements.expDate = { value: date };
      elements.occasionalQuantityBody = { innerHTML: '', querySelectorAll: () => [] };
      set('allCategories', [{ id: 'cat-repair', name: 'Repair', typeId: 'type-a' }]);
      set('allQuantityCategories', [{ id: 'parts', categoryId: 'cat-repair', name: 'Parts', unit: 'Count', defaultQuantity: 2 }]);
      set('allExpenses', [
        milk('old-repair', '2026-11-01', 100, { category: 'Repair', mode }),
        milk('repair', date, 150, { category: 'Repair', mode, approvalStatus: 'Pending' })
      ]);
      set('allExpenseQuantities', [
        quantity('old-repair', 2, 50, { quantityCategoryId: 'parts', name: 'Parts', unit: 'Count' }),
        ...(savedPrice ? [quantity('repair', 2, savedPrice, { quantityCategoryId: 'parts', name: 'Parts', unit: 'Count' })] : [])
      ]);
      context.approvalStatusBadge = value => value;
      context.updateDateStatusColor = () => {};
      context.renderExpenseDatePicker = () => {};
      let dailyFormLoaded = false;
      context.buildCategoryInputs = (existing, readOnly) => {
        dailyFormLoaded = true;
        assert.equal(Object.keys(existing).length, 0);
        assert.equal(readOnly, false);
      };

      assert.doesNotThrow(() => context.loadDateIntoForm(date), `${mode}, saved price ${savedPrice}`);
      assert.equal(dailyFormLoaded, true);
      assert.equal(elements.btnSaveExpense.disabled, false);
      assert.equal(elements.expRemarks.readOnly, false);
      assert.match(elements.occasionalQuantityBody.innerHTML, /data-occasional-expense-id="repair"/);
      assert.match(elements.occasionalQuantityBody.innerHTML, new RegExp(`aria-label="Price per unit"[^>]*value="${savedPrice || 50}"`));
      assert.match(elements.occasionalQuantityBody.innerHTML, /quantity-field-name[^]*<span>Item<\/span>[^]*Parts/);
      assert.match(elements.occasionalQuantityBody.innerHTML, /quantity-field-amount[^]*<span>Quantity<\/span>[^]*occasional-tab-quantity/);
      assert.match(elements.occasionalQuantityBody.innerHTML, /quantity-field-unit[^]*<span>Unit<\/span>[^]*Count/);
    }
  }
});

test('ledger balance is goods at entered unit prices less payments, regardless of the expense amount', () => {
  const { context, set } = createPage();
  set('allUnpaidQuantities', [
    { id: 'r1', typeId: 'type-a', category: 'Milk', receivedDate: '2026-01-01', totalAmount: 1000, paidAmount: 400, payments: [{ expenseId: 'p1', amount: 400 }] }
  ]);
  set('allExpenses', [
    milk('old', '2025-12-31', 999),
    milk('p1', '2026-01-10', 400),
    milk('e1', '2026-01-12', 300),
    milk('e2', '2026-01-15', 200)
  ]);
  set('allExpenseQuantities', [quantity('e1', 10, 50)]);
  const ledger = context.categoryLedger('type-a', 'Milk');
  assert.equal(ledger.start, '2026-01-01');
  assert.equal(ledger.received, 1500);
  assert.equal(ledger.paid, 900);
  assert.equal(ledger.balance, 600);
});

test('an expense with priced quantities that equals their value leaves the balance unchanged', () => {
  const { context, set } = createPage();
  set('allUnpaidQuantities', []);
  set('allExpenses', [milk('e1', '2026-01-12', 500)]);
  set('allExpenseQuantities', [quantity('e1', 10, 50)]);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 0);
  assert.equal(context.pendingBadgeHtml('type-a', 'Milk'), '');
});

test('part payment of received goods leaves a pending balance and overpayment becomes an advance', () => {
  const { context, set } = createPage();
  set('allUnpaidQuantities', []);
  set('allExpenseQuantities', [quantity('e1', 10, 50)]);
  set('allExpenses', [milk('e1', '2026-01-12', 200)]);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 300);
  assert.match(context.pendingBadgeHtml('type-a', 'Milk'), /INR 300.00 pending/);
  set('allExpenses', [milk('e1', '2026-01-12', 200), milk('e2', '2026-01-13', 450)]);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, -150);
  assert.match(context.pendingBadgeHtml('type-a', 'Milk'), /INR 150.00 advance/);
});

test('quantities saved without a price are treated as paid on the spot', () => {
  const { context, set } = createPage();
  set('allUnpaidQuantities', []);
  set('allExpenseQuantities', [quantity('e1', 10, 50), quantity('e2', 5, 0)]);
  set('allExpenses', [milk('e1', '2026-01-12', 500), milk('e2', '2026-01-13', 275)]);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 0);
});

test('payments before the first priced entry are ignored and unpriced categories have no balance', () => {
  const { context, set } = createPage();
  set('allUnpaidQuantities', []);
  set('allExpenseQuantities', [quantity('e2', 10, 50)]);
  set('allExpenses', [milk('e1', '2026-01-01', 800), milk('e2', '2026-01-12', 500)]);
  assert.equal(context.categoryLedger('type-a', 'Milk').start, '2026-01-12');
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 0);
  set('allExpenseQuantities', []);
  assert.equal(context.categoryLedger('type-a', 'Milk'), null);
  assert.equal(context.categoryLedger('type-a', ''), null);
});

test('ledger keeps types, categories and employee payments separate and ignores case', () => {
  const { context, set } = createPage();
  set('allUnpaidQuantities', []);
  set('allExpenseQuantities', [quantity('e1', 10, 50)]);
  set('allExpenses', [
    milk('e1', '2026-01-12', 100, { category: 'MILK ' }),
    milk('other-type', '2026-01-13', 100, { typeId: 'type-b' }),
    milk('other-category', '2026-01-13', 100, { category: 'Rice' }),
    milk('salary', '2026-01-13', 100, { employeeId: 'emp' })
  ]);
  assert.equal(context.categoryLedger('type-a', 'milk').balance, 400);
  assert.equal(context.categoryLedger('type-b', 'Milk'), null);
});

test('on-spot string matches include priced receipts and payments in the existing category ledger', () => {
  const { context, set, elements } = createPage();
  set('allCategories', [{ id: 'cat', name: 'Fresh Milk', typeId: 'type-a', openingBalance: 200, balanceUpdatedAt: '2026-01-01' }]);
  set('allExpenses', [
    milk('regular', '2026-02-01', 100, { category: 'Fresh Milk' }),
    milk('spot', '2026-02-02', 50, { category: ' fresh   MILK ', typeId: 'type-b', onSpot: true }),
    milk('payment', '2026-02-03', 100, { category: 'FRESH MILK', onSpot: true })
  ]);
  set('allExpenseQuantities', [quantity('regular', 10, 50), quantity('spot', 2, 50)]);
  assert.equal(context.categoryLedger('type-a', 'Fresh Milk').balance, 550);
  assert.equal(context.categoryLedger('type-b', 'fresh milk').balance, 550);
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesTotals.innerHTML, /Total pending: INR 550.00/);
  assert.match(elements.categoryBalancesBody.innerHTML, /INR 550.00/);
  assert.doesNotMatch(elements.categoryBalancesBody.innerHTML, /2 Litre/);
});

test('ambiguous on-spot names prefer their own type and never combine other category balances', () => {
  const { context, set } = createPage();
  set('allCategories', [
    { id: 'a', name: 'Milk', typeId: 'type-a', openingBalance: 100 },
    { id: 'b', name: 'Milk', typeId: 'type-b', openingBalance: 200 }
  ]);
  set('allExpenses', [milk('spot', '2026-02-01', 50, { onSpot: true })]);
  set('allExpenseQuantities', [quantity('spot', 2, 50)]);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 150);
  assert.equal(context.categoryLedger('type-b', 'Milk').balance, 200);
  assert.equal(context.balanceCategory('unknown', 'Milk', true), null);
});

test('money applied to a receipt of another category counts against that receipt only', () => {
  const { context, set } = createPage();
  set('allUnpaidQuantities', [
    { id: 'r1', typeId: 'type-a', category: 'Rice', receivedDate: '2026-01-01', totalAmount: 600, paidAmount: 250, payments: [{ expenseId: 'e1', amount: 250 }] }
  ]);
  set('allExpenseQuantities', [quantity('e1', 10, 50)]);
  set('allExpenses', [milk('e1', '2026-01-12', 400)]);
  assert.equal(context.categoryLedger('type-a', 'Rice').balance, 350);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 350);
});

test('links waiting to be saved reduce the receipt balance and never exceed it', () => {
  const { context, set } = createPage();
  set('allExpenses', []);
  set('allExpenseQuantities', []);
  set('allUnpaidQuantities', [{ id: 'r1', typeId: 'type-a', category: 'Milk', receivedDate: '2026-01-01', totalAmount: 500, paidAmount: 100 }]);
  set('pendingUnpaidLinks', new Map([['r1::row', { receiptId: 'r1', amount: 150 }]]));
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 250);
  set('pendingUnpaidLinks', new Map([['r1::row', { receiptId: 'r1', amount: 900 }]]));
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 0);
});

test('category badges refresh in place and escape names', () => {
  const { context, slots, set } = createPage();
  set('allUnpaidQuantities', [{ id: 'r1', typeId: 'type-a', category: 'Rice', receivedDate: '2026-01-01', totalAmount: 250, paidAmount: 0 }]);
  set('allExpenses', []);
  set('allExpenseQuantities', []);
  const slot = { dataset: { pendingType: 'type-a', pendingCategory: 'Rice' }, innerHTML: '' };
  slots.push(slot);
  context.refreshCategoryPendingBadges();
  assert.match(slot.innerHTML, /INR 250.00 pending/);
  set('allUnpaidQuantities', []);
  context.refreshCategoryPendingBadges();
  assert.match(slot.innerHTML, /INR 0.00 pending/);
  assert.match(context.pendingSlotHtml('type-a', '<b>x</b>'), /&lt;b&gt;x&lt;\/b&gt;/);
});

function fakeGroup({ quantity: quantityValue, price }) {
  const target = { textContent: '' };
  const fields = {
    '.expense-quantity, .occasional-tab-quantity, .occasional-onspot-quantity': { value: quantityValue },
    '.expense-quantity-price': { value: price },
    '.quantity-value': target
  };
  return { target, group: { querySelector: selector => fields[selector] } };
}

test('each quantity shows its value from quantity and entered unit price', () => {
  const { context } = createPage();
  const priced = fakeGroup({ quantity: '10', price: '52.5' });
  context.updateQuantityValue(priced.group);
  assert.equal(priced.target.textContent, '= INR 525.00');
  const blank = fakeGroup({ quantity: '10', price: '' });
  context.updateQuantityValue(blank.group);
  assert.equal(blank.target.textContent, '');
});

test('quantity inputs calculate the blank field from the other two values', () => {
  const { context } = createPage();
  for (const [amount, price, total, key, expected] of [
    ['10', '50', '', 'totalAmount', '500'],
    ['10', '', '500', 'unitPrice', '50'],
    ['', '50', '500', 'amount', '10'],
    ['0', '', '500', 'unitPrice', ''],
    ['', '0', '500', 'amount', '']
  ]) {
    const fields = { amount: { value: amount }, unitPrice: { value: price }, totalAmount: { value: total } };
    const group = { dataset: {}, querySelector: selector => ({
      '.expense-quantity, .occasional-tab-quantity, .occasional-onspot-quantity': fields.amount,
      '.expense-quantity-price': fields.unitPrice, '.expense-quantity-total': fields.totalAmount
    })[selector] };
    context.updateQuantityValue(group);
    assert.equal(fields[key].value, expected);
    if (key === 'totalAmount') {
      fields.amount.value = '12';
      context.updateQuantityValue(group, fields.amount);
      assert.equal(fields.totalAmount.value, '600');
      fields.totalAmount.value = '700';
      context.updateQuantityValue(group, fields.totalAmount);
      assert.equal(fields.totalAmount.value, '700');
    }
  }
});

test('the row summary compares received value with the expense amount without deriving a price', () => {
  const { context } = createPage();
  const first = fakeGroup({ quantity: '10', price: '50' });
  const second = fakeGroup({ quantity: '2', price: '100' });
  const target = { textContent: '' };
  const row = {
    dataset: { expenseAmount: '300' },
    querySelector: selector => selector === '.quantity-row-summary' ? target : null,
    querySelectorAll: selector => selector === '.quantity-price-group' ? [first.group, second.group] : []
  };
  context.updateQuantityRowSummary(row);
  assert.equal(target.textContent, 'Received value INR 700.00 · This expense INR 300.00');
  first.group.querySelector('.expense-quantity-price').value = '';
  second.group.querySelector('.expense-quantity-price').value = '';
  context.updateQuantityRowSummary(row);
  assert.equal(target.textContent, '');
});

test('the price input is labelled for assistive technology and lockable', () => {
  const { context } = createPage();
  assert.match(context.quantityPriceInputHtml(52.5, false), /aria-label="Price per unit"[^>]*value="52.5"/);
  assert.doesNotMatch(context.quantityPriceInputHtml(52.5, false), /readonly disabled/);
  assert.match(context.quantityPriceInputHtml(52.5, false), /Previous price is suggested when available and can be edited/);
  assert.match(context.quantityPriceInputHtml(0, true), /value=""[^>]* readonly disabled/);
  assert.doesNotMatch(context.quantityPriceInputHtml(52.5, false), /quantity-value/);
  assert.match(context.quantityPriceInputHtml(52.5, false), /expense-quantity-total/);
});

test('quantity price suggestion uses the latest earlier saved price for the same quantity and unit', () => {
  const { context, elements, set } = createPage();
  elements.expDate = { value: '2026-02-03' };
  set('allExpenses', [
    milk('old-price', '2026-02-01'),
    milk('latest-price', '2026-02-02'),
    milk('other-type', '2026-02-02', 100, { typeId: 'type-b' }),
    milk('current-day', '2026-02-03')
  ]);
  set('allExpenseQuantities', [
    { expenseId: 'old-price', quantityCategoryId: 'q-volume', name: 'Volume', unit: 'Litre', amount: 10, unitPrice: 40 },
    { expenseId: 'latest-price', quantityCategoryId: 'q-volume', name: 'Volume', unit: 'Litre', amount: 10, unitPrice: 55 },
    { expenseId: 'latest-price', quantityCategoryId: 'q-weight', name: 'Weight', unit: 'KG', amount: 2, unitPrice: 80 },
    { expenseId: 'other-type', quantityCategoryId: 'q-volume', name: 'Volume', unit: 'Litre', amount: 10, unitPrice: 99 },
    { expenseId: 'current-day', quantityCategoryId: 'q-volume', name: 'Volume', unit: 'Litre', amount: 10, unitPrice: 66 }
  ]);

  assert.equal(context.previousUnitPrice({ quantityCategoryId: 'q-volume', name: 'Volume', unit: 'Litre', typeId: 'type-a', category: 'Milk' }), 55);
  assert.equal(context.previousUnitPrice({ quantityCategoryId: 'q-weight', name: 'Weight', unit: 'KG', typeId: 'type-a', category: 'Milk' }), 80);
  assert.equal(context.previousUnitPrice({ quantityCategoryId: 'onspot:type-a:Volume', name: 'Volume', unit: 'KG', typeId: 'type-a', category: 'Milk' }), '');
});

test('on-spot quantity input prepopulates the prior price and remains editable', () => {
  const { context, elements, set } = createPage();
  elements.expDate = { value: '2026-02-03' };
  set('allExpenses', [milk('previous', '2026-02-02')]);
  set('allExpenseQuantities', [{ expenseId: 'previous', name: 'Green leaves', unit: 'KG', amount: 2, unitPrice: 30 }]);
  const html = context.onSpotQuantityInput({ name: 'Green leaves', unit: 'KG' }, 'expense-quantity', { typeId: 'type-a', category: 'Milk' });
  assert.match(html, /aria-label="Price per unit"[^>]*value="30"(?![^>]*readonly)/);
  const clearedDraft = context.onSpotQuantityInput({ name: 'Green leaves', unit: 'KG' }, 'expense-quantity', { typeId: 'type-a', category: 'Milk', preserveBlankPrice: true });
  assert.match(clearedDraft, /aria-label="Price per unit"[^>]*value=""/);
});

test('on-spot quantity offers and retains the selected Grams unit', () => {
  const { context } = createPage();
  const html = context.onSpotQuantityInput({ name: 'Spices', unit: 'Grams', amount: 100, unitPrice: 2 });
  assert.match(html, /<option selected>Grams<\/option>/);
  assert.match(html, /quantity-field-name[^]*<span>Item<\/span>[^]*expense-quantity-name/);
  assert.match(html, /quantity-field-amount[^]*<span>Quantity<\/span>/);
  assert.match(html, /quantity-field-price[^]*Price \/ unit/);
  assert.match(html, /quantity-field-total[^]*Total/);
});

test('linked quantities use the same labeled layout and escape item names', () => {
  const { context } = createPage();
  const html = context.linkedQuantityInputHtml({ name: '<Milk>', amount: 3, unit: 'Litre' });
  assert.match(html, /quantity-linked/);
  assert.match(html, /quantity-field-name[^]*&lt;Milk&gt;/);
  assert.match(html, /quantity-field-amount[^]*value="3" readonly disabled/);
  assert.match(html, /quantity-field-unit[^]*Litre/);
});

test('daily and occasional quantity tables use category cards with horizontal headers', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/expenses.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');
  assert.match(html, /<table class="[^"]*quantity-cards[^"]*" id="quantityInputsTable"/);
  assert.match(html, /<table class="[^"]*quantity-cards[^"]*">[^]*?<tbody id="occasionalQuantityBody"/);
  assert.match(css, /\.quantity-cards tbody tr,[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.quantity-cards tbody td\[data-label="Quantities"\]\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

test('quantity fields use compact rows on desktop and reflow on narrow screens', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');
  assert.match(css, /\.quantity-price-group,\s*\.quantity-linked\s*\{[^}]*grid-template-columns:[^;]+;[^}]*min-width:\s*33rem/);
  assert.match(css, /@container quantity-list\s*\(max-width:\s*34rem\)\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*min-width:\s*0/);
  assert.match(css, /\.quantity-field input,\s*\.quantity-field select\s*\{[^}]*font-size:\s*\.75rem/);
  assert.match(css, /\.quantity-toolbar\s*\{[^}]*display:\s*flex/);
});

test('expanded category and focused quantity have separate highlights', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/styles.css'), 'utf8');
  assert.match(css, /\.quantity-cards tbody tr:has\(\.quantity-section-toggle\[aria-expanded="true"\]\)\s*\{[^}]*border-color:/);
  assert.match(css, /\.quantity-price-group:focus-within\s*\{[^}]*background:[^}]*outline:/);
});

test('occasional quantity save is beside the chooser and hidden when approved', () => {
  const { context, elements, set } = createPage();
  elements.expDate = { value: '2026-02-03' };
  elements.occasionalQuantityBody = { innerHTML: '', querySelectorAll: () => [] };
  set('allCategories', [{ id: 'cat', typeId: 'type-a', name: 'Milk', handpickQuantities: true }]);
  const expense = milk('e1', '2026-02-03', 100, { mode: 'Occasional', approvalStatus: 'Pending' });
  context.renderOccasionalQuantityInputs([expense], new Map([['type-a', 'Vendors']]), true);
  assert.match(elements.occasionalQuantityBody.innerHTML, /quantity-toolbar[^]*Choose quantities[^]*title="Save quantities"[^]*saveOccasionalQuantities\('e1', this\)[^]*<\/div>/);
  context.renderOccasionalQuantityInputs([{ ...expense, approvalStatus: 'Approved' }], new Map(), true);
  assert.doesNotMatch(elements.occasionalQuantityBody.innerHTML, /title="Save quantities"/);
});

test('quantity sections toggle independently and retain their state on rerender', () => {
  const { context } = createPage();
  const key = JSON.stringify(['2026-02-03', 'daily', 'type-a', 'milk', false]);
  const otherKey = JSON.stringify(['2026-02-03', 'occasional', 'e1']);
  const content = { hidden: true };
  const label = { textContent: 'Show' };
  const attributes = {};
  const button = {
    dataset: { quantitySectionKey: key, quantityCategory: 'Milk' },
    closest: () => ({ querySelector: () => content }),
    setAttribute: (name, value) => { attributes[name] = value; },
    querySelector: () => label
  };
  assert.match(context.quantitySectionToggleHtml(key, 'Milk'), /aria-expanded="false"/);
  assert.match(context.quantitySectionCellHtml(key, '<input value="7">'), /quantity-section-cell [^"]*" hidden><input value="7">/);
  context.toggleQuantitySection(button);
  assert.equal(content.hidden, false);
  assert.equal(attributes['aria-expanded'], 'true');
  assert.equal(attributes['aria-label'], 'Hide quantities for Milk');
  assert.equal(label.textContent, 'Hide');
  assert.match(context.quantitySectionToggleHtml(key, 'Milk'), /aria-expanded="true"/);
  assert.doesNotMatch(context.quantitySectionCellHtml(key, ''), / hidden/);
  assert.match(context.quantitySectionToggleHtml(otherKey, 'Milk'), /aria-expanded="false"/);
  context.toggleQuantitySection(button);
  assert.equal(content.hidden, true);
  assert.equal(attributes['aria-expanded'], 'false');
  assert.equal(label.textContent, 'Show');
  assert.match(context.quantitySectionToggleHtml(key, 'Milk'), /aria-expanded="false"/);
});

test('occasional quantities start hidden with the toggle in the category row', () => {
  const { context, elements, set } = createPage();
  elements.expDate = { value: '2026-02-03' };
  elements.occasionalQuantityBody = { innerHTML: '', querySelectorAll: () => [] };
  set('allCategories', [{ id: 'cat', typeId: 'type-a', name: 'Milk' }]);
  set('allQuantityCategories', [{ id: 'q1', categoryId: 'cat', name: 'Milk', unit: 'Litre', defaultQuantity: 3 }]);
  const expense = milk('e1', '2026-02-03', 100, { mode: 'Occasional', approvalStatus: 'Pending' });
  context.renderOccasionalQuantityInputs([expense], new Map(), true);
  assert.match(elements.occasionalQuantityBody.innerHTML, /<td data-label="Category"[^]*quantity-section-toggle[^]*aria-expanded="false"[^]*<\/td><td[^]*quantity-section-cell [^"]*" hidden>[^]*occasional-tab-quantity[^]*value="3"/);
  assert.match(elements.occasionalQuantityBody.innerHTML, /title="Save quantities"/);
});

test('daily quantity save uses the existing bulk save and queues behind an active save', async () => {
  const { context } = createPage();
  context.clearTimeout = () => {};
  let saves = 0;
  context.save = async () => { saves++; };
  const button = { disabled: false };
  await context.saveDailyQuantities(button);
  assert.equal(saves, 1);
  assert.equal(button.disabled, false);
  vm.runInContext('autoSaveInFlight = true;', context);
  context.setAutoSaveStatus = () => {};
  await context.saveDailyQuantities(button);
  assert.equal(saves, 1);
  assert.equal(vm.runInContext('autoSavePending', context), true);
});

test('saving collects the unit price entered beside each quantity', () => {
  const { context, setRow } = createPage();
  const input = (name, amount, price, custom) => ({
    value: amount, dataset: { quantityCategoryId: custom ? '' : `q-${name}`, name, unit: 'Litre' },
    closest: selector => {
      if (selector === '.onspot-quantity') return custom ? { querySelector: s => s === '.expense-quantity-name' ? { value: name } : { value: 'KG' } } : null;
      if (selector === '.quantity-price-group') return { querySelector: () => ({ value: price }) };
      return null;
    }
  });
  setRow({ querySelectorAll: () => [input('Milk', '10', '52.5'), input('Curd', '2', '', true), input('Zero', '0', '9')] });
  const quantities = context.collectQuantitiesFor({ dataset: { type: 'type-a', category: 'Milk', quantityRowKey: 'k' } });
  assert.equal(JSON.stringify(quantities.map(item => [item.name, item.unit, item.amount, item.unitPrice])),
    JSON.stringify([['Milk', 'Litre', '10', '52.5'], ['Curd', 'KG', '2', '']]));
});

test('quantity report averages the unit prices entered and notes unpriced quantities', () => {
  const { context, elements, set } = createPage();
  set('allExpenseQuantities', [
    quantity('e1', 10, 40), quantity('e2', 10, 60), quantity('e3', 5, 0),
    { expenseId: 'e1', name: 'Curd', unit: 'KG', amount: 2, unitPrice: 0 }
  ]);
  context.renderQuantitySummary([{ id: 'e1', amount: 1 }, { id: 'e2', amount: 999999 }, { id: 'e3', amount: 5 }]);
  const html = elements.quantityReportBody.innerHTML;
  assert.match(html, /Volume[\s\S]*INR 50.00 \/ Litre/);
  assert.match(html, /Based on 20 of 25 Litre/);
  assert.match(html, /Curd[\s\S]*—/);
  assert.match(elements.quantityReportFoot.innerHTML, /<td><\/td><td><\/td>/);
});

test('report categories show the net balance', () => {
  const { context, elements, set } = createPage();
  context.getSelectedCats = () => [];
  context.getSelectedTypeIds = () => [];
  context.isReportSectionVisible = () => true;
  context.renderOccasionalSummary = () => {};
  context.renderCategoryTypeSummary = () => {};
  context.renderQuantitySummary = () => {};
  context.renderReportChart = () => {};
  context.approvalStatusBadge = status => status;
  set('allUnpaidQuantities', [{ id: 'r1', typeId: 'type-a', category: 'Rice', receivedDate: '2026-01-01', totalAmount: 250, paidAmount: 0 }]);
  set('allExpenseQuantities', [quantity('e1', 10, 50)]);
  set('allExpenses', [
    milk('e1', '2026-02-01', 200),
    milk('x2', '2026-02-01', 100, { category: 'Rice' }),
    milk('x3', '2026-02-01', 10, { category: 'Salt' })
  ]);
  context.renderSummary();
  const html = elements.expBody.innerHTML;
  assert.match(html, /Milk: INR 200.00/);
  assert.match(html, /Rice: INR 100.00/);
  assert.doesNotMatch(html, /INR 300.00 pending|INR 150.00 pending/);
  assert.doesNotMatch(html, /Salt: INR 10.00<span/);
});

test('occasional report rows show the category balance', () => {
  const { context, elements, set } = createPage();
  context.approvalStatusBadge = status => status;
  set('allUnpaidQuantities', [{ id: 'r1', typeId: 'type-a', category: 'Milk', receivedDate: '2026-01-01', totalAmount: 400, paidAmount: 0 }]);
  set('allExpenses', []);
  set('allExpenseQuantities', []);
  context.renderOccasionalSummary([{ id: 'o1', date: '2026-02-01', category: 'Milk', typeId: 'type-a', amount: 50, approvalStatus: 'Pending' }]);
  assert.match(elements.occasionalReportBody.innerHTML, /Milk/);
  assert.doesNotMatch(elements.occasionalReportBody.innerHTML, /INR 400.00 pending/);
});

test('the quantity report has a matching average price column', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/expenses.html'), 'utf8');
  assert.match(html, /<th class="text-end">Total<\/th><th class="text-end">Avg Price \/ Unit<\/th>/);
});

test('received-without-payment creation workflow is removed without removing historical balance support', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/expenses.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/expenses.js'), 'utf8');
  assert.doesNotMatch(html, /btnAddUnpaidDaily|btnAddUnpaidOccasional|unpaidQuantityModal|Received without payment/);
  assert.doesNotMatch(source, /openUnpaidQuantityModal|saveUnpaidQuantityFromModal|editingUnpaidQuantityId/);
  assert.match(source, /function categoryLedger/);
  assert.match(source, /function renderUnpaidQuantities/);
});

test('category pending payments are inside the existing report without a separate popup', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/expenses.html'), 'utf8');
  const reportStart = html.indexOf('id="reportModal"');
  const balancesStart = html.indexOf('id="categoryBalancesReportSection"');
  const scriptsStart = html.indexOf('<script src=');
  assert.ok(reportStart >= 0 && balancesStart > reportStart && balancesStart < scriptsStart);
  assert.doesNotMatch(html, /id="categoryBalancesModal"|id="btnCategoryBalances"/);
  assert.equal((html.match(/id="categoryBalancesBody"/g) || []).length, 1);
  assert.match(html, /id="categoryBalancesReportSection"[^>]*hidden/);
});

test('report pending payments load only on demand and can be hidden again', async () => {
  const { context, elements } = createPage();
  const section = { hidden: true };
  const button = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  elements.categoryBalancesReportSection = section;
  elements.btnToggleCategoryBalances = button;
  let loads = 0;
  context.openCategoryBalances = async () => { loads++; };
  context.resetCategoryBalancesVisibility();
  assert.equal(loads, 0);
  assert.equal(section.hidden, true);
  await context.toggleCategoryBalances();
  assert.equal(loads, 1);
  assert.equal(section.hidden, false);
  assert.equal(button.attributes['aria-expanded'], 'true');
  await context.toggleCategoryBalances();
  assert.equal(loads, 1);
  assert.equal(section.hidden, true);
  assert.equal(button.textContent, 'Show Pending Payments');
  assert.equal(button.attributes['aria-expanded'], 'false');
});

test('pending report shows only category pending amounts, excluding advances and details', () => {
  const { context, elements, set } = createPage();
  set('allExpenses', [milk('e1', '2026-02-01', 200), milk('e2', '2026-02-01', 250, { category: 'Rice' })]);
  set('allExpenseQuantities', [quantity('e1', 10, 50), quantity('e2', 2, 100)]);
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesTotals.innerHTML, /Total pending: INR 300.00/);
  const html = elements.categoryBalancesBody.innerHTML;
  assert.match(html, /Milk/);
  assert.match(html, /INR 300.00/);
  assert.doesNotMatch(html, /Rice|10 Litre|Received value|Payments:|<details|<form/);
  assert.doesNotMatch(elements.categoryBalancesTotals.innerHTML, /Advances/);
});

test('category popup uses saved receipt payments and escapes category and quantity names', () => {
  const { context, elements, set } = createPage();
  set('allUnpaidQuantities', [{ id: 'r1', typeId: 'type-a', category: '<img>', receivedDate: '2026-01-01', totalAmount: 500, paidAmount: 100, items: [{ name: '<script>', amount: 10, unit: 'KG' }] }]);
  set('pendingUnpaidLinks', new Map([['draft', { receiptId: 'r1', amount: 150 }]]));
  set('allExpenses', [milk('paid', '2026-01-02', 100, { category: '<img>' })]);
  set('allUnpaidQuantities', [{ id: 'r1', typeId: 'type-a', category: '<img>', receivedDate: '2026-01-01', totalAmount: 500, paidAmount: 100, payments: [{ expenseId: 'paid', amount: 100 }] }]);
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesTotals.innerHTML, /Total pending: INR 400.00/);
  assert.match(elements.categoryBalancesBody.innerHTML, /&lt;img&gt;/);
  assert.doesNotMatch(elements.categoryBalancesBody.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(elements.categoryBalancesBody.innerHTML, /<img>|<script>/);
});

test('category popup refreshes its datasets and reports loading failures', async () => {
  const { context, elements } = createPage();
  let shown = 0;
  context.bootstrap = { Modal: { getOrCreateInstance: () => ({ show() { shown++; } }) } };
  context.api = async (method, endpoint) => ({
    '/expenses': [milk('e1', '2026-02-01', 200)],
    '/expenses/quantities': [quantity('e1', 10, 50)],
    '/expenses/unpaid?includeSettled=1': [], '/categories': []
  })[endpoint];
  await context.openCategoryBalances();
  assert.equal(shown, 0);
  assert.match(elements.categoryBalancesTotals.innerHTML, /INR 300.00/);
  context.api = async () => { throw new Error('Offline'); };
  await context.openCategoryBalances();
  assert.match(elements.categoryBalancesBody.textContent, /Unable to load category balances: Offline/);
  assert.equal(elements.categoryBalancesTotals.textContent, '');
});

test('category popup handles empty data', () => {
  const { context, elements } = createPage();
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesBody.innerHTML, /No pending payments for the selected filters/);
  assert.match(elements.categoryBalancesTotals.innerHTML, /Total pending: INR 0.00/);
});

test('previous balance adds to goods received less payments and updates instead of accumulating', () => {
  const { context, set } = createPage();
  const category = { id: 'cat', name: 'Milk', typeId: 'type-a', openingBalance: 400, balanceUpdatedAt: '2026-01-01T10:00:00Z' };
  set('allCategories', [category]);
  set('allExpenses', [milk('e1', '2026-02-01', 200), milk('e2', '2026-02-02', 100)]);
  set('allExpenseQuantities', [quantity('e1', 10, 50)]);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 600);
  set('allCategories', [{ ...category, openingBalance: -100 }]);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 100);
  set('allCategories', [{ ...category, openingBalance: 0 }]);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 200);
});

test('previous balance works before any priced goods exist and payments lower it', () => {
  const { context, set, elements } = createPage();
  set('allCategories', [{ id: 'cat', name: 'Milk', typeId: 'type-a', openingBalance: 500, balanceUpdatedAt: '2026-01-01T10:00:00Z' }]);
  set('allExpenses', [milk('payment', '2026-02-01', 100)]);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 400);
  context.renderCategoryBalances();
  assert.doesNotMatch(elements.categoryBalancesBody.innerHTML, /Capture \/ edit previous balance/);
  assert.match(elements.categoryBalancesBody.innerHTML, /INR 400.00/);
});

test('unused configured categories still allow capturing a previous balance', () => {
  const { context, set, elements } = createPage();
  set('allCategories', [{ id: 'cat', name: 'Milk', typeId: 'type-a' }]);
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesBody.innerHTML, /No pending payments/);
  assert.match(context.pendingSlotHtml('type-a', 'Milk'), /category-balance-edit/);
  assert.doesNotMatch(context.pendingSlotHtml('type-a', 'Milk'), />Previous balance</);
});

test('inline pending balance edit adjusts opening only and keeps quantity and payments intact', async () => {
  const { context, set } = createPage();
  set('allCategories', [{ id: 'cat', name: 'Milk', typeId: 'type-a', openingBalance: 100, balanceUpdatedAt: '2026-01-01' }]);
  set('allExpenses', [milk('e1', '2026-02-01', 200)]);
  set('allExpenseQuantities', [quantity('e1', 10, 50)]);
  const input = { value: '600', checkValidity: () => true };
  const status = {};
  const slot = {
    dataset: { pendingType: 'type-a', pendingCategory: 'Milk' },
    querySelector: selector => selector === 'input' ? input : status,
    querySelectorAll: () => [input], innerHTML: ''
  };
  let saved;
  context.api = async (method, endpoint, body) => {
    saved = { method, endpoint, body };
    return { id: 'cat', openingBalance: body.openingBalance, balanceUpdatedAt: '2026-02-01' };
  };
  context.showNotification = () => {};
  await context.saveInlineCategoryBalance(slot);
  assert.equal(saved.body.openingBalance, 300);
  assert.equal(context.categoryLedger('type-a', 'Milk').balance, 600);
  assert.equal(context.categoryLedger('type-a', 'Milk').received, 500);
  assert.equal(context.categoryLedger('type-a', 'Milk').paid, 200);
  assert.match(slot.innerHTML, /INR 600.00 pending/);
});

test('inline pending editor shows failures without discarding entered amount', async () => {
  const { context, set } = createPage();
  set('allCategories', [{ id: 'cat', name: 'Milk', typeId: 'type-a' }]);
  const input = { value: '500', checkValidity: () => true };
  const status = {};
  const slot = { dataset: { pendingType: 'type-a', pendingCategory: 'Milk' },
    querySelector: selector => selector === 'input' ? input : status, querySelectorAll: () => [input] };
  context.api = async () => { throw new Error('Offline'); };
  await context.saveInlineCategoryBalance(slot);
  assert.match(status.textContent, /Save failed: Offline/);
  assert.equal(input.value, '500');
  assert.equal(input.disabled, false);
});

test('pending report respects dates, category and type filters', () => {
  const { context, elements, set } = createPage();
  set('allExpenses', [milk('old', '2026-01-01', 10), milk('current', '2026-02-01', 100), milk('later', '2026-03-01', 500)]);
  set('allExpenseQuantities', [quantity('old', 20, 50), quantity('current', 10, 50), quantity('later', 20, 50)]);
  elements.fDateFrom = { value: '2026-02-01' };
  elements.fDateTo = { value: '2026-02-28' };
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesTotals.innerHTML, /Total pending: INR 1390.00/);
  context.getSelectedCats = () => ['Rice'];
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesTotals.innerHTML, /INR 0.00/);
  context.getSelectedCats = () => ['Milk'];
  context.getSelectedTypeIds = () => ['type-b'];
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesTotals.innerHTML, /INR 0.00/);
  context.getSelectedTypeIds = () => ['type-a'];
  context.isReportSectionVisible = id => id === 'occasionalReportSection';
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesTotals.innerHTML, /INR 0.00/);
});

test('filtered pending carries earlier goods and payments forward and excludes later payments', () => {
  const { context, set } = createPage();
  set('allExpenses', [milk('goods', '2026-01-01', 100), milk('earlier', '2026-01-15', 200), milk('current', '2026-02-05', 150), milk('later', '2026-03-01', 550)]);
  set('allExpenseQuantities', [quantity('goods', 20, 50)]);
  const ledger = context.categoryLedger('type-a', 'Milk', false, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(ledger.received, 1000);
  assert.equal(ledger.paid, 450);
  assert.equal(ledger.balance, 550);
});

test('payments against older receipts are counted once at the report end date', () => {
  const { context, set } = createPage();
  set('allExpenses', [milk('earlier', '2026-01-15', 200), milk('current', '2026-02-05', 300), milk('later', '2026-03-01', 500)]);
  set('allUnpaidQuantities', [{ id: 'receipt', category: 'Milk', typeId: 'type-a', receivedDate: '2026-01-01', totalAmount: 1000, paidAmount: 1000,
    payments: [{ expenseId: 'earlier', amount: 200 }, { expenseId: 'current', amount: 300 }, { expenseId: 'later', amount: 500 }] }]);
  const ledger = context.categoryLedger('type-a', 'Milk', false, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(ledger.received, 1000);
  assert.equal(ledger.paid, 500);
  assert.equal(ledger.balance, 500);
});

test('opening balance remains settled by earlier payments when changing the report start', () => {
  const { context, set } = createPage();
  set('allCategories', [{ id: 'cat', typeId: 'type-a', name: 'Milk', openingBalance: 700, balanceUpdatedAt: '2026-01-01' }]);
  set('allExpenses', [milk('paid', '2026-01-10', 700)]);
  for (const from of ['2026-01-01', '2026-02-01']) {
    assert.equal(context.categoryLedger('type-a', 'Milk', false, { from, to: '2026-02-28' }).balance, 0);
  }
});

test('report excludes goods and receipts received after its end date', () => {
  const { context, set, elements } = createPage();
  set('allExpenses', [milk('future', '2026-03-01', 100)]);
  set('allExpenseQuantities', [quantity('future', 20, 50)]);
  set('allUnpaidQuantities', [{ id: 'receipt', typeId: 'type-a', category: 'Milk', receivedDate: '2026-03-01', totalAmount: 1000, paidAmount: 0 }]);
  elements.fDateFrom = { value: '2026-02-01' };
  elements.fDateTo = { value: '2026-02-28' };
  context.renderCategoryBalances();
  assert.match(elements.categoryBalancesTotals.innerHTML, /Total pending: INR 0.00/);
});

test('report opens without fetching or rendering data until the user clicks Show', async () => {
  const { context, elements } = createPage();
  elements.categoryBalancesReportSection = { hidden: false };
  elements.btnToggleCategoryBalances = { setAttribute() {} };
  let shown = 0;
  let renders = 0;
  let complete;
  let requests = 0;
  context.bootstrap = { Modal: { getOrCreateInstance: () => ({ show() { shown++; } }) } };
  context.api = () => { requests++; return new Promise(resolve => { complete = resolve; }); };
  context.buildCatFilterChips = () => {};
  context.renderSummary = () => {
    assert.equal(elements.categoryBalancesReportSection.hidden, true);
    renders++;
  };
  const request = context.openExpenseReport();
  assert.equal(shown, 1);
  assert.equal(renders, 0);
  assert.equal(elements.expenseReportLoadStatus.hidden, false);
  assert.equal(requests, 0);
  const load = context.loadSelectedExpenseReport();
  await context.loadSelectedExpenseReport();
  assert.equal(requests, 1);
  complete({ expenses: [], quantities: [] });
  await load;
  await request;
  assert.equal(renders, 1);
  assert.equal(elements.expenseReportLoadStatus.hidden, true);
});

test('failed report refresh leaves a visible error and allows retry', async () => {
  const { context, elements } = createPage();
  elements.categoryBalancesReportSection = { hidden: false };
  elements.btnToggleCategoryBalances = { setAttribute() {} };
  context.bootstrap = { Modal: { getOrCreateInstance: () => ({ show() {} }) } };
  context.showNotification = () => {};
  context.api = async () => { throw new Error('Offline'); };
  await context.loadSelectedExpenseReport();
  assert.match(elements.expenseReportLoadStatus.textContent, /Unable to refresh report: Offline/);
  context.api = async () => ({ expenses: [], quantities: [] });
  context.buildCatFilterChips = () => {};
  context.renderSummary = () => {};
  await context.loadSelectedExpenseReport();
  assert.equal(elements.expenseReportLoadStatus.hidden, true);
});

test('report request contains selected filters and requests quantities only when selected', async () => {
  const { context, elements } = createPage();
  elements.fDateFrom = { value: '2026-02-01' };
  elements.fDateTo = { value: '2026-02-10' };
  elements.reportIncludeQuantities = { checked: false };
  context.getSelectedCats = () => ['Fresh Milk'];
  context.getSelectedTypeIds = () => ['type-a'];
  context.isReportSectionVisible = id => id === 'dailyCashReportSection';
  context.renderSummary = () => {};
  let requested;
  context.api = async (method, endpoint) => { requested = endpoint; return { expenses: [], quantities: [] }; };
  await context.loadSelectedExpenseReport();
  let params = new URLSearchParams(requested.split('?')[1]);
  assert.equal(params.get('from'), '2026-02-01');
  assert.equal(params.get('to'), '2026-02-10');
  assert.equal(params.get('category'), 'Fresh Milk');
  assert.equal(params.get('typeId'), 'type-a');
  assert.equal(params.get('mode'), 'Daily');
  assert.equal(params.has('quantities'), false);
  elements.reportIncludeQuantities.checked = true;
  await context.loadSelectedExpenseReport();
  params = new URLSearchParams(requested.split('?')[1]);
  assert.equal(params.get('quantities'), '1');
});

test('selected approval data renders daily approve and reject controls', async () => {
  const { context, elements } = createPage();
  elements.fDateFrom = { value: '2026-02-01' };
  elements.fDateTo = { value: '2026-02-28' };
  elements.categoryBalancesReportSection = { hidden: true };
  context.isReportSectionVisible = id => id === 'dailyCashReportSection';
  context.api = async () => ({ expenses: [milk('pending', '2026-02-05', 200, { approvalStatus: 'Pending' })], quantities: [] });
  context.renderReportChart = () => {};
  await context.loadSelectedExpenseReport();
  assert.equal(elements.expenseReportResults.hidden, false);
  assert.match(elements.expBody.innerHTML, /Milk: INR 200.00/);
  assert.match(elements.expBody.innerHTML, /approveDate\('2026-02-05'\)/);
  assert.match(elements.expBody.innerHTML, /openRejectModal\('2026-02-05'\)/);
});

test('selected occasional approval data renders its separate approval actions', async () => {
  const { context, elements } = createPage();
  elements.fDateFrom = { value: '2026-02-01' };
  elements.fDateTo = { value: '2026-02-28' };
  elements.categoryBalancesReportSection = { hidden: true };
  context.isReportSectionVisible = id => id === 'occasionalReportSection';
  context.api = async () => ({ expenses: [milk('pending', '2026-02-05', 200, { mode: 'Occasional', approvalStatus: 'Pending' })], quantities: [] });
  context.renderReportChart = () => {};
  await context.loadSelectedExpenseReport();
  assert.equal(elements.expenseReportResults.hidden, false);
  assert.match(elements.occasionalReportBody.innerHTML, /approveDate\('2026-02-05', 'Occasional'\)/);
  assert.match(elements.occasionalReportBody.innerHTML, /openRejectModal\('2026-02-05', 'Occasional'\)/);
});

test('approval report warns when no mode is selected instead of requesting an empty report', async () => {
  const { context } = createPage();
  context.isReportSectionVisible = () => false;
  const messages = [];
  context.showNotification = message => messages.push(message);
  context.api = () => assert.fail('No report should be fetched without a selected mode');
  await context.loadSelectedExpenseReport();
  assert.match(messages[0], /Select Daily or Occasional/);
});

test('approval report explains when the running server has not loaded the new endpoint', async () => {
  const { context, elements } = createPage();
  context.showNotification = () => {};
  context.api = async () => { throw new Error('Expense not found.'); };
  await context.loadSelectedExpenseReport();
  assert.match(elements.expenseReportLoadStatus.textContent, /server needs restarting/);
});
