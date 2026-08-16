/* add-expense.js */

let allCategories = [];

document.addEventListener('DOMContentLoaded', async () => {
  // Set today's date
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('expDate').value = today;
  const lbl = document.getElementById('todayLabel');
  if (lbl) lbl.textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  document.getElementById('btnSaveExpense').addEventListener('click', save);

  try {
    allCategories = await api('GET', '/categories');
    buildCategoryRows();
  } catch (err) {
    document.getElementById('categoryRows').innerHTML =
      `<div class="alert alert-danger">Failed to load categories: ${err.message}</div>`;
  }
});

function buildCategoryRows() {
  const active = allCategories
    .filter(c => c.status === 'Active')
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const container = document.getElementById('categoryRows');

  if (!active.length) {
    container.innerHTML = `<div class="text-center text-muted py-3">
      No active categories. <a href="/categories.html">Manage Categories →</a></div>`;
    return;
  }

  container.innerHTML = `
    <table class="table table-sm table-borderless mb-0">
      <tbody>
        ${active.map(c => `
          <tr>
            <td class="fw-medium align-middle" style="width:55%">${c.name}</td>
            <td style="width:45%">
              <div class="input-group input-group-sm">
                <span class="input-group-text fw-semibold">&#8377;</span>
                <input type="number"
                  class="form-control cat-amount"
                  data-category="${c.name}"
                  min="0" step="0.01"
                  placeholder="0"
                  oninput="updateTotal()">
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

function updateTotal() {
  let total = 0;
  document.querySelectorAll('.cat-amount').forEach(inp => {
    total += parseFloat(inp.value) || 0;
  });
  document.getElementById('runningTotal').textContent = formatCurrency(total);
}

async function save() {
  const date = document.getElementById('expDate').value;
  if (!date) { showNotification('Please select a date.', 'warning'); return; }

  const entries = [];
  document.querySelectorAll('.cat-amount').forEach(inp => {
    const amount = parseFloat(inp.value);
    if (amount > 0) entries.push({ category: inp.dataset.category, amount });
  });

  if (!entries.length) { showNotification('Enter at least one amount greater than 0.', 'warning'); return; }

  const remarks = document.getElementById('expRemarks').value.trim();
  const btn = document.getElementById('btnSaveExpense');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';

  try {
    await api('POST', '/expenses/bulk', { date, entries, remarks });
    showNotification('Expense saved successfully.');
    // Reset amounts only, keep the date
    document.querySelectorAll('.cat-amount').forEach(inp => inp.value = '');
    document.getElementById('expRemarks').value = '';
    updateTotal();
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Expense';
  }
}
