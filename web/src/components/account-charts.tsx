"use client";

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ACTION_LABELS, accountHours } from "@/lib/decisions";
import { number } from "@/lib/format";
import type { AccountSeries } from "@/lib/types";
import { COLORS, grid, tick, tooltipStyle } from "./chart-theme";
import { EmptyState } from "./ui";

const hourLabel = (value: number) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    timeZone: "UTC",
  });

export function AccountCharts({ series }: { series: AccountSeries }) {
  if (!series.points.length)
    return (
      <EmptyState title="No events in this period">
        Choose a wider time range to explore this account’s activity.
      </EmptyState>
    );
  const { hours: data, incident } = accountHours(series.points);
  const allowed = data.reduce((total, hour) => total + hour.allow, 0);
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
  // The same dashed line on every lane: where several signals light up at once.
  const incidentLine = (label?: boolean) =>
    incident === undefined ? null : (
      <ReferenceLine
        x={incident}
        stroke={COLORS.block}
        strokeDasharray="4 3"
        label={
          label
            ? {
                value: "first hold / block",
                position: "insideTopLeft",
                fill: "var(--status-blocked-text)",
                fontSize: 11,
              }
            : undefined
        }
      />
    );
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
            {incidentLine(true)}
            <Area
              dataKey="recipients"
              name="Recipients"
              type="linear"
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
              tick={tick}
              axisLine={false}
              tickLine={false}
            />
            {incidentLine()}
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
            {incidentLine()}
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
              fill="var(--account-change)"
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
        <small>
          Flag, hold and block per hour · {number(allowed)} allowed events not
          shown · UTC
        </small>
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
            {incidentLine()}
            {(["flag", "hold", "block"] as const).map((action) => (
              <Bar
                key={action}
                dataKey={action}
                name={ACTION_LABELS[action]}
                fill={COLORS[action]}
                stackId="actions"
                maxBarSize={16}
                isAnimationActive={false}
              />
            ))}
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(value) => hourLabel(Number(value)) + " UTC"}
            />
            <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
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
