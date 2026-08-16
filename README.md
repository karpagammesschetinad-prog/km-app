# BizTracker — Expense & Salary Manager

A full-stack web app for **expense tracking** and **employee salary management** with **Google Sheets** as the data store.

## Features

| Module | Capabilities |
|---|---|
| Dashboard | Live stats, expense-by-category chart, 6-month trend chart |
| Expenses | Add / edit / delete, approve / reject, filter by date / category / status |
| Employees | Add / edit / deactivate / delete, salary stored per employee |
| Salaries | One-click monthly processing, allowances & deductions, mark as Paid |

---

## Quick Start

### 1 — Google Cloud setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create (or select) a project.
2. Enable **Google Sheets API** (`APIs & Services → Library`).
3. Create a **Service Account** (`IAM & Admin → Service Accounts → Create`).
4. On the service account, go to **Keys → Add Key → Create new key → JSON**.  
   A `*.json` file will download — keep it safe.
5. Open your Google Spreadsheet and **Share** it with the service account email  
   (`...@....iam.gserviceaccount.com`) as **Editor**.
6. Copy the Spreadsheet ID from the URL:  
   `https://docs.google.com/spreadsheets/d/**SPREADSHEET_ID**/edit`

### 2 — Project setup

```bash
# Install dependencies
cd app
npm install
```

### 3 — Configuration

```bash
# Copy the template
copy .env.example .env    # Windows
cp .env.example .env      # Mac/Linux
```

Open `.env` and fill in two values:

| Variable | Where to find it |
|---|---|
| `SPREADSHEET_ID` | From your Google Sheet URL |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Paste the JSON key file contents as **one line** |

**Convert the JSON key to a single line (PowerShell):**
```powershell
(Get-Content .\service-account.json -Raw) -replace '\r?\n','' | Set-Clipboard
```
Then paste the clipboard value as `GOOGLE_SERVICE_ACCOUNT_KEY=<paste here>`.

### 4 — Run

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Open **http://localhost:3000** in your browser.

The app automatically creates the three sheets (`Expenses`, `Employees`, `Salaries`) with headers on first run.

---

## Google Sheets structure

| Sheet | Columns |
|---|---|
| **Expenses** | ID, Date, Category, Description, Amount, EmployeeID, EmployeeName, Status, CreatedAt |
| **Employees** | ID, Name, Email, Department, Position, BaseSalary, JoinDate, Status |
| **Salaries** | ID, EmployeeID, EmployeeName, Month, Year, BaseSalary, Allowances, Deductions, NetSalary, PaymentDate, Status |

---

## API Reference

### Expenses `/api/expenses`
| Method | Path | Description |
|---|---|---|
| GET | `/` | List all expenses |
| POST | `/` | Create expense |
| PUT | `/:id` | Update expense |
| DELETE | `/:id` | Delete expense |

### Employees `/api/employees`
| Method | Path | Description |
|---|---|---|
| GET | `/` | List all employees |
| POST | `/` | Create employee |
| PUT | `/:id` | Update employee |
| DELETE | `/:id` | Delete employee |

### Salaries `/api/salaries`
| Method | Path | Description |
|---|---|---|
| GET | `/` | List all salary records |
| POST | `/process` | Bulk-create records for active employees |
| POST | `/` | Create single salary record |
| PUT | `/:id` | Update salary record |
| DELETE | `/:id` | Delete salary record |

---

## Project structure

```
app/
├── server.js               # Express entry point
├── .env.example            # Environment variable template
├── services/
│   └── googleSheets.js     # Google Sheets API wrapper
├── routes/
│   ├── expenses.js
│   ├── employees.js
│   └── salaries.js
└── public/
    ├── index.html          # Dashboard
    ├── expenses.html
    ├── employees.html
    ├── salaries.html
    ├── css/styles.css
    └── js/
        ├── main.js         # Shared utilities
        ├── dashboard.js
        ├── expenses.js
        ├── employees.js
        └── salaries.js
```
