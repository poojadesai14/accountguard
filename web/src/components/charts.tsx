"use client";

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge, EmptyState } from "./ui";
import {
  ACTION_LABELS,
  decisionSeries,
  type DecisionBucket,
} from "@/lib/decisions";
import { dateTime, number } from "@/lib/format";
import type { AccountSeries, StatsPoint } from "@/lib/types";

const COLORS = {
  allow: "var(--allow)",
  flag: "var(--flag)",
  hold: "var(--hold)",
  block: "var(--block)",
};
const tick = { fontSize: 15, fill: "var(--chart-text)" };
const grid = "var(--chart-grid)";
const tooltipStyle = {
  border: "1px solid var(--line)",
  backgroundColor: "var(--surface)",
  color: "var(--ink)",
  borderRadius: 6,
  fontSize: 15,
  boxShadow: "0 6px 24px #00000066",
};
const hourLabel = (value: number) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    timeZone: "UTC",
  });

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
        Flagged, quarantined, and blocked decisions will appear here as events
        arrive.
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

export function AccountCharts({ series }: { series: AccountSeries }) {
  if (!series.points.length)
    return (
      <EmptyState title="No events in this period">
        Choose a wider time range to explore this account’s activity.
      </EmptyState>
    );
  const data = series.points.map((point) => ({
    ...point,
    time: new Date(point.t).getTime(),
    content: point.content_hits.length,
    changes: point.account_changes,
    ...Object.fromEntries(
      Object.entries(point.actions).map(([action, count]) => [
        `action_${action}`,
        count,
      ]),
    ),
  }));
  const first = data[0].time;
  const last = Math.max(data[data.length - 1].time, first + 3_600_000);
  const domain: [number, number] = [first, last];
  const asns = [
    ...new Set(
      series.points.flatMap((point) => point.asns.map((asn) => asn.asn)),
    ),
  ];
  const networkPoints = series.points.flatMap((point) =>
    point.asns.map((asn) => ({
      ...asn,
      time: new Date(point.t).getTime(),
      lane: asns.indexOf(asn.asn) + 1,
    })),
  );
  const axis = (
    <XAxis
      dataKey="time"
      type="number"
      domain={domain}
      tick={tick}
      axisLine={false}
      tickLine={false}
      hide
    />
  );
  const common = {
    margin: { top: 8, right: 18, bottom: 4, left: 8 },
    syncId: `account-${series.account_id}`,
  };
  return (
    <div className="account-charts">
      <div className="chart-lane-label">
        <span>Recipient volume</span>
        <small>Recipients / hour</small>
      </div>
      <div
        className="volume-chart"
        role="img"
        aria-label="Hourly recipients with the current baseline and spike threshold"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart {...common} data={data}>
            <CartesianGrid stroke={grid} vertical={false} />
            {axis}
            <YAxis
              width={58}
              tick={tick}
              tickFormatter={(value) => Math.round(Number(value)).toString()}
              axisLine={false}
              tickLine={false}
              domain={[
                0,
                (max: number) =>
                  Math.ceil(Math.max(max, series.spike_threshold) * 1.15),
              ]}
            />
            <ReferenceArea
              y1={0}
              y2={series.baseline_hourly}
              fill="var(--chart-band)"
              fillOpacity={0.35}
            />
            <ReferenceLine
              y={series.baseline_hourly}
              stroke="var(--chart-baseline)"
              strokeDasharray="4 4"
            />
            <ReferenceLine
              y={series.spike_threshold}
              stroke={COLORS.flag}
              strokeDasharray="4 4"
            />
            <Area
              dataKey="recipients"
              name="Recipients"
              type="monotone"
              stroke="var(--chart-line)"
              strokeWidth={2}
              fill="var(--chart-line)"
              fillOpacity={0.08}
              isAnimationActive={false}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(value) => hourLabel(Number(value)) + " UTC"}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-key">
        <span>
          <i style={{ background: "var(--chart-line)" }} />
          Recipients
        </span>
        <span>
          <i style={{ background: "var(--chart-baseline)" }} />
          Current baseline: {series.baseline_hourly.toFixed(1)}
        </span>
        <span>
          <i style={{ background: COLORS.flag }} />
          Spike threshold: {series.spike_threshold.toFixed(1)}
        </span>
      </div>
      <div className="chart-lane-label">
        <span>Network activity</span>
        <small>
          <i className="legend-dot new" />
          First seen
          <i className="legend-dot known" />
          Known ASN
        </small>
      </div>
      <div
        className="signal-chart"
        role="img"
        aria-label="ASN observations; red dots indicate first seen during this hour"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart {...common}>
            {axis}
            <YAxis
              width={58}
              dataKey="lane"
              type="number"
              domain={[0, asns.length + 1]}
              ticks={asns.map((_, index) => index + 1)}
              tickFormatter={(value) => String(asns[value - 1] ?? "")}
              tick={{ ...tick, fontSize: 13 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload;
                return active && p ? (
                  <div className="chart-tooltip">
                    <strong>
                      AS{p.asn} {p.org}
                    </strong>
                    <p>{hourLabel(p.time)} UTC</p>
                    <p>
                      {p.first_seen
                        ? "First observed this hour"
                        : "Previously observed"}
                    </p>
                  </div>
                ) : null;
              }}
            />
            <Scatter
              name="Known ASN"
              data={networkPoints.filter((point) => !point.first_seen)}
              fill="var(--chart-baseline)"
              isAnimationActive={false}
            />
            <Scatter
              name="First seen"
              data={networkPoints.filter((point) => point.first_seen)}
              fill={COLORS.block}
              isAnimationActive={false}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-lane-label">
        <span>Content & account signals</span>
        <small>Content hits · Account changes</small>
      </div>
      <div
        className="signal-chart"
        role="img"
        aria-label="Content signal counts and account change events"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart {...common} data={data}>
            {axis}
            <YAxis
              width={58}
              tick={tick}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Bar
              dataKey="content"
              name="Content signals"
              fill="var(--flag)"
              maxBarSize={10}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="changes"
              name="Account changes"
              fill="#aaa3c2"
              maxBarSize={10}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(value) => hourLabel(Number(value)) + " UTC"}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-lane-label">
        <span>Decision activity</span>
        <small>Shared time axis · UTC</small>
      </div>
      <div
        className="decision-strip"
        role="img"
        aria-label="Account decisions by action over the same time axis"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart {...common} data={data}>
            <XAxis
              dataKey="time"
              type="number"
              domain={domain}
              tick={tick}
              tickFormatter={hourLabel}
              minTickGap={65}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              width={58}
              tick={tick}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            {Object.entries(COLORS).map(([action, color]) => (
              <Bar
                key={action}
                dataKey={`action_${action}`}
                name={ACTION_LABELS[action as keyof typeof ACTION_LABELS]}
                fill={color}
                stackId="actions"
                maxBarSize={16}
                isAnimationActive={false}
              />
            ))}
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(value) => hourLabel(Number(value)) + " UTC"}
            />
            <Legend iconSize={10} wrapperStyle={{ fontSize: 14 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="chart-footnote">
        The baseline band shows the current learned value. Historical baseline
        values are not stored.
      </p>
    </div>
  );
}
