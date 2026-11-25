import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fakeNetwork, type Network } from "./network";

let network: Network;
beforeEach(() => {
  network = fakeNetwork();
});
afterEach(() => network.restore());

const health = () => exports.default.fetch("https://gateway.test/healthz");

test("the gateway is healthy when every listed service is, and says no more about them", async () => {
  const answer = await health();
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({
    ok: true,
    services: { "/snippet-review": true, "/private-investigator": true, "/multi-review": true },
  });
});

test("a backend that is down makes the gateway unhealthy, naming the service", async () => {
  network.health = (host) => (host === "multi-review.test" ? new Response("down", { status: 500 }) : Response.json({ ok: true }));
  const answer = await health();
  expect(answer.status).toBe(503);
  expect(await answer.json()).toMatchObject({ ok: false, services: { "/multi-review": false, "/private-investigator": true } });
});

test("a backend that answers but not with ok: true counts as down", async () => {
  network.health = () => Response.json({ ok: false });
  expect((await health()).status).toBe(503);
});
