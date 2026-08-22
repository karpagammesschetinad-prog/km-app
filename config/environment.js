const environment = (process.env.NODE_ENV || 'development').toLowerCase() === 'production'
  ? 'production'
  : 'development';

function getSpreadsheetId() {
  const environmentKey = environment === 'production'
    ? 'SPREADSHEET_ID_PRODUCTION'
    : 'SPREADSHEET_ID_DEVELOPMENT';
  return process.env[environmentKey] || (environment === 'development' ? process.env.SPREADSHEET_ID : '');
}

module.exports = { environment, getSpreadsheetId };