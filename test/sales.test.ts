import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { pay } from "./buyer";
import { closeWindow, order, paidOrder as paidOrderOn, recorded, report, salesSummary } from "./gateway";
import { fakeNetwork, notSettled, type Network } from "./network";

let network: Network;
beforeEach(() => {
  network = fakeNetwork();
});
afterEach(() => network.restore());

const REVIEW = { summary: "Looks fine.", findings: [] };
const paidOrder = () => paidOrderOn(network);
// What the challenge prices Private Investigator at: $0.50 (wrangler.jsonc) in USDC's atomic units.
const PRICE = 500_000;

test("a delivered review is recorded once, with its payer and the amount collected", async () => {
  const before = await recorded("delivered");
  const job = await paidOrder();
  await report(job, { status: "done", result: REVIEW });
  await runDurableObjectAlarm(job.stub);
  await report(job, { status: "done", result: REVIEW });
  await runDurableObjectAlarm(job.stub);

  const after = await recorded("delivered");
  expect(after.jobs - before.jobs).toBe(1);
  expect(after.collected - before.collected).toBe(PRICE);
  expect(after.payers).toBeGreaterThanOrEqual(1);
});

test("two reviews bought by the same payer count as one payer", async () => {
  for (let i = 0; i < 2; i++) {
    const job = await paidOrder();
    await report(job, { status: "done", result: REVIEW });
    await runDurableObjectAlarm(job.stub);
  }
  expect(await recorded("delivered")).toMatchObject({ payers: 1 });
});

test("a job that fails is recorded with the backend's reason and nothing collected", async () => {
  const before = await recorded("failed", "failed");
  const job = await paidOrder();
  await report(job, { status: "failed", reason: "failed" });
  await runDurableObjectAlarm(job.stub);
  const after = await recorded("failed", "failed");
  expect(after.jobs - before.jobs).toBe(1);
  expect(after.collected).toBe(0);
});

test("an order the backend refuses is recorded with its refusal code", async () => {
  const before = await recorded("refused", "not_open");
  network.backend = () => Response.json({ error: "not_open", message: "The pull request is not open." }, { status: 422 });
  expect((await order("/private-investigator", await pay(await order("/private-investigator")))).status).toBe(422);
  expect((await recorded("refused", "not_open")).jobs - before.jobs).toBe(1);
});

test("an order the backend can't take is recorded as the service being unavailable", async () => {
  const before = await recorded("refused", "service_unavailable");
  network.backend = () => new Response("down", { status: 500 });
  expect((await order("/private-investigator", await pay(await order("/private-investigator")))).status).toBe(503);
  expect((await recorded("refused", "service_unavailable")).jobs - before.jobs).toBe(1);
});

test("a job that never reports is recorded as timed out when its window closes", async () => {
  const before = await recorded("failed", "timeout");
  const job = await paidOrder();
  await closeWindow(job.stub);
  await runDurableObjectAlarm(job.stub);
  expect((await recorded("failed", "timeout")).jobs - before.jobs).toBe(1);
});

test("a result whose payment is never collected is recorded as unpaid", async () => {
  const before = await recorded("failed", "payment_failed");
  network.settle = notSettled;
  const job = await paidOrder();
  await report(job, { status: "done", result: REVIEW });
  await runDurableObjectAlarm(job.stub);
  await closeWindow(job.stub);
  await runDurableObjectAlarm(job.stub);
  expect((await recorded("failed", "payment_failed")).jobs - before.jobs).toBe(1);
});

test("the sales record is read only with the sales token", async () => {
  expect((await salesSummary("guess")).status).toBe(401);
  expect((await salesSummary()).status).toBe(200);
});
