// Builds the full-stack test world through the real ingest API, so every decision
// is scored by the real engine. Deterministic: fixed event IDs, no randomness.
//
// Six accounts, each with 12 days of normal sending from AWS (one send per business
// hour, linking stripe.com). Four are then attacked the way cmd/seed does it: from
// DigitalOcean, linking invoice-portal.net (a young domain in config.yaml); the
// first sends are held, then a recipient spike blocks and auto-suspends the key.
export const API = "http://127.0.0.1:3202";
export const ANALYST = { Authorization: "Bearer fullstack-analyst-token" };
const INGEST = { Authorization: "Bearer fullstack-ingest-token" };

/** Accounts attacked, by the scenario that handles them. */
export const ATTACKED = {
  takeover: "fs_takeover", // resolved as takeover
  vendor: "fs_vendor", // resolved legitimate (the owner's new vendor), key restored
  oops: "fs_oops", // resolved legitimate by mistake, then corrected
  stepwise: "fs_stepwise", // one decision at a time, following the next-step links
} as const;
/** Accounts with history only. */
export const QUIET = { quiet: "fs_quiet", flagged: "fs_flagged" } as const;

const aws = { ip: "52.94.236.248", asn: 16509, asn_org: "AMAZON-02" };
const digitalOcean = {
  ip: "167.99.10.20",
  asn: 14061,
  asn_org: "DIGITALOCEAN-ASN",
};

function send(
  id: string,
  account: string,
  at: Date,
  network: typeof aws,
  recipients: number,
  link: string,
) {
  return {
    event_id: id,
    type: "email.send",
    occurred_at: at.toISOString(),
    account_id: account,
    api_key_id: `${account}_key`,
    source: "api",
    network,
    client: { user_agent: "resend-node:4.0.0" },
    email: {
      from: `Billing <billing@${account}.example>`,
      to: Array.from(
        { length: recipients },
        (_, i) => `customer${i}@example.org`,
      ),
      html: `<p>Your monthly update.</p><a href="https://${link}/x">link</a>`,
    },
  };
}

async function post(event: { event_id: string } & Record<string, unknown>) {
  const res = await fetch(`${API}/v1/events`, {
    method: "POST",
    headers: { ...INGEST, "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  const body = (await res.json()) as {
    action?: string;
    reason?: string;
    unscored?: boolean;
  };
  if (!res.ok || body.unscored)
    throw new Error(
      `${event.event_id}: HTTP ${res.status} ${JSON.stringify(body)}`,
    );
  return body;
}

export default async function world() {
  // Yesterday, so nothing is dated in the future; the attack at 02:00, a quiet hour.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  today.setUTCDate(today.getUTCDate() - 1);
  const at = (days: number, minutes: number) =>
    new Date(today.getTime() - days * 86_400_000 + minutes * 60_000);

  for (const account of [...Object.values(ATTACKED), ...Object.values(QUIET)]) {
    for (let day = 12; day >= 1; day--)
      for (let hour = 9; hour <= 17; hour++) {
        const r = await post(
          send(
            `${account}_h_${day}_${hour}`,
            account,
            at(day, hour * 60 + ((day * hour) % 50)),
            aws,
            20 + ((day * 7 + hour * 3) % 41),
            "stripe.com",
          ),
        );
        if (r.action !== "allow")
          throw new Error(`${account} history scored ${r.action}`);
      }
  }

  // A flag never opens a review: a new network alone, nothing else.
  const flagged = await post(
    send(
      `${QUIET.flagged}_new_net`,
      QUIET.flagged,
      at(0, 120),
      digitalOcean,
      3,
      "stripe.com",
    ),
  );
  if (flagged.action !== "flag")
    throw new Error(`flagged account scored ${flagged.action}`);

  for (const account of Object.values(ATTACKED)) {
    let blocked = false;
    for (let i = 0; i <= 40 && !blocked; i++) {
      const r = await post(
        send(
          `${account}_attack_${i}`,
          account,
          new Date(at(0, 120).getTime() + i * 20_000),
          digitalOcean,
          i === 0 ? 1 : 5,
          "invoice-portal.net",
        ),
      );
      blocked = r.action === "block";
      if (!blocked && r.action !== "hold")
        throw new Error(`${account} attack ${i}: ${r.action}`);
    }
    if (!blocked) throw new Error(`${account}: 40 attack sends never blocked`);
    // One more send on the now-suspended key: rejected, with no review of its own.
    const rejected = await post(
      send(
        `${account}_after`,
        account,
        new Date(at(0, 120).getTime() + 41 * 20_000),
        digitalOcean,
        5,
        "invoice-portal.net",
      ),
    );
    if (rejected.reason !== "key_suspended")
      throw new Error(`${account}: not rejected after the block`);
  }

  // Persistence: the attacker creates a backup key on the taken-over account and
  // hasn't used it yet.
  await post({
    event_id: `${ATTACKED.takeover}_backup_created`,
    type: "account.change",
    occurred_at: new Date(at(0, 120).getTime() + 42 * 20_000).toISOString(),
    account_id: ATTACKED.takeover,
    api_key_id: `${ATTACKED.takeover}_key`,
    source: "api",
    network: digitalOcean,
    change: {
      kind: "api_key.created",
      target_id: `${ATTACKED.takeover}_backup`,
    },
  });
}
