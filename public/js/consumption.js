/* consumption.js — inline dual-input stock entry, no popups */

let stockData = [];
let entries = [];
let entryDate = '';
let previewByQuantity = new Map();
let previewToken = 0;
let editingEntryId = null;
let editingContext = null;
let stockChart = null;
let dailyChart = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatQuantity(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n * 1000) / 1000;
  const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/\.?0+$/, '');
  return unit ? `${str} ${unit}` : str;
}

function roundStr(value) {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 1000) / 1000;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(3).replace(/\.?0+$/, '');
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('consumption')) { window.location.href = '/index.html'; return; }
  setupControls();
  document.getElementById('btnRefreshConsumption')?.addEventListener('click', () => loadPage());
  // Auto-refresh when the user returns to this tab so expense-quantity edits made elsewhere show up.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadPage();
  });
  window.addEventListener('focus', () => loadPage());
  await loadPage();
});

function setupControls() {
  const today = todayKey();
  entryDate = today;
  const entryDateInput = document.getElementById('entryDate');
  entryDateInput.value = today;
  entryDateInput.max = today;
  entryDateInput.readOnly = !isSuperUser();
  entryDateInput.addEventListener('change', async () => {
    entryDate = entryDateInput.value || today;
    await refreshEntryPreviews();
    renderStockTable();
  });

  const start = new Date();
  start.setDate(start.getDate() - 30);
  const startKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const startInput = document.getElementById('filterStartDate');
  const endInput = document.getElementById('filterEndDate');
  startInput.value = startKey;
  endInput.value = today;
  startInput.max = today;
  endInput.max = today;
  [startInput, endInput, document.getElementById('filterQuantity')].forEach(el => {
    el.addEventListener('change', () => loadEntries());
  });
  document.getElementById('stockSearch')?.addEventListener('input', renderStockTable);
  document.getElementById('dailyChartQuantity')?.addEventListener('change', renderDailyChart);

  document.getElementById('entryHint').innerHTML = isSuperUser()
    ? '<strong>Available Stock</strong> shows incoming − consumed. Enter <strong>Used</strong> or <strong>Available</strong> — the other is calculated. Pick a date to backdate.'
    : '<strong>Available Stock</strong> shows incoming − consumed. Enter <strong>Used</strong> or <strong>Available</strong> — the other is calculated. Save the row to record it.';
}

async function loadPage() {
  document.getElementById('stockBody').innerHTML = loadingRow(10);
  document.getElementById('entriesBody').innerHTML = loadingRow(8);
  try {
    stockData = await api('GET', '/consumption/stock');
    await refreshEntryPreviews();
    populateQuantityFilters();
    renderStockTable();
    renderStockChart();
    await loadEntries();
    renderStats();
  } catch (err) {
    document.getElementById('stockBody').innerHTML = emptyRow(10, 'Failed to load stock.');
    document.getElementById('entriesBody').innerHTML = emptyRow(8, 'Failed to load entries.');
    showNotification('Error: ' + err.message, 'danger');
  }
}

async function refreshEntryPreviews() {
  const token = ++previewToken;
  const targets = stockData.filter(row => row.status === 'Active');
  const map = new Map();
  const results = await Promise.all(targets.map(row =>
    api('GET', `/consumption/preview?date=${encodeURIComponent(entryDate)}&quantityCategoryId=${encodeURIComponent(row.quantityCategoryId)}`)
      .then(preview => ({ id: row.quantityCategoryId, preview }))
      .catch(() => ({ id: row.quantityCategoryId, preview: null }))
  ));
  if (token !== previewToken) return;
  for (const { id, preview } of results) if (preview) map.set(id, preview);
  previewByQuantity = map;
}

