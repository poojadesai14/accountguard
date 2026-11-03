"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ACTION_LABELS,
  decisionSeries,
  type DecisionBucket,
} from "@/lib/decisions";
import { dateTime, number } from "@/lib/format";
import type { StatsPoint } from "@/lib/types";
import { COLORS, grid, tick, tooltipStyle } from "./chart-theme";
import { Badge, EmptyState } from "./ui";

export function DecisionChart({
  points,
  bucket,
  from,
  to,
}: {
  points: StatsPoint[];
  bucket: DecisionBucket;
  from?: string;
  to?: string;
}) {
  const data = decisionSeries(points, bucket, from, to);
  if (!data.length)
    return (
      <EmptyState title="No elevated activity in this period">
        Flagged, held, and blocked decisions will appear here as events arrive.
      </EmptyState>
    );
  const actions = ["flag", "hold", "block"] as const;
  const max = Math.max(
    1,
    ...data.flatMap((point) => actions.map((action) => point[action])),
  );
  const domain: [number, number] = [data[0].time, data[data.length - 1].time];
  if (domain[0] === domain[1])
    domain[1] += bucket === "1d" ? 86_400_000 : 3_600_000;
  const timeLabel = (value: number) =>
    new Date(value).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      ...(bucket === "1h" ? { hour: "numeric" as const } : {}),
      timeZone: "UTC",
    });
  return (
    <div
      className="decision-trends"
      role="group"
      aria-label="Elevated activity trends"
    >
      <p className="trend-scale">
        Decisions per {bucket === "1d" ? "day" : "hour"} · Same scale in every
        row · UTC
      </p>
      {actions.map((action, index) => (
        <section className="decision-trend" key={action}>
          <div className="trend-heading">
            <Badge action={action} />
            <span>
              <strong>
                {number(
                  data.reduce((total, point) => total + point[action], 0),
                )}
              </strong>{" "}
              total
            </span>
          </div>
          <div
            className={
              index === actions.length - 1
                ? "trend-chart trend-chart-with-time"
                : "trend-chart"
            }
            role="figure"
            aria-label={`${ACTION_LABELS[action]} decisions over time`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data}
                margin={{ top: 12, right: 24, bottom: 12, left: 0 }}
              >
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={domain}
                  scale="time"
                  tick={index === actions.length - 1 ? tick : false}
                  tickFormatter={timeLabel}
                  minTickGap={70}
                  height={index === actions.length - 1 ? 32 : 0}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={tick}
                  domain={[0, max]}
                  ticks={[0, max]}
                  interval={0}
                  width={48}
                  tickFormatter={(value) => number(Number(value))}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(value) => timeLabel(Number(value)) + " UTC"}
                  formatter={(value) => [
                    number(Number(value)),
                    ACTION_LABELS[action],
                  ]}
                  cursor={{
                    stroke: "var(--chart-text)",
                    strokeDasharray: "3 3",
                  }}
                />
                <Line
                  dataKey={action}
                  name={ACTION_LABELS[action]}
                  type="linear"
                  stroke={COLORS[action]}
                  strokeWidth={2}
                  dot={
                    data.length === 1 ? { r: 4, fill: COLORS[action] } : false
                  }
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      ))}
      <details className="chart-data">
        <summary>View chart data</summary>
        <div className="table-scroll">
          <table aria-label="Elevated activity data">
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                {actions.map((action) => (
                  <th scope="col" key={action}>
                    {ACTION_LABELS[action]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.time}>
                  <th scope="row">
                    {dateTime(new Date(point.time).toISOString())}
                  </th>
                  {actions.map((action) => (
                    <td key={action}>{number(point[action])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
