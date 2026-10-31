import { Navigation } from "@/components/navigation";
import { requireSession } from "@/lib/auth";
import { logout } from "@/app/actions";

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