async function loadEntries() {
  document.getElementById('entriesBody').innerHTML = loadingRow(8);
  try {
    const params = new URLSearchParams();
    const start = document.getElementById('filterStartDate').value;
    const end = document.getElementById('filterEndDate').value;
    const qid = document.getElementById('filterQuantity').value;
    if (start) params.set('startDate', start);
    if (end) params.set('endDate', end);
    if (qid) params.set('quantityCategoryId', qid);
    const query = params.toString();
    entries = await api('GET', '/consumption' + (query ? `?${query}` : ''));
    renderEntriesTable();
    renderDailyChart();
  } catch (err) {
    document.getElementById('entriesBody').innerHTML = emptyRow(8, 'Failed to load entries.');
    showNotification('Error: ' + err.message, 'danger');
  }
}

function populateQuantityFilters() {
  const options = stockData
    .filter(row => row.status !== 'Removed' || row.incoming > 0 || row.consumed > 0)
    .map(row => `<option value="${row.quantityCategoryId}">${escapeHtml(row.name)} (${escapeHtml(row.unit || 'unit')})</option>`)
    .join('');
  const filterSelect = document.getElementById('filterQuantity');
  const previousFilter = filterSelect.value;
  filterSelect.innerHTML = '<option value="">All quantities</option>' + options;
  filterSelect.value = previousFilter;
  const dailySelect = document.getElementById('dailyChartQuantity');
  const previousDaily = dailySelect.value;
  dailySelect.innerHTML = '<option value="">All quantities (top 6)</option>' + options;
  dailySelect.value = previousDaily;
}

function renderStats() {
  document.getElementById('statQuantityCount').textContent = stockData.length;
  document.getElementById('statInStock').textContent = stockData.filter(row => row.remaining > 0.0001).length;
  document.getElementById('statDepleted').textContent = stockData.filter(row => row.incoming > 0 && Math.abs(row.remaining) < 0.0001).length;
  document.getElementById('statOverdrawn').textContent = stockData.filter(row => row.remaining < -0.0001).length;
}

/* ---------- Stock + entry table ---------- */

