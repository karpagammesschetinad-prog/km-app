/* =============================================
   main.js — Shared utilities for all pages
   ============================================= */

const API_BASE = '/api';
let CURRENCY = 'USD';
let idleLogoutTimer = null;
let idleWarningTimer = null;
let idleLogoutInProgress = false;
let idleTimeoutMinutes = null;
const IDLE_WARNING_SECONDS = 30;

// Load config from server (currency and security settings)
const configReady = (async () => {
  try {
    const r = await fetch(`${API_BASE}/config`);
    const response = await r.json();
    const cfg = response.data || response;
    CURRENCY = cfg.currency || 'USD';
    idleTimeoutMinutes = Number(cfg.idleTimeoutMinutes) || null;
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

/* ---------- Optional Tamil virtual keyboard ---------- */
const TAMIL_KEY_ROWS = [
  ['அ', 'ஆ', 'இ', 'ஈ', 'உ', 'ஊ', 'எ', 'ஏ', 'ஐ', 'ஒ', 'ஓ', 'ஔ'],
  ['க்', 'க', 'ங', 'ச', 'ஞ', 'ட', 'ண', 'த', 'ந', 'ப', 'ம', 'ய', 'ர', 'ல', 'வ', 'ழ', 'ள', 'ற', 'ன'],
  ['ா', 'ி', 'ீ', 'ு', 'ூ', 'ெ', 'ே', 'ை', 'ொ', 'ோ', 'ௌ', '்', 'ஂ', 'ஃ']
];
let tamilKeyboardTarget = null;
const NATIVE_KEYBOARD_STORAGE_KEY = 'biztracker-use-native-keyboard';

function usesNativeKeyboard() {
  return localStorage.getItem(NATIVE_KEYBOARD_STORAGE_KEY) === 'true';
}

function applyKeyboardMode(element) {
  if (!isTamilKeyboardTarget(element)) return;
  element.setAttribute('inputmode', usesNativeKeyboard() ? 'text' : 'none');
}

function applyKeyboardModeToInputs() {
  document.querySelectorAll('input, textarea').forEach(applyKeyboardMode);
}

function isTamilKeyboardTarget(element) {
  if (!element || element.disabled || element.readOnly) return false;
  if (element.tagName === 'TEXTAREA') return true;
  return element.tagName === 'INPUT' && ['text', 'search', 'email', 'tel', 'password'].includes(element.type);
}

function insertTamilText(value) {
  const target = tamilKeyboardTarget;
  if (!isTamilKeyboardTarget(target)) return;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  target.setRangeText(value, start, end, 'end');
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.focus();
}

function deleteTamilText() {
  const target = tamilKeyboardTarget;
  if (!isTamilKeyboardTarget(target)) return;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  if (start !== end) target.setRangeText('', start, end, 'end');
  else if (start > 0) target.setRangeText('', start - 1, start, 'end');
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.focus();
}

function setupTamilKeyboard() {
  if (document.getElementById('_tamilKeyboardToggle')) return;
  const toggle = document.createElement('button');
  toggle.id = '_tamilKeyboardToggle';
  toggle.type = 'button';
  toggle.className = 'tamil-keyboard-toggle';
  toggle.title = 'Toggle Tamil virtual keyboard';
  toggle.setAttribute('aria-label', 'Toggle Tamil virtual keyboard');
  toggle.innerHTML = '<span>தமிழ்</span><i class="bi bi-keyboard"></i>';

  const panel = document.createElement('section');
  panel.id = '_tamilKeyboardPanel';
  panel.className = 'tamil-keyboard-panel';
  panel.setAttribute('aria-label', 'Tamil virtual keyboard');
  panel.innerHTML = '<div class="tamil-keyboard-header"><strong>Tamil keyboard</strong><label class="small d-flex align-items-center gap-1" title="Allow the device keyboard for text fields"><input type="checkbox" id="_useNativeKeyboard"> Device keyboard</label><button type="button" class="tamil-keyboard-close" aria-label="Close Tamil keyboard"><i class="bi bi-x-lg"></i></button></div>' +
    TAMIL_KEY_ROWS.map(row => '<div class="tamil-keyboard-row">' + row.map(key => `<button type="button" class="tamil-key" data-tamil-key="${key}">${key}</button>`).join('') + '</div>').join('') +
    '<div class="tamil-keyboard-row tamil-keyboard-actions"><button type="button" class="tamil-key tamil-key-wide" data-tamil-key=" ">Space</button><button type="button" class="tamil-key" data-tamil-action="backspace" aria-label="Backspace"><i class="bi bi-backspace"></i></button><button type="button" class="tamil-key" data-tamil-action="clear">Clear</button></div>';

  document.body.append(toggle, panel);
  const hideKeyboardIfFocusMoved = () => {
    const active = document.activeElement;
    if (isTamilKeyboardTarget(active) || panel.contains(active) || toggle.contains(active)) return;
    document.body.classList.remove('tamil-keyboard-ready');
    panel.classList.remove('show');
    toggle.classList.remove('active');
  };
  const nativeKeyboardCheckbox = panel.querySelector('#_useNativeKeyboard');
  nativeKeyboardCheckbox.checked = usesNativeKeyboard();
  nativeKeyboardCheckbox.addEventListener('change', () => {
    localStorage.setItem(NATIVE_KEYBOARD_STORAGE_KEY, String(nativeKeyboardCheckbox.checked));
    applyKeyboardModeToInputs();
    if (nativeKeyboardCheckbox.checked) {
      panel.classList.remove('show');
      toggle.classList.remove('active');
    } else if (isTamilKeyboardTarget(tamilKeyboardTarget)) {
      panel.classList.add('show');
      toggle.classList.add('active');
    }
  });
  applyKeyboardModeToInputs();
  document.addEventListener('focusin', event => {
    if (isTamilKeyboardTarget(event.target)) {
      applyKeyboardMode(event.target);
      tamilKeyboardTarget = event.target;
      document.body.classList.add('tamil-keyboard-ready');
      if (!usesNativeKeyboard()) {
        panel.classList.add('show');
        toggle.classList.add('active');
      }
    }
  });
  document.addEventListener('focusout', () => setTimeout(hideKeyboardIfFocusMoved, 0));
  document.addEventListener('pointerdown', event => {
    if (isTamilKeyboardTarget(event.target) || panel.contains(event.target) || toggle.contains(event.target)) return;
    document.body.classList.remove('tamil-keyboard-ready');
    panel.classList.remove('show');
    toggle.classList.remove('active');
  });
  toggle.addEventListener('click', () => {
    panel.classList.toggle('show');
    toggle.classList.toggle('active', panel.classList.contains('show'));
  });
  panel.querySelector('.tamil-keyboard-close').addEventListener('click', () => {
    panel.classList.remove('show');
    toggle.classList.remove('active');
  });
  panel.addEventListener('mousedown', event => event.preventDefault());
  panel.addEventListener('click', event => {
    const key = event.target.closest('[data-tamil-key]');
    const action = event.target.closest('[data-tamil-action]')?.dataset.tamilAction;
    if (key) insertTamilText(key.dataset.tamilKey);
    if (action === 'backspace') deleteTamilText();
    if (action === 'clear' && isTamilKeyboardTarget(tamilKeyboardTarget)) {
      tamilKeyboardTarget.setRangeText('', 0, tamilKeyboardTarget.value.length, 'end');
      tamilKeyboardTarget.dispatchEvent(new Event('input', { bubbles: true }));
      tamilKeyboardTarget.focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', setupTamilKeyboard);

async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
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

function canAccess(screen, sub = null) {
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

function setupIdleLogout() {
  if (idleLogoutTimer) clearTimeout(idleLogoutTimer);
  if (idleWarningTimer) clearInterval(idleWarningTimer);
  let warning = document.getElementById('_idleLogoutWarning');
  if (!warning) {
    warning = document.createElement('div');
    warning.id = '_idleLogoutWarning';
    warning.className = 'idle-logout-warning';
    warning.setAttribute('role', 'alert');
    document.body.appendChild(warning);
  }
  warning.classList.remove('show');
  const resetIdleLogout = () => {
    if (idleLogoutInProgress) return;
    clearTimeout(idleLogoutTimer);
    clearInterval(idleWarningTimer);
    warning.classList.remove('show');
    const timeoutMs = idleTimeoutMinutes * 60 * 1000;
    const warningAt = Math.max(0, timeoutMs - IDLE_WARNING_SECONDS * 1000);
    idleWarningTimer = setTimeout(() => {
      let secondsLeft = IDLE_WARNING_SECONDS;
      warning.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-2"></i><strong>Session expiring:</strong> You will be logged out in <strong>${secondsLeft}</strong> seconds.`;
      warning.classList.add('show');
      idleWarningTimer = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft <= 0) return clearInterval(idleWarningTimer);
        warning.querySelector('strong:last-child').textContent = secondsLeft;
      }, 1000);
    }, warningAt);
    idleLogoutTimer = setTimeout(async () => {
      clearInterval(idleWarningTimer);
      idleLogoutInProgress = true;
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
      window.location.href = '/login.html?reason=timeout';
    }, idleTimeoutMinutes * 60 * 1000);
  };
  ['click', 'keydown', 'pointerdown', 'touchstart', 'scroll'].forEach(eventName => {
    document.addEventListener(eventName, resetIdleLogout, { passive: true });
  });
  resetIdleLogout();
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
      const sub    = el.dataset.sub || null;
      const sp = perms[screen];
      // Support both old boolean and new nested format
      const screenEnabled = sp && (typeof sp === 'boolean' ? sp : sp.enabled);
      if (!screenEnabled) {
        el.classList.add('su-only'); // hide if screen not enabled
        return;
      }
      if (sub) {
        // sub-level check (e.g. data-sub="add" on Add Expense link)
        const subEnabled = typeof sp === 'boolean' ? sp : !!sp[sub];
        if (!subEnabled) { el.classList.add('su-only'); return; }
      }
      el.classList.remove('su-only');
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
    if (user.role === 'superuser') {
      const settings = document.createElement('a');
      settings.className = 'btn btn-sm btn-outline-secondary';
      settings.href = '/settings.html';
      settings.title = 'Settings';
      settings.innerHTML = '<i class="bi bi-gear"></i>';
      div.prepend(settings);
    }
    document.getElementById('btnLogout').addEventListener('click', async () => {
      if (!confirm('Are you sure you want to logout?')) return;
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
  }
  await configReady;
  if (idleTimeoutMinutes) setupIdleLogout();
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
