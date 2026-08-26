// Server entry point. Its only job is to listen, unconditionally.
//
// It used to be a `import.meta.url === process.argv[1]` check inside
// src/server.js. That check is a guess about how the process was launched, and it
// guesses wrong as soon as a platform bundles or imports the app instead of
// running the file directly — the server then never listens, and the platform
// reports a crash with nothing in it. A dedicated entry point cannot guess wrong:
// whatever imports or runs this file gets a listening server.
import { createApp, handleRequest } from './src/server.js';
import { dispatchDue } from './src/messages.js';

// PORT=0 means "any free port", which `|| 3000` silently turned back into 3000 —
// so a test asking for an ephemeral port got the real one, and failed against
// whatever was already listening there.
const requested = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isInteger(requested) && requested >= 0 ? requested : 3000;

// Listen first, set up the database on the first request. If the database cannot
// be opened, the platform then gets a running server that explains the problem,
// instead of a process that exited during boot with nothing to show for it.
const server = createApp();

server.listen(port, () => {
  console.log(`Inkflow running on http://localhost:${port}`);
});

server.on('error', (err) => {
  console.error('[fatal] listen', err);
  process.exitCode = 1;
});

// Reminders and aftercare go out from here; one tick a minute is plenty.
const timer = setInterval(() => {
  try {
    dispatchDue();
  } catch (err) {
    console.error('[scheduler]', err);
  }
}, 60000);
timer.unref();

export default handleRequest;
export { server };
