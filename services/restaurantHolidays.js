const { SHEETS, getAllRows } = require('./googleSheets');

function holidayRowToObj(row) {
  return {
    id: row[0] || '',
    startDate: row[1] || '',
    endDate: row[2] || '',
    reason: row[3] || '',
    createdBy: row[4] || '',
    createdAt: row[5] || '',
    updatedBy: row[6] || '',
    updatedAt: row[7] || ''
  };
}

// End dates are inclusive in the calendar, but exclusive in salary leave records.
function holidayLeaveRecords(holidayRows, employeeRows) {
  const leaves = [];
  for (const row of holidayRows) {
    const holiday = holidayRowToObj(row);
    const end = new Date(holiday.endDate + 'T00:00:00.000Z');
    if (!holiday.id || !holiday.startDate || !Number.isFinite(end.getTime())) continue;
    end.setUTCDate(end.getUTCDate() + 1);
    const endDateTime = end.toISOString().split('T')[0] + 'T00:00';
    for (const employee of employeeRows) {
      if (!employee[0]) continue;
      leaves.push({
        id: 'holiday:' + holiday.id + ':' + employee[0],
        holidayId: holiday.id,
        isRestaurantHoliday: true,
        employeeId: employee[0],
        employeeName: employee[1] || '',
        startDateTime: holiday.startDate + 'T00:00',
        endDateTime,
        remarks: 'Restaurant holiday: ' + holiday.reason,
        createdBy: holiday.createdBy,
        createdAt: holiday.createdAt
      });
    }
  }
  return leaves;
}

async function getRestaurantHolidayLeaves(employeeId) {
  const [holidayRows, employeeRows] = await Promise.all([
    getAllRows(SHEETS.RESTAURANT_HOLIDAYS),
    getAllRows(SHEETS.EMPLOYEES)
  ]);
  const leaves = holidayLeaveRecords(holidayRows, employeeRows);
  return employeeId ? leaves.filter(leave => leave.employeeId === employeeId) : leaves;
}

module.exports = { holidayRowToObj, holidayLeaveRecords, getRestaurantHolidayLeaves };