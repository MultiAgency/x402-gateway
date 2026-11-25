import { createX402Server } from "@coinbase/cdp-sdk/x402";
import type { ExactEIP3009Payload, ExactPermit2Payload } from "@x402/evm";
import type { x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { HonoAdapter } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import { services } from "./catalog";
import type { Gateway } from "./service";

/** A buyer's payment that has been verified and not yet collected. Plain data, so a job can keep it. */
export interface HeldPayment {
  /** What the chain lets be spent only once (`paymentIdentity`): the same money, however the payload is dressed. */
  id: string;
  /** When the signed payment stops being collectable, in epoch milliseconds: the buyer's to set, not the route's. */
  expires: number;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  extensions: Record<string, unknown>;
}

/** How far a buyer's clock and the trip here may put a payment's expiry short of the route's window. */
const CLOCK_SKEW_MS = 60_000;

/**
 * The single-use anchor of an `exact` EVM payment, as the chain enforces it: the authorizer and nonce of an EIP-3009
 * authorization (nonces are per token) or of a Permit2 permit (nonces are per owner). The signature covers only the
 * authorization, so the rest of the payload can change without changing the money; this identity cannot. Undefined
 * for any other payload.
 */
export function paymentIdentity(payload: PaymentPayload, requirements: PaymentRequirements): string | undefined {
  const evm = payload.payload as Partial<ExactEIP3009Payload & ExactPermit2Payload>;
  const anchor = (signed: { from?: unknown; nonce?: unknown } | undefined) =>
    typeof signed?.from === "string" && typeof signed.nonce === "string" ? [signed.from, signed.nonce] : undefined;
  const eip3009 = anchor(evm.authorization);
  if (eip3009) return [requirements.network, "eip3009", requirements.asset, ...eip3009].join(":").toLowerCase();
  const permit2 = anchor(evm.permit2Authorization);
  if (permit2) return [requirements.network, "permit2", ...permit2].join(":").toLowerCase();
  return undefined;
}

/**
 * When an `exact` EVM payment stops being collectable, in epoch milliseconds: an EIP-3009 authorization's `validBefore`
 * or a Permit2 permit's `deadline`, both signed. Undefined for any other payload.
 */
export function paymentExpiry(payload: PaymentPayload): number | undefined {
  const evm = payload.payload as Partial<ExactEIP3009Payload & ExactPermit2Payload>;
  const seconds = evm.authorization?.validBefore ?? evm.permit2Authorization?.deadline;
  return typeof seconds === "string" && /^\d+$/.test(seconds) ? Number(seconds) * 1000 : undefined;
}

/** What charging a service's route takes. */
export type Paywall = MiddlewareHandler<Gateway>;

// One server per isolate, built on first use because secrets and network access exist only inside a request.
let server: Promise<x402HTTPResourceServer> | undefined;

/** The x402 server for every available service's route, priced and listed from the catalog. */
function x402(env: Env): Promise<x402HTTPResourceServer> {
  server ??= build(env).catch((error: unknown) => {
    server = undefined;
    throw error;
  });
  return server;
}

function build(env: Env): Promise<x402HTTPResourceServer> {
  const development = env.X402_ENVIRONMENT === "development";
  return createX402Server({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    environment: development ? "development" : "production",
    payToConfig: { type: "address", evm: env.PAY_TO as `0x${string}` },
    routes: Object.fromEntries(
      services
        .filter((service) => service.available(env))
        .map((service) => [
          `POST ${service.path}`,
          {
            price: service.price(env),
            description: service.description,
            networks: [development ? "eip155:84532" : "eip155:8453"],
            maxTimeoutSeconds: service.paymentWindowSeconds,
            extensions: declareDiscoveryExtension({
              bodyType: "json",
              input: service.example.input,
              inputSchema: service.inputSchema,
              output: { example: service.example.output, schema: service.outputSchema },
            }),
          },
        ]),
    ),
  });
}

/**
 * Verifies the payment and hands it to the route as `payment`, collecting nothing: the job that the route starts
 * collects it once its result is delivered (`collect`).
 */
export const paywall: Paywall = async (c, next) => {
  const http = await x402(c.env);
  const adapter = new HonoAdapter(c);
  const result = await http.processHTTPRequest({
    adapter,
    path: c.req.path,
    method: c.req.method,
    paymentHeader: adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
  });
  if (result.type === "payment-error") {
    const { status, headers, body, isHtml } = result.response;
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    return isHtml ? c.html(String(body ?? ""), status as 402) : c.json(body ?? {}, status as 402);
  }
  if (result.type === "no-payment-required") return next();

  const id = paymentIdentity(result.paymentPayload, result.paymentRequirements);
  const expires = paymentExpiry(result.paymentPayload);
  if (!id || expires === undefined) {
    return c.json({ error: "unsupported_payment", message: "This payment can't be held until delivery. Nothing was charged." }, 400);
  }
  // Verification only asks that a payment be valid for a few more seconds, and the job is paid for at its end.
  if (expires < Date.now() + result.paymentRequirements.maxTimeoutSeconds * 1000 - CLOCK_SKEW_MS) {
    const message = `This payment expires before the job can finish. Sign it for ${result.paymentRequirements.maxTimeoutSeconds} seconds; nothing was charged.`;
    return c.json({ error: "payment_window_too_short", message }, 400);
  }
  c.set("payment", {
    id,
    expires,
    payload: result.paymentPayload,
    requirements: result.paymentRequirements,
    extensions: result.declaredExtensions ?? {},
  });
  await next();
  if (c.res.status >= 400) await result.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: c.res.status });
};

/**
 * Collects a held payment: the transaction that paid it and who paid, or why it was not paid. Throws when the
 * facilitator can't be reached.
 */
export async function collect(
  env: Env,
  held: HeldPayment,
): Promise<{ transaction: string; payer?: string } | { refused: string }> {
  const result = await (await x402(env)).processSettlement(held.payload, held.requirements, held.extensions);
  return result.success
    ? { transaction: result.transaction, payer: result.payer }
    : { refused: result.errorReason ?? "settlement failed" };
}
