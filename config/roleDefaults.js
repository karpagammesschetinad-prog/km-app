/* Shared role permission defaults — used by auth.js and users.js routes */

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

module.exports = { ROLE_DEFAULTS };
