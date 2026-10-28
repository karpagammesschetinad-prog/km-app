const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/employees.js'), 'utf8');

function createPage() {
  const elements = {
    empSearch: { value: '' },
    empShowInactive: { checked: false },
    empBody: { innerHTML: '' },
    empCount: { textContent: '' }
  };
  for (const element of Object.values(elements)) {
    element.listeners = {};
    element.addEventListener = (event, listener) => { element.listeners[event] = listener; };
  }
  let employees = [
    { id: 'active', name: 'Alice', phone: '111', status: 'Active' },
    { id: 'inactive', name: 'Alice Former', phone: '222', status: 'Inactive' }
  ];
  const context = vm.createContext({
    document: {
      addEventListener() {},
      getElementById: id => elements[id]
    },
    canAccess: () => true,
    isSuperUser: () => false,
    loadingRow: () => 'Loading',
    emptyRow: () => 'No employees found.',
    formatDate: () => '',
    formatCurrency: () => '',
    statusBadge: status => status,
    showNotification: message => assert.fail(message),
    _cache: {},
    api: async (method, endpoint) => endpoint === '/employees' ? employees : []
  });
  vm.runInContext(source, context);
  context.setupSearch();
  return { context, elements, setEmployees: value => { employees = value; } };
}

test('employee directory hides inactive employees and counts visible employees by default', async () => {
  const { context, elements } = createPage();
  await context.loadEmployeesPage();
  assert.match(elements.empBody.innerHTML, /id=active/);
  assert.doesNotMatch(elements.empBody.innerHTML, /id=inactive/);
  assert.equal(elements.empCount.textContent, 1);
  assert.equal(context._cache.employees.length, 2);
});

test('show inactive adds inactive employees and switching it off hides them again', async () => {
  const { context, elements } = createPage();
  await context.loadEmployeesPage();
  elements.empShowInactive.checked = true;
  elements.empShowInactive.listeners.change();
  assert.match(elements.empBody.innerHTML, /id=active/);
  assert.match(elements.empBody.innerHTML, /id=inactive/);
  assert.equal(elements.empCount.textContent, 2);
  elements.empShowInactive.checked = false;
  elements.empShowInactive.listeners.change();
  assert.doesNotMatch(elements.empBody.innerHTML, /id=inactive/);
  assert.equal(elements.empCount.textContent, 1);
});

test('name and phone searches respect the inactive toggle', async () => {
  const { context, elements } = createPage();
  await context.loadEmployeesPage();
  elements.empSearch.value = 'ALICE';
  elements.empSearch.listeners.input();
  assert.equal(elements.empCount.textContent, 1);
  elements.empSearch.value = '222';
  elements.empSearch.listeners.input();
  assert.equal(elements.empCount.textContent, 0);
  assert.equal(elements.empBody.innerHTML, 'No employees found.');
  elements.empShowInactive.checked = true;
  elements.empShowInactive.listeners.change();
  assert.match(elements.empBody.innerHTML, /id=inactive/);
  assert.doesNotMatch(elements.empBody.innerHTML, /id=active/);
  assert.equal(elements.empCount.textContent, 1);
});

test('reloading after employee changes preserves search and inactive visibility', async () => {
  const { context, elements, setEmployees } = createPage();
  await context.loadEmployeesPage();
  setEmployees([{ id: 'inactive', name: 'Alice Former', phone: '222', status: 'Inactive' }]);
  await context.loadEmployeesPage();
  assert.equal(elements.empCount.textContent, 0);
  elements.empShowInactive.checked = true;
  elements.empSearch.value = 'missing';
  await context.loadEmployeesPage();
  assert.equal(elements.empCount.textContent, 0);
  elements.empSearch.value = 'alice';
  await context.loadEmployeesPage();
  assert.match(elements.empBody.innerHTML, /id=inactive/);
  assert.equal(elements.empCount.textContent, 1);
});