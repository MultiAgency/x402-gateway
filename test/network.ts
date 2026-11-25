// Everything the gateway reaches over the network, faked at `fetch`: the CDP facilitator, the review backends and the
// model the gateway's own jobs call (NEAR AI Cloud's Messages API).
// The Worker and its Durable Objects run in the test's isolate, so one spy sees all of their requests.
import { vi } from "vitest";

const FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
const MODEL = "https://cloud-api.near.ai/v1/messages";
export const NETWORK = "eip155:84532";

type Settle = (body: { paymentPayload: unknown; paymentRequirements: unknown }) => Response | Promise<Response>;

export interface Network {
  /** Every settlement the facilitator was asked for, in order. */
  settled: unknown[];
  /** Every job a backend was handed, by backend host. */
  jobs: { host: string; body: { id: string; input: unknown; callback: { url: string; token: string } } }[];
  /** How the facilitator answers a settlement; succeeds by default. */
  settle: Settle;
  /** How a backend answers `POST /jobs`; queues by default. */
  backend: (host: string) => Response;
  /** How a backend answers `GET /healthz`; healthy by default. */
  health: (host: string) => Response;
  /** Every request made to the model, in order. */
  prompts: unknown[];
  /** How the model answers; with `CLEAN_REVIEW` by default. */
  model: () => Response | Promise<Response>;
  restore(): void;
}

/** A review with nothing to raise, as the model returns it. */
export const CLEAN_REVIEW = { summary: "Sums item prices.", verdict: "approve", findings: [] };

/** A Messages API reply: `text` as the model's answer, ending as `stopReason` says. */
export function modelReply(text: string, stopReason = "end_turn"): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

export const settledOk: Settle = () =>
  Response.json({ success: true, transaction: `0x${"ab".repeat(32)}`, network: NETWORK, payer: "0xbuyer" });

/** The facilitator declines to settle, as it does when the buyer's funds are gone. */
export const notSettled: Settle = () =>
  Response.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: NETWORK });

export function fakeNetwork(): Network {
  const network: Network = {
    settled: [],
    jobs: [],
    settle: settledOk,
    backend: () => new Response("queued", { status: 202 }),
    health: () => Response.json({ ok: true, running: 0, queued: 0 }),
    prompts: [],
    model: () => modelReply(JSON.stringify(CLEAN_REVIEW)),
    restore: () => spy.mockRestore(),
  };
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.url.startsWith(FACILITATOR)) {
      const path = url.pathname.slice(new URL(FACILITATOR).pathname.length);
      if (path === "/supported") {
        return Response.json({
          kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
          extensions: ["bazaar"],
          signers: {},
        });
      }
      if (path === "/verify") return Response.json({ isValid: true, payer: "0xbuyer" });
      if (path === "/settle") {
        const body = await request.json<{ paymentPayload: unknown; paymentRequirements: unknown }>();
        network.settled.push(body);
        return network.settle(body);
      }
    }
    if (request.url === MODEL) {
      network.prompts.push(await request.json());
      return network.model();
    }
    if (url.hostname.endsWith(".test") && url.pathname === "/jobs") {
      network.jobs.push({ host: url.hostname, body: await request.json() });
      return network.backend(url.hostname);
    }
    if (url.hostname.endsWith(".test") && url.pathname === "/healthz") return network.health(url.hostname);
    if (url.hostname.endsWith(".test")) throw new Error(`unexpected request to ${request.url}`);
    return real(input, init);
  });
  return network;
}
