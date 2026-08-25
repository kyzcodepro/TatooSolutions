// Writes public/build.json during the platform's build step.
//
// A static file is the only thing that can be inspected when the server does not
// run: it names the commit that was actually built, which no amount of guessing
// from a crash page can tell you. Never fails the build.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../public/build.json', import.meta.url));
const info = {
  commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7)
    ?? process.env.GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
  built_at: new Date().toISOString(),
  built_with_node: process.version,
};

try {
  await writeFile(target, `${JSON.stringify(info, null, 2)}\n`);
  console.log('[build] wrote public/build.json', JSON.stringify(info));
} catch (err) {
  console.warn('[build] could not write build info:', err.message);
}
