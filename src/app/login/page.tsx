import { loadConfig } from "@/lib/config";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const { devLoginEnabled } = loadConfig(process.env);
  return (
    <main className="narrow stack">
      <h1>Sign in</h1>
      {devLoginEnabled ? (
        <>
          <LoginForm />
          <p className="muted">
            Development login (no password). Seeded users: <code>dana@example.test</code> (Admin, Payments),{" "}
            <code>alice@example.test</code> (Responder, Payments),{" "}
            <code>bob@example.test</code> (Viewer, Payments), <code>carol@example.test</code> (Responder, Search).
          </p>
        </>
      ) : (
        <p>Sign-in is not configured in this environment.</p>
      )}
    </main>
  );
}
