/* users.js */

let allUsers = [];
let selectedUserId = null;
let resetTargetId = null;

const SCREEN_PERMISSIONS = [
  {
    key: 'expenses', label: 'Expenses', icon: 'bi-receipt',
    subs: [
      { key: 'view',    label: 'View expense list' },
      { key: 'add',     label: 'Add / edit expenses' },
      { key: 'approve', label: 'Approve / reject expenses' }
    ]
  },
  {
    key: 'categories', label: 'Categories', icon: 'bi-tags',
    subs: [
      { key: 'view',   label: 'View categories' },
      { key: 'manage', label: 'Add / edit / delete categories' }
    ]
  },
  {
    key: 'employees', label: 'Employees', icon: 'bi-people',
    subs: [
      { key: 'view',     label: 'View employee list' },
      { key: 'add',      label: 'Add / edit employees' },
      { key: 'leaves',   label: 'Manage leave records' },
      { key: 'payments', label: 'Record salary payments' }
    ]
  },
  {
    key: 'salaries', label: 'Salaries', icon: 'bi-cash-stack', superuserOnly: true,
    subs: [
      { key: 'view', label: 'View salary overview' }
    ]
  },
  {
    key: 'users', label: 'Users', icon: 'bi-person-lock', superuserOnly: true,
    subs: [
      { key: 'view',   label: 'View users list' },
      { key: 'manage', label: 'Add / edit / delete users' }
    ]
  }
];

const ROLE_DEFAULTS = {
  superuser: {
    expenses:   { enabled: true,  view: true,  add: true,  approve: true },
    categories: { enabled: true,  view: true,  manage: true },
    employees:  { enabled: true,  view: true,  add: true,  leaves: true, payments: true },
    salaries:   { enabled: true,  view: true },
    users:      { enabled: true,  view: true,  manage: true }
  },
  cashier: {
    expenses:   { enabled: true,  view: true,  add: true,  approve: false },
    categories: { enabled: false, view: false, manage: false },
    employees:  { enabled: true,  view: true,  add: false,  leaves: true, payments: true },
    salaries:   { enabled: false, view: false },
    users:      { enabled: false, view: false, manage: false }
  }
};

// Returns resolved screen permissions object for a user
function resolvePerms(u) {
  const p = u.permissions;
  // Valid new format: non-array object with nested screen objects
  if (p && !Array.isArray(p) && typeof p === 'object' && typeof p.expenses === 'object') return p;
  return ROLE_DEFAULTS[u.role] || ROLE_DEFAULTS.cashier;
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (user.role !== 'superuser') { window.location.href = '/index.html'; return; }

  document.getElementById('btnAddUser').addEventListener('click', openAddModal);
  document.getElementById('btnSaveUser').addEventListener('click', saveUser);

  document.getElementById('btnTogglePass').addEventListener('click', () => togglePwd('uPassword', 'passIcon'));
  document.getElementById('btnToggleReset').addEventListener('click', () => togglePwd('newPassword', 'resetIcon'));
  document.getElementById('btnConfirmReset').addEventListener('click', confirmReset);

  document.getElementById('searchUser').addEventListener('input', renderList);
  document.getElementById('filterRole').addEventListener('change', renderList);
  document.getElementById('filterStatus').addEventListener('change', renderList);

  // Role dropdown preview
  document.getElementById('uRole').addEventListener('change', onRoleDropdownChange);

  await loadUsers();
});

function onRoleDropdownChange() {
  const role = document.getElementById('uRole').value;
  const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.cashier;
  const preview = document.getElementById('rolePermPreview');
  if (!preview) return;

  const lines = SCREEN_PERMISSIONS.map(screen => {
    const sp = defaults[screen.key] || {};
    if (!sp.enabled) return `<span class="text-muted text-decoration-line-through">${screen.label}</span>`;
    const activeSubs = screen.subs.filter(s => sp[s.key]).map(s => s.label);
    return `<strong>${screen.label}</strong>: ${activeSubs.join(', ') || 'access only'}`;
  });
  preview.innerHTML = lines.join('<br>');
}

function togglePwd(inputId, iconId) {
  const inp = document.getElementById(inputId);
  const ico = document.getElementById(iconId);
  if (inp.type === 'password') { inp.type = 'text'; ico.className = 'bi bi-eye-slash'; }
  else { inp.type = 'password'; ico.className = 'bi bi-eye'; }
}

async function loadUsers() {
  try {
    allUsers = await api('GET', '/users');
    updateStats();
    renderList();
  } catch (err) {
    document.getElementById('userList').innerHTML =
      '<div class="text-center py-4 text-danger small p-3">' + err.message + '</div>';
  }
}

