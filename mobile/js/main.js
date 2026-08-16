/* =============================================
   mobile/js/main.js — shared utilities (GAS version)
   Drop-in replacement for the server-based main.js
   ============================================= */

const CURRENCY = 'INR';
let currentUser = null;
const _cache = { employees: null };

/* ---------- Auth helpers ---------- */

async function loadCurrentUser() {
  if (currentUser) return currentUser;
  const cached = getCachedUser(); // from api.js
  if (!cached) return null;
  // Verify token is still valid with GAS (non-blocking — use cache first)
  currentUser = cached;
  gasMe().then(u => { if (u) { currentUser = u; setCurrentUser(u); } }).catch(() => {});
  return currentUser;
}

function isSuperUser() {
  return currentUser && currentUser.role === 'superuser';
}

async function requireLogin() {
  const user = await loadCurrentUser();
  if (!user) { window.location.href = 'login.html'; return null; }

  if (user.role === 'superuser') {
    document.querySelectorAll('.su-only').forEach(el => el.classList.remove('su-only'));
  }

  const navbar = document.querySelector('.top-navbar');
  if (navbar && !document.getElementById('_userBadge')) {
    const div = document.createElement('div');
    div.id = '_userBadge';
    div.className = 'd-flex align-items-center gap-2 ms-auto';
    div.innerHTML = `
      <span class="badge ${user.role === 'superuser' ? 'bg-primary' : 'bg-secondary'} px-2 py-1">
        <i class="bi bi-person-fill me-1"></i>${user.displayName}
      </span>
      <button class="btn btn-sm btn-outline-danger" id="btnLogout" title="Logout">
        <i class="bi bi-box-arrow-right"></i>
      </button>`;
    navbar.appendChild(div);
    document.getElementById('btnLogout').addEventListener('click', async () => {
      await gasLogout();
      window.location.href = 'login.html';
    });
  }
  return user;
}

/* ---------- API wrapper (maps desktop api() calls to GAS) ---------- */

async function api(method, path, body = null) {
  // Map REST paths to GAS action names
  const map = {
    'GET /expenses':          () => gasExpenses.getAll(),
    'POST /expenses/bulk':    () => gasExpenses.bulk(body),
    'DELETE /expenses':       () => gasExpenses.delete(body.id),
    'GET /categories':        () => gasCategories.getAll(),
    'POST /categories':       () => gasCategories.create(body),
    'PUT /categories':        () => gasCategories.update(body),
    'DELETE /categories':     () => gasCategories.delete(body.id),
    'GET /employees':         () => gasEmployees.getAll(),
    'POST /employees':        () => gasEmployees.create(body),
    'PUT /employees':         () => gasEmployees.update(body),
    'DELETE /employees':      () => gasEmployees.delete(body.id),
    'GET /salaries':          () => gasSalaries.getAll(),
    'POST /salaries':         () => gasSalaries.create(body),
    'PUT /salaries':          () => gasSalaries.update(body),
    'DELETE /salaries':       () => gasSalaries.delete(body.id),
    'GET /users':             () => gasUsers.getAll(),
    'POST /users':            () => gasUsers.create(body),
    'DELETE /users':          () => gasUsers.delete(body.id)
  };

  // Normalise path — strip IDs and store them in body
  let normPath = path;
  // /expenses/approve/DATE
  const approveMatch = path.match(/^\/expenses\/approve\/(.+)$/);
  if (approveMatch) return gasExpenses.approve(approveMatch[1]);
  // /expenses/reject/DATE
  const rejectMatch = path.match(/^\/expenses\/reject\/(.+)$/);
  if (rejectMatch) return gasExpenses.reject(rejectMatch[1], body && body.reason);
  // /users/ID  PUT
  const userPutMatch = path.match(/^\/users\/(.+)$/);
  if (userPutMatch && method === 'PUT') return gasUsers.update({ ...body, id: userPutMatch[1] });
  if (userPutMatch && method === 'DELETE') return gasUsers.delete(userPutMatch[1]);
  // /categories/ID  PUT/DELETE
  const catMatch = path.match(/^\/categories\/(.+)$/);
  if (catMatch && method === 'PUT')    return gasCategories.update({ ...body, id: catMatch[1] });
  if (catMatch && method === 'DELETE') return gasCategories.delete(catMatch[1]);
  // /employees/ID
  const empMatch = path.match(/^\/employees\/(.+)$/);
  if (empMatch && method === 'PUT')    return gasEmployees.update({ ...body, id: empMatch[1] });
  if (empMatch && method === 'DELETE') return gasEmployees.delete(empMatch[1]);
  // /salaries/ID
  const salMatch = path.match(/^\/salaries\/(.+)$/);
  if (salMatch && method === 'PUT')    return gasSalaries.update({ ...body, id: salMatch[1] });
  if (salMatch && method === 'DELETE') return gasSalaries.delete(salMatch[1]);

  const key = `${method} ${normPath}`;
  const fn  = map[key];
  if (!fn) throw new Error('Unknown API path: ' + key);
  return fn();
}

