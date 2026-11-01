import { Suspense } from "react";
import Link from "next/link";
import { Navigation } from "@/components/navigation";
import { requireSession } from "@/lib/auth";
import { analystApi } from "@/lib/api";
import { ModeChip } from "@/components/ui";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();
  // One global statement of the engine mode, so shadow decisions are never read
  // as enforced on any page. Hidden if the API is unreachable.
  const config = await analystApi<{ mode: "shadow" | "enforce" }>("/v1/config");
  const mode = config.data?.mode;
  return (
    <div className="workspace-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Suspense>
        <Navigation mode={mode} />
      </Suspense>
      <main id="main" className="main-content">
        <div className="workspace-topbar">
          <Link href="/" className="workspace-brand" aria-label="Review queue">
            <span className="brand-name">ATO Console</span>
          </Link>
          {mode && <ModeChip mode={mode} />}
        </div>
        {children}
        <footer className="page-footer">
          Resend take-home demo, not an official Resend product · Metadata only,
          email content is never shown · Times in UTC
        </footer>
      </main>
    </div>
  );
}
