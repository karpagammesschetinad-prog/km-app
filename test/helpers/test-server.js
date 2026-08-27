/* Test harness: mounts a router on a throwaway Express app with a fake session. */

const express = require('express');

function startTestServer(mountPath, router) {
  const session = { user: null };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = session.user ? { user: session.user } : {};
    next();
  });
  app.use(mountPath, router);

  const server = app.listen(0);
  const ready = new Promise(resolve => server.once('listening', resolve));

  const request = async (method, path, body) => {
    await ready;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = text; }
    return { status: response.status, body: payload };
  };

  return {
    request,
    loginAs: user => { session.user = user; },
    logout: () => { session.user = null; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

module.exports = { startTestServer };
