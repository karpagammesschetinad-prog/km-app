/* =============================================
   main.js — Shared utilities for all pages
   ============================================= */

const API_BASE = '/api';
let CURRENCY = 'USD';

// Load config from server (currency etc.)
(async () => {
  try {
    const r = await fetch(`${API_BASE}/config`);
    const cfg = await r.json();
    CURRENCY = cfg.currency || 'USD';
  } catch (_) {}
})();

// Cached employees list
const _cache = { employees: null };

/* ---------- Formatting helpers ---------- */

function formatCurrency(amount) {
  const n = parseFloat(amount) || 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: CURRENCY,
    minimumFractionDigits: 0, maximumFractionDigits: 2
  }).format(n);
}

function formatDate(str) {
  if (!str) return '—';
  try {
    const d = new Date(str.includes('T') ? str : str + 'T00:00:00');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) { return str; }
}

function formatMonth(month, year) {
  return new Date(parseInt(year), parseInt(month) - 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/* ---------- Status badge ---------- */
function statusBadge(status) {
  const map = {
    Pending: 'warning', Approved: 'success', Rejected: 'danger',
    Active: 'success', Inactive: 'secondary', Paid: 'success'
  };
  const c = map[status] || 'secondary';
  return `<span class="badge bg-${c}-subtle text-${c} border border-${c}-subtle">${status || '—'}</span>`;
}

/* ---------- Table helpers ---------- */
function loadingRow(cols) {
  return `<tr><td colspan="${cols}" class="text-center py-4 text-muted">
    <div class="spinner-border spinner-border-sm text-primary me-2" role="status"></div>Loading…
  </td></tr>`;
}

function emptyRow(cols, msg = 'No records found') {
  return `<tr><td colspan="${cols}" class="text-center py-5 text-muted">
    <i class="bi bi-inbox fs-3 d-block mb-2 opacity-50"></i>${msg}
  </td></tr>`;
}

/* ---------- Toast notifications ---------- */
function showNotification(message, type = 'success') {
  let box = document.getElementById('_toastBox');
  if (!box) {
    box = document.createElement('div');
    box.id = '_toastBox';
    box.className = 'toast-container position-fixed bottom-0 end-0 p-3';
    box.style.zIndex = 9999;
    document.body.appendChild(box);
  }
  const icons = { success: 'check-circle-fill', danger: 'x-circle-fill', warning: 'exclamation-triangle-fill', info: 'info-circle-fill' };
  const id = '_t' + Date.now();
  box.insertAdjacentHTML('beforeend', `
    <div id="${id}" class="toast align-items-center border-0 bg-${type} text-white" role="alert">
      <div class="d-flex">
        <div class="toast-body"><i class="bi bi-${icons[type] || 'info-circle-fill'} me-2"></i>${message}</div>
        <button class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>`);
  const el = document.getElementById(id);
  new bootstrap.Toast(el, { delay: 3500 }).show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

/* ---------- API helper ---------- */
async function api(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json();
  if (!data.success) throw new Error(data.message || 'Request failed');
  return data.data ?? data;
}

/* ---------- Employee helpers (shared) ---------- */
async function fetchEmployees(forceRefresh = false) {
  if (_cache.employees && !forceRefresh) return _cache.employees;
  _cache.employees = await api('GET', '/employees');
  return _cache.employees;
}

function populateEmployeeSelect(selectEl, employees, selectedId = null) {
  selectEl.innerHTML = '<option value="">— Select Employee —</option>';
  (employees || []).forEach(emp => {
    const opt = document.createElement('option');
    opt.value = emp.id;
    opt.textContent = emp.name;
    opt.dataset.salary = emp.baseSalary;
    if (selectedId && emp.id === selectedId) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

/* ---------- Auth state (loaded once per page) ---------- */
let currentUser = null;

async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.success) {
      currentUser = data.data;
      return currentUser;
    }
  } catch (_) {}
  return null;
}

function isSuperUser() {
  return currentUser && currentUser.role === 'superuser';
}

function canAccess(screen) {
  if (!currentUser) return false;
  if (currentUser.role === 'superuser') return true;
  const perms = currentUser.permissions;
  if (!perms || typeof perms !== 'object') {
    // No permissions stored: cashier default
    if (screen === 'expenses') return sub ? (sub === 'view' || sub === 'add') : true;
    return false;
  }
  const sp = perms[screen];
  if (!sp) return false;
  // Old flat boolean format (migration)
  if (typeof sp === 'boolean') return sp;
  // New nested format
  if (!sp.enabled) return false;
  if (sub === null) return true;
  return !!sp[sub];
}

async function requireLogin() {
  const user = await loadCurrentUser();
  if (!user) {
    window.location.href = '/login.html';
    return null;
  }

  // Show nav items based on role or per-user permissions
  if (user.role === 'superuser') {
    // Superuser sees everything
    document.querySelectorAll('.su-only').forEach(el => el.classList.remove('su-only'));
  } else {
    // For other roles: show only permitted screens
    const perms = user.permissions || {};
    document.querySelectorAll('[data-screen]').forEach(el => {
      const screen = el.dataset.screen;
      const sp = perms[screen];
      // Support both old boolean and new nested format
      const enabled = sp && (typeof sp === 'boolean' ? sp : sp.enabled);
      if (enabled) el.classList.remove('su-only');
    });
  }
  // Inject user badge + logout into all top navbars
  const navbar = document.querySelector('.top-navbar');
  if (navbar && !document.getElementById('_userBadge')) {
    const div = document.createElement('div');
    div.id = '_userBadge';
    div.className = 'd-flex align-items-center gap-2 ms-auto';
    div.innerHTML =
      `<span class="badge ${user.role === 'superuser' ? 'bg-primary' : 'bg-secondary'} px-2 py-1">
        <i class="bi bi-person-fill me-1"></i>${user.displayName}
      </span>
      <button class="btn btn-sm btn-outline-danger" id="btnLogout" title="Logout">
        <i class="bi bi-box-arrow-right"></i>
      </button>`;
    navbar.appendChild(div);
    document.getElementById('btnLogout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
  }
  return user;
}

/* ---------- Active nav + mobile sidebar ---------- */
document.addEventListener('DOMContentLoaded', () => {
  // Highlight active nav link
  const page = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.sidebar .nav-link').forEach(link => {
    const href = (link.getAttribute('href') || '').split('/').pop();
    if (href === page || (page === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });

  // Mobile sidebar toggle
  const btn = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');

  btn?.addEventListener('click', () => {
    sidebar?.classList.toggle('show');
    overlay?.classList.toggle('show');
  });
  overlay?.addEventListener('click', () => {
    sidebar?.classList.remove('show');
    overlay?.classList.remove('show');
  });
});
