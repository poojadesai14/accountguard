import { PERIOD_LABELS, PERIODS, type Period } from "@/lib/format";

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
          {PERIOD_LABELS[value]}
        </button>
      ))}
    </form>
  );
}
