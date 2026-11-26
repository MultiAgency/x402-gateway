import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { services } from "./catalog";
import { claimOn } from "./claims";
import { collect, type HeldPayment } from "./paywall";
import { sales, type Channel, type Sale } from "./sales";
import { backendHealthy, refusalCode, sendJob, ServiceError } from "./service";

/** How a job ended: reported by its backend, or by the job's record for work the gateway runs itself. */
export const Outcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), result: z.unknown() }),
  z.object({ status: z.literal("failed"), reason: z.string(), message: z.string().optional() }),
]);
export type Outcome = z.infer<typeof Outcome>;
type Failed = Extract<Outcome, { status: "failed" }>;

/** What the buyer sees. The result comes only with the transaction that paid for it. */
export type JobView = { service: string; created: string } & (
  | { status: "running" }
  | { status: "done"; result: unknown; transaction: string }
  | Failed
);

const RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Collection must land before the payment itself expires: this covers the facilitator and the chain. */
const COLLECTION_MARGIN_MS = 60_000;
/** Between attempts to collect a payment that was not settled. */
const RETRY_MS = 30_000;
/** Between health checks of a backend that is waking. */
const WAKE_RETRY_MS = 2_000;
const NOT_STARTED = "The service could not start this job. Nothing was charged; the same payment can be sent again.";
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LATE: Failed = { status: "failed", reason: "timeout", message: "The service finished after the payment window closed. Nothing was charged." };
const LOST: Failed = { status: "failed", reason: "timeout", message: "The service did not report an outcome in time. Nothing was charged." };
const UNPAID: Failed = {
  status: "failed",
  reason: "payment_failed",
  message: "The payment could not be collected, so the result was not released.",
};
const BROKE: Failed = { status: "failed", reason: "failed", message: "The service did not complete this job. Nothing was charged." };

/** A job paid for while its backend was asleep: what it is handed once the backend wakes. */
interface HandOff {
  input: unknown;
  callback: { url: string; token: string };
}

interface Stored {
  id: string;
  service: string;
  channel: Channel;
  created: number;
  /** SHA-256 of the token the backend must present to report the outcome; absent for a job the gateway runs. */
  tokenHash?: ArrayBuffer;
  /** The order of a job the gateway runs itself (`Service.work`), until it has run. */
  input?: unknown;
  /** A backend's job not yet handed over, because the backend was asleep when it was paid for. */
  handOff?: HandOff;
  payment: HeldPayment;
  /** The last moment the payment can be collected. */
  collectBy: number;
  outcome?: Outcome;
  /** The transaction that collected the payment. */
  transaction?: string;
  /** Whether the job's end is in the sales record. */
  recorded?: boolean;
}

/**
 * One purchased job: its record and its buyer's payment, kept for a week, then deleted. Addressed by the job's id.
 * A backend's job is run by the backend, which reports its outcome with the job's token; a job the gateway runs itself
 * is run by this object's alarm, which reports the outcome the same way, without a token. The payment is collected only
 * once the job is done, by the alarm, which tries again until the payment can no longer be collected. However the job
 * ends, the end goes into the sales record once.
 */
export class Job extends DurableObject<Env> {
  /**
   * Opens a backend's job (`token`, for its reports) or one the gateway runs itself (`input`, its order), and returns
   * the last moment its payment can be collected: a result after it is never paid for.
   */
  async open(job: { id: string; service: string; payment: HeldPayment } & ({ token: string } | { input: unknown })): Promise<number> {
    const created = Date.now();
    const window = created + job.payment.requirements.maxTimeoutSeconds * 1000;
    const collectBy = Math.min(window, job.payment.expires) - COLLECTION_MARGIN_MS;
    const stored: Stored = {
      id: job.id,
      service: job.service,
      channel: "x402",
      created,
      ...("token" in job ? { tokenHash: await sha256(job.token) } : { input: job.input }),
      payment: job.payment,
      collectBy,
    };
    await this.ctx.storage.put("job", stored);
    // The gateway's own work starts at once. At `collectBy` a job that has not ended is lost, or its payment
    // uncollectable, and that end is recorded.
    await this.ctx.storage.setAlarm("input" in job ? created : collectBy);
    return collectBy;
  }

