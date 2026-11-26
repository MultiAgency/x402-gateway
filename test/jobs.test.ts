import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { pay } from "./buyer";
import { closeWindow, order, paidOrder as paidOrderOn, recorded, report, view } from "./gateway";
import { fakeNetwork, notSettled, settledOk, type Network } from "./network";

let network: Network;
beforeEach(() => {
  network = fakeNetwork();
});
afterEach(() => network.restore());

const REVIEW = { summary: "Looks fine.", findings: [] };
const paidOrder = () => paidOrderOn(network);

function challengeOf(response: Response): { accepts: { maxTimeoutSeconds: number }[] } {
  return JSON.parse(atob(response.headers.get("payment-required")!));
}

test("an unpaid order gets the payment challenge and starts nothing", async () => {
  const challenge = await order("/private-investigator");
  expect(challenge.status).toBe(402);
  expect(network.jobs).toHaveLength(0);
});

test("a backend's job's payment can be collected for an hour; a snippet review's for ten minutes", async () => {
  expect(challengeOf(await order("/private-investigator")).accepts[0]!.maxTimeoutSeconds).toBe(3600);
  expect(challengeOf(await order("/multi-review")).accepts[0]!.maxTimeoutSeconds).toBe(3600);
  expect(challengeOf(await order("/snippet-review")).accepts[0]!.maxTimeoutSeconds).toBe(600);
});

test("a paid order starts the job and collects nothing yet", async () => {
  const { started, id } = await paidOrder();
  expect(started.headers.get("payment-response")).toBeNull();
  expect(network.settled).toHaveLength(0);
  expect(await view(id)).toMatchObject({ status: "running" });
});

test("a delivered result is collected once, then released with the transaction that paid for it", async () => {
  const job = await paidOrder();
  expect((await report(job, { status: "done", result: REVIEW })).status).toBe(204);
  expect(await view(job.id)).toMatchObject({ status: "running" });

  expect(await runDurableObjectAlarm(job.stub)).toBe(true);
  expect(network.settled).toHaveLength(1);
  expect(await view(job.id)).toMatchObject({ status: "done", result: REVIEW, transaction: `0x${"ab".repeat(32)}` });

  expect((await report(job, { status: "done", result: REVIEW })).status).toBe(204);
  await runDurableObjectAlarm(job.stub);
  expect(network.settled).toHaveLength(1);
});

test("a failed job collects nothing", async () => {
  const job = await paidOrder();
  await report(job, { status: "failed", reason: "failed", message: "The review did not complete." });
  await runDurableObjectAlarm(job.stub);
  expect(network.settled).toHaveLength(0);
  expect(await view(job.id)).toMatchObject({ status: "failed", reason: "failed" });
});

test("an order the backend refuses reaches the buyer as the backend said it, and collects nothing", async () => {
  network.backend = () => Response.json({ error: "not_open", message: "The pull request is not open." }, { status: 422 });
  const refused = await order("/private-investigator", await pay(await order("/private-investigator")));
  expect(refused.status).toBe(422);
  expect(await refused.json()).toEqual({ error: "not_open", message: "The pull request is not open." });
  expect(network.settled).toHaveLength(0);
  expect(await view(network.jobs[0]!.body.id)).toEqual({ error: "not_found" });
});

test("a backend answering anything but 202 or a 422 refusal is unavailable, and the buyer is not shown its answer", async () => {
  for (const answer of [
    () => Response.json({ error: "invalid_request", message: "Not a purchase this service accepts." }, { status: 400 }),
    () => new Response(null, { status: 401 }),
    () => new Response("Not Found", { status: 404 }),
    () => new Response("Too Many Requests", { status: 429 }),
  ]) {
    network.backend = answer;
    const failed = await order("/private-investigator", await pay(await order("/private-investigator")));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: "service_unavailable" });
  }
  expect(network.settled).toHaveLength(0);
});

test("a payment the facilitator does not settle withholds the result, and is tried again", async () => {
  network.settle = notSettled;
  const job = await paidOrder();
  await report(job, { status: "done", result: REVIEW });
  await runDurableObjectAlarm(job.stub);
  expect(network.settled).toHaveLength(1);
  expect(await view(job.id)).toEqual(expect.not.objectContaining({ result: expect.anything() }));

  network.settle = settledOk;
  expect(await runDurableObjectAlarm(job.stub)).toBe(true);
  expect(network.settled).toHaveLength(2);
  expect(await view(job.id)).toMatchObject({ status: "done", result: REVIEW });
});

test("a payment still uncollected when its window closes releases nothing and is not tried again", async () => {
  network.settle = notSettled;
  const job = await paidOrder();
  await report(job, { status: "done", result: REVIEW });
  await runDurableObjectAlarm(job.stub);
  await closeWindow(job.stub);

  await runDurableObjectAlarm(job.stub);
  expect(network.settled).toHaveLength(1);
  const failed = await view(job.id);
  expect(failed).toMatchObject({ status: "failed", reason: "payment_failed" });
  expect(failed).not.toHaveProperty("result");
});

