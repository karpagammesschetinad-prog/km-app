const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');

// Load .env before the Express server starts.
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envPath });

/* Find a free TCP port, then start Express on it */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let mainWindow = null;
let serverPort = null;

/* Poll until Express is accepting connections */
function waitForServer(port, cb, retries = 0) {
  if (retries > 50) { cb(new Error('Express server did not start in time.')); return; }
  const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
    res.resume();
    cb(null);
  });
  req.on('error', () => setTimeout(() => waitForServer(port, cb, retries + 1), 300));
  req.end();
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'BizTracker',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // Show window only once it has fully loaded (avoids white flash)
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open any <a target="_blank"> links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    serverPort = await getFreePort();
    // Tell server.js which port to use
    process.env.PORT = String(serverPort);
    // Start the Express server embedded in this process
    require('../server');
    waitForServer(serverPort, (err) => {
      if (err) {
        dialog.showErrorBox('BizTracker — Startup Error', err.message);
        app.quit();
        return;
      }
      createWindow(serverPort);
    });
  } catch (err) {
    dialog.showErrorBox('BizTracker — Port Error', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow && serverPort) createWindow(serverPort);
});
