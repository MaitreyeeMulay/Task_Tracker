"use client";

import { useActionState } from "react";
import { devLogin, passwordLoginAction, type LoginState } from "./actions";

export function PasswordForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(passwordLoginAction, {});
  return (
    <form action={action} className="card stack">
      <label className="stack">
        <span>Email</span>
        <input name="email" type="email" required autoComplete="username" />
      </label>
      <label className="stack">
        <span>Password</span>
        <input name="password" type="password" required autoComplete="current-password" minLength={12} maxLength={128} />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {state.error ? <p role="alert" className="error">{state.error}</p> : null}
    </form>
  );
}

export function DevLoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(devLogin, {});
  return (
    <form action={action} className="card stack">
      <label className="stack">
        <span>Email (development only, no password)</span>
        <input name="email" type="email" required autoComplete="username" placeholder="alice@example.test" />
      </label>
      <button type="submit" className="secondary" disabled={pending}>
        {pending ? "Signing in…" : "Dev sign-in"}
      </button>
      {state.error ? <p role="alert" className="error">{state.error}</p> : null}
    </form>
  );
}
