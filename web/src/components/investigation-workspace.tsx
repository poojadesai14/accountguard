"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Check, Copy, Search, ShieldCheck } from "lucide-react";
import { ACTION_LABELS, defaultEvent } from "@/lib/decisions";
import { dateTime, humanize, number } from "@/lib/format";
import type { TimelineRow } from "@/lib/types";
import { Badge, CardHeader, EmptyState } from "./ui";

export function MetadataBlock({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown>;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const json = JSON.stringify(value, null, 2);
  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <section className="metadata-block" aria-label={`${title} metadata`}>
      <div className="metadata-block-heading">
        <h3>{title}</h3>
        <button
          type="button"
          onClick={copy}
          className="copy-metadata"
          aria-label={`Copy ${title.toLowerCase()} metadata`}
          title={`Copy ${title.toLowerCase()} metadata`}
        >
          {copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <pre>
        <code>{json}</code>
      </pre>
      <span className="copy-feedback" role="status">
        {copyState === "copied"
          ? "Copied to clipboard"
          : copyState === "failed"
            ? "Copy failed. Select and copy the text above."
            : ""}
      </span>
    </section>
  );
}

export function InvestigationWorkspace({ rows }: { rows: TimelineRow[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [limit, setLimit] = useState(100);
  const events = rows.map((row) => ({ ...row, hits: row.hits ?? [] }));
  const search = query.trim().toLowerCase();
  const filtered = events.filter(
    (row) =>
      (outcome === "all" || row.action === outcome) &&
      (!search ||
        [
          row.event_id,
          row.api_key_id,
          row.ip,
          row.asn,
          row.asn ? `AS${row.asn}` : null,
          row.asn_org,
          row.type,
          ...row.hits.flatMap((hit) => [
            hit.name,
            humanize(hit.name),
            hit.detail,
          ]),
        ].some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(search),
        )),
  );
  const selected =
    filtered.find((row) => row.event_id === selectedId) ??
    defaultEvent(filtered);
  if (!rows.length)
    return (
      <section className="card">
        <CardHeader title="Event stream" />
        <EmptyState title="No events in this time range.">
          Choose a wider period to investigate earlier activity.
        </EmptyState>
      </section>
    );
  return (
    <div
      className="investigation-workspace"
      role="region"
      aria-label="Event investigation workspace"
    >
      <section
        className="card event-stream-panel"
        aria-labelledby="event-stream-title"
      >
        <div className="stream-panel-header">
          <div>
            <h2 id="event-stream-title">Event stream</h2>
            <p>{number(rows.length)} events · Newest first · UTC</p>
          </div>
          <span className="count-pill">Snapshot</span>
        </div>
        <div className="stream-filters">
          <label className="stream-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Filter event stream"
              placeholder="IP, API key, or signal…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(100);
              }}
            />
          </label>
          {/* Buttons, like the dashboard filters: a native select's menu is
              drawn by the OS and ignores the theme. */}
          <div
            className="severity-pills stream-outcomes"
            role="group"
            aria-label="Filter event outcomes"
          >
            {(
              [
                ["all", "All"],
                ["allow", "Allow"],
                ["flag", "Flag"],
                ["hold", "Hold"],
                ["block", "Block"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={outcome === value}
                onClick={() => {
                  setOutcome(value);
                  setLimit(100);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="stream-scroll">
          {filtered.length ? (
            <ol className="event-stream-list" aria-label="Account events">
              {filtered.slice(0, limit).map((row) => (
                <li key={row.event_id}>
                  <button
                    type="button"
                    className={`stream-event ${selected?.event_id === row.event_id ? "selected" : ""}`}
                    aria-pressed={selected?.event_id === row.event_id}
                    aria-label={`Inspect ${row.event_id}`}
                    onClick={() => setSelectedId(row.event_id)}
                  >
                    <span
                      className={`event-marker event-marker-${row.action ?? "neutral"}`}
                    />
                    <span className="stream-event-body">
                      <span className="stream-event-heading">
                        <strong>{humanize(row.type)}</strong>
                        <Badge action={row.action} />
                      </span>
                      <span className="stream-event-key mono">
                        {row.api_key_id ?? "No API key"}
                      </span>
                      <span className="stream-event-meta">
                        <span className="stream-event-network mono">
                          {row.asn
                            ? `AS${row.asn}`
                            : (row.ip ?? "Network unavailable")}
                        </span>
                        <span className="stream-event-time">
                          {dateTime(row.occurred_at)}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState compact title="No matching events">
              Try another IP, key, signal, or outcome.
            </EmptyState>
          )}
          {filtered.length > limit && (
            <button
              type="button"
              className="button button-secondary stream-more"
              onClick={() => setLimit((value) => value + 100)}
            >
              Show more events
            </button>
          )}
        </div>
        <div className="stream-list-footer" role="status">
          {number(Math.min(limit, filtered.length))} of{" "}
          {number(filtered.length)} matching events
        </div>
      </section>

      {selected ? (
        <>
          <section
            className="selected-event-panel"
            aria-label="Selected event investigation"
            key={selected.event_id}
          >
            <section
              className={`card stream-decision stream-decision-${selected.action ?? "neutral"}`}
            >
              <div className="selected-event-caption">
                <ShieldCheck size={16} />
                <span>Selected decision</span>
                <span className="count-pill">
                  {selected.enforced === null
                    ? "Unscored"
                    : selected.enforced
                      ? "Enforced"
                      : "Shadow mode"}
                </span>
              </div>
              <div className="stream-decision-summary">
                <h2>
                  {selected.action
                    ? ACTION_LABELS[selected.action]
                    : "UNSCORED"}
                </h2>
                <p className="stream-risk-score">
                  Risk score <strong>{selected.score ?? "—"}</strong>
                  <span>/ 100</span>
                </p>
              </div>
              {selected.enforced === false && (
                <p className="stream-shadow-note">
                  Computed decision. No enforcement was applied.
                </p>
              )}
              {selected.reason && (
                <p className="stream-decision-reason">
                  {humanize(selected.reason)}
                </p>
              )}
              {selected.hits.length ? (
                <ul className="hit-list" aria-label="Selected event signals">
                  {selected.hits.map((hit) => (
                    <li className="hit-row" key={hit.name}>
                      <span
                        className={`category-marker category-${hit.category}`}
                      />
                      <div className="hit-evidence">
                        <div className="hit-heading">
                          <strong>{humanize(hit.name)}</strong>
                          <span className="hit-category">{hit.category}</span>
                        </div>
                        <p>{hit.detail}</p>
                      </div>
                      <span className="hit-points">
                        +{hit.points}
                        <small>pts</small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  compact
                  title={
                    selected.action
                      ? "No scoring signals fired"
                      : "No decision recorded"
                  }
                >
                  {selected.action
                    ? "This event did not produce any scored signal hits."
                    : "There are no signal scores to show for this event."}
                </EmptyState>
              )}
              <div className="selected-event-footer">
                <p className="selected-event-id mono" title={selected.event_id}>
                  {selected.event_id}
                </p>
                {selected.decision_id && (
                  <Link
                    className="button button-secondary"
                    href={`/decisions/${selected.decision_id}`}
                  >
                    Open full review <ArrowUpRight size={15} />
                  </Link>
                )}
              </div>
              {/* Raw fields for copying into a ticket; closed so analysts read the signals first. */}
              <details className="raw-metadata">
                <summary>Raw metadata</summary>
                <aside
                  className="metadata-blocks"
                  aria-label="Selected event metadata"
                >
                  <MetadataBlock
                    title="Event"
                    value={{
                      event_id: selected.event_id,
                      type: selected.type,
                      occurred_at: selected.occurred_at,
                      source: selected.source,
                      api_key_id: selected.api_key_id,
                    }}
                  />
                  <MetadataBlock
                    title="Network"
                    value={{
                      ip: selected.ip,
                      asn: selected.asn,
                      asn_org: selected.asn_org,
                      user_agent: selected.user_agent,
                    }}
                  />
                  <MetadataBlock
                    title="Content"
                    value={{
                      sender_domain: selected.sender_domain,
                      recipient_count: selected.recipient_count,
                      link_domains: selected.link_domains,
                      reply_to_domains: selected.reply_to_domains,
                      body_email_domains: selected.body_email_domains,
                    }}
                  />
                  <MetadataBlock
                    title="Decision"
                    value={{
                      decision_id: selected.decision_id,
                      action: selected.action,
                      enforced: selected.enforced,
                      score: selected.score,
                      reason: selected.reason,
                      hold_status: selected.hold_status,
                      review_status: selected.review_status,
                      label: selected.label,
                    }}
                  />
                </aside>
              </details>
            </section>
          </section>
        </>
      ) : (
        <section className="card no-selected-event">
          <EmptyState title="Select another filter">
            No matching events to inspect.
          </EmptyState>
        </section>
      )}
    </div>
  );
}