function updateStats() {
  document.getElementById('stTotal').textContent   = allUsers.length;
  document.getElementById('stSuper').textContent   = allUsers.filter(u => u.role === 'superuser').length;
  document.getElementById('stCashier').textContent = allUsers.filter(u => u.role === 'cashier').length;
  document.getElementById('stInactive').textContent = allUsers.filter(u => u.status === 'Inactive').length;
}

function getFiltered() {
  const q      = (document.getElementById('searchUser').value || '').toLowerCase();
  const role   = document.getElementById('filterRole').value;
  const status = document.getElementById('filterStatus').value;
  return allUsers.filter(u => {
    if (q && !u.username.includes(q) && !u.displayName.toLowerCase().includes(q)) return false;
    if (role   && u.role   !== role)   return false;
    if (status && u.status !== status) return false;
    return true;
  });
}

function renderList() {
  const list = document.getElementById('userList');
  const filtered = getFiltered();
  if (!filtered.length) {
    list.innerHTML = '<div class="text-center py-5 text-muted small">No users match the filter.</div>';
    return;
  }
  list.innerHTML = filtered.map(u => {
    const initials = u.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
    const avatarColor = u.role === 'superuser' ? '#3b82f6' : '#64748b';
    const roleTxt = u.role === 'superuser' ? 'Super User' : 'Cashier';
    const isSelected = u.id === selectedUserId ? 'selected' : '';
    const inactive = u.status !== 'Active' ? 'opacity-50' : '';
    return `<div class="user-card d-flex align-items-center gap-3 px-3 py-3 ${isSelected} ${inactive}"
         onclick="selectUser('${u.id}')">
      <div class="avatar" style="background:${avatarColor}20;color:${avatarColor}">${initials}</div>
      <div class="flex-grow-1 min-width-0">
        <div class="fw-semibold text-truncate">${u.displayName}</div>
        <div class="text-muted small">@${u.username}</div>
      </div>
      <div class="text-end flex-shrink-0">
        <div class="small" style="color:${avatarColor};font-weight:600">${roleTxt}</div>
        ${u.status !== 'Active' ? '<span class="badge bg-danger-subtle text-danger" style="font-size:.65rem">Inactive</span>' : ''}
      </div>
    </div>`;
  }).join('');
}

function selectUser(id) {
  selectedUserId = id;
  renderList(); // re-render to update selected highlight
  showDetail(id);
}

