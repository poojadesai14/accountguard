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
import { EmptyState } from "./ui";
import type { AccountSeries, StatsPoint } from "@/lib/types";

const COLORS = {
  allow: "#a5b69a",
  flag: "#cfad50",
  hold: "#d78955",
  block: "#ba625d",
};
const tick = { fontSize: 11, fill: "#707968" };
const grid = "#eceee7";
const tooltipStyle = {
  border: "1px solid #e4e7dc",
  borderRadius: 10,
  fontSize: 12,
  boxShadow: "0 6px 20px #1721170a",
};
const hourLabel = (value: number) =>
  new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    timeZone: "UTC",
  });

export function DecisionChart({ points }: { points: StatsPoint[] }) {
  if (!points.length)
    return (
      <EmptyState title="No elevated activity in this period">
        Flagged, held, and blocked decisions will appear here as events arrive.
      </EmptyState>
    );
  const data = points.map((point) => ({
    ...point,
    time: new Date(point.t).getTime(),
  }));
  return (
    <div
      className="overview-chart"
      role="img"
      aria-label="Stacked chart of flagged, held, and blocked decisions over time"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 12, right: 12, left: -10, bottom: 8 }}
        >
          <CartesianGrid stroke={grid} vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={hourLabel}
            tick={tick}
            axisLine={false}
            tickLine={false}
            minTickGap={60}
          />
          <YAxis
            tick={tick}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(value) => hourLabel(Number(value)) + " UTC"}
            cursor={{ fill: "#f0f2e9" }}
          />
          <Bar
            dataKey="flag"
            name="Flag"
            stackId="decisions"
            fill={COLORS.flag}
            maxBarSize={26}
            isAnimationActive={false}
          />
          <Bar
            dataKey="hold"
            name="Hold"
            stackId="decisions"
            fill={COLORS.hold}
            maxBarSize={26}
            isAnimationActive={false}
          />
          <Bar
            dataKey="block"
            name="Block"
            stackId="decisions"
            fill={COLORS.block}
            maxBarSize={26}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
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
              width={42}
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
              fill="#dce6d4"
              fillOpacity={0.5}
            />
            <ReferenceLine
              y={series.baseline_hourly}
              stroke="#809578"
              strokeDasharray="4 4"
            />
            <ReferenceLine
              y={series.spike_threshold}
              stroke="#cfad50"
              strokeDasharray="4 4"
            />
            <Area
              dataKey="recipients"
              name="Recipients"
              type="monotone"
              stroke="#526e4b"
              strokeWidth={2}
              fill="#e1e9d9"
              fillOpacity={0.65}
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
          <i style={{ background: "#526e4b" }} />
          Recipients
        </span>
        <span>
          <i style={{ background: "#dce6d4" }} />
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
          <i className="legend-dot red" />
          First seen
          <i className="legend-dot green" />
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
              width={42}
              dataKey="lane"
              type="number"
              domain={[0, asns.length + 1]}
              ticks={asns.map((_, index) => index + 1)}
              tickFormatter={(value) => String(asns[value - 1] ?? "")}
              tick={{ ...tick, fontSize: 9 }}
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
              fill="#809578"
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
              width={42}
              tick={tick}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Bar
              dataKey="content"
              name="Content signals"
              fill="#b19866"
              maxBarSize={10}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="changes"
              name="Account changes"
              fill="#8e8aa8"
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
              width={42}
              tick={tick}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            {Object.entries(COLORS).map(([action, color]) => (
              <Bar
                key={action}
                dataKey={`action_${action}`}
                name={action}
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
            <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
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
