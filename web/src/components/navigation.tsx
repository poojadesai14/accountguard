"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  ArrowUpRight,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { logout } from "@/app/actions";

export function Navigation() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label="ATO Console overview">
        <ShieldCheck size={28} className="brand-mark" aria-hidden="true" />
        <span className="brand-name">ATO Console</span>
      </Link>
      <div className="workspace">
        <span className="workspace-icon">
          <ShieldCheck size={18} />
        </span>
        <div>
          Account protection<small>Analyst workspace</small>
        </div>
      </div>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label="Main navigation">
        <Link
          href="/"
          aria-label="Overview"
          title="Overview"
          aria-current={pathname === "/" ? "page" : undefined}
          className={pathname === "/" ? "nav-item active" : "nav-item"}
        >
          <LayoutDashboard size={17} />
          <span className="nav-text">Overview</span>
        </Link>
        <Link
          href="/accounts"
          aria-label="Accounts"
          title="Accounts"
          aria-current={pathname.startsWith("/accounts") ? "page" : undefined}
          className={
            pathname.startsWith("/accounts") ||
            pathname.startsWith("/decisions") ||
            pathname.startsWith("/hold")
              ? "nav-item active"
              : "nav-item"
          }
        >
          <Users size={17} />
          <span className="nav-text">Accounts</span>
        </Link>
      </nav>
      <div className="sidebar-footer">
        <div className="privacy-note">
          <ShieldCheck size={17} />
          <div>
            Metadata only<small>Email content stays private.</small>
          </div>
        </div>
        <form action={logout}>
          <button
            className="nav-item logout"
            type="submit"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={16} />
            <span className="nav-text">Sign out</span>
            <ArrowUpRight size={13} />
          </button>
        </form>
      </div>
    </aside>
  );
}

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      className="button button-secondary"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
    >
      <RefreshCw size={14} className={pending ? "spin" : ""} />
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
