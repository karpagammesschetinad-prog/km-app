const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/js/settings.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/settings.html'), 'utf8');
const holiday = {
  id: 'h1', startDate: '2026-11-09', endDate: '2026-11-10', reason: 'Maintenance',
  createdBy: 'Admin', createdAt: '2026-11-08T10:00:00Z',
  updatedBy: 'Owner', updatedAt: '2026-11-09T10:00:00Z'
};

function createPage() {
  const elements = {};
  const notifications = [];
  const requests = [];
  const confirmations = [];
  const listeners = {};
  let response = (method) => method === 'GET' ? [holiday] : holiday;
  let approve = true;
  function element(id) {
    if (!elements[id]) elements[id] = {
      value: '', checked: false, disabled: false, hidden: true, innerHTML: '', textContent: '', min: '',
      listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; },
      contains: () => true, focus() { this.focused = true; },
      closest: () => ({ insertAdjacentHTML() {} })
    };
    return elements[id];
  }
  element('holidayForm').reset = () => {
    for (const id of ['holidayStartDate', 'holidayEndDate', 'holidayReason']) element(id).value = '';
  };
  const context = vm.createContext({
    document: { getElementById: element, addEventListener: (name, handler) => { listeners[name] = handler; } },
    window: { confirm(message) { confirmations.push(message); return approve; } },
    requireLogin: async () => ({ role: 'superuser' }),
    showNotification: (message, type) => notifications.push({ message, type }),
    api: async (method, url, payload) => {
      requests.push({ method, url, payload: payload && JSON.parse(JSON.stringify(payload)) });
      return response(method, url, payload);
    }
  });
  vm.runInContext(script, context);
  return {
    context, elements, element, notifications, requests, confirmations, listeners,
    respond: fn => { response = fn; }, confirm: value => { approve = value; },
    setRecords(records) { context.records = records; vm.runInContext('restaurantHolidays = records;', context); },
    fill(values = {}) {
      element('holidayStartDate').value = values.startDate ?? holiday.startDate;
      element('holidayEndDate').value = values.endDate ?? holiday.endDate;
      element('holidayReason').value = values.reason ?? '  Renovation  ';
    },
    click(action, id = holiday.id) {
      return context.handleHolidayHistoryClick({ target: { closest: () => ({ dataset: { holidayAction: action, holidayId: id } }) } });
    },
    save() { return context.saveRestaurantHoliday({ preventDefault() {} }); },
    init(role = 'superuser') { return context.initRestaurantHolidays({ role }); }
  };
}

