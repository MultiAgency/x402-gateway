import { DurableObject } from "cloudflare:workers";

interface Held {
  job: string;
}

/**
 * The job one payment bought, addressed by the payment's identity (`paymentIdentity`). A payment is held, not collected,
 * while its job runs, so the facilitator would verify it again for a second order; this is what stops one payment
 * buying two jobs. Kept until the payment can no longer be collected, then deleted.
 */
export class Claim extends DurableObject<Env> {
  /** Gives the payment to `job` unless it already bought one: the job that holds it either way. */
  async claim(job: string, expires: number): Promise<string> {
    const held = await this.ctx.storage.get<Held>("claim");
    if (held) return held.job;
    await this.ctx.storage.put("claim", { job } satisfies Held);
    await this.ctx.storage.setAlarm(expires);
    return job;
  }

  /** Frees the payment of a job that never started, so it was never charged and is still the buyer's to spend. */
  async release(job: string): Promise<void> {
    const held = await this.ctx.storage.get<Held>("claim");
    if (held?.job !== job) return;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** The claim on the payment with this identity. */
export function claimOn(env: Env, payment: string): DurableObjectStub<Claim> {
  return env.CLAIMS.getByName(payment);
}
