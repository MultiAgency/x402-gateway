import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { pay, payExpiringIn, retouched } from "./buyer";
import { order, report, view } from "./gateway";
import { fakeNetwork, type Network } from "./network";

let network: Network;
beforeEach(() => {
  network = fakeNetwork();
});
afterEach(() => network.restore());

const PATH = "/private-investigator";
const REVIEW = { summary: "Looks fine.", findings: [] };
const payment = async () => pay(await order(PATH));

test("one payment sent twice buys one job, and the second order answers with it", async () => {
  const paid = await payment();
  const first = await order(PATH, paid);
  const second = await order(PATH, paid);
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(network.jobs).toHaveLength(1);
  const [a, b] = [await first.json<{ id: string }>(), await second.json<{ id: string }>()];
  expect(b.id).toBe(a.id);
});

test("one payment sent twice at once buys one job", async () => {
  const paid = await payment();
  const answers = await Promise.all([order(PATH, paid), order(PATH, paid)]);
  expect(answers.map((answer) => answer.status)).toEqual([202, 202]);
  expect(network.jobs).toHaveLength(1);
});

test("changing what the signature doesn't cover does not make it another payment", async () => {
  const paid = await payment();
  await order(PATH, paid);
  const changed = retouched(paid, (payload) => {
    payload.resource = { ...(payload.resource as object), description: "a different order" };
  });
  expect((await order(PATH, changed)).status).toBe(202);
  expect(network.jobs).toHaveLength(1);
});

test("a payment whose order was refused is still the buyer's to spend", async () => {
  const paid = await payment();
  network.backend = () => Response.json({ error: "not_open", message: "The pull request is not open." }, { status: 422 });
  expect((await order(PATH, paid)).status).toBe(422);
  network.backend = () => new Response("queued", { status: 202 });
  expect((await order(PATH, paid)).status).toBe(202);
  expect(network.jobs).toHaveLength(2);
});

test("a payment sent again after its job was delivered shows that job, and is collected once", async () => {
  const paid = await payment();
  const { id } = await (await order(PATH, paid)).json<{ id: string }>();
  await report(network.jobs[0]!.body, { status: "done", result: REVIEW });
  await runDurableObjectAlarm(env.JOBS.get(env.JOBS.idFromName(id)));
  expect(await view(id)).toMatchObject({ status: "done" });

  const again = await order(PATH, paid);
  expect(await again.json()).toMatchObject({ id, status: "done" });
  expect(network.jobs).toHaveLength(1);
  expect(network.settled).toHaveLength(1);
});

test("a payment that expires before the job's window closes starts nothing", async () => {
  const paid = await payExpiringIn(await order(PATH), 10);
  const answer = await order(PATH, paid);
  expect(answer.status).toBe(400);
  expect(await answer.json()).toMatchObject({ error: "payment_window_too_short" });
  expect(network.jobs).toHaveLength(0);
});

test("two payments from the same buyer are two jobs", async () => {
  await order(PATH, await payment());
  await order(PATH, await payment());
  expect(network.jobs).toHaveLength(2);
});