function renderStockTable() {
  const tbody = document.getElementById('stockBody');
  const query = (document.getElementById('stockSearch')?.value || '').toLowerCase().trim();
  const rows = stockData.filter(row =>
    !query || row.name.toLowerCase().includes(query) || (row.categoryName || '').toLowerCase().includes(query));
  if (!rows.length) { tbody.innerHTML = emptyRow(10, 'No quantities tracked yet.'); return; }
  const canAdd = canAccess('consumption', 'add');
  // Group rows by parent category so a single Category cell spans all its quantities.
  const groups = new Map();
  for (const row of rows) {
    const key = row.categoryName || '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const html = [];
  for (const [categoryName, groupRows] of groups.entries()) {
    groupRows.forEach((row, index) => {
      html.push(renderStockRow(row, canAdd, index === 0 ? { name: categoryName, rowspan: groupRows.length } : null));
    });
  }
  tbody.innerHTML = html.join('');
  for (const row of rows) attachStockRowHandlers(row.quantityCategoryId);
}

function renderStockRow(row, canAdd, categoryCell = null) {
  const preview = previewByQuantity.get(row.quantityCategoryId);
  const availableBefore = preview ? preview.availableBeforeEntry : row.remaining;
  const badge = row.remaining < -0.0001
    ? '<span class="badge bg-danger-subtle text-danger border border-danger-subtle ms-1">Over</span>'
    : row.remaining < 0.0001 && row.incoming > 0
      ? '<span class="badge bg-warning-subtle text-warning border border-warning-subtle ms-1">Depleted</span>'
      : row.incoming < 0.0001
        ? '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle ms-1">No incoming</span>'
        : '';
  const disabled = !canAdd || row.status !== 'Active' || row.autoConsume;
  const beforeClass = availableBefore < -0.0001 ? 'bg-danger-subtle text-danger border-danger-subtle'
    : availableBefore < 0.0001 ? 'bg-warning-subtle text-warning border-warning-subtle'
    : 'bg-success-subtle text-success border-success-subtle';
  const availableBadge = row.autoConsume
    ? '<span class="badge bg-info-subtle text-info border border-info-subtle fs-6"><i class="bi bi-arrow-repeat me-1"></i>Same-day</span>'
    : `<span class="badge ${beforeClass} border fs-6" style="font-variant-numeric:tabular-nums">${formatQuantity(availableBefore)}${row.unit ? ` <span class="opacity-75">${escapeHtml(row.unit)}</span>` : ''}</span>`;
  const inputAttrs = disabled ? 'disabled' : '';
  const disabledNote = row.autoConsume
    ? '<div class="small text-info"><i class="bi bi-arrow-repeat me-1"></i>Consumed same day</div>'
    : (disabled && row.status !== 'Active' ? '<div class="small text-muted">Inactive</div>' : '');
  const categoryTd = categoryCell
    ? `<td data-label="Category" class="fw-semibold align-middle bg-light-subtle" rowspan="${categoryCell.rowspan}">${escapeHtml(categoryCell.name)}</td>`
    : '';
  return `
    <tr data-quantity-id="${row.quantityCategoryId}" data-available-before="${availableBefore}">
      ${categoryTd}
      <td data-label="Quantity"><span class="fw-semibold">${escapeHtml(row.name)}</span>${badge}${disabledNote}</td>
      <td data-label="Unit">${escapeHtml(row.unit || '—')}</td>
      <td data-label="Incoming" class="text-end">${formatQuantity(row.incoming)}${row.incomingUnpaid > 0 ? `<div class="small text-muted">unpaid ${formatQuantity(row.incomingUnpaid)}</div>` : ''}</td>
      <td data-label="Consumed" class="text-end">${formatQuantity(row.consumed)}</td>
      <td data-label="Available Stock" class="text-end">${availableBadge}</td>
      <td data-label="Used"><input type="number" class="form-control form-control-sm js-used" step="0.001" placeholder="0" ${inputAttrs}></td>
      <td data-label="Available"><input type="number" class="form-control form-control-sm js-avail" step="0.001" placeholder="0" ${inputAttrs}></td>
      <td data-label="Remarks"><input type="text" class="form-control form-control-sm js-remarks" maxlength="200" placeholder="Optional" ${inputAttrs}></td>
      <td data-label="Save">
        <div class="d-flex align-items-center gap-1">
          <button class="btn btn-sm btn-primary js-save" ${disabled ? 'disabled' : ''}><i class="bi bi-check-lg"></i></button>
          <div class="form-check m-0 d-none js-anomaly-wrap" title="Allow anomaly">
            <input class="form-check-input js-allow-anomaly" type="checkbox">
          </div>
        </div>
        <div class="small text-warning js-anomaly-msg d-none"></div>
      </td>
    </tr>`;
}

function attachStockRowHandlers(quantityCategoryId) {
  const row = document.querySelector(`tr[data-quantity-id="${quantityCategoryId}"]`);
  if (!row) return;
  const availableBefore = parseFloat(row.dataset.availableBefore) || 0;
  const used = row.querySelector('.js-used');
  const avail = row.querySelector('.js-avail');
  const anomalyWrap = row.querySelector('.js-anomaly-wrap');
  const anomalyMsg = row.querySelector('.js-anomaly-msg');
  const allowCheckbox = row.querySelector('.js-allow-anomaly');
  const saveBtn = row.querySelector('.js-save');

  const bindPair = (source, target, transform) => {
    source.addEventListener('input', () => {
      if (source.value === '') {
        target.disabled = false;
        target.value = '';
      } else {
        target.disabled = true;
        const num = parseFloat(source.value);
        target.value = Number.isFinite(num) ? roundStr(transform(num)) : '';
      }
      refreshAnomalyState();
    });
  };
  bindPair(used, avail, u => availableBefore - u);
  bindPair(avail, used, a => availableBefore - a);

  const refreshAnomalyState = () => {
    const rawAvail = avail.value === '' ? null : parseFloat(avail.value);
    if (rawAvail === null || !Number.isFinite(rawAvail)) {
      anomalyWrap.classList.add('d-none');
      anomalyMsg.classList.add('d-none');
      allowCheckbox.checked = false;
      return;
    }
    if (rawAvail > availableBefore + 1e-6) {
      anomalyMsg.textContent = `More stock than expected (${formatQuantity(availableBefore)} was available).`;
      anomalyMsg.classList.remove('d-none');
      anomalyWrap.classList.remove('d-none');
    } else if (rawAvail <= 1e-6) {
      anomalyMsg.textContent = `Available stock cannot be zero — only ${formatQuantity(availableBefore)} was available.`;
      anomalyMsg.classList.remove('d-none');
      anomalyWrap.classList.remove('d-none');
    } else {
      anomalyMsg.classList.add('d-none');
      anomalyWrap.classList.add('d-none');
      allowCheckbox.checked = false;
    }
  };

  saveBtn.addEventListener('click', () => saveStockRow(quantityCategoryId));
}

async function saveStockRow(quantityCategoryId) {
  const row = document.querySelector(`tr[data-quantity-id="${quantityCategoryId}"]`);
  if (!row) return;
  const availableBefore = parseFloat(row.dataset.availableBefore) || 0;
  const used = row.querySelector('.js-used');
  const avail = row.querySelector('.js-avail');
  const remarks = row.querySelector('.js-remarks').value.trim();
  const allowAnomaly = row.querySelector('.js-allow-anomaly').checked;
  const saveBtn = row.querySelector('.js-save');

  let availableStock;
  if (avail.value !== '' && Number.isFinite(parseFloat(avail.value))) {
    availableStock = parseFloat(avail.value);
  } else if (used.value !== '' && Number.isFinite(parseFloat(used.value))) {
    availableStock = availableBefore - parseFloat(used.value);
  } else {
    showNotification('Enter Used or Available for this quantity.', 'warning');
    return;
  }

  saveBtn.disabled = true;
  try {
    await api('POST', '/consumption', {
      date: entryDate, quantityCategoryId, availableStock, remarks, allowAnomaly
    });
    showNotification('Recorded.', 'success');
    await loadPage();
  } catch (err) {
    if (/exceeds what was available|cannot be zero/i.test(err.message)) {
      const anomalyMsg = row.querySelector('.js-anomaly-msg');
      const anomalyWrap = row.querySelector('.js-anomaly-wrap');
      anomalyMsg.textContent = err.message;
      anomalyMsg.classList.remove('d-none');
      anomalyWrap.classList.remove('d-none');
      showNotification('Tick "Allow anomaly" to save this entry.', 'warning');
    } else {
      showNotification('Error: ' + err.message, 'danger');
    }
  } finally {
    saveBtn.disabled = false;
  }
}

/* ---------- History table with inline edit ---------- */

function renderEntriesTable() {
  const tbody = document.getElementById('entriesBody');
  const countEl = document.getElementById('entryCount');
  if (countEl) countEl.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
  if (!entries.length) { tbody.innerHTML = emptyRow(8, 'No consumption recorded in this range.'); return; }
  const canManage = canAccess('consumption', 'manage') || isSuperUser();
  tbody.innerHTML = entries.map(entry =>
    entry.id === editingEntryId ? renderEditRow(entry) : renderReadOnlyRow(entry, canManage)
  ).join('');
  if (editingEntryId) attachEditRowHandlers();
}

function renderReadOnlyRow(entry, canManage) {
  const usedClass = entry.usedAmount < -0.0001 ? 'text-danger fw-semibold' : 'text-warning fw-semibold';
  return `
    <tr>
      <td data-label="Date">${formatDate(entry.date)}</td>
      <td data-label="Quantity">${escapeHtml(entry.name)}</td>
      <td data-label="Available" class="text-end fw-semibold">${formatQuantity(entry.availableStock)}</td>
      <td data-label="Used" class="text-end ${usedClass}">${formatQuantity(entry.usedAmount)}${entry.usedAmount < -0.0001 ? '<div class="small text-danger">anomaly</div>' : ''}</td>
      <td data-label="Unit">${escapeHtml(entry.unit || '—')}</td>
      <td data-label="Remarks">${entry.remarks ? escapeHtml(entry.remarks) : '<span class="text-muted">—</span>'}</td>
      <td data-label="Recorded by"><div>${escapeHtml(entry.createdByName || '—')}</div><div class="small text-muted">${entry.createdAt ? formatDate(entry.createdAt.slice(0, 10)) : ''}</div></td>
      <td data-label="Actions">
        ${canManage ? `
          <button class="btn btn-sm btn-outline-secondary btn-action" onclick="beginEditEntry('${entry.id}')" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger btn-action" onclick="deleteConsumption('${entry.id}')" title="Delete"><i class="bi bi-trash"></i></button>
        ` : ''}
      </td>
    </tr>`;
}

function renderEditRow(entry) {
  const availableBefore = editingContext ? editingContext.availableBeforeEntry : (entry.availableStock + entry.usedAmount);
  return `
    <tr class="table-active" data-edit-id="${entry.id}" data-available-before="${availableBefore}">
      <td data-label="Date">
        ${isSuperUser()
          ? `<input type="date" class="form-control form-control-sm js-edit-date" value="${entry.date}" max="${todayKey()}">`
          : formatDate(entry.date)}
      </td>
      <td data-label="Quantity">${escapeHtml(entry.name)}</td>
      <td data-label="Available"><input type="number" class="form-control form-control-sm js-edit-avail" step="0.001" value="${entry.availableStock}"></td>
      <td data-label="Used"><input type="number" class="form-control form-control-sm js-edit-used" step="0.001" value="${roundStr(entry.usedAmount)}" disabled></td>
      <td data-label="Unit">${escapeHtml(entry.unit || '—')}</td>
      <td data-label="Remarks"><input type="text" class="form-control form-control-sm js-edit-remarks" maxlength="200" value="${escapeHtml(entry.remarks || '')}"></td>
      <td data-label="Available before"><span class="small text-muted">was ${formatQuantity(availableBefore, entry.unit)}</span></td>
      <td data-label="Actions">
        <div class="d-flex gap-1 align-items-center">
          <button class="btn btn-sm btn-success btn-action js-edit-save" title="Save"><i class="bi bi-check-lg"></i></button>
          <button class="btn btn-sm btn-outline-secondary btn-action js-edit-cancel" title="Cancel"><i class="bi bi-x-lg"></i></button>
          <div class="form-check m-0 d-none js-edit-anomaly-wrap" title="Allow anomaly">
            <input class="form-check-input js-edit-allow" type="checkbox">
          </div>
        </div>
        <div class="small text-warning js-edit-anomaly-msg d-none"></div>
      </td>
    </tr>`;
}

function attachEditRowHandlers() {
  const row = document.querySelector('tr[data-edit-id]');
  if (!row) return;
  const availableBefore = parseFloat(row.dataset.availableBefore) || 0;
  const used = row.querySelector('.js-edit-used');
  const avail = row.querySelector('.js-edit-avail');
  const dateInput = row.querySelector('.js-edit-date');
  const remarksInput = row.querySelector('.js-edit-remarks');
  const anomalyWrap = row.querySelector('.js-edit-anomaly-wrap');
  const anomalyMsg = row.querySelector('.js-edit-anomaly-msg');
  const allowCheckbox = row.querySelector('.js-edit-allow');

  const bindPair = (source, target, transform) => {
    source.addEventListener('input', () => {
      if (source.value === '') {
        target.disabled = false;
        target.value = '';
      } else {
        target.disabled = true;
        const num = parseFloat(source.value);
        target.value = Number.isFinite(num) ? roundStr(transform(num)) : '';
      }
      refreshAnomalyState();
    });
  };
  bindPair(avail, used, a => availableBefore - a);
  bindPair(used, avail, u => availableBefore - u);
  // Initial derived used value is already displayed.

  const refreshAnomalyState = () => {
    const rawAvail = avail.value === '' ? null : parseFloat(avail.value);
    if (rawAvail === null || !Number.isFinite(rawAvail)) {
      anomalyWrap.classList.add('d-none');
      anomalyMsg.classList.add('d-none');
      allowCheckbox.checked = false;
      return;
    }
    if (rawAvail > availableBefore + 1e-6) {
      anomalyMsg.textContent = `More stock than expected (${formatQuantity(availableBefore)} was available).`;
      anomalyMsg.classList.remove('d-none');
      anomalyWrap.classList.remove('d-none');
    } else if (rawAvail <= 1e-6) {
      anomalyMsg.textContent = `Available stock cannot be zero — only ${formatQuantity(availableBefore)} was available.`;
      anomalyMsg.classList.remove('d-none');
      anomalyWrap.classList.remove('d-none');
    } else {
      anomalyMsg.classList.add('d-none');
      anomalyWrap.classList.add('d-none');
      allowCheckbox.checked = false;
    }
  };

  row.querySelector('.js-edit-cancel').addEventListener('click', () => cancelEditEntry());
  row.querySelector('.js-edit-save').addEventListener('click', () => saveEditEntry({
    date: dateInput ? dateInput.value : null,
    availableStock: avail.value === '' ? null : parseFloat(avail.value),
    remarks: remarksInput.value.trim(),
    allowAnomaly: allowCheckbox.checked
  }));
  if (dateInput) {
    dateInput.addEventListener('change', async () => {
      const entry = entries.find(item => item.id === editingEntryId);
      if (!entry) return;
      try {
        const preview = await api('GET', `/consumption/preview?date=${encodeURIComponent(dateInput.value)}` +
          `&quantityCategoryId=${encodeURIComponent(entry.quantityCategoryId)}` +
          `&excludeEntryId=${encodeURIComponent(entry.id)}`);
        editingContext = preview;
        renderEntriesTable();
      } catch (err) {
        showNotification('Preview failed: ' + err.message, 'danger');
      }
    });
  }
}

async function beginEditEntry(id) {
  const entry = entries.find(row => row.id === id);
  if (!entry) return;
  editingEntryId = id;
  try {
    editingContext = await api('GET', `/consumption/preview?date=${encodeURIComponent(entry.date)}` +
      `&quantityCategoryId=${encodeURIComponent(entry.quantityCategoryId)}` +
      `&excludeEntryId=${encodeURIComponent(entry.id)}`);
  } catch (_) {
    editingContext = { availableBeforeEntry: entry.availableStock + entry.usedAmount };
  }
  renderEntriesTable();
}

function cancelEditEntry() {
  editingEntryId = null;
  editingContext = null;
  renderEntriesTable();
}

async function saveEditEntry({ date, availableStock, remarks, allowAnomaly }) {
  if (availableStock === null || !Number.isFinite(availableStock)) {
    showNotification('Enter Used or Available.', 'warning');
    return;
  }
  try {
    await api('PUT', `/consumption/${editingEntryId}`, { date, availableStock, remarks, allowAnomaly });
    showNotification('Entry updated.', 'success');
    editingEntryId = null;
    editingContext = null;
    await loadPage();
  } catch (err) {
    if (/exceeds what was available|cannot be zero/i.test(err.message)) {
      const row = document.querySelector('tr[data-edit-id]');
      if (row) {
        row.querySelector('.js-edit-anomaly-msg').textContent = err.message;
        row.querySelector('.js-edit-anomaly-msg').classList.remove('d-none');
        row.querySelector('.js-edit-anomaly-wrap').classList.remove('d-none');
      }
      showNotification('Tick "Allow anomaly" to save.', 'warning');
    } else {
      showNotification('Error: ' + err.message, 'danger');
    }
  }
}

async function deleteConsumption(id) {
  const entry = entries.find(row => row.id === id);
  if (!entry) return;
  if (!confirm(`Delete entry of ${formatQuantity(entry.availableStock, entry.unit)} ${entry.name} on ${entry.date}?`)) return;
  try {
    await api('DELETE', `/consumption/${id}`);
    showNotification('Entry deleted.', 'success');
    await loadPage();
  } catch (err) {
    showNotification('Error: ' + err.message, 'danger');
  }
}

/* ---------- Charts ---------- */

function renderStockChart() {
  const ctx = document.getElementById('stockChart');
  if (!ctx) return;
  const top = [...stockData]
    .filter(row => row.incoming > 0 || row.consumed > 0)
    .sort((a, b) => b.incoming - a.incoming)
    .slice(0, 10);
  document.getElementById('stockChartHint').textContent = top.length === stockData.length
    ? `${top.length} quantities` : `Top ${top.length} of ${stockData.length}`;
  const labels = top.map(row => row.name);
  const consumed = top.map(row => Math.max(0, row.consumed));
  const remaining = top.map(row => Math.max(0, row.remaining));
  const overdrawn = top.map(row => Math.max(0, -row.remaining));
  if (stockChart) stockChart.destroy();
  stockChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Consumed', data: consumed, backgroundColor: 'rgba(255,159,64,0.85)', stack: 'usage' },
        { label: 'Remaining', data: remaining, backgroundColor: 'rgba(75,192,120,0.85)', stack: 'usage' },
        { label: 'Over-consumed', data: overdrawn, backgroundColor: 'rgba(220,53,69,0.85)', stack: 'usage' }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: ctx => {
              const row = top[ctx.dataIndex];
              return `${ctx.dataset.label}: ${formatQuantity(ctx.parsed.y)} ${row.unit || ''}`.trim();
            }
          }
        }
      },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }
    }
  });
}

