import { DurableObject } from "cloudflare:workers";

/**
 * How a job was bought. `x402`: paid over x402 at the gateway's own route, on `network`. Which directory the buyer
 * found the route in is not visible to the gateway, so it is not recorded.
 */
export type Channel = "x402";

/** How a job ended. Only `delivered` was charged. */
export type Sale = {
  job: string;
  service: string;
  channel: Channel;
  network: string;
} & (
  | { outcome: "delivered"; payer?: string; amount: string; transaction: string }
  | { outcome: "failed" | "refused"; reason: string }
);

/**
 * Per service, channel, outcome and reason: how many jobs, how many distinct payers, and the atomic units collected.
 * `reason` is null for a delivered job.
 */
export type SalesRow = {
  service: string;
  channel: string;
  network: string;
  outcome: string;
  reason: string | null;
  jobs: number;
  payers: number;
  collected: number;
};

/**
 * Every job's end, kept after its job record is deleted, so the channels can be compared on what they sell. One
 * instance: a row per job, written once.
 */
export class Sales extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sales (
          job TEXT PRIMARY KEY,
          ended_at INTEGER NOT NULL,
          service TEXT NOT NULL,
          channel TEXT NOT NULL,
          network TEXT NOT NULL,
          outcome TEXT NOT NULL,
          reason TEXT,
          payer TEXT,
          amount TEXT,
          transaction_hash TEXT
        )
      `);
    });
  }

  /** Records how a job ended. A job already recorded keeps its first record. */
  record(sale: Sale): void {
    const delivered = sale.outcome === "delivered" ? sale : undefined;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO sales (job, ended_at, service, channel, network, outcome, reason, payer, amount, transaction_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sale.job,
      Date.now(),
      sale.service,
      sale.channel,
      sale.network,
      sale.outcome,
      sale.outcome === "delivered" ? null : sale.reason,
      delivered?.payer ?? null,
      delivered?.amount ?? null,
      delivered?.transaction ?? null,
    );
  }

  summary(): SalesRow[] {
    return this.ctx.storage.sql
      .exec<SalesRow>(
        `SELECT service, channel, network, outcome, reason, COUNT(*) AS jobs, COUNT(DISTINCT payer) AS payers,
                COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS collected
         FROM sales GROUP BY service, channel, network, outcome, reason
         ORDER BY service, channel, network, outcome, reason`,
      )
      .toArray();
  }
}

/** The one sales record. */
export function sales(env: Env): DurableObjectStub<Sales> {
  return env.SALES.getByName("sales");
}
