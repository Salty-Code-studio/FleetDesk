// API-first starter. The landing page intentionally exposes no data and links
// to the health check. All functionality lives under /api/*.
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", lineHeight: 1.5 }}>
      <h1>Hardened API Starter</h1>
      <p>This service is API-first. See the README for routes and the threat model.</p>
      <ul>
        <li>
          <code>GET /api/health</code> — liveness/readiness probe
        </li>
        <li>
          <code>POST /api/auth/jwt/register</code>, <code>/login</code>, <code>/refresh</code>,{" "}
          <code>/logout</code>
        </li>
        <li>
          <code>POST /api/auth/session/login</code>, <code>/logout</code>;{" "}
          <code>GET /api/auth/session/csrf</code>
        </li>
        <li>
          <code>/api/notes</code> and <code>/api/notes/[id]</code> — protected, owner-scoped
        </li>
      </ul>
    </main>
  );
}