test('Holiday markup has labelled controls, closure help, separate forms and no inline handlers', () => {
  assert.match(html, /id="restaurantHolidaysCard"[^>]*hidden/);
  for (const id of ['holidayStartDate', 'holidayEndDate', 'holidayReason']) {
    assert.match(html, new RegExp(`for="${id}"`));
  }
  assert.match(html, /Start and end dates are inclusive/);
  assert.match(html, /No salary is earned and no petta deduction/);
  assert.match(html, /Payments and bonuses are unaffected/);
  let depth = 0;
  for (const match of html.matchAll(/<\/?form\b[^>]*>/g)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    assert.ok(depth >= 0 && depth <= 1, 'Forms must not be nested');
  }
  assert.equal(depth, 0);
  assert.doesNotMatch(html + script, /\bon\w+\s*=\s*["']/i);
});

test('History escapes text and attributes, shows audit and sorts latest start first without mutating data', () => {
  const page = createPage();
  const unsafe = `"'><img src=x onerror=alert(1)>&`;
  const records = [
    { ...holiday, id: unsafe, reason: unsafe, createdBy: unsafe, updatedBy: unsafe, createdAt: unsafe, updatedAt: unsafe },
    { ...holiday, id: 'new', startDate: '2026-12-01', endDate: '2026-12-01', reason: 'Newest' },
    { ...holiday, id: 'old', startDate: '2026-10-01', reason: 'Oldest' }
  ];
  page.setRecords(records);
  page.context.renderRestaurantHolidays();
  const rendered = page.element('holidayHistory').innerHTML;
  assert.doesNotMatch(rendered, /<img/);
  assert.match(rendered, /data-holiday-id="&quot;&#39;&gt;&lt;img/);
  assert.match(rendered, /aria-label="Edit holiday .*&quot;&#39;&gt;&lt;img/);
  assert.match(rendered, /Created: &quot;/);
  assert.match(rendered, /Updated: &quot;/);
  assert.ok(rendered.indexOf('Newest') < rendered.indexOf('&lt;img'));
  assert.ok(rendered.indexOf('&lt;img') < rendered.indexOf('Oldest'));
  assert.equal(records[0].id, unsafe);
  page.setRecords([]);
  page.context.renderRestaurantHolidays();
  assert.match(page.element('holidayHistory').innerHTML, /No restaurant holidays/);
});

test('Initialization is superuser-only, delegated, and idempotent', async () => {
  const page = createPage();
  await page.init('user');
  assert.equal(page.requests.length, 0);
  assert.equal(page.element('restaurantHolidaysCard').hidden, true);
  await page.init();
  await page.init();
  assert.deepEqual(page.requests.map(item => item.url), ['/holidays']);
  assert.equal(page.element('restaurantHolidaysCard').hidden, false);
  assert.equal(page.element('holidayHistory').listeners.click, page.context.handleHolidayHistoryClick);
  assert.equal(page.element('holidayForm').listeners.submit, page.context.saveRestaurantHoliday);
});

test('POST sends trimmed payload, confirms payroll impact and resets on success', async () => {
  const page = createPage();
  await page.init();
  page.fill();
  await page.save();
  assert.deepEqual(page.requests[1], { method: 'POST', url: '/holidays', payload: {
    startDate: holiday.startDate, endDate: holiday.endDate, reason: 'Renovation'
  } });
  assert.match(page.confirmations[0], /past salary amounts/);
  assert.match(page.confirmations[0], /Payments and bonuses are unaffected/);
  assert.equal(page.element('holidayReason').value, '');
  assert.equal(page.element('holidaySaveBtn').disabled, false);
  assert.equal(page.element('holidayFields').disabled, false);
  assert.ok(page.notifications.some(item => /holiday saved/.test(item.message)));
});

test('Delegated edit populates inputs, PUT encodes id, and cancel returns to POST mode', async () => {
  const page = createPage();
  const record = { ...holiday, id: 'h/"?1' };
  page.respond(method => method === 'GET' ? [record] : record);
  await page.init();
  await page.click('edit', record.id);
  assert.equal(page.element('holidayReason').value, holiday.reason);
  assert.equal(page.element('holidayStartDate').focused, true);
  assert.equal(page.element('holidayCancelBtn').hidden, false);
  page.fill({ reason: 'Edited', endDate: '2026-11-11' });
  await page.save();
  assert.deepEqual(page.requests[1], { method: 'PUT', url: '/holidays/h%2F%22%3F1', payload: {
    startDate: holiday.startDate, endDate: '2026-11-11', reason: 'Edited'
  } });
  await page.click('edit', record.id);
  page.element('holidayCancelBtn').listeners.click();
  assert.equal(page.element('holidayCancelBtn').hidden, true);
  assert.equal(page.element('holidayFormTitle').textContent, 'Add holiday');
  assert.equal(page.element('holidayEndDate').min, '');
  page.fill();
  await page.save();
  assert.equal(page.requests[3].method, 'POST');
});

test('Invalid ranges, impossible dates and blank reasons do not mutate or confirm', async () => {
  const page = createPage();
  await page.init();
  for (const values of [
    { startDate: '2026-11-11', endDate: '2026-11-10' },
    { startDate: '2026-02-30' }, { endDate: '' }, { reason: '   ' }
  ]) {
    page.fill(values);
    await page.save();
  }
  assert.equal(page.requests.length, 1);
  assert.equal(page.confirmations.length, 0);
  assert.equal(page.notifications.length, 4);
});

test('Cancelled mutations leave inputs and history intact', async () => {
  const page = createPage();
  await page.init();
  page.confirm(false);
  page.fill();
  await page.save();
  await page.click('delete');
  assert.equal(page.requests.length, 1);
  assert.equal(page.element('holidayReason').value, '  Renovation  ');
  assert.match(page.element('holidayHistory').innerHTML, /Maintenance/);
});

test('Failed PUT keeps edit values and restores all disabled controls', async () => {
  const page = createPage();
  await page.init();
  await page.click('edit');
  page.fill({ reason: 'Retry me' });
  page.respond(() => { throw new Error('Offline'); });
  await page.save();
  assert.equal(page.element('holidayReason').value, 'Retry me');
  assert.equal(page.element('holidayCancelBtn').hidden, false);
  assert.equal(page.element('holidaySaveBtn').disabled, false);
  assert.equal(page.element('holidayReloadBtn').disabled, false);
  assert.doesNotMatch(page.element('holidayHistory').innerHTML, / disabled/);
  assert.match(page.notifications.at(-1).message, /Failed to save restaurant holiday: Offline/);
  page.respond(method => method === 'GET' ? [holiday] : holiday);
  await page.save();
  assert.equal(page.requests[2].method, 'PUT');
});

test('DELETE confirms, encodes id, removes history and cancels the deleted edit', async () => {
  const page = createPage();
  const record = { ...holiday, id: 'h/1' };
  page.respond(() => [record]);
  await page.init();
  await page.click('edit', record.id);
  page.respond(method => method === 'GET' ? [] : {});
  await page.click('delete', record.id);
  assert.equal(page.requests[1].method, 'DELETE');
  assert.equal(page.requests[1].url, '/holidays/h%2F1');
  assert.match(page.confirmations[0], /Delete restaurant holiday.*past salary amounts/);
  assert.match(page.element('holidayHistory').innerHTML, /No restaurant holidays/);
  assert.equal(page.element('holidayCancelBtn').hidden, true);
  assert.equal(page.element('holidaySaveBtn').disabled, false);
});

test('Failed DELETE preserves history and restores actions', async () => {
  const page = createPage();
  await page.init();
  page.respond(() => { throw new Error('Denied'); });
  await page.click('delete');
  assert.match(page.element('holidayHistory').innerHTML, /Maintenance/);
  assert.doesNotMatch(page.element('holidayHistory').innerHTML, / disabled/);
  assert.equal(page.element('holidayFields').disabled, false);
  assert.match(page.notifications.at(-1).message, /Failed to delete restaurant holiday: Denied/);
});

test('Busy save prevents duplicate submissions and history actions', async () => {
  const page = createPage();
  await page.init();
  let release;
  page.respond(method => method === 'GET' ? [holiday] : new Promise(resolve => { release = resolve; }));
  page.fill();
  const pending = page.save();
  assert.equal(page.element('holidaySaveBtn').disabled, true);
  assert.match(page.element('holidayHistory').innerHTML, / disabled/);
  await page.save();
  await page.click('delete');
  assert.equal(page.requests.length, 2);
  release(holiday);
  await pending;
  assert.equal(page.element('holidaySaveBtn').disabled, false);
});

test('Load failure is isolated from other settings; reload recovers', async () => {
  const page = createPage();
  page.respond((method, url) => {
    if (url === '/holidays') throw new Error('Holiday service offline');
    if (url === '/settings/autosave') return { AUTO_SAVE_ENABLED: 'true' };
    return { PAYMENT_TYPES: [], FY_START_DATE: '2026-04-01', FY_END_DATE: '2027-03-31' };
  });
  await page.listeners.DOMContentLoaded();
  assert.equal(page.element('autoSaveEnabled').checked, true);
  assert.equal(page.element('fyStartDate').value, '2026-04-01');
  assert.equal(typeof page.element('settingsForm').listeners.submit, 'function');
  assert.match(page.element('holidayStatus').textContent, /could not be loaded/);
  assert.equal(page.element('holidaySaveBtn').disabled, false);
  page.respond(() => [holiday]);
  await page.element('holidayReloadBtn').listeners.click();
  assert.match(page.element('holidayHistory').innerHTML, /Maintenance/);
  assert.match(page.element('holidayStatus').textContent, /1 holiday period recorded/);
});

test('Successful mutation with failed refresh remains successful and retains returned record', async () => {
  const page = createPage();
  await page.init();
  page.respond(method => {
    if (method === 'GET') throw new Error('Refresh offline');
    return { ...holiday, id: 'h2', reason: 'New closure' };
  });
  page.fill();
  await page.save();
  assert.match(page.element('holidayHistory').innerHTML, /New closure/);
  assert.ok(page.notifications.some(item => /holiday saved/.test(item.message)));
  assert.ok(page.notifications.some(item => /Failed to load restaurant holidays/.test(item.message)));
  assert.ok(!page.notifications.some(item => /Failed to save/.test(item.message)));
  assert.equal(page.element('holidaySaveBtn').disabled, false);
});