// Driving the gateway as its buyers, its backends and its owner do.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { SalesRow } from "../src/sales";
import { pay } from "./buyer";
import type { Network } from "./network";

export const PULL_REQUEST = { pull_request: "https://github.com/octocat/Hello-World/pull/1" };
export const SNIPPET = { code: "const total = items.reduce((sum, item) => sum + item.price, 0);", language: "javascript" };

/** What each service is ordered with. */
const ORDERS: Record<string, unknown> = { "/snippet-review": SNIPPET };

export function order(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`https://gateway.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(ORDERS[path] ?? PULL_REQUEST),
  });
}

/** Orders a review, pays for it, and returns the job the backend was handed. */
export async function paidOrder(network: Network, path = "/private-investigator") {
  const started = await order(path, await pay(await order(path)));
  expect(started.status).toBe(202);
  const job = network.jobs.at(-1)!.body;
  return { started, ...job, stub: env.JOBS.get(env.JOBS.idFromName(job.id)) };
}

export function report(job: { callback: { url: string; token: string } }, outcome: unknown): Promise<Response> {
  const body = JSON.stringify(outcome);
  return exports.default.fetch(job.callback.url, {
    method: "POST",
    headers: { authorization: `Bearer ${job.callback.token}`, "content-type": "application/json", "content-length": String(body.length) },
    body,
  });
}

export async function view(id: string): Promise<Record<string, unknown>> {
  return (await exports.default.fetch(`https://gateway.test/jobs/${id}`)).json();
}

/** Moves the job's payment window into the past, as if its hour had gone by. */
export function closeWindow(stub: DurableObjectStub): Promise<void> {
  return runInDurableObject(stub, async (_, state) => {
    const job = await state.storage.get<Record<string, unknown>>("job");
    await state.storage.put("job", { ...job, collectBy: Date.now() - 1 });
  });
}

export async function salesSummary(token = "sales-token"): Promise<Response> {
  return exports.default.fetch("https://gateway.test/sales", { headers: { authorization: `Bearer ${token}` } });
}

/** The jobs recorded so far with this outcome and reason (any reason when omitted), and their payers and collected units. */
export async function recorded(outcome: string, reason?: string | null): Promise<Pick<SalesRow, "jobs" | "payers" | "collected">> {
  const { sales } = await (await salesSummary()).json<{ sales: SalesRow[] }>();
  const rows = sales.filter((row) => row.outcome === outcome && (reason === undefined || row.reason === reason));
  const sum = (key: "jobs" | "payers" | "collected") => rows.reduce((total, row) => total + row[key], 0);
  return { jobs: sum("jobs"), payers: sum("payers"), collected: sum("collected") };
}
