import { loadDashboard } from "@/app/dashboard-data";
import { dashboardQuery } from "@/lib/dashboard";
import { Dashboard } from "@/components/dashboard/dashboard";

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = dashboardQuery(await searchParams);
  const initial = await loadDashboard(query);
  return <Dashboard query={query} initial={initial} />;
}
