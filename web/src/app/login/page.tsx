import { ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/forms";
import { safeReturnPath } from "@/lib/session";

export const metadata = { title: "Sign in" };
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className="login-page">
      <div className="login-brand">
        resend<span>ATO</span>
      </div>
      <section className="login-card">
        <span className="login-symbol">
          <ShieldCheck size={27} strokeWidth={1.4} />
        </span>
        <p className="eyebrow">ANALYST WORKSPACE</p>
        <h1>
          A clearer view
          <br />
          of account security.
        </h1>
        <p className="login-description">
          Investigate unusual activity, understand every signal, and make the
          next call with context.
        </p>
        <LoginForm next={safeReturnPath(params.next)} />
        <div className="login-footer">
          <span className="online-dot" />
          Private workspace · Authorized analysts only
        </div>
      </section>
      <p className="login-caption">
        Built around the evidence. Designed for the decision.
      </p>
    </main>
  );
}
