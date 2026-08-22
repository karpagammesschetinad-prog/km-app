/* categories.js */

let allCategories = [];
let allTypes = [];
let allUsers = [];
let editingCatId = null;
let editingTypeId = null;

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
    bootstrap.Modal.getOrCreateInstance(document.getElementById('catModal')).show();
  });
  document.getElementById('btnSaveCategory').addEventListener('click', save);
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
  body.innerHTML = allTypes.map(t => `<tr>
    <td data-label="Order">${t.sortOrder}</td><td data-label="Internal name" class="fw-semibold">${t.name}</td><td data-label="Display text">${t.displayText || t.name}</td>
    <td data-label="Access">${t.accessMode === 'Limited' ? '<span class="badge bg-warning-subtle text-warning border border-warning-subtle">Limited</span>' : '<span class="badge bg-success-subtle text-success border border-success-subtle">All users</span>'}</td>
    <td data-label="Users">${t.accessMode === 'Limited' ? (t.allowedUserIds.map(id => (allUsers.find(u => u.id === id) || {}).displayName || id).join(', ') || 'None') : 'Everyone'}</td>
    <td data-label="Actions"><div class="d-flex gap-1"><button class="btn btn-sm btn-outline-primary btn-action" onclick="openTypeEdit('${t.id}')" title="Edit"><i class="bi bi-pencil"></i></button><button class="btn btn-sm btn-outline-danger btn-action" onclick="removeType('${t.id}')" title="Delete"><i class="bi bi-trash"></i></button></div></td>
  </tr>`).join('') || emptyRow(5, 'No category types yet.');
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
    typeId: document.getElementById('catType').value
  };

  const btn = document.getElementById('btnSaveCategory');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';

  try {
    if (editingCatId) {
      await api('PUT', `/categories/${editingCatId}`, body);
      showNotification('Category updated.');
    } else {
      await api('POST', '/categories', body);
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
  populateTypeSelect();
  document.getElementById('catType').value = c.typeId || '';
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

