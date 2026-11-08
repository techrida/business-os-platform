// Liveness only: proves the Node process is up and can serve a request. It must not touch
// Valkey, ZITADEL or the API, otherwise a dependency outage would make the orchestrator
// restart a healthy container.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
