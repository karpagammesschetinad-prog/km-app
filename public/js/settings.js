let paymentTypes = [];

function getSettingsPayload() {
  return {
    FY_START_DATE: document.getElementById('fyStartDate').value,
    FY_END_DATE: document.getElementById('fyEndDate').value,
    IDLE_TIMEOUT_MINUTES: document.getElementById('idleTimeoutMinutes').value,
    PAYMENT_TYPES: paymentTypes,
    ONLINE_VENDORS: document.getElementById('onlineVendors').value
  };
}

async function saveSettings(showSuccess = true) {
  if (!paymentTypes.length) {
    showNotification('Add at least one payment type.', 'warning');
    return false;
  }
  await api('PUT', '/settings', getSettingsPayload());
  if (showSuccess) showNotification('Settings saved.');
  return true;
}

function normalizePaymentType(value) {
  return String(value || '').trim();
}

function parsePaymentTypes(value) {
  if (Array.isArray(value)) return value.map(normalizePaymentType).filter(Boolean);
  return String(value || '').split(',').map(normalizePaymentType).filter(Boolean);
}

function renderPaymentTypes() {
  const list = document.getElementById('paymentTypesList');
  if (!list) return;
  if (!paymentTypes.length) {
    list.innerHTML = '<span class="text-muted small">No payment types added.</span>';
    return;
  }
  list.innerHTML = paymentTypes.map(type => `<span class="badge text-bg-light border d-inline-flex align-items-center gap-2 py-2 px-2">${type}<button type="button" class="btn btn-sm btn-link text-danger p-0 payment-type-delete" data-payment-type="${type}" title="Delete ${type}"><i class="bi bi-x-circle"></i></button></span>`).join('');
  list.querySelectorAll('.payment-type-delete').forEach(button => {
    button.addEventListener('click', async () => {
      const type = button.dataset.paymentType;
      paymentTypes = paymentTypes.filter(item => item !== type);
      renderPaymentTypes();
      try {
        await saveSettings(false);
        showNotification('Payment type deleted.');
      } catch (err) {
        showNotification('Save failed: ' + err.message, 'danger');
      }
    });
  });
}

async function addPaymentType() {
  const value = window.prompt('Enter payment type name');
  if (value == null) return;
  const type = normalizePaymentType(value);
  if (!type) return showNotification('Payment type cannot be empty.', 'warning');
  if (paymentTypes.some(item => item.toLowerCase() === type.toLowerCase())) {
    return showNotification('Payment type already exists.', 'warning');
  }
  paymentTypes.push(type);
  renderPaymentTypes();
  try {
    await saveSettings(false);
    showNotification('Payment type added.');
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  const autoSaveInput = document.getElementById('autoSaveEnabled');
  try {
    const setting = await api('GET', '/settings/autosave');
    autoSaveInput.checked = setting.AUTO_SAVE_ENABLED === 'true';
  } catch (err) { showNotification('Failed to load auto-save setting: ' + err.message, 'danger'); }
  autoSaveInput.addEventListener('change', async () => {
    autoSaveInput.disabled = true;
    try {
      await api('PUT', '/settings/autosave', { AUTO_SAVE_ENABLED: autoSaveInput.checked });
      showNotification(`Auto-save ${autoSaveInput.checked ? 'enabled' : 'disabled'} for all users.`);
    } catch (err) {
      autoSaveInput.checked = !autoSaveInput.checked;
      showNotification('Failed to save auto-save setting: ' + err.message, 'danger');
    } finally { autoSaveInput.disabled = false; }
  });
  if (user.role !== 'superuser') return;
  document.getElementById('addPaymentTypeBtn').addEventListener('click', addPaymentType);
  try {
    const settings = await api('GET', '/settings');
    document.getElementById('fyStartDate').value = settings.FY_START_DATE;
    document.getElementById('fyEndDate').value = settings.FY_END_DATE;
    document.getElementById('idleTimeoutMinutes').value = settings.IDLE_TIMEOUT_MINUTES;
    paymentTypes = parsePaymentTypes(settings.PAYMENT_TYPES);
    document.getElementById('onlineVendors').value = settings.ONLINE_VENDORS;
    renderPaymentTypes();
  } catch (err) { showNotification('Failed to load settings: ' + err.message, 'danger'); }

  document.getElementById('settingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await saveSettings();
    } catch (err) { showNotification('Save failed: ' + err.message, 'danger'); }
  });
});
