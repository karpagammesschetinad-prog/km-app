const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPage() {
  const cells = [];
  const headers = [];
  const formulaHeaders = [];
  const elements = {
    plFormulaPanel: { hidden: true },
    plFormulaTitle: { textContent: '' },
    plFormulaText: { textContent: '' }
  };
  const context = vm.createContext({
    document: {
      addEventListener() {},
      getElementById(id) { return elements[id]; },
      querySelectorAll(selector) {
        if (selector.includes('[data-col-group]') || selector.includes('[data-formula-column]')) return cells;
        return selector.includes('[data-formula]') ? formulaHeaders : headers;
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/reports.js'), 'utf8'), context);
  return { context, cells, headers, formulaHeaders, elements };
}

function groupedCell(group, formulaColumn = '') {
  const classes = new Set();
  return {
    dataset: { colGroup: group, formulaColumn },
    classList: {
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); }
    }
  };
}

test('Received source columns expand and collapse inside the salary group', () => {
  const { context, cells, headers } = createPage();
  const salaryCells = [groupedCell('salary'), groupedCell('salary'), groupedCell('salary')];
  const sourceCells = [groupedCell('salarySources'), groupedCell('salarySources'), groupedCell('salarySources')];
  cells.push(...salaryCells, ...sourceCells);
  const makeHeader = group => {
    const icon = { className: '' };
    return { dataset: { toggleGroup: group }, querySelector: () => icon, icon };
  };
  headers.push(makeHeader('salary'), makeHeader('salarySources'));

  assert.equal(context.plColumnCount(), 8);
  vm.runInContext("expandedColumnGroups.add('salary'); applyColumnGroups();", context);
  assert.equal(context.plColumnCount(), 11);
  assert.ok(salaryCells.every(cell => !cell.classList.contains('d-none')));
  assert.ok(sourceCells.every(cell => cell.classList.contains('d-none')));

  vm.runInContext("expandedColumnGroups.add('salarySources'); applyColumnGroups();", context);
  assert.equal(context.plColumnCount(), 14);
  assert.ok(sourceCells.every(cell => !cell.classList.contains('d-none')));

  vm.runInContext("expandedColumnGroups.delete('salary'); expandedColumnGroups.delete('salarySources'); applyColumnGroups();", context);
  assert.equal(context.plColumnCount(), 8);
  assert.ok(salaryCells.every(cell => cell.classList.contains('d-none')));
  assert.ok(sourceCells.every(cell => cell.classList.contains('d-none')));
});

test('P&L labels salary source subtotals as Day Sale Cash, Cash In Hand, and Online Paid', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/reports.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../public/js/reports.js'), 'utf8');
  assert.match(html, /data-toggle-group="salarySources"[^>]*>Received/);
  assert.match(html, /data-col-group="salarySources">Day Sale Cash/);
  assert.match(html, /data-col-group="salarySources">Cash In Hand/);
  assert.match(html, /data-col-group="salarySources">Online Paid/);
  assert.match(script, /data-col-group="salarySources"/);
});

test('P&L balance and profit headers explain their calculation formulas', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/reports.html'), 'utf8');
  assert.match(html, /data-formula="cashInHand"[^>]*>Cash In Hand/);
  assert.match(html, /data-formula="onlineBalance"[^>]*>Online Balance/);
  assert.match(html, /data-formula="profit"[^>]*>Profit</);
  assert.match(html, /data-formula="profitBalance"[^>]*>Profit Balance/);
  assert.match(html, /id="plFormulaPanel" hidden/);
  assert.match(html, /id="btnResetPLView"/);
});

test('Sales vs Cost Alignment chart plots Profit instead of Profit Balance', () => {
  const { context } = createPage();
  let chartConfig;
  context.testCanvas = {};
  context.Chart = function (_canvas, config) { chartConfig = config; };
  vm.runInContext('document.getElementById = id => id === "plChart" ? testCanvas : undefined;', context);
  context.renderChart([
    { date: '2026-02-01', sales: 1000, totalCost: 600, profit: 400, profitBalance: -200 }
  ]);
  const profitSeries = chartConfig.data.datasets.find(dataset => dataset.label === 'Profit');
  assert.deepEqual(Array.from(profitSeries.data), [400]);
  assert.equal(chartConfig.data.datasets.some(dataset => dataset.label === 'Profit balance'), false);
});

test('clicking a P&L formula selects related columns and Reset view restores the collapsed table', () => {
  const { context, cells, headers, formulaHeaders, elements } = createPage();
  const salesCells = [groupedCell('sales'), groupedCell('sales')];
  const expenseCells = [groupedCell('expenses'), groupedCell('expenses')];
  const salaryCells = [groupedCell('salary'), groupedCell('salary')];
  const resultCell = groupedCell('', 'cashInHand');
  cells.push(...salesCells, ...expenseCells, ...salaryCells, resultCell);
  const makeHeader = group => {
    const icon = { className: '' };
    return { dataset: { toggleGroup: group }, querySelector: () => icon, icon };
  };
  headers.push(makeHeader('sales'), makeHeader('expenses'), makeHeader('salary'));
  const formulaHeader = {
    dataset: { formula: 'cashInHand' },
    classList: {
      toggle(name, enabled) { enabled ? formulaHeader.classes.add(name) : formulaHeader.classes.delete(name); },
      contains(name) { return formulaHeader.classes.has(name); }
    },
    classes: new Set()
  };
  formulaHeaders.push(formulaHeader);

  context.showPLFormula('cashInHand');
  assert.equal(elements.plFormulaPanel.hidden, false);
  assert.equal(elements.plFormulaTitle.textContent, 'Cash In Hand calculation');
  assert.match(elements.plFormulaText.textContent, /Cash Sales − Cash-enabled Expenses/);
  assert.ok(salesCells.every(cell => !cell.classList.contains('d-none')));
  assert.ok(expenseCells.every(cell => !cell.classList.contains('d-none')));
  assert.ok(salaryCells.every(cell => cell.classList.contains('d-none')));
  assert.ok([...salesCells, ...expenseCells].every(cell => cell.classList.contains('pl-formula-highlight')));
  assert.ok(resultCell.classList.contains('pl-formula-highlight'));
  assert.ok(formulaHeader.classList.contains('pl-formula-active'));

  context.resetPLView();
  assert.equal(elements.plFormulaPanel.hidden, true);
  assert.equal(context.plColumnCount(), 8);
  assert.ok([...salesCells, ...expenseCells, ...salaryCells].every(cell => cell.classList.contains('d-none')));
  assert.ok([...salesCells, ...expenseCells, resultCell].every(cell => !cell.classList.contains('pl-formula-highlight')));
  assert.ok(!formulaHeader.classList.contains('pl-formula-active'));
});
