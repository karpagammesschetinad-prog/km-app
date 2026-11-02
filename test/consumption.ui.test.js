const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPage() {
  const elements = {
    priceChangeNotice: { hidden: true },
    priceChangeNoticeList: { innerHTML: '' }
  };
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: id => elements[id] },
    formatCurrency: amount => `₹${Number(amount).toFixed(2)}`,
    formatDate: date => date,
    formatQuantity: (amount, unit) => `${amount} ${unit}`,
    canAccess: () => true,
    escapeHtml: value => String(value ?? '')
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/consumption.js'), 'utf8'), context);
  return { context, elements };
}

test('Consumption shows a notice with prior and current prices and change percent', () => {
  const { context, elements } = createPage();
  context.testStock = [{
    name: 'Chicken', unit: 'KG',
    priceChange: { previousPrice: 80, currentPrice: 92, date: '2026-01-02', change: 12, changePercent: 15 }
  }];
  vm.runInContext('stockData = testStock;', context);
  context.renderPriceChangeNotice();
  assert.equal(elements.priceChangeNotice.hidden, false);
  assert.match(elements.priceChangeNoticeList.innerHTML, /Chicken/);
  assert.match(elements.priceChangeNoticeList.innerHTML, /₹80\.00 → ₹92\.00 \(\+15\.0%\)/);
  assert.match(elements.priceChangeNoticeList.innerHTML, /2026-01-02/);
});

test('Consumption marks the changed quantity in the stock row', () => {
  const { context } = createPage();
  const html = context.renderStockRow({
    quantityCategoryId: 'q1', name: 'Chicken', unit: 'KG', status: 'Active',
    remaining: 3, incoming: 8, consumed: 5, autoConsume: false,
    priceChange: { previousPrice: 80, currentPrice: 92 }
  }, true);
  assert.match(html, /Price changed/);
});

test('Consumption price-change notice stays hidden when prices have not changed', () => {
  const { context, elements } = createPage();
  context.testStock = [{ name: 'Chicken', unit: 'KG', priceChange: null }];
  vm.runInContext('stockData = testStock;', context);
  context.renderPriceChangeNotice();
  assert.equal(elements.priceChangeNotice.hidden, true);
  assert.equal(elements.priceChangeNoticeList.innerHTML, '');
});
