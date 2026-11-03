"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { loadDashboard } from "@/app/dashboard-data";
import { dashboardURL, type DashboardQuery } from "@/lib/dashboard";
import type { DashboardData } from "@/lib/types";

const REFRESH_MS = 30_000;

// useDashboardRefresh keeps the dashboard's data current: it polls every 30 s
// while the page is visible, refreshes when the page becomes visible again, and
// never overlaps a pending request or navigation. A failed refresh keeps the last
// good snapshot and reports the error. Responses that arrive after the analyst
// has navigated elsewhere are dropped.
export function useDashboardRefresh(
  query: DashboardQuery,
  initial: DashboardData,
) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const currentQuery = useRef(query);
  const navigatingRef = useRef(false);
  const inFlight = useRef(false);
  // Bumped on every navigation, so a refresh started before it is ignored.
  const generation = useRef(0);
  useEffect(() => {
    currentQuery.current = query;
    navigatingRef.current = navigating;
  });

  const [received, setReceived] = useState(initial);
  if (received !== initial) {
    setReceived(initial);
    setData((previous) =>
      initial.snapshot ? initial : { ...previous, error: initial.error },
    );
  }
  useEffect(() => {
    generation.current++;
  }, [initial, query]);

  const refresh = useCallback(async (force = false) => {
    if (
      inFlight.current ||
      navigatingRef.current ||
      (!force && document.visibilityState !== "visible")
    )
      return;
    inFlight.current = true;
    setRefreshing(true);
    const started = generation.current;
    try {
      const next = await loadDashboard(currentQuery.current);
      if (started === generation.current)
        setData((previous) =>
          next.snapshot
            ? keepTelemetryOnError(previous, next)
            : { ...previous, error: next.error ?? "Refresh failed." },
        );
    } catch {
      if (started === generation.current)
        setData((previous) => ({
          ...previous,
          error: "Refresh failed. Please try again.",
        }));
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  function navigate(patch: Partial<DashboardQuery>) {
    generation.current++;
    startNavigation(() =>
      router.push(dashboardURL(currentQuery.current, patch), { scroll: false }),
    );
  }
  function openPage(href: string) {
    startNavigation(() => router.push(href));
  }

  return {
    data,
    refreshing,
    busy: refreshing || navigating,
    refresh,
    navigate,
    openPage,
  };
}

// A refresh whose telemetry failed keeps the telemetry already on screen, but
// only while it is for the same range and audit page.
function keepTelemetryOnError(
  previous: DashboardData,
  next: DashboardData,
): DashboardData {
  const samePeriod =
    !!next.telemetry_error &&
    next.telemetry_period === previous.telemetry_period;
  return {
    ...next,
    stats: next.stats ?? (samePeriod ? previous.stats : undefined),
    audit:
      next.audit ??
      (samePeriod && next.audit_before_id === previous.audit_before_id
        ? previous.audit
        : undefined),
  };
}
