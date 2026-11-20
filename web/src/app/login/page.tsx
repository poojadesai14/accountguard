import { ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/forms/login";
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
        <span className="brand-name">ATO Console</span>
        <span>take-home</span>
      </div>
      <section className="login-card">
        <span className="login-symbol">
          <ShieldCheck size={27} strokeWidth={1.4} />
        </span>
        <p className="eyebrow">ANALYST WORKSPACE</p>
        <h1>Sign in</h1>
        <p className="login-description">
          Analyst console for an account-takeover detection demo. Not a production
          product.
        </p>
        <LoginForm next={safeReturnPath(params.next)} />
        <div className="login-footer">
          <span className="online-dot" />
          Private workspace · Authorized analysts only
        </div>
      </section>
    </main>
  );
}
