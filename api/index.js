// Vercel serverless entry point. Every route (pages, static assets and the JSON
// API) goes through the same handler the local server uses, so there is one code
// path to reason about.
//
// Caveat that matters: a serverless instance only has a writable /tmp, which is
// per-instance and wiped on cold start. This deployment is a working demo, not a
// place to take real bookings — see "Déployer" in the README for durable storage.
import { handleRequest } from '../src/server.js';

export default handleRequest;