/* ---------- Formatting helpers ---------- */

function formatCurrency(amount) {
  const n = parseFloat(amount) || 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR',
    minimumFractionDigits: 0, maximumFractionDigits: 2
  }).format(n);
}

function formatDate(str) {
  if (!str) return '—';
  try {
    const d = new Date(str.includes('T') ? str : str + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch(_) { return str; }
}

function formatMonth(month, year) {
  return new Date(parseInt(year), parseInt(month) - 1)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function statusBadge(status) {
  const map = { Pending:'warning', Approved:'success', Rejected:'danger', Active:'success', Inactive:'secondary', Paid:'success' };
  const c = map[status] || 'secondary';
  return `<span class="badge bg-${c}-subtle text-${c} border border-${c}-subtle">${status || '—'}</span>`;
}

function loadingRow(cols) {
  return `<tr><td colspan="${cols}" class="text-center py-4 text-muted">
    <div class="spinner-border spinner-border-sm text-primary me-2"></div>Loading…</td></tr>`;
}

function emptyRow(cols, msg = 'No records found') {
  return `<tr><td colspan="${cols}" class="text-center py-5 text-muted">
    <i class="bi bi-inbox fs-3 d-block mb-2 opacity-50"></i>${msg}</td></tr>`;
}

function showNotification(message, type = 'success') {
  let box = document.getElementById('_toastBox');
  if (!box) {
    box = document.createElement('div');
    box.id = '_toastBox';
    box.className = 'toast-container position-fixed bottom-0 end-0 p-3';
    box.style.zIndex = 9999;
    document.body.appendChild(box);
  }
  const icons = { success:'check-circle-fill', danger:'x-circle-fill', warning:'exclamation-triangle-fill', info:'info-circle-fill' };
  const id = '_t' + Date.now();
  box.insertAdjacentHTML('beforeend', `
    <div id="${id}" class="toast align-items-center border-0 bg-${type} text-white" role="alert">
      <div class="d-flex">
        <div class="toast-body"><i class="bi bi-${icons[type]||'info-circle-fill'} me-2"></i>${message}</div>
        <button class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>`);
  const el = document.getElementById(id);
  new bootstrap.Toast(el, { delay: 3500 }).show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

/* ---------- Employee helpers ---------- */

async function fetchEmployees(forceRefresh = false) {
  if (_cache.employees && !forceRefresh) return _cache.employees;
  _cache.employees = await api('GET', '/employees');
  return _cache.employees;
}

function populateEmployeeSelect(selectEl, employees, selectedId = null) {
  selectEl.innerHTML = '<option value="">— Select Employee —</option>';
  (employees || []).forEach(emp => {
    const opt = document.createElement('option');
    opt.value = emp.id; opt.textContent = emp.name; opt.dataset.salary = emp.baseSalary;
    if (selectedId && emp.id === selectedId) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

/* ---------- Active nav + mobile sidebar ---------- */
document.addEventListener('DOMContentLoaded', () => {
  const page = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.sidebar .nav-link').forEach(link => {
    const href = (link.getAttribute('href') || '').split('/').pop();
    if (href === page) link.classList.add('active');
  });

  const toggle  = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay && overlay.classList.toggle('active');
    });
    overlay && overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
    });
  }
});
