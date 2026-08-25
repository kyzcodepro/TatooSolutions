// Vercel serverless entry point (preset "Other"). Every route — pages, static
// assets and the JSON API — goes through the same handler the local server uses.
//
// The application is imported inside the handler, not at module scope: a static
// import aborts the function before any code can report why, which is exactly the
// FUNCTION_INVOCATION_FAILED page with nothing in it. src/diagnostics.js is a leaf
// module (Node built-ins only), so it stays loadable when the app is not.
//
// Caveat that matters: a serverless instance only has a writable /tmp, which is
// per-instance and wiped on cold start. This deployment is a working demo, not a
// place to take real bookings — see "Déployer" in the README for durable storage.
import { renderDiagnostics } from '../src/diagnostics.js';

const loadApp = () => import('../src/server.js');

/** `load` is injectable so the failure path can be exercised in tests. */
export function createHandler(load = loadApp) {
  let appPromise = null;
  return async function handler(req, res) {
    try {
      const { handleRequest } = await (appPromise ??= load());
      return await handleRequest(req, res);
    } catch (err) {
      appPromise = null; // a transient failure should not poison the instance
      console.error('[fatal]', err);
      return await renderDiagnostics(res, err);
    }
  };
}

export default createHandler();
