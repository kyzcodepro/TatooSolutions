// Inert probe: no application code, no database, nothing that can fail.
//
// It answers the question the crash page cannot: is Vercel actually running the
// functions in api/ ? If /api/ping replies, the runtime and this directory are
// live and any remaining failure is in the application. If it does not reply, the
// project is not building api/ at all and the problem is the build configuration.
//
// The application router also answers /api/ping, with "probe":"app" instead of
// "probe":"function", so the reply also tells which deployment mode is serving.
export default function handler(req, res) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({
    probe: 'function',
    node: process.version,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    region: process.env.VERCEL_REGION ?? null,
    time: new Date().toISOString(),
  }));
}
