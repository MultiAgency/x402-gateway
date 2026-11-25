// Jobs the gateway runs itself (Snippet Review): bought, polled and charged as a backend's job is, with the work run
// by the job's record. Its alarm runs on its own here, as it does deployed, so these tests wait for the job to end.
import { afterEach, beforeEach, expect, test } from "vitest";
import { pay } from "./buyer";
import { order, recorded, report, view } from "./gateway";
import { CLEAN_REVIEW, fakeNetwork, modelReply, type Network } from "./network";

let network: Network;
beforeEach(() => {
  network = fakeNetwork();
});
afterEach(() => network.restore());

const PATH = "/snippet-review";
// What the challenge prices Snippet Review at: $0.25 (wrangler.jsonc) in USDC's atomic units.
const PRICE = 250_000;

async function paidOrder(): Promise<{ id: string; status: string; status_url: string }> {
  const started = await order(PATH, await pay(await order(PATH)));
  expect(started.status).toBe(202);
  return started.json();
}

/** A model that takes `ms` to give a clean review. Its timer runs in the job's own context, as Workers requires. */
const slowModel = (ms: number) => () =>
  new Promise<Response>((resolve) => setTimeout(() => resolve(modelReply(JSON.stringify(CLEAN_REVIEW))), ms));

/** The job once it has ended, as a buyer polling it sees it. */
async function ended(id: string): Promise<Record<string, unknown>> {
  for (let poll = 0; poll < 200; poll++) {
    const job = await view(id);
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} was still running`);
}

test("a paid order answers with the job to poll while the review is still running, and collects nothing yet", async () => {
  network.model = slowModel(1_000);
  const job = await paidOrder();
  expect(job).toMatchObject({ status: "running", status_url: `https://gateway.test/jobs/${job.id}` });
  await expect.poll(() => network.prompts.length).toBe(1);
  expect(network.settled).toHaveLength(0);
  expect(await view(job.id)).toMatchObject({ status: "running" });

  expect(await ended(job.id)).toMatchObject({ status: "done", result: CLEAN_REVIEW });
});

test("a finished review is collected for once, then released with the transaction that paid for it", async () => {
  const job = await paidOrder();
  expect(await ended(job.id)).toMatchObject({ status: "done", result: CLEAN_REVIEW, transaction: `0x${"ab".repeat(32)}` });
  expect(network.prompts).toHaveLength(1);
  expect(network.settled).toHaveLength(1);
});

test("a delivered review is recorded once, with the amount collected", async () => {
  const before = await recorded("delivered");
  await ended((await paidOrder()).id);
  const after = await recorded("delivered");
  expect(after.jobs - before.jobs).toBe(1);
  expect(after.collected - before.collected).toBe(PRICE);
});

test("a review the model declines fails with that reason and collects nothing", async () => {
  network.model = () => modelReply("", "refusal");
  const job = await paidOrder();
  expect(await ended(job.id)).toMatchObject({ status: "failed", reason: "review_declined" });
  expect(network.settled).toHaveLength(0);
});

test("an answer that isn't a review fails as incomplete and collects nothing", async () => {
  network.model = () => modelReply("Looks good to me!");
  const job = await paidOrder();
  expect(await ended(job.id)).toMatchObject({ status: "failed", reason: "review_incomplete" });
  expect(network.settled).toHaveLength(0);
});

test("a model that keeps failing ends the job as failed after one retry, uncharged and without a result", async () => {
  network.model = () => new Response("overloaded", { status: 500 });
  const job = await paidOrder();
  const failed = await ended(job.id);
  expect(failed).toMatchObject({ status: "failed", reason: "upstream_error" });
  expect(failed).not.toHaveProperty("result");
  expect(network.prompts).toHaveLength(2);
  expect(network.settled).toHaveLength(0);
});

test("nobody outside the gateway can report the outcome of a job it runs itself", async () => {
  network.model = slowModel(1_000);
  const job = await paidOrder();
  const forged = await report(
    { callback: { url: `https://gateway.test/jobs/${job.id}/outcome`, token: "guess" } },
    { status: "done", result: { summary: "forged", verdict: "approve", findings: [] } },
  );
  expect(forged.status).toBe(401);
  expect(await view(job.id)).toMatchObject({ status: "running" });
  expect(await ended(job.id)).toMatchObject({ status: "done", result: CLEAN_REVIEW });
});
