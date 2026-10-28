const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPage() {
  const input = { value: '', min: '' };
  let reported = false;
  const elements = {
    leaveReturnDate: input,
    returnLeaveForm: {
      reset() { input.value = ''; },
      checkValidity: () => !!input.value && input.value >= input.min,
      reportValidity() { reported = true; }
    },
    btnSaveReturnLeave: { disabled: false, innerHTML: '' },
    returnLeaveModal: {}
  };
  const requests = [];
  const modal = { shown: false, show() { this.shown = true; }, hide() { this.shown = false; } };
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: id => elements[id] },
    bootstrap: { Modal: { getOrCreateInstance: () => modal, getInstance: () => modal } },
    api: async (...args) => { requests.push(args); },
    showNotification() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/employee-detail.js'), 'utf8'), context);
  vm.runInContext("empLeaves = [{ id: 'leave-1', startDateTime: '2026-01-01T00:00', endDateTime: '' }]; loadAll = async () => {};", context);
  return { context, elements, requests, modal, wasReported: () => reported };
}

test('return popup uses a required native date picker', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/employee-detail.html'), 'utf8');
  assert.match(html, /<input type="date"[^>]*id="leaveReturnDate"[^>]*required>/);
  const { context, elements, modal, requests } = createPage();
  context.closeLeave('leave-1');
  assert.equal(modal.shown, true);
  assert.equal(elements.leaveReturnDate.min, '2026-01-02');
  assert.equal(requests.length, 0);
});

test('return date is required and cannot precede the end of the first leave day', async () => {
  const page = createPage();
  page.context.closeLeave('leave-1');
  for (const date of ['', '2026-01-01', '2025-12-31']) {
    page.elements.leaveReturnDate.value = date;
    await page.context.saveLeaveReturn();
    assert.equal(page.requests.length, 0);
  }
  assert.equal(page.wasReported(), true);
  assert.equal(page.modal.shown, true);
});

test('saving records midnight on the selected return date and closes the popup', async () => {
  const { context, elements, modal, requests } = createPage();
  context.closeLeave('leave-1');
  elements.leaveReturnDate.value = '2026-01-05';
  await context.saveLeaveReturn();
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'PUT');
  assert.equal(requests[0][1], '/leaves/leave-1');
  assert.equal(requests[0][2].endDateTime, '2026-01-05T00:00');
  assert.equal(modal.shown, false);
  assert.equal(elements.btnSaveReturnLeave.disabled, false);
});

test('failed save keeps the popup open and re-enables the button', async () => {
  const { context, elements, modal } = createPage();
  context.api = async () => { throw new Error('Failed to save'); };
  context.closeLeave('leave-1');
  elements.leaveReturnDate.value = '2026-01-05';
  await context.saveLeaveReturn();
  assert.equal(modal.shown, true);
  assert.equal(elements.btnSaveReturnLeave.disabled, false);
});