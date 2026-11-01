"use client";

import { useActionState } from "react";
import { devLogin, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(devLogin, {});
  return (
    <form action={action} className="card stack">
      <label className="stack">
        <span>Email</span>
        <input name="email" type="email" required autoComplete="username" placeholder="alice@example.test" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {state.error ? <p role="alert" className="error">{state.error}</p> : null}
    </form>
  );
}