  async view(): Promise<JobView | undefined> {
    const stored = await this.ctx.storage.get<Stored>("job");
    if (!stored) return undefined;
    const job = { service: stored.service, created: new Date(stored.created).toISOString() };
    const { outcome, transaction } = stored;
    if (outcome?.status === "done" && transaction) return { ...job, status: "done", result: outcome.result, transaction };
    if (outcome?.status === "failed") return { ...job, ...outcome };
    if (Date.now() < stored.collectBy) return { ...job, status: "running" };
    return { ...job, ...(outcome ? UNPAID : LOST) };
  }

  /**
   * A backend's report of its job's outcome, with the job's token. Only a backend's job has one, so nobody outside the
   * gateway can report the outcome of a job the gateway runs.
   */
  async finish(token: string, outcome: Outcome): Promise<"recorded" | "unauthorized" | "missing"> {
    const stored = await this.ctx.storage.get<Stored>("job");
    if (!stored) return "missing";
    if (!stored.tokenHash || !crypto.subtle.timingSafeEqual(stored.tokenHash, await sha256(token))) return "unauthorized";
    await this.conclude(stored, outcome);
    return "recorded";
  }

  /** Records the outcome once; a repeated outcome of a finished job changes nothing. A result starts collection. */
  private async conclude(stored: Stored, outcome: Outcome): Promise<void> {
    if (stored.outcome) return;
    const ended = outcome.status === "done" && Date.now() >= stored.collectBy ? LATE : outcome;
    if (ended.status === "failed") return this.end(stored, { outcome: "failed", reason: ended.reason }, { outcome: ended });
    await this.ctx.storage.put("job", { ...stored, outcome: ended });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Runs a job the gateway runs itself and concludes it, dropping its order. The work's errors become its outcome rather
   * than escaping: an alarm that throws is run again, which would run, and pay for, the work again.
   */
  private async perform(stored: Stored): Promise<void> {
    const work = services.find((service) => service.path === stored.service)?.work;
    let outcome: Outcome;
    try {
      if (!work) throw new Error(`${stored.service} is not run by the gateway`);
      outcome = { status: "done", result: await work(stored.input, this.env) };
    } catch (error) {
      if (error instanceof ServiceError) {
        outcome = { status: "failed", reason: error.code, message: error.message };
      } else {
        console.error(JSON.stringify({ message: "job failed", job: stored.id, service: stored.service, error: String(error) }));
        outcome = BROKE;
      }
    }
    const { input: _ran, ...ran } = stored;
    await this.conclude(ran, outcome);
  }

  /** Keeps a backend's job to hand over once the backend wakes, which the alarm checks from now on. */
  async handOverLater(handOff: HandOff): Promise<void> {
    const stored = await this.ctx.storage.get<Stored>("job");
    if (!stored) return;
    await this.ctx.storage.put("job", { ...stored, handOff });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Hands a waiting job to its backend once the backend answers its health check. A refusal ends the job; a backend
   * that hasn't taken it within `BACKEND_WAKE_SECONDS` of the order is unavailable, and that ends it too.
   */
  private async handOver(stored: Stored & { handOff: HandOff }): Promise<void> {
    const backend = services.find((service) => service.path === stored.service)?.backend?.(this.env);
    if (backend && (await backendHealthy(backend))) {
      const { input, callback } = stored.handOff;
      const sent = await sendJob(backend, { id: stored.id, input, deadline: stored.collectBy, callback }, stored.service);
      if (sent.taken) {
        const { handOff: _handed, ...taken } = stored;
        await this.ctx.storage.put("job", taken);
        return this.ctx.storage.setAlarm(stored.collectBy);
      }
      if (sent.refusal !== undefined) return this.giveUp(stored, refusalCode(sent.refusal) ?? "refused", refusalMessage(sent.refusal));
    }
    const now = Date.now();
    if (now >= stored.created + Number(this.env.BACKEND_WAKE_SECONDS) * 1000) return this.giveUp(stored, "service_unavailable", NOT_STARTED);
    await this.ctx.storage.setAlarm(now + WAKE_RETRY_MS);
  }

  /**
   * Ends a job its backend never started, as a refusal at once would: recorded as refused, nothing charged, and the
   * payment released so the buyer can send it again. The buyer, who already has the job, sees it failed and why.
   */
  private async giveUp(stored: Stored, reason: string, message: string): Promise<void> {
    await claimOn(this.env, stored.payment.id).release(stored.id);
    const { handOff: _dropped, ...ended } = stored;
    await this.end(ended, { outcome: "refused", reason }, { outcome: { status: "failed", reason, message } });
  }

  /** Deletes a job its backend never started: it was refused, and that is recorded. */
  async refuse(reason: string): Promise<void> {
    const stored = await this.ctx.storage.get<Stored>("job");
    if (stored) await sales(this.env).record(this.sale(stored, { outcome: "refused", reason }));
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<Stored>("job");
    if (!stored) return;
    const now = Date.now();
    if (stored.handOff && !stored.outcome) return this.handOver({ ...stored, handOff: stored.handOff });
    if (stored.input !== undefined && !stored.outcome && now < stored.collectBy) return this.perform(stored);
    if (stored.outcome?.status === "done" && !stored.transaction && now < stored.collectBy) {
      return this.collectPayment(stored);
    }
    if (!stored.recorded && now >= stored.collectBy) {
      return this.end(stored, { outcome: "failed", reason: (stored.outcome ? UNPAID : LOST).reason }, {});
    }
    if (now >= stored.created + RETENTION_MS) return this.ctx.storage.deleteAll();
    await this.ctx.storage.setAlarm(stored.created + RETENTION_MS);
  }

  private async collectPayment(stored: Stored): Promise<void> {
    const collected = await collect(this.env, stored.payment).catch((error: unknown) => ({ refused: String(error) }));
    if ("transaction" in collected) {
      const { transaction, payer } = collected;
      const amount = stored.payment.requirements.amount;
      return this.end(stored, { outcome: "delivered", payer, amount, transaction }, { transaction });
    }
    console.error(JSON.stringify({ message: "payment not collected", job: stored.id, reason: collected.refused }));
    // At `collectBy` the alarm finds the payment uncollectable and records that end.
    await this.ctx.storage.setAlarm(Math.min(Date.now() + RETRY_MS, stored.collectBy));
  }

  /**
   * Records how the job ended, then keeps `change` with the mark that it is recorded, and keeps the record until it is
   * deleted. Recording first means a failure in between records the end again, which the sales record ignores.
   */
  private async end(stored: Stored, end: Ending, change: Partial<Stored>): Promise<void> {
    await sales(this.env).record(this.sale(stored, end));
    await this.ctx.storage.put("job", { ...stored, ...change, recorded: true });
    await this.ctx.storage.setAlarm(stored.created + RETENTION_MS);
  }

  private sale(stored: Stored, end: Ending): Sale {
    return { job: stored.id, service: stored.service, channel: stored.channel, network: stored.payment.requirements.network, ...end };
  }
}

/** The `message` of a backend's refusal (`{ error, message }`), or a general one. */
function refusalMessage(body: string): string {
  try {
    const { message } = JSON.parse(body) as { message?: unknown };
    if (typeof message === "string" && message) return message;
  } catch {}
  return "The service refused this job. Nothing was charged.";
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** How a job ended, as the sales record takes it; the job fills in the rest. */
type Ending = DistributiveOmit<Sale, "job" | "service" | "channel" | "network">;

/** The job with this id, or undefined when the id is not one this gateway issues. */
export function jobById(env: Env, id: string): DurableObjectStub<Job> | undefined {
  return JOB_ID.test(id) ? env.JOBS.get(env.JOBS.idFromName(id)) : undefined;
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}
