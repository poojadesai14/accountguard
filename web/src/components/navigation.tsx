"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  ArrowUpRight,
  ChevronRight,
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
      <Link href="/" className="brand" aria-label="Resend ATO overview">
        <span className="brand-symbol">
          r<span>→</span>
        </span>
        <span>
          resend<span className="brand-product">ATO</span>
        </span>
      </Link>
      <div className="workspace">
        <span className="workspace-icon">
          <ShieldCheck size={18} />
        </span>
        <div>
          Account protection<small>Analyst workspace</small>
        </div>
        <ChevronRight size={14} />
      </div>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label="Main navigation">
        <Link
          href="/"
          className={pathname === "/" ? "nav-item active" : "nav-item"}
        >
          <LayoutDashboard size={17} />
          Overview
        </Link>
        <Link
          href="/accounts"
          className={
            pathname.startsWith("/accounts") ||
            pathname.startsWith("/decisions") ||
            pathname.startsWith("/hold")
              ? "nav-item active"
              : "nav-item"
          }
        >
          <Users size={17} />
          Accounts
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
          <button className="nav-item logout" type="submit">
            <LogOut size={16} />
            Sign out
            <ArrowUpRight size={13} />
          </button>
        </form>
        <div className="analyst-avatar">
          <span>AN</span>
          <div>
            Analyst<small>Review access</small>
          </div>
          <span className="online-dot" />
        </div>
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
