/* categories.js */

let allCategories = [];
let editingCatId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('categories')) { window.location.href = '/index.html'; return; }
  setupModal();
  await loadCategories();
});

async function loadCategories() {
  document.getElementById('catBody').innerHTML = loadingRow(4);
  try {
    allCategories = await api('GET', '/categories');
    renderTable(allCategories);
  } catch (err) {
    document.getElementById('catBody').innerHTML = emptyRow(4, 'Failed to load categories.');
    showNotification('Error: ' + err.message, 'danger');
  }
}

function renderTable(list) {
  const tbody = document.getElementById('catBody');
  const countEl = document.getElementById('catCount');
  const active = list.filter(c => c.status === 'Active').length;
  if (countEl) countEl.textContent = `${active} active / ${list.length} total`;

  if (!list.length) { tbody.innerHTML = emptyRow(4, 'No categories yet.'); return; }

  const sorted = [...list].sort((a, b) => a.sortOrder - b.sortOrder);
  tbody.innerHTML = sorted.map(c => `
    <tr>
      <td class="text-center text-muted">${c.sortOrder}</td>
      <td class="fw-semibold">${c.name}</td>
      <td>${statusBadge(c.status)}</td>
      <td>
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
    const maxOrder = allCategories.reduce((m, c) => Math.max(m, c.sortOrder || 0), 0);
    document.getElementById('catOrder').value = maxOrder + 1;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('catModal')).show();
  });
  document.getElementById('btnSaveCategory').addEventListener('click', save);
}

async function save() {
  const form = document.getElementById('catForm');
  form.classList.add('was-validated');
  if (!form.checkValidity()) return;

  const body = {
    name: document.getElementById('catName').value.trim(),
    sortOrder: parseInt(document.getElementById('catOrder').value) || 1,
    status: document.getElementById('catStatus').value
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