function showDetail(id) {
  const u = allUsers.find(x => x.id === id);
  if (!u) return;
  const panel = document.getElementById('detailPanel');
  const empty = document.getElementById('detailEmpty');
  empty.style.display = 'none';
  panel.classList.add('show');

  const initials = u.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
  const avatarColor = u.role === 'superuser' ? '#3b82f6' : '#64748b';
  const perms = resolvePerms(u);
  const isInactive = u.status === 'Inactive';

  panel.innerHTML = `
    <div class="p-4">
      <!-- Profile header -->
      <div class="d-flex align-items-center gap-3 mb-4">
        <div class="avatar" style="width:56px;height:56px;font-size:1.3rem;background:${avatarColor}20;color:${avatarColor};border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">${initials}</div>
        <div class="flex-grow-1">
          <h5 class="mb-0 fw-bold">${u.displayName}</h5>
          <div class="text-muted small">@${u.username}</div>
        </div>
        <div>
          ${u.role === 'superuser'
            ? '<span class="badge bg-primary px-2 py-1">Super User</span>'
            : '<span class="badge bg-secondary px-2 py-1">Cashier</span>'}
        </div>
      </div>

      <!-- Info grid -->
      <div class="row g-2 mb-4">
        <div class="col-6">
          <div class="p-3 rounded" style="background:#f8fafc;border:1px solid #e2e8f0">
            <div class="text-muted" style="font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.4px">Status</div>
            <div class="fw-semibold mt-1">
              ${isInactive
                ? '<span class="text-danger"><i class="bi bi-x-circle-fill me-1"></i>Inactive</span>'
                : '<span class="text-success"><i class="bi bi-check-circle-fill me-1"></i>Active</span>'}
            </div>
          </div>
        </div>
        <div class="col-6">
          <div class="p-3 rounded" style="background:#f8fafc;border:1px solid #e2e8f0">
            <div class="text-muted" style="font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.4px">Member Since</div>
            <div class="fw-semibold mt-1">${u.createdAt ? formatDate(u.createdAt) : '—'}</div>
          </div>
        </div>
      </div>

      <!-- Permissions (editable) -->
      <div class="mb-4">
        <div class="d-flex align-items-center justify-content-between mb-2">
          <div class="fw-semibold small text-muted" style="text-transform:uppercase;letter-spacing:.5px;font-size:.72rem">Screen Access</div>
          <button class="btn btn-sm btn-outline-primary" style="font-size:.75rem;padding:.2rem .6rem" onclick="savePermissions('${u.id}')">
            <i class="bi bi-floppy me-1"></i>Save Permissions
          </button>
        </div>
        ${u.role === 'superuser' ? `
          <div class="alert alert-primary py-2 mb-0 small"><i class="bi bi-shield-check me-2"></i>Super users always have access to all screens.</div>
        ` : `
        <div id="permList" style="display:flex;flex-direction:column;gap:.5rem">
          ${SCREEN_PERMISSIONS.map(screen => {
            const sp = perms[screen.key] || {};
            const screenEnabled = !!sp.enabled;
            const isDisabled = screen.superuserOnly ? 'disabled' : '';
            const disabledTitle = screen.superuserOnly ? 'title="Requires superuser role"' : '';
            return `
            <div class="perm-screen-block border rounded p-2" style="background:#f8fafc" data-screen-key="${screen.key}">
              <!-- Screen header -->
              <div class="form-check form-switch d-flex align-items-center gap-2 mb-1">
                <input class="form-check-input perm-screen-toggle" type="checkbox" role="switch"
                  id="scr_${screen.key}" data-screen="${screen.key}"
                  ${screenEnabled ? 'checked' : ''} ${isDisabled} ${disabledTitle}
                  style="width:2.2em;height:1.1em;margin-top:0;cursor:pointer"
                  onchange="onScreenToggle('${screen.key}', this.checked)">
                <label class="form-check-label fw-semibold" for="scr_${screen.key}" style="cursor:pointer">
                  <i class="bi ${screen.icon} me-1 text-primary"></i>${screen.label}
                  ${screen.superuserOnly ? `<span class="badge bg-danger-subtle text-danger border border-danger-subtle ms-1" style="font-size:.65rem">${screen.key === 'users' ? 'Superuser only' : 'Superuser only'}</span>` : ''}
                </label>
              </div>
              <!-- Sub-items -->
              <div class="ps-4 perm-subs" id="subs_${screen.key}" ${!screenEnabled ? 'style="opacity:.4;pointer-events:none"' : ''}>
                ${screen.subs.map(sub => {
                  const subEnabled = !!sp[sub.key];
                  return `<div class="form-check d-flex align-items-center gap-2 mb-1">
                    <input class="form-check-input perm-sub-toggle" type="checkbox"
                      id="sub_${screen.key}_${sub.key}"
                      data-screen="${screen.key}" data-sub="${sub.key}"
                      ${subEnabled ? 'checked' : ''} ${isDisabled}
                      style="cursor:pointer">
                    <label class="form-check-label small text-muted" for="sub_${screen.key}_${sub.key}" style="cursor:pointer">
                      ${sub.label}
                    </label>
                  </div>`;
                }).join('')}
              </div>
            </div>`;
          }).join('')}
        </div>`}
      </div>

      <!-- Actions -->
      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-primary btn-sm" onclick="openEditModal('${u.id}')">
          <i class="bi bi-pencil me-1"></i>Edit Profile
        </button>
        <button class="btn btn-outline-secondary btn-sm" onclick="openResetModal('${u.id}')">
          <i class="bi bi-key me-1"></i>Reset Password
        </button>
        <button class="btn btn-sm ${isInactive ? 'btn-outline-success' : 'btn-outline-warning'}"
          onclick="toggleStatus('${u.id}','${isInactive ? 'Active' : 'Inactive'}')">
          <i class="bi bi-${isInactive ? 'person-check' : 'person-dash'} me-1"></i>
          ${isInactive ? 'Activate' : 'Deactivate'}
        </button>
        ${u.role !== 'superuser' ? `
        <button class="btn btn-outline-danger btn-sm" onclick="deleteUser('${u.id}','${u.username}')">
          <i class="bi bi-trash me-1"></i>Delete
        </button>` : ''}
      </div>
    </div>`;
}

/* ---- Screen toggle: enable/disable all subs ---- */
function onScreenToggle(screenKey, enabled) {
  const subsDiv = document.getElementById('subs_' + screenKey);
  if (subsDiv) {
    subsDiv.style.opacity = enabled ? '1' : '0.4';
    subsDiv.style.pointerEvents = enabled ? '' : 'none';
  }
}

/* ---- Save permissions ---- */
async function savePermissions(userId) {
  const permissions = {};
  SCREEN_PERMISSIONS.forEach(screen => {
    const screenEl = document.getElementById('scr_' + screen.key);
    if (!screenEl) return;
    const sp = { enabled: screenEl.checked };
    screen.subs.forEach(sub => {
      const subEl = document.getElementById('sub_' + screen.key + '_' + sub.key);
      sp[sub.key] = subEl ? subEl.checked : false;
    });
    permissions[screen.key] = sp;
  });
  try {
    await api('PUT', '/users/' + userId, { permissions });
    const u = allUsers.find(x => x.id === userId);
    if (u) u.permissions = permissions;
    showNotification('Permissions saved.');
  } catch (err) {
    showNotification(err.message, 'danger');
  }
}

