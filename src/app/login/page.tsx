import { loadConfig } from "@/lib/config";
import { DevLoginForm, PasswordForm } from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const { devLoginEnabled, sessionSecrets } = loadConfig(process.env);
  if (sessionSecrets.length === 0) {
    return (
      <main className="narrow stack">
        <h1>Sign in</h1>
        <p>Sign-in is not configured in this environment (SESSION_SECRET is missing).</p>
      </main>
    );
  }
  return (
    <main className="narrow stack">
      <h1>Sign in</h1>
      <PasswordForm />
      <p className="muted small">After 5 wrong passwords an account is locked for 15 minutes.</p>
      {devLoginEnabled ? (
        <>
          <h2>Development</h2>
          <DevLoginForm />
          <p className="muted">
            Seeded users: <code>dana@example.test</code> (Admin, Payments), <code>alice@example.test</code> (Responder, Payments),{" "}
            <code>bob@example.test</code> (Viewer, Payments), <code>carol@example.test</code> (Responder, Search). Their password is the{" "}
            <code>DEV_SEED_PASSWORD</code> from your <code>.env</code>, if you set one before seeding.
          </p>
        </>
      ) : null}
    </main>
  );
}
