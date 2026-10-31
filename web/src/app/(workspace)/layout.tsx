import { Navigation } from "@/components/navigation";
import { requireSession } from "@/lib/auth";
import { logout } from "@/app/actions";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import Link from "next/link";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();
  return (
    <div className="workspace-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Navigation />
      <main id="main" className="main-content">
        <div className="workspace-topbar">
          <Link
            href="/"
            className="workspace-brand"
            aria-label="Resend ATO overview"
          >
            <img
              src="/resend-wordmark-white.svg"
              width="104"
              height="26"
              alt="Resend"
            />
            <span className="brand-product">ATO</span>
          </Link>
          <div className="workspace-path">
            <ShieldCheck size={15} />
            <span>Account protection</span>
            <span className="path-divider">/</span>
            <span className="muted">Analyst workspace</span>
          </div>
          <span className="access-label">
            <LockKeyhole size={13} />
            Analyst access
          </span>
        </div>
        {children}
        <footer className="page-footer">
          <span>Resend · Account protection</span>
          <span>All timestamps in UTC · Email content is never displayed</span>
          <form action={logout} className="mobile-logout">
            <button type="submit" className="button button-secondary">
              Sign out
            </button>
          </form>
        </footer>
      </main>
    </div>
  );
}
