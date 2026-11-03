"use client";

import { useActionState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { login } from "@/app/actions";
import { Feedback } from "./review-fields";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(login, {});
  return (
    <form action={action} className="login-form">
      <input type="hidden" name="next" value={next} />
      <label htmlFor="password">Workspace password</label>
      <div className="password-input">
        <LockKeyhole size={17} />
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
          placeholder="Enter your password"
        />
      </div>
      <Feedback state={state} />
      <button className="button button-primary" disabled={pending}>
        {pending ? "Signing in…" : "Open workspace"}
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
