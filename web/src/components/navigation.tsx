"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Activity, LayoutDashboard, LogOut, ShieldCheck } from "lucide-react";
import { logout } from "@/app/actions";
import { ModeChip } from "./ui";

export function Navigation({ mode }: { mode?: "shadow" | "enforce" }) {
  const pathname = usePathname();
  const telemetry = useSearchParams().get("tab") === "telemetry";
  // Account, decision and owner pages are reached from the queue, so they keep
  // the Queue item active.
  const queue = !telemetry && pathname !== "/login";
  return (
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label="ATO Console">
        <ShieldCheck size={28} className="brand-mark" aria-hidden="true" />
        <span className="brand-name">ATO Console</span>
      </Link>
      <nav aria-label="Main navigation">
        <Link
          href="/"
          aria-label="Queue"
          title="Queue"
          aria-current={queue ? "page" : undefined}
          className={queue ? "nav-item active" : "nav-item"}
        >
          <LayoutDashboard size={17} />
          <span className="nav-text">Queue</span>
        </Link>
        <Link
          href="/?tab=telemetry"
          aria-label="Telemetry"
          title="Telemetry"
          aria-current={telemetry ? "page" : undefined}
          className={telemetry ? "nav-item active" : "nav-item"}
        >
          <Activity size={17} />
          <span className="nav-text">Telemetry</span>
        </Link>
      </nav>
      {mode && (
        <span className="sidebar-mode">
          <ModeChip mode={mode} />
        </span>
      )}
      <div className="sidebar-footer">
        <form action={logout}>
          <button
            className="nav-item logout"
            type="submit"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={16} />
            <span className="nav-text">Sign out</span>
          </button>
        </form>
      </div>
    </aside>
  );
}
