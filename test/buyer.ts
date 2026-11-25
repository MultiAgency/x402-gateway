// A buyer's side of x402: reads a 402 challenge and signs a real payment for it with a throwaway key.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(generatePrivateKey());
const buyer = new x402HTTPClient(new x402Client().register("eip155:*", new ExactEvmScheme(account)));

/**
 * The same payment with its payload changed by `change`, as a buyer can change it: the signature covers only the
 * authorization, so anything else can be altered and the payment still verifies.
 */
export function retouched(headers: Record<string, string>, change: (payload: Record<string, unknown>) => void): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      const payload = JSON.parse(atob(value)) as Record<string, unknown>;
      change(payload);
      return [name, btoa(JSON.stringify(payload))];
    }),
  );
}

/**
 * A payment signed to expire `seconds` from now, sent as if it accepted `challenge` unchanged: the signature covers
 * only the authorization, so the requirements a payload says it accepts are the buyer's to state.
 */
export async function payExpiringIn(challenge: Response, seconds: number): Promise<Record<string, string>> {
  const required = JSON.parse(atob(challenge.headers.get("payment-required")!)) as { accepts: { maxTimeoutSeconds: number }[] };
  const window = required.accepts[0]!.maxTimeoutSeconds;
  for (const accepted of required.accepts) accepted.maxTimeoutSeconds = seconds;
  const headers = new Headers(challenge.headers);
  headers.set("payment-required", btoa(JSON.stringify(required)));
  const signed = await pay(new Response(await challenge.text(), { status: challenge.status, headers }));
  return retouched(signed, (payload) => {
    (payload.accepted as { maxTimeoutSeconds: number }).maxTimeoutSeconds = window;
  });
}

/** The headers that pay for the request `challenge` (a 402 response) asked payment for. */
export async function pay(challenge: Response): Promise<Record<string, string>> {
  const body = await challenge.clone().json().catch(() => undefined);
  const required = buyer.getPaymentRequiredResponse((name) => challenge.headers.get(name), body);
  return buyer.encodePaymentSignatureHeader(await buyer.createPaymentPayload(required));
}
