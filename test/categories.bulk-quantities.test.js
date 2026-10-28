const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page() {
  const elements = {
    bulkCategoryQuantities: { value: '' }, bulkCategoryQuantitiesStatus: {}, quantityFields: {}
  };
  const context = vm.createContext({ document: { addEventListener() {}, getElementById: id => elements[id], querySelector: () => null } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/categories.js'), 'utf8'), context);
  return { context, elements };
}

test('multiple quantity names and units parse together', () => {
  const { context } = page();
  const rows = context.parseBulkCategoryQuantities('Weight, kg\r\n\nVolume, ltr\nPieces, count');
  assert.equal(JSON.stringify(rows.map(row => [row.name, row.unit])), JSON.stringify([['Weight', 'KG'], ['Volume', 'Litre'], ['Pieces', 'Count']]));
});

test('bulk quantities reject duplicate names and invalid units', () => {
  const { context } = page();
  for (const text of ['Milk, KG\nmilk, Litre', 'Weight', 'Weight, Bag', ', KG', 'Weight, KG, extra']) {
    assert.throws(() => context.parseBulkCategoryQuantities(text));
  }
  assert.throws(() => context.parseBulkCategoryQuantities('Weight, KG', ['weight']));
});

test('bulk add renders all fields and invalid batches do not partially add', () => {
  const { context, elements } = page();
  elements.bulkCategoryQuantities.value = 'Weight, KG\nVolume, Litre';
  context.addBulkCategoryQuantities();
  assert.match(elements.quantityFields.innerHTML, /Weight/);
  assert.match(elements.quantityFields.innerHTML, /Volume/);
  assert.match(elements.bulkCategoryQuantitiesStatus.textContent, /2 quantity fields added/);
  const before = elements.quantityFields.innerHTML;
  elements.bulkCategoryQuantities.value = 'Pieces, Count\nBad, unknown';
  context.addBulkCategoryQuantities();
  assert.equal(elements.quantityFields.innerHTML, before);
  assert.match(elements.bulkCategoryQuantitiesStatus.textContent, /Entry 2/);
});

test('grams and common abbreviations work in category bulk entry', () => {
  const { context } = page();
  for (const unit of ['Grams', 'gram', 'g', 'gm']) {
    assert.equal(context.parseBulkCategoryQuantities('Spices, ' + unit)[0].unit, 'Grams');
  }
});