/* ============================================================
   mobile/js/api.js — Google Apps Script API client
   Replace GAS_URL with your deployed Web App URL
   ============================================================ */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbyRXn9TRyY8yIi6mtmte_Rp54fAngurcUZY8g5zTPUAPSMhsULllaN9bN1pt3rUD72V/exec';

/* Auth token is stored in localStorage */
function getToken() { return localStorage.getItem('biz_token') || ''; }
function setToken(t) { t ? localStorage.setItem('biz_token', t) : localStorage.removeItem('biz_token'); }
function setCurrentUser(u) { u ? localStorage.setItem('biz_user', JSON.stringify(u)) : localStorage.removeItem('biz_user'); }
function getCachedUser() {
  try { return JSON.parse(localStorage.getItem('biz_user') || 'null'); } catch(_) { return null; }
}

/* Core GAS call — JSONP to bypass CORS/redirect issue with GAS */
function gasCall(action, body = null) {
  return new Promise((resolve, reject) => {
    const token  = getToken();
    const cbName = '_cb' + Date.now().toString(36);
    const url    = new URL(GAS_URL);
    url.searchParams.set('action',   action);
    url.searchParams.set('callback', cbName);
    if (token) url.searchParams.set('token',   token);
    if (body)  url.searchParams.set('payload', JSON.stringify(body));

    const timer = setTimeout(() => {
      cleanup(); reject(new Error('Request timed out'));
    }, 30000);

    function cleanup() {
      clearTimeout(timer);
      delete window[cbName];
      const el = document.getElementById(cbName);
      if (el) el.remove();
    }

    window[cbName] = function(data) {
      cleanup();
      if (!data.success) return reject(new Error(data.message || 'Request failed'));
      resolve(data.data ?? data);
    };

    const script = document.createElement('script');
    script.id  = cbName;
    script.src = url.toString();
    script.onerror = () => { cleanup(); reject(new Error('GAS not reachable — redeploy Web App')); };
    document.head.appendChild(script);
  });
}

/* Auth */
async function gasLogin(username, password) {
  const data = await gasCall('login', { username, password });
  setToken(data.token);
  const user = { ...data }; delete user.token;
  setCurrentUser(user);
  return user;
}

async function gasLogout() {
  await gasCall('logout').catch(() => {});
  setToken(null);
  setCurrentUser(null);
}

async function gasMe() {
  const token = getToken();
  if (!token) return null;
  try {
    const user = await gasCall('me');
    setCurrentUser(user);
    return user;
  } catch(_) {
    setToken(null);
    return null;
  }
}

/* Expenses */
const gasExpenses = {
  getAll:    ()       => gasCall('getExpenses'),
  bulk:      (body)   => gasCall('bulkExpenses', body),
  approve:   (date)   => gasCall('approveDate',  { date }),
  reject:    (date, reason) => gasCall('rejectDate', { date, reason }),
  delete:    (id)     => gasCall('deleteExpense', { id })
};

/* Categories */
const gasCategories = {
  getAll:  ()     => gasCall('getCategories'),
  create:  (body) => gasCall('createCategory', body),
  update:  (body) => gasCall('updateCategory', body),
  delete:  (id)   => gasCall('deleteCategory', { id })
};

/* Employees */
const gasEmployees = {
  getAll:  ()     => gasCall('getEmployees'),
  create:  (body) => gasCall('createEmployee', body),
  update:  (body) => gasCall('updateEmployee', body),
  delete:  (id)   => gasCall('deleteEmployee', { id })
};

/* Salaries */
const gasSalaries = {
  getAll:  ()     => gasCall('getSalaries'),
  create:  (body) => gasCall('createSalary', body),
  update:  (body) => gasCall('updateSalary', body),
  delete:  (id)   => gasCall('deleteSalary', { id })
};

/* Users */
const gasUsers = {
  getAll:  ()     => gasCall('getUsers'),
  create:  (body) => gasCall('createUser', body),
  update:  (body) => gasCall('updateUser', body),
  delete:  (id)   => gasCall('deleteUser', { id })
};