/* ---- Add / Edit modal ---- */
function openAddModal() {
  document.getElementById('userModalTitle').textContent = 'Add User';
  document.getElementById('userId').value = '';
  document.getElementById('uUsername').value = '';
  document.getElementById('uUsername').disabled = false;
  document.getElementById('uDisplayName').value = '';
  document.getElementById('uRole').value = 'cashier';
  document.getElementById('uPassword').value = '';
  document.getElementById('uPassword').type = 'password';
  document.getElementById('passIcon').className = 'bi bi-eye';
  document.getElementById('passLabel').innerHTML = 'Password <span class="text-danger">*</span>';
  document.getElementById('passHint').textContent = '';
  document.getElementById('statusRow').style.display = 'none';
  onRoleDropdownChange();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('userModal')).show();
}

function openEditModal(id) {
  const u = allUsers.find(x => x.id === id);
  if (!u) return;
  document.getElementById('userModalTitle').textContent = 'Edit User';
  document.getElementById('userId').value = u.id;
  document.getElementById('uUsername').value = u.username;
  document.getElementById('uUsername').disabled = true;
  document.getElementById('uDisplayName').value = u.displayName;
  document.getElementById('uRole').value = u.role;
  document.getElementById('uPassword').value = '';
  document.getElementById('uPassword').type = 'password';
  document.getElementById('passIcon').className = 'bi bi-eye';
  document.getElementById('passLabel').innerHTML = 'New Password';
  document.getElementById('passHint').textContent = 'Leave blank to keep current password.';
  document.getElementById('statusRow').style.display = '';
  document.getElementById('uStatus').value = u.status;
  onRoleDropdownChange();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('userModal')).show();
}

async function saveUser() {
  const id          = document.getElementById('userId').value;
  const isEdit      = !!id;
  const username    = document.getElementById('uUsername').value.trim().toLowerCase();
  const displayName = document.getElementById('uDisplayName').value.trim();
  const role        = document.getElementById('uRole').value;
  const password    = document.getElementById('uPassword').value;
  const status      = document.getElementById('uStatus').value || 'Active';

  if (!displayName)          { showNotification('Display name is required.', 'warning'); return; }
  if (!isEdit && !username)  { showNotification('Username is required.', 'warning'); return; }
  if (!isEdit && !password)  { showNotification('Password is required.', 'warning'); return; }

  const btn = document.getElementById('btnSaveUser');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';
  try {
    if (isEdit) {
      const body = { displayName, role, status };
      if (password) body.password = password;
      await api('PUT', '/users/' + id, body);
      showNotification('User updated.');
    } else {
      await api('POST', '/users', { username, displayName, role, password });
      showNotification('User created.');
    }
    bootstrap.Modal.getInstance(document.getElementById('userModal')).hide();
    await loadUsers();
    if (selectedUserId) showDetail(selectedUserId);
  } catch (err) {
    showNotification(err.message, 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save';
  }
}

/* ---- Reset password ---- */
function openResetModal(id) {
  const u = allUsers.find(x => x.id === id);
  if (!u) return;
  resetTargetId = id;
  document.getElementById('resetUserName').textContent = u.displayName + ' (@' + u.username + ')';
  document.getElementById('newPassword').value = '';
  document.getElementById('newPassword').type = 'password';
  document.getElementById('resetIcon').className = 'bi bi-eye';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('resetModal')).show();
}

async function confirmReset() {
  const password = document.getElementById('newPassword').value;
  if (!password) { showNotification('Enter a new password.', 'warning'); return; }
  const btn = document.getElementById('btnConfirmReset');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>';
  try {
    await api('PUT', '/users/' + resetTargetId, { password });
    bootstrap.Modal.getInstance(document.getElementById('resetModal')).hide();
    showNotification('Password reset successfully.');
  } catch (err) {
    showNotification(err.message, 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-key me-1"></i>Reset';
  }
}

/* ---- Toggle status ---- */
async function toggleStatus(id, newStatus) {
  try {
    await api('PUT', '/users/' + id, { status: newStatus });
    showNotification('User ' + (newStatus === 'Active' ? 'activated' : 'deactivated') + '.');
    await loadUsers();
    showDetail(id);
  } catch (err) {
    showNotification(err.message, 'danger');
  }
}

/* ---- Delete ---- */
async function deleteUser(id, username) {
  if (!confirm('Delete user "' + username + '"? This cannot be undone.')) return;
  try {
    await api('DELETE', '/users/' + id);
    showNotification('User deleted.');
    selectedUserId = null;
    document.getElementById('detailPanel').classList.remove('show');
    document.getElementById('detailEmpty').style.display = '';
    await loadUsers();
  } catch (err) {
    showNotification(err.message, 'danger');
  }
}
