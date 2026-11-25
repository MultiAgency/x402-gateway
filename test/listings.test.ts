import { validateDiscoveryExtension, type DiscoveryExtension } from "@x402/extensions/bazaar";
import { afterEach, beforeEach, expect, test } from "vitest";
import { order } from "./gateway";
import { fakeNetwork, type Network } from "./network";

let network: Network;
beforeEach(() => {
  network = fakeNetwork();
});
afterEach(() => network.restore());

/** The Bazaar declaration a route's unpaid challenge carries: what directories index. */
async function listing(path: string): Promise<DiscoveryExtension> {
  const challenge = await order(path);
  expect(challenge.status).toBe(402);
  const required = JSON.parse(atob(challenge.headers.get("payment-required")!)) as { extensions: { bazaar: DiscoveryExtension } };
  return required.extensions.bazaar;
}

test.each(["/snippet-review", "/private-investigator", "/multi-review"])(
  "%s is listed with an output schema its example satisfies, by Bazaar's own validator",
  async (path) => {
    const bazaar = await listing(path);
    expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
    const output = (bazaar.schema as { properties: { output?: { properties: { example: { properties?: object } } } } }).properties.output;
    expect(Object.keys(output?.properties.example.properties ?? {}).length).toBeGreaterThan(0);
  },
);
