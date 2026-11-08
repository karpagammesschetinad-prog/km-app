let paymentTypes = [];
let restaurantHolidays = [];
let holidayEditingId = null;
let holidayBusy = false;
let holidaysInitialized = false;

function escapeHolidayText(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function renderRestaurantHolidays() {
  const history = document.getElementById('holidayHistory');
  const records = [...restaurantHolidays].sort((a, b) =>
    String(b.startDate).localeCompare(String(a.startDate)) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  history.innerHTML = records.length ? records.map(record => {
    const id = escapeHolidayText(record.id);
    const dates = record.startDate === record.endDate ? escapeHolidayText(record.startDate) :
      `${escapeHolidayText(record.startDate)} <span class="text-muted">→</span> ${escapeHolidayText(record.endDate)}`;
    const label = escapeHolidayText(`${record.startDate} to ${record.endDate}: ${record.reason}`);
    const disabled = holidayBusy ? ' disabled' : '';
    return `<tr><td class="small text-nowrap">${dates}</td><td class="small text-break">${escapeHolidayText(record.reason)}</td>
      <td class="small text-break"><div>Created: ${escapeHolidayText(record.createdBy || '—')}</div><div class="text-muted">${escapeHolidayText(record.createdAt || '')}</div>
      ${record.updatedBy || record.updatedAt ? `<div>Updated: ${escapeHolidayText(record.updatedBy || '—')}</div><div class="text-muted">${escapeHolidayText(record.updatedAt || '')}</div>` : ''}</td>
      <td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-outline-primary" data-holiday-action="edit" data-holiday-id="${id}" aria-label="Edit holiday ${label}"${disabled}><i class="bi bi-pencil" aria-hidden="true"></i></button>
      <button type="button" class="btn btn-sm btn-outline-danger" data-holiday-action="delete" data-holiday-id="${id}" aria-label="Delete holiday ${label}"${disabled}><i class="bi bi-trash" aria-hidden="true"></i></button></td></tr>`;
  }).join('') : '<tr><td colspan="4" class="text-muted small py-3">No restaurant holidays recorded.</td></tr>';
}

function setHolidayBusy(busy) {
  holidayBusy = busy;
  document.getElementById('holidayFields').disabled = busy;
  document.getElementById('holidaySaveBtn').disabled = busy;
  document.getElementById('holidayReloadBtn').disabled = busy;
  renderRestaurantHolidays();
}

function resetHolidayForm() {
  holidayEditingId = null;
  document.getElementById('holidayForm').reset();
  document.getElementById('holidayEndDate').min = '';
  document.getElementById('holidayFormTitle').textContent = 'Add holiday';
  document.getElementById('holidaySaveBtn').textContent = 'Save holiday';
  document.getElementById('holidayCancelBtn').hidden = true;
}

async function loadRestaurantHolidays() {
  const status = document.getElementById('holidayStatus');
  status.textContent = 'Loading holidays…';
  try {
    const records = await api('GET', '/holidays');
    if (!Array.isArray(records)) throw new Error('Invalid holiday history response');
    restaurantHolidays = records;
    renderRestaurantHolidays();
    status.textContent = `${records.length} holiday period${records.length === 1 ? '' : 's'} recorded.`;
    return true;
  } catch (err) {
    renderRestaurantHolidays();
    status.textContent = 'Holiday history could not be loaded. Use Reload holiday history to retry.';
    showNotification('Failed to load restaurant holidays: ' + err.message, 'danger');
    return false;
  }
}

function validHolidayDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function saveRestaurantHoliday(event) {
  event.preventDefault();
  if (!holidaysInitialized || holidayBusy) return;
  const payload = {
    startDate: document.getElementById('holidayStartDate').value,
    endDate: document.getElementById('holidayEndDate').value,
    reason: document.getElementById('holidayReason').value.trim()
  };
  if (!validHolidayDate(payload.startDate) || !validHolidayDate(payload.endDate) ||
      payload.endDate < payload.startDate || !payload.reason) {
    showNotification('Enter valid inclusive dates (end on or after start) and a reason.', 'warning');
    return;
  }
  if (!window.confirm('Save this unpaid restaurant holiday? Changes recalculate payroll and may change past salary amounts. Payments and bonuses are unaffected.')) return;
  const editingId = holidayEditingId;
  setHolidayBusy(true);
  try {
    const record = await api(editingId === null ? 'POST' : 'PUT',
      editingId === null ? '/holidays' : '/holidays/' + encodeURIComponent(editingId), payload);
    if (record && record.id != null) {
      restaurantHolidays = restaurantHolidays.filter(item => String(item.id) !== String(record.id));
      restaurantHolidays.push(record);
    }
    resetHolidayForm();
    showNotification(editingId === null ? 'Restaurant holiday saved. Payroll recalculated.' : 'Restaurant holiday updated. Payroll recalculated.');
    await loadRestaurantHolidays();
  } catch (err) {
    showNotification('Failed to save restaurant holiday: ' + err.message, 'danger');
  } finally { setHolidayBusy(false); }
}

async function handleHolidayHistoryClick(event) {
  if (!holidaysInitialized || holidayBusy) return;
  const button = event.target.closest('[data-holiday-action]');
  if (!button || !document.getElementById('holidayHistory').contains(button)) return;
  const record = restaurantHolidays.find(item => String(item.id) === button.dataset.holidayId);
  if (!record) return;
  if (button.dataset.holidayAction === 'edit') {
    holidayEditingId = String(record.id);
    document.getElementById('holidayStartDate').value = record.startDate;
    document.getElementById('holidayEndDate').value = record.endDate;
    document.getElementById('holidayEndDate').min = record.startDate;
    document.getElementById('holidayReason').value = record.reason;
    document.getElementById('holidayFormTitle').textContent = 'Edit holiday';
    document.getElementById('holidaySaveBtn').textContent = 'Save changes';
    document.getElementById('holidayCancelBtn').hidden = false;
    document.getElementById('holidayStartDate').focus();
    return;
  }
  if (button.dataset.holidayAction !== 'delete' || !window.confirm(
    `Delete restaurant holiday ${record.startDate} to ${record.endDate}? Changes recalculate payroll and may change past salary amounts. Payments and bonuses are unaffected.`)) return;
  setHolidayBusy(true);
  try {
    await api('DELETE', '/holidays/' + encodeURIComponent(record.id));
    restaurantHolidays = restaurantHolidays.filter(item => String(item.id) !== String(record.id));
    if (holidayEditingId === String(record.id)) resetHolidayForm();
    showNotification('Restaurant holiday deleted. Payroll recalculated.');
    await loadRestaurantHolidays();
  } catch (err) {
    showNotification('Failed to delete restaurant holiday: ' + err.message, 'danger');
  } finally { setHolidayBusy(false); }
}

async function initRestaurantHolidays(user) {
  if (user.role !== 'superuser' || holidaysInitialized) return;
  holidaysInitialized = true;
  document.getElementById('restaurantHolidaysCard').hidden = false;
  document.getElementById('holidayForm').addEventListener('submit', saveRestaurantHoliday);
  document.getElementById('holidayCancelBtn').addEventListener('click', () => {
    if (!holidayBusy) resetHolidayForm();
  });
  document.getElementById('holidayStartDate').addEventListener('change', () => {
    document.getElementById('holidayEndDate').min = document.getElementById('holidayStartDate').value;
  });
  document.getElementById('holidayHistory').addEventListener('click', handleHolidayHistoryClick);
  document.getElementById('holidayReloadBtn').addEventListener('click', async () => {
    if (holidayBusy) return;
    setHolidayBusy(true);
    try { await loadRestaurantHolidays(); } finally { setHolidayBusy(false); }
  });
  setHolidayBusy(true);
  try { await loadRestaurantHolidays(); } finally { setHolidayBusy(false); }
}

function getSettingsPayload() {
  return {
    FY_START_DATE: document.getElementById('fyStartDate').value,
    FY_END_DATE: document.getElementById('fyEndDate').value,
    IDLE_TIMEOUT_MINUTES: document.getElementById('idleTimeoutMinutes').value,
    AUTO_APPROVAL_ENABLED: document.getElementById('autoApprovalEnabled').checked,
    AUTO_APPROVAL_DAYS: document.getElementById('autoApprovalDays').value,
    PAYMENT_TYPES: paymentTypes,
    ONLINE_VENDORS: document.getElementById('onlineVendors').value
  };
}

async function saveSettings(showSuccess = true) {
  if (!paymentTypes.length) {
    showNotification('Add at least one payment type.', 'warning');
    return false;
  }
  await api('PUT', '/settings', getSettingsPayload());
  if (showSuccess) showNotification('Settings saved.');
  return true;
}

function normalizePaymentType(value) {
  return String(value || '').trim();
}

function parsePaymentTypes(value) {
  if (Array.isArray(value)) return value.map(normalizePaymentType).filter(Boolean);
  return String(value || '').split(',').map(normalizePaymentType).filter(Boolean);
}

function renderPaymentTypes() {
  const list = document.getElementById('paymentTypesList');
  if (!list) return;
  if (!paymentTypes.length) {
    list.innerHTML = '<span class="text-muted small">No payment types added.</span>';
    return;
  }
  list.innerHTML = paymentTypes.map(type => `<span class="badge text-bg-light border d-inline-flex align-items-center gap-2 py-2 px-2">${type}<button type="button" class="btn btn-sm btn-link text-danger p-0 payment-type-delete" data-payment-type="${type}" title="Delete ${type}"><i class="bi bi-x-circle"></i></button></span>`).join('');
  list.querySelectorAll('.payment-type-delete').forEach(button => {
    button.addEventListener('click', async () => {
      const type = button.dataset.paymentType;
      paymentTypes = paymentTypes.filter(item => item !== type);
      renderPaymentTypes();
      try {
        await saveSettings(false);
        showNotification('Payment type deleted.');
      } catch (err) {
        showNotification('Save failed: ' + err.message, 'danger');
      }
    });
  });
}

async function addPaymentType() {
  const value = window.prompt('Enter payment type name');
  if (value == null) return;
  const type = normalizePaymentType(value);
  if (!type) return showNotification('Payment type cannot be empty.', 'warning');
  if (paymentTypes.some(item => item.toLowerCase() === type.toLowerCase())) {
    return showNotification('Payment type already exists.', 'warning');
  }
  paymentTypes.push(type);
  renderPaymentTypes();
  try {
    await saveSettings(false);
    showNotification('Payment type added.');
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  // Holiday loading is isolated from the other Settings requests.
  if (user.role === 'superuser') void initRestaurantHolidays(user);
  const autoSaveInput = document.getElementById('autoSaveEnabled');
  try {
    const setting = await api('GET', '/settings/autosave');
    autoSaveInput.checked = setting.AUTO_SAVE_ENABLED === 'true';
  } catch (err) { showNotification('Failed to load auto-save setting: ' + err.message, 'danger'); }
  autoSaveInput.addEventListener('change', async () => {
    autoSaveInput.disabled = true;
    try {
      await api('PUT', '/settings/autosave', { AUTO_SAVE_ENABLED: autoSaveInput.checked });
      showNotification(`Auto-save ${autoSaveInput.checked ? 'enabled' : 'disabled'} for all users.`);
    } catch (err) {
      autoSaveInput.checked = !autoSaveInput.checked;
      showNotification('Failed to save auto-save setting: ' + err.message, 'danger');
    } finally { autoSaveInput.disabled = false; }
  });
  if (user.role !== 'superuser') return;
  document.getElementById('idleTimeoutMinutes').closest('.col-md-6').insertAdjacentHTML('afterend', `
    <div class="col-md-6"><div class="form-check form-switch mt-4">
      <input class="form-check-input" type="checkbox" role="switch" id="autoApprovalEnabled">
      <label class="form-check-label" for="autoApprovalEnabled">Auto-approve pending expenses</label>
    </div></div>
    <div class="col-md-6"><label class="form-label">Auto-approve After (days)</label>
      <input type="number" class="form-control" id="autoApprovalDays" min="1" max="365" required>
      <div class="form-text">Pending expenses are approved after this many days.</div>
    </div>`);
  document.getElementById('addPaymentTypeBtn').addEventListener('click', addPaymentType);
  try {
    const settings = await api('GET', '/settings');
    document.getElementById('fyStartDate').value = settings.FY_START_DATE;
    document.getElementById('fyEndDate').value = settings.FY_END_DATE;
    document.getElementById('idleTimeoutMinutes').value = settings.IDLE_TIMEOUT_MINUTES;
    document.getElementById('autoApprovalEnabled').checked = settings.AUTO_APPROVAL_ENABLED === 'true';
    document.getElementById('autoApprovalDays').value = settings.AUTO_APPROVAL_DAYS;
    paymentTypes = parsePaymentTypes(settings.PAYMENT_TYPES);
    document.getElementById('onlineVendors').value = settings.ONLINE_VENDORS;
    renderPaymentTypes();
  } catch (err) { showNotification('Failed to load settings: ' + err.message, 'danger'); }

  document.getElementById('settingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await saveSettings();
    } catch (err) { showNotification('Save failed: ' + err.message, 'danger'); }
  });
});
