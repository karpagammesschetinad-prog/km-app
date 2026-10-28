/* categories.js */

let allCategories = [];
let allTypes = [];
let allUsers = [];
let editingCatId = null;
let editingTypeId = null;
let categoryQuantities = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('categories')) { window.location.href = '/index.html'; return; }
  setupModal();
  setupTypeModal();
  document.getElementById('categoryTypeFilter').addEventListener('change', () => renderTable(allCategories));
  await loadCategories();
});

async function loadCategories() {
  document.getElementById('catBody').innerHTML = loadingRow(4);
  try {
    [allCategories, allTypes, allUsers] = await Promise.all([
      api('GET', '/categories'), api('GET', '/categories/types/all'), api('GET', '/users')
    ]);
    renderTypes();
    populateTypeSelect();
    populateTypeFilter();
    renderTable(allCategories);
  } catch (err) {
    document.getElementById('catBody').innerHTML = emptyRow(4, 'Failed to load categories.');
    showNotification('Error: ' + err.message, 'danger');
  }
}

function renderTable(list) {
  const tbody = document.getElementById('catBody');
  const countEl = document.getElementById('catCount');
  const selectedType = document.getElementById('categoryTypeFilter')?.value || '';
  const filtered = selectedType ? list.filter(c => c.typeId === selectedType) : list;
  const active = filtered.filter(c => c.status === 'Active').length;
  if (countEl) countEl.textContent = `${active} active / ${filtered.length} total`;

  if (!filtered.length) { tbody.innerHTML = emptyRow(4, 'No categories found for this type.'); return; }

  const sorted = [...filtered].sort((a, b) => a.sortOrder - b.sortOrder);
  tbody.innerHTML = sorted.map(c => `
    <tr>
      <td data-label="Order" class="text-center text-muted">${c.sortOrder}</td>
      <td data-label="Category" class="fw-semibold">${c.name}<div class="text-muted small">${c.typeName || (allTypes.find(t => t.id === c.typeId) || { name: 'General' }).name}</div></td>
      <td data-label="Status">${statusBadge(c.status)}</td>
      <td data-label="Actions">
        <div class="d-flex gap-1">
          <button class="btn btn-sm btn-outline-primary btn-action" onclick="openEdit('${c.id}')" title="Edit">
            <i class="bi bi-pencil"></i>
          </button>
          <button class="btn btn-sm btn-outline-${c.status === 'Active' ? 'warning' : 'success'} btn-action"
            onclick="toggleStatus('${c.id}','${c.status === 'Active' ? 'Inactive' : 'Active'}')"
            title="${c.status === 'Active' ? 'Deactivate' : 'Activate'}">
            <i class="bi bi-${c.status === 'Active' ? 'pause-circle' : 'play-circle'}"></i>
          </button>
          <button class="btn btn-sm btn-outline-danger btn-action" onclick="remove('${c.id}')" title="Delete">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function setupModal() {
  document.getElementById('btnAddCategory').addEventListener('click', () => {
    editingCatId = null;
    const form = document.getElementById('catForm');
    form.reset();
    form.classList.remove('was-validated');
    document.getElementById('catModalTitle').textContent = 'Add Category';
    document.getElementById('catStatus').value = 'Active';
    populateTypeSelect();
    const legacyType = allTypes.find(t => t.name === 'General') || allTypes.find(t => t.sortOrder === 1) || allTypes[0];
    document.getElementById('catType').value = legacyType?.id || '';
    const maxOrder = allCategories.reduce((m, c) => Math.max(m, c.sortOrder || 0), 0);
    document.getElementById('catOrder').value = maxOrder + 1;
    categoryQuantities = [];
    renderQuantityFields();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('catModal')).show();
  });
  document.getElementById('btnSaveCategory').addEventListener('click', save);
  document.getElementById('btnAddBulkQuantities').addEventListener('click', addBulkCategoryQuantities);
  document.getElementById('catModal').addEventListener('show.bs.modal', () => {
    document.getElementById('bulkCategoryQuantities').value = '';
    document.getElementById('bulkCategoryQuantitiesStatus').textContent = '';
  });
  document.getElementById('btnAddQuantityField').addEventListener('click', () => {
    syncQuantityFields();
    categoryQuantities.push({ id: '', name: '', unit: 'Count', autoConsume: false });
    renderQuantityFields();
  });
}

function parseBulkCategoryQuantities(text, existingNames = []) {
  const names = new Set(existingNames.map(name => name.trim().toLowerCase()));
  const units = { kg: 'KG', g: 'Grams', gm: 'Grams', gram: 'Grams', grams: 'Grams', litre: 'Litre', liter: 'Litre', ltr: 'Litre', count: 'Count' };
  return String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const parts = line.split(',').map(part => part.trim());
    const name = parts[0];
    const unit = units[(parts[1] || '').toLowerCase()];
    if (parts.length !== 2 || !name || !unit) throw new Error(`Entry ${index + 1}: enter a quantity name and KG, Grams, Litre or Count, separated by a comma.`);
    if (names.has(name.toLowerCase())) throw new Error(`Entry ${index + 1}: quantity "${name}" already exists.`);
    names.add(name.toLowerCase());
    return { id: '', name, unit, autoConsume: false };
  });
}

function addBulkCategoryQuantities() {
  const input = document.getElementById('bulkCategoryQuantities');
  const status = document.getElementById('bulkCategoryQuantitiesStatus');
  syncQuantityFields();
  try {
    const quantities = parseBulkCategoryQuantities(input.value, categoryQuantities.map(quantity => quantity.name).filter(Boolean));
    if (!quantities.length) throw new Error('Enter at least one quantity name and unit.');
    categoryQuantities = categoryQuantities.filter(quantity => quantity.id || quantity.name);
    categoryQuantities.push(...quantities);
    renderQuantityFields();
    input.value = '';
    status.textContent = `${quantities.length} quantity fields added. Click Save Category to save them.`;
  } catch (err) {
    status.textContent = err.message;
  }
}

function renderQuantityFields() {
  const container = document.getElementById('quantityFields');
  container.innerHTML = categoryQuantities.map((quantity, index) => `<div class="row g-2 align-items-center mb-2">
    <div class="col"><input class="form-control form-control-sm quantity-name" data-index="${index}" value="${escapeHtml(quantity.name)}" placeholder="e.g. Weight"></div>
    <div class="col-3"><select class="form-select form-select-sm quantity-unit" data-index="${index}">
      ${['KG', 'Grams', 'Litre', 'Count'].map(unit => `<option${quantity.unit === unit ? ' selected' : ''}>${unit}</option>`).join('')}
    </select></div>
    <div class="col-auto" style="width:140px"><input type="number" class="form-control form-control-sm quantity-default" data-index="${index}" min="0" step="0.01" value="${escapeHtml(quantity.defaultQuantity ?? '')}" placeholder="Default qty" aria-label="Default quantity" title="Optional quantity to prefill in new expense entries"></div>
    <div class="col-auto">
      <div class="form-check m-0" title="Any incoming for this quantity is counted as fully consumed the same day.">
        <input class="form-check-input quantity-auto-consume" type="checkbox" id="qAuto-${index}" data-index="${index}"${quantity.autoConsume ? ' checked' : ''}>
        <label class="form-check-label small" for="qAuto-${index}">Same-day</label>
      </div>
    </div>
    <div class="col-auto"><button class="btn btn-sm btn-outline-danger" type="button" onclick="removeQuantityField(${index})" title="Remove quantity"><i class="bi bi-trash"></i></button></div>
  </div>`).join('') || '<div class="text-muted small">No quantity fields configured.</div>';
}

function removeQuantityField(index) {
  syncQuantityFields();
  categoryQuantities.splice(index, 1);
  renderQuantityFields();
}

function syncQuantityFields() {
  categoryQuantities = categoryQuantities.map((quantity, index) => ({
    id: quantity.id,
    name: document.querySelector(`.quantity-name[data-index="${index}"]`)?.value.trim() || '',
    unit: document.querySelector(`.quantity-unit[data-index="${index}"]`)?.value || '',
    autoConsume: !!document.querySelector(`.quantity-auto-consume[data-index="${index}"]`)?.checked,
    defaultQuantity: document.querySelector(`.quantity-default[data-index="${index}"]`)?.value ?? ''
  }));
}

function collectQuantityFields() {
  syncQuantityFields();
  return categoryQuantities.filter(quantity => quantity.name);
}

function populateTypeSelect() {
  const select = document.getElementById('catType');
  if (!select) return;
  const legacyType = allTypes.find(t => t.name === 'General') || allTypes.find(t => t.sortOrder === 1) || allTypes[0];
  select.innerHTML = allTypes.map(t => `<option value="${t.id}">${t.displayText || t.name}</option>`).join('');
  if (legacyType) select.value = legacyType.id;
}

function populateTypeFilter() {
  const select = document.getElementById('categoryTypeFilter');
  if (!select) return;
  const selected = select.value;
  select.innerHTML = '<option value="">All category types</option>' +
    allTypes.map(t => `<option value="${t.id}">${t.displayText || t.name}</option>`).join('');
  select.value = selected && [...select.options].some(option => option.value === selected) ? selected : '';
}

function renderTypes() {
  const body = document.getElementById('typeBody');
  if (!body) return;
  const workflowBadge = workflow => {
    if (workflow === 'Occasional') return '<span class="badge bg-info-subtle text-info border border-info-subtle">Occasional / Non-cash</span>';
    if (workflow === 'Daily Non Cash') return '<span class="badge bg-warning-subtle text-warning border border-warning-subtle">Daily / Non-cash</span>';
    return '<span class="badge bg-primary-subtle text-primary border border-primary-subtle">Daily / Cash</span>';
  };
  body.innerHTML = allTypes.map(t => `<tr>
    <td data-label="Order">${t.sortOrder}</td><td data-label="Internal name" class="fw-semibold">${t.name}</td><td data-label="Display text">${t.displayText || t.name}</td><td data-label="Workflow">${workflowBadge(t.workflow)}</td>
    <td data-label="Access">${t.accessMode === 'Limited' ? '<span class="badge bg-warning-subtle text-warning border border-warning-subtle">Limited</span>' : '<span class="badge bg-success-subtle text-success border border-success-subtle">All users</span>'}</td>
    <td data-label="Users">${t.accessMode === 'Limited' ? (t.allowedUserIds.map(id => (allUsers.find(u => u.id === id) || {}).displayName || id).join(', ') || 'None') : 'Everyone'}</td>
    <td data-label="Actions"><div class="d-flex gap-1"><button class="btn btn-sm btn-outline-primary btn-action" onclick="openTypeEdit('${t.id}')" title="Edit"><i class="bi bi-pencil"></i></button><button class="btn btn-sm btn-outline-danger btn-action" onclick="removeType('${t.id}')" title="Delete"><i class="bi bi-trash"></i></button></div></td>
  </tr>`).join('') || emptyRow(7, 'No category types yet.');
}

function setupTypeModal() {
  document.getElementById('btnAddCategoryType').addEventListener('click', () => {
    editingTypeId = null;
    document.getElementById('typeForm').reset();
    document.getElementById('typeModalTitle').textContent = 'Add Category Type';
    document.getElementById('typeOrder').value = allTypes.length + 1;
    renderTypeUsers([]); toggleTypeUsers();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('typeModal')).show();
  });
  document.getElementById('typeAccess').addEventListener('change', toggleTypeUsers);
  document.getElementById('btnSaveType').addEventListener('click', saveType);
}

function toggleTypeUsers() { document.getElementById('typeUsersWrap').style.display = document.getElementById('typeAccess').value === 'Limited' ? '' : 'none'; }

function renderTypeUsers(selected) {
  document.getElementById('typeUsers').innerHTML = allUsers.filter(u => u.role !== 'superuser' && u.status === 'Active').map(u => `<div class="col-12 col-md-6"><label class="form-check"><input class="form-check-input type-user-check" type="checkbox" value="${u.id}" ${selected.includes(u.id) ? 'checked' : ''}><span class="form-check-label">${u.displayName} <small class="text-muted">@${u.username}</small></span></label></div>`).join('') || '<div class="text-muted small">No active non-superusers found.</div>';
}

function openTypeEdit(id) {
  const type = allTypes.find(item => item.id === id);
  if (!type) return;
  editingTypeId = id;
  document.getElementById('typeModalTitle').textContent = 'Edit Category Type';
  document.getElementById('typeName').value = type.name;
  document.getElementById('typeDisplayText').value = type.displayText || type.name;
  document.getElementById('typeOrder').value = type.sortOrder;
  document.getElementById('typeStatus').value = type.status;
  document.getElementById('typeWorkflow').value = type.workflow || 'Daily Cash';
  document.getElementById('typeAccess').value = type.accessMode;
  renderTypeUsers(type.allowedUserIds); toggleTypeUsers();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('typeModal')).show();
}

async function saveType() {
  const body = {
    name: document.getElementById('typeName').value.trim(),
    displayText: document.getElementById('typeDisplayText').value.trim(),
    sortOrder: parseInt(document.getElementById('typeOrder').value) || 1,
    status: document.getElementById('typeStatus').value,
    workflow: document.getElementById('typeWorkflow').value,
    accessMode: document.getElementById('typeAccess').value,
    allowedUserIds: [...document.querySelectorAll('.type-user-check:checked')].map(el => el.value)
  };
  if (!body.name) return showNotification('Type name is required.', 'warning');
  try {
    await api(editingTypeId ? 'PUT' : 'POST', editingTypeId ? `/categories/types/${editingTypeId}` : '/categories/types', body);
    bootstrap.Modal.getInstance(document.getElementById('typeModal')).hide();
    showNotification('Category type saved.'); await loadCategories();
  } catch (err) { showNotification('Save failed: ' + err.message, 'danger'); }
}

async function removeType(id) {
  if (!confirm('Delete this category type? Categories will return to General.')) return;
  try { await api('DELETE', `/categories/types/${id}`); showNotification('Category type deleted.'); await loadCategories(); }
  catch (err) { showNotification('Delete failed: ' + err.message, 'danger'); }
}

async function save() {
  const form = document.getElementById('catForm');
  form.classList.add('was-validated');
  if (!form.checkValidity()) return;

  const body = {
    name: document.getElementById('catName').value.trim(),
    sortOrder: parseInt(document.getElementById('catOrder').value) || 1,
    status: document.getElementById('catStatus').value,
    typeId: document.getElementById('catType').value,
    handpickQuantities: document.getElementById('catHandpickQuantities').checked
  };

  const btn = document.getElementById('btnSaveCategory');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';

  try {
    if (editingCatId) {
      await api('PUT', `/categories/${editingCatId}`, body);
      await api('PUT', `/categories/${editingCatId}/quantities`, { quantities: collectQuantityFields() });
      showNotification('Category updated.');
    } else {
      const category = await api('POST', '/categories', body);
      await api('PUT', `/categories/${category.id}/quantities`, { quantities: collectQuantityFields() });
      showNotification('Category added.');
    }
    bootstrap.Modal.getInstance(document.getElementById('catModal')).hide();
    await loadCategories();
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Category';
  }
}

async function openEdit(id) {
  const c = allCategories.find(x => x.id === id);
  if (!c) return;
  editingCatId = id;
  const form = document.getElementById('catForm');
  form.classList.remove('was-validated');
  document.getElementById('catModalTitle').textContent = 'Edit Category';
  document.getElementById('catName').value = c.name;
  document.getElementById('catOrder').value = c.sortOrder;
  document.getElementById('catStatus').value = c.status;
  document.getElementById('catHandpickQuantities').checked = !!c.handpickQuantities;
  populateTypeSelect();
  document.getElementById('catType').value = c.typeId || '';
  categoryQuantities = await api('GET', `/categories/${id}/quantities`);
  renderQuantityFields();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('catModal')).show();
}

async function toggleStatus(id, newStatus) {
  try {
    await api('PUT', `/categories/${id}`, { status: newStatus });
    showNotification(`Category ${newStatus === 'Active' ? 'activated' : 'deactivated'}.`);
    await loadCategories();
  } catch (err) { showNotification('Error: ' + err.message, 'danger'); }
}

async function remove(id) {
  if (!confirm('Delete this category? Existing expense records will not be affected.')) return;
  try {
    await api('DELETE', `/categories/${id}`);
    showNotification('Category deleted.');
    await loadCategories();
  } catch (err) { showNotification('Error: ' + err.message, 'danger'); }
}

