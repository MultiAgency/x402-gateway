#!/usr/bin/env node
// Buys from a running gateway on Base Sepolia, as a real buyer does, and checks that each way an order can end charges
// what it should: a delivered result once, everything else nothing. Pays only on Base Sepolia (eip155:84532).
//
// Before running:
//   1. A throwaway buyer wallet holding a few Base Sepolia USDC (https://faucet.circle.com); no ETH, since the
//      facilitator pays the gas. Its private key goes in BUYER_PRIVATE_KEY.
//   2. gateway/.dev.vars, which overrides wrangler.jsonc's vars under `wrangler dev`:
//        X402_ENVIRONMENT=development
//        CDP_API_KEY_ID=...            CDP_API_KEY_SECRET=...      (a real CDP key: the facilitator verifies and settles)
//        NEARAI_API_KEY=...            SALES_TOKEN=any-local-token
//        MULTI_REVIEW_URL=http://localhost:8080            MULTI_REVIEW_TOKEN=local-multi-review
//        PRIVATE_INVESTIGATOR_URL=http://localhost:8081    PRIVATE_INVESTIGATOR_TOKEN=local-private-investigator
//   3. The gateway: `npm run dev` in gateway/ (http://localhost:8787).
//   4. The backends, each with PURCHASE_GATEWAY=http://localhost:8787 and the matching PURCHASE_TOKEN:
//        code-review:  PORT=8080 PURCHASE_TOKEN=local-multi-review PURCHASE_ANTHROPIC_API_KEY=... GITHUB_TOKEN=... npm run dev
//        private-ai:   PORT=8081 PURCHASE_TOKEN=local-private-investigator NEARAI_API_KEY=... GITHUB_TOKEN=... \
//                      node purchase/server.mjs
//      A backend left out is skipped: an empty *_URL leaves its service unlisted.
//
// Run from gateway/:
//   BUYER_PRIVATE_KEY=0x... OPEN_PR=https://github.com/<owner>/<repo>/pull/<n> CLOSED_PR=https://github.com/... \
//   SALES_TOKEN=any-local-token node scripts/testnet-run.mjs [listing|unpaid|short|refused|snippet|private-investigator|multi-review|sales|all]
//
// OPEN_PR should be a small open pull request in a public repository; CLOSED_PR a closed one.

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const GATEWAY = process.env.GATEWAY ?? "http://localhost:8787";
const NETWORK = "eip155:84532";
const POLL_MS = 15_000;

const account = privateKeyToAccount(required("BUYER_PRIVATE_KEY"));
// With x402's default spend controls, as most buyers have them: no single payment over $1.
const buyer = new x402HTTPClient(new x402Client().register("eip155:*", new ExactEvmScheme(account)));
const chain = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL) });

const SNIPPET = {
  code: "function total(items) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) sum += items[i].price;\n  return sum;\n}",
  language: "javascript",
};

const scenarios = {
  async listing() {
    const listed = await (await fetch(GATEWAY)).json();
    const paths = listed.services.map((service) => new URL(service.url).pathname);
    check(paths.includes("/snippet-review"), `lists ${paths.join(", ")}`);
  },

  async unpaid() {
    const challenge = await order("/snippet-review", SNIPPET);
    check(challenge.status === 402, `an unpaid order is challenged (${challenge.status})`);
    check(requirementsOf(challenge).network === NETWORK, `on ${NETWORK}`);
  },

  async short() {
    const before = await balance();
    const answer = await order("/snippet-review", SNIPPET, await payExpiringIn(await order("/snippet-review", SNIPPET), 30));
    const body = await answer.json();
    check(answer.status === 400 && body.error === "payment_window_too_short", `a 30-second payment is refused (${answer.status} ${body.error})`);
    check((await balance()) === before, "and nothing is charged");
  },

  async refused() {
    const closed = { pull_request: required("CLOSED_PR") };
    const paths = await jobServices();
    check(paths.length > 0, `job services listed: ${paths.join(", ") || "none (set their *_URL)"}`);
    for (const path of paths) {
      const before = await balance();
      const answer = await order(path, closed, await paymentFor(path, closed));
      const body = await answer.json();
      check(answer.status === 422, `${path}: a closed pull request is refused (${answer.status} ${body.error})`);
      check((await balance()) === before, `${path}: and nothing is charged`);
    }
  },

  snippet: () => delivered("/snippet-review", SNIPPET),
  "private-investigator": () => deliveredIfListed("/private-investigator"),
  "multi-review": () => deliveredIfListed("/multi-review"),

  async sales() {
    const answer = await fetch(new URL("/sales", GATEWAY), { headers: { authorization: `Bearer ${required("SALES_TOKEN")}` } });
    check(answer.ok, `the sales record answers (${answer.status})`);
    console.table((await answer.json()).sales);
  },
};