test("a job that never reports is lost after its window, and collects nothing", async () => {
  const job = await paidOrder();
  await closeWindow(job.stub);
  expect(await view(job.id)).toMatchObject({ status: "failed", reason: "timeout" });
  await runDurableObjectAlarm(job.stub);
  expect(network.settled).toHaveLength(0);
});

test("a result reported after the window closes is neither collected nor released", async () => {
  const job = await paidOrder();
  await closeWindow(job.stub);
  await report(job, { status: "done", result: REVIEW });
  await runDurableObjectAlarm(job.stub);
  expect(network.settled).toHaveLength(0);
  const failed = await view(job.id);
  expect(failed).toMatchObject({ status: "failed", reason: "timeout" });
  expect(failed).not.toHaveProperty("result");
});

test("an outcome sent without a length is read like any other, and one too large is refused", async () => {
  const job = await paidOrder();
  const streamed = (text: string) =>
    exports.default.fetch(job.callback.url, {
      method: "POST",
      headers: { authorization: `Bearer ${job.callback.token}`, "content-type": "application/json" },
      // A stream of unknown length, which is sent without a Content-Length header.
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
    });
  expect((await streamed(JSON.stringify({ status: "done", result: "x".repeat(2 * 1024 * 1024) }))).status).toBe(413);
  expect((await streamed(JSON.stringify({ status: "done", result: REVIEW }))).status).toBe(204);
});

test("only the backend's token can report an outcome", async () => {
  const job = await paidOrder();
  const forged = await report({ callback: { url: job.callback.url, token: "guess" } }, { status: "done", result: REVIEW });
  expect(forged.status).toBe(401);
  expect(await view(job.id)).toMatchObject({ status: "running" });
});

test("a backend is handed the moment its job's payment stops being collectable", async () => {
  const job = await paidOrder();
  const collectBy = await runInDurableObject(job.stub, async (_, state) => (await state.storage.get<{ collectBy: number }>("job"))!.collectBy);
  expect(job.deadline).toBe(new Date(collectBy).toISOString());
});

/** Pays for a Private Investigator review while its backend is asleep, and returns the job that order started. */
async function coldOrder() {
  const payment = await pay(await order("/private-investigator"));
  const started = await order("/private-investigator", payment);
  expect(started.status).toBe(202);
  const { id } = await started.json<{ id: string }>();
  return { id, payment, stub: env.JOBS.get(env.JOBS.idFromName(id)) };
}

const asleep = () => new Response("no container instance", { status: 503 });

test("an order to a backend that is asleep is answered at once, and the job is handed over once it wakes", async () => {
  let awake = false;
  network.health = () => (awake ? Response.json({ ok: true }) : asleep());
  const job = await coldOrder();
  expect(network.jobs).toHaveLength(0);
  expect(await view(job.id)).toMatchObject({ status: "running" });

  expect(await runDurableObjectAlarm(job.stub)).toBe(true);
  expect(network.jobs).toHaveLength(0);

  awake = true;
  expect(await runDurableObjectAlarm(job.stub)).toBe(true);
  expect(network.jobs.map((handed) => handed.body.id)).toEqual([job.id]);
  expect(await view(job.id)).toMatchObject({ status: "running" });
});

test("a job its backend refuses once awake ends failed with the backend's reason, uncharged, its payment free again", async () => {
  let awake = false;
  network.health = () => (awake ? Response.json({ ok: true }) : asleep());
  const job = await coldOrder();
  awake = true;
  network.backend = () => Response.json({ error: "not_open", message: "The pull request is not open." }, { status: 422 });
  await runDurableObjectAlarm(job.stub);
  expect(await view(job.id)).toMatchObject({ status: "failed", reason: "not_open", message: "The pull request is not open." });
  expect(network.settled).toHaveLength(0);
  expect((await recorded("refused", "not_open")).jobs).toBeGreaterThan(0);
  // As with a refusal at once: the same payment can buy a review again.
  network.backend = () => new Response("queued", { status: 202 });
  const again = await order("/private-investigator", job.payment);
  expect(again.status).toBe(202);
  expect((await again.json<{ id: string }>()).id).not.toBe(job.id);
});

test("a job whose backend doesn't wake in time ends failed as unavailable: handed nothing, charged nothing", async () => {
  network.health = asleep;
  const job = await coldOrder();
  // Past the time a backend has to wake (BACKEND_WAKE_SECONDS, 1 s in tests).
  await runInDurableObject(job.stub, async (_, state) => {
    const stored = await state.storage.get<{ created: number }>("job");
    await state.storage.put("job", { ...stored, created: stored!.created - 2_000 });
  });
  await runDurableObjectAlarm(job.stub);
  expect(await view(job.id)).toMatchObject({ status: "failed", reason: "service_unavailable" });
  expect(network.jobs).toHaveLength(0);
  expect(network.settled).toHaveLength(0);
});
