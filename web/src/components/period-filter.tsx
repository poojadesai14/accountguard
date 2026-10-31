import { PERIODS, type Period } from "@/lib/format";

export function PeriodFilter({ period }: { period: Period }) {
  return (
    <form className="period-filter" aria-label="Time range">
      {PERIODS.map((value) => (
        <button
          key={value}
          type="submit"
          name="period"
          value={value}
          className={period === value ? "selected" : ""}
        >
          {value === "all"
            ? "All time"
            : value === "24h"
              ? "24 hours"
              : value === "7d"
                ? "7 days"
                : "30 days"}
        </button>
      ))}
    </form>
  );
}