/** Orders, pays, polls to the end, and checks the result came with the one transaction that took the price. */
async function delivered(path, body) {
  const before = await balance();
  const payment = await paymentFor(path, body);
  const price = BigInt(JSON.parse(atob(Object.values(payment)[0])).accepted.amount);
  const started = await order(path, body, payment);
  const job = await started.json();
  check(started.status === 202, `${path}: the paid order starts job ${job.id} (${started.status})`);
  if (started.status !== 202) return;

  const again = await (await order(path, body, payment)).json();
  check(again.id === job.id, `${path}: the same payment sent again answers with the same job`);

  const done = await poll(job.status_url);
  check(done.status === "done" && done.transaction, `${path}: ends ${done.status}${done.reason ? ` (${done.reason})` : ""}`);
  if (done.status !== "done") return check((await balance()) === before, `${path}: and nothing is charged`);

  await chain.waitForTransactionReceipt({ hash: done.transaction });
  check(before - (await balance()) === price, `${path}: charged ${price} units once, in ${done.transaction}`);
  console.log(JSON.stringify(done.result, null, 2).slice(0, 1500));
}

async function deliveredIfListed(path) {
  if (!(await jobServices()).includes(path)) return console.log(`- ${path}: not listed (its *_URL is empty), skipped`);
  return delivered(path, { pull_request: required("OPEN_PR") });
}

async function jobServices() {
  const listed = await (await fetch(GATEWAY)).json();
  return listed.services.map((service) => new URL(service.url).pathname).filter((path) => path !== "/snippet-review");
}

function order(path, body, headers = {}) {
  return fetch(new URL(path, GATEWAY), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function paymentFor(path, body) {
  return pay(await order(path, body));
}

async function pay(challenge) {
  if (requirementsOf(challenge).network !== NETWORK) throw new Error(`refusing to pay on ${requirementsOf(challenge).network}`);
  const required = buyer.getPaymentRequiredResponse((name) => challenge.headers.get(name), await challenge.clone().json().catch(() => undefined));
  return buyer.encodePaymentSignatureHeader(await buyer.createPaymentPayload(required));
}

/** A payment signed to expire `seconds` from now, sent as if it accepted the route's own window. */
async function payExpiringIn(challenge, seconds) {
  const required = JSON.parse(atob(challenge.headers.get("payment-required")));
  const window = required.accepts[0].maxTimeoutSeconds;
  for (const accepted of required.accepts) accepted.maxTimeoutSeconds = seconds;
  const headers = new Headers(challenge.headers);
  headers.set("payment-required", btoa(JSON.stringify(required)));
  const signed = await pay(new Response(await challenge.text(), { status: challenge.status, headers }));
  return Object.fromEntries(
    Object.entries(signed).map(([name, value]) => {
      const payload = JSON.parse(atob(value));
      payload.accepted.maxTimeoutSeconds = window;
      return [name, btoa(JSON.stringify(payload))];
    }),
  );
}

function requirementsOf(challenge) {
  return JSON.parse(atob(challenge.headers.get("payment-required"))).accepts[0];
}

let asset;
async function balance() {
  asset ??= requirementsOf(await order("/snippet-review", SNIPPET)).asset;
  return chain.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
}

async function poll(statusUrl) {
  for (;;) {
    const job = await (await fetch(statusUrl)).json();
    if (job.status !== "running") return job;
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

let failures = 0;
function check(ok, what) {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${what}`);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const chosen = process.argv[2] ?? "all";
const names = chosen === "all" ? Object.keys(scenarios) : [chosen];
console.log(`buyer ${account.address} on ${GATEWAY}`);
for (const name of names) {
  if (!scenarios[name]) throw new Error(`no scenario ${name}: one of ${Object.keys(scenarios).join(", ")}, all`);
  console.log(`\n# ${name}`);
  await scenarios[name]();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