function renderDailyChart() {
  const ctx = document.getElementById('dailyChart');
  if (!ctx) return;
  const selectedId = document.getElementById('dailyChartQuantity').value;
  const relevant = selectedId ? entries.filter(entry => entry.quantityCategoryId === selectedId) : entries;
  if (!relevant.length) {
    if (dailyChart) { dailyChart.destroy(); dailyChart = null; }
    return;
  }
  const days = new Set();
  const perQuantity = new Map();
  for (const entry of relevant) {
    days.add(entry.date);
    const key = entry.quantityCategoryId;
    if (!perQuantity.has(key)) perQuantity.set(key, { name: entry.name, unit: entry.unit, series: new Map() });
    const series = perQuantity.get(key).series;
    series.set(entry.date, (series.get(entry.date) || 0) + Math.max(0, entry.usedAmount));
  }
  const sortedDays = [...days].sort();
  const palette = ['#0d6efd', '#198754', '#dc3545', '#fd7e14', '#6f42c1', '#20c997'];
  const topKeys = selectedId
    ? [selectedId]
    : [...perQuantity.entries()]
        .sort((a, b) => [...b[1].series.values()].reduce((sum, value) => sum + value, 0) -
          [...a[1].series.values()].reduce((sum, value) => sum + value, 0))
        .slice(0, 6)
        .map(([key]) => key);
  const datasets = topKeys.map((key, index) => {
    const info = perQuantity.get(key);
    return {
      label: `${info.name}${info.unit ? ` (${info.unit})` : ''}`,
      data: sortedDays.map(day => info.series.get(day) || 0),
      borderColor: palette[index % palette.length],
      backgroundColor: palette[index % palette.length] + '33',
      tension: 0.3, fill: false
    };
  });
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(ctx, {
    type: 'line',
    data: { labels: sortedDays, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: { y: { beginAtZero: true } }
    }
  });
}
