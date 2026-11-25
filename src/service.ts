import type { Context } from "hono";
import type { z } from "zod";
import { claimOn } from "./claims";
import type { HeldPayment } from "./paywall";

/** Where a job service runs. An empty `url` means the service is not configured. */
export interface Backend {
  url: string;
  token: string;
}

/** A request to the gateway; `payment` is set once the paywall has verified the buyer's payment. */
export type Gateway = { Bindings: Env; Variables: { payment?: HeldPayment } };
export type AppContext = Context<Gateway>;

/**
 * One thing for sale: a paid POST route, how it is listed, and what serves it. Every service is sold as a job: a paid
 * order answers at once with the job to poll, and the payment is collected only when the job delivers its result.
 * Buyers' clients wait only seconds for an answer (Coinbase's wallet, under 10), and a service's work takes longer.
 */
export interface Service {
  path: `/${string}`;
  title: string;
  /** Shown to buyers and indexed by the marketplace; 500 characters at most. */
  description: string;
  price(env: Env): string;
  /** A service whose backend is not configured is neither listed nor served. */
  available(env: Env): boolean;
  /** Whether it can serve now: directories keep a listing only while it can (`GET /healthz`). */
  healthy(env: Env): Promise<boolean>;
  example: { input: Record<string, unknown>; output: unknown };
  /**
   * JSON Schema for the request body, so an agent can build a valid call before paying. Like `outputSchema`, an object
   * schema's `properties` and `required` without its `type`, as x402's Bazaar extension takes them.
   */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the paid response, the shape of `example.output`, which directories rank listings on. */
  outputSchema: Record<string, unknown>;
  /** How long a buyer's signed payment can be collected, from when they sign it. It bounds the job. */
  paymentWindowSeconds: number;
  /** Any response of 400 or above cancels the payment, so the buyer is not charged for it. */
  serve(body: unknown, c: AppContext): Promise<Response>;
  /** For a job the gateway runs itself: the work, given the order's validated input. Its result is what is sold. */
  work?(input: unknown, env: Env): Promise<unknown>;
}

/** What a service says about itself. Its output is the job every service answers with (`jobStarted`). */
type Listing = Omit<Service, "serve" | "available" | "healthy" | "paymentWindowSeconds" | "work" | "example" | "outputSchema"> & {
  example: { input: Record<string, unknown> };
};

/** What a paid order answers with (202): the job to poll. The listed output of every service. */
const jobStarted = {
  example: {
    id: "3f2b6c1e-8a4d-4e0b-9c57-1d2a7f6b9e10",
    status: "running",
    status_url: "https://example.com/jobs/3f2b6c1e-8a4d-4e0b-9c57-1d2a7f6b9e10",
  },
  schema: {
    properties: {
      // No `format`s: Bazaar's validator does not know them, and warns on every start that it ignored them.
      id: { type: "string", description: "The job's id, a UUID; knowing it is the right to read the job" },
      status: {
        type: "string",
        enum: ["running", "done", "failed"],
        description: "running for a new job; a payment sent again answers with its job's current status",
      },
      status_url: { type: "string", description: "The URL to poll with GET for the finished result" },
    },
    required: ["id", "status", "status_url"],
    additionalProperties: false,
  },
};

/** How long a backend has to answer its health check. */
const HEALTH_TIMEOUT_MS = 5_000;
/**
 * How long a backend has to take or refuse a job: inside the seconds a buyer's client waits. A job it takes after this
 * finds its record gone and is never charged; the buyer can send the same payment again.
 */
const START_TIMEOUT_MS = 8_000;

/** Why a job the gateway runs itself failed, as its buyer should see it. Nothing is charged for it. */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A job that runs for minutes on a backend: the buyer signs a payment to start it, polls for the result, and is
 * charged only when the result is delivered. `paymentWindowSeconds` bounds the job: a result that arrives after it
 * can no longer be paid for, and is not released.
 */
export function job<I>(
  listing: Listing,
  input: z.ZodType<I>,
  backend: (env: Env) => Backend,
  paymentWindowSeconds: number,
): Service {
  return {
    ...listed(listing),
    available: (env) => backend(env).url !== "",
    healthy: (env) => backendHealthy(backend(env)),
    paymentWindowSeconds,
    serve: (body, c) =>
      parsed(input, body, c, (data) =>
        startJob(c, listing.path, (job) => handOff(c, { ...job, service: listing.path, backend: backend(c.env), input: data })),
      ),
  };
}

/**
 * A job the gateway runs itself: bought, polled and charged exactly as a backend's job is, with `work` run by the job's
 * record. A `ServiceError` it throws reaches the buyer as the job's failure; any other error, as a generic one.
 */
export function task<I>(
  listing: Listing,
  input: z.ZodType<I>,
  work: (input: I, env: Env) => Promise<unknown>,
  paymentWindowSeconds: number,
): Service {
  return {
    ...listed(listing),
    available: () => true,
    // Run by the gateway itself, so it is up whenever the gateway answers.
    healthy: async () => true,
    paymentWindowSeconds,
    serve: (body, c) =>
      parsed(input, body, c, (data) =>
        startJob(c, listing.path, async ({ id, payment }) => {
          await c.env.JOBS.get(c.env.JOBS.idFromName(id)).open({ id, service: listing.path, payment, input: data });
          return answerJob(c, id, "running");
        }),
      ),
    // The input was validated by `input` when the job was ordered.
    work: (data, env) => work(data as I, env),
  };
}

/** A listing with the output every service is sold with: the job to poll. */
function listed(listing: Listing): Pick<Service, keyof Listing | "outputSchema"> {
  return { ...listing, example: { ...listing.example, output: jobStarted.example }, outputSchema: jobStarted.schema };
}

function parsed<I>(
  input: z.ZodType<I>,
  body: unknown,
  c: AppContext,
  then: (data: I) => Promise<Response>,
): Promise<Response> {
  const result = input.safeParse(body);
  if (!result.success) {
    return Promise.resolve(c.json({ error: "invalid_request", issues: result.error.issues }, 400));
  }
  return then(result.data);
}

/**
 * Starts the one job a held payment buys, with `begin`, and answers as `begin` does: 202 with where to poll once the
 * job runs. The same payment sent again, however its unsigned fields are changed, answers with the job it already
 * bought and starts nothing. A job that does not start leaves the payment unspent, so the buyer can use it again.
 */
async function startJob(
  c: AppContext,
  service: string,
  begin: (job: { id: string; payment: HeldPayment }) => Promise<Response>,
): Promise<Response> {
  const payment = c.get("payment");
  if (!payment) throw new Error(`${service} is sold as a job, so its route must hold the payment first`);
  const id = crypto.randomUUID();
  const claim = claimOn(c.env, payment.id);
  const holder = await claim.claim(id, Date.now() + payment.requirements.maxTimeoutSeconds * 1000);
  if (holder !== id) return alreadyBought(c, holder);

  const answer = await begin({ id, payment }).catch(async (error: unknown) => {
    await claim.release(id);
    throw error;
  });
  if (answer.status !== 202) await claim.release(id);
  return answer;
}

/** Where a job is polled. */
function statusUrl(c: AppContext, id: string): string {
  return new URL(`/jobs/${id}`, c.req.url).href;
}

/** A paid order's answer (`jobStarted`): the job, its status and where to poll it. */
function answerJob(c: AppContext, id: string, status: string): Response {
  return c.json({ id, status, status_url: statusUrl(c, id) }, 202);
}

/** The job a payment already bought, for an order that sends that payment again. */
async function alreadyBought(c: AppContext, id: string): Promise<Response> {
  const job = await c.env.JOBS.get(c.env.JOBS.idFromName(id)).view();
  if (!job) return c.json({ error: "payment_used", message: "This payment was already used." }, 409);
  return answerJob(c, id, job.status);
}

/**
 * Hands a job to its backend: 202 once the backend queues it.
 *
 * The backend receives `{ id, input, callback: { url, token } }` with the service's bearer token,
 * and later POSTs an `Outcome` to `callback.url` with `callback.token` as its bearer token.
 * A backend that refuses the job answers 422 with `{ error, message }`, which reaches the buyer
 * unchanged and uncharged. Any other answer, or none in time, is the service being unavailable.
 */
async function handOff(
  c: AppContext,
  { id, service, backend, input, payment }: { id: string; service: string; backend: Backend; input: unknown; payment: HeldPayment },
): Promise<Response> {
  const token = crypto.randomUUID();
  const record = c.env.JOBS.get(c.env.JOBS.idFromName(id));

  await record.open({ id, service, token, payment });
  const accepted = await fetch(new URL("jobs", withTrailingSlash(backend.url)), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${backend.token}` },
    body: JSON.stringify({ id, input, callback: { url: `${statusUrl(c, id)}/outcome`, token } }),
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ message: "backend unreachable", service, job: id, error: String(error) }));
    return undefined;
  });

  if (accepted?.ok) {
    await accepted.body?.cancel();
    return answerJob(c, id, "running");
  }
  if (accepted?.status === 422) {
    const refusal = await accepted.text();
    await record.refuse(refusalCode(refusal) ?? "refused");
    return new Response(refusal, { status: 422, headers: { "content-type": "application/json" } });
  }
  if (accepted) {
    await accepted.body?.cancel();
    console.error(JSON.stringify({ message: "backend failed to start job", service, job: id, status: accepted.status }));
  }
  await record.refuse("service_unavailable");
  return c.json({ error: "service_unavailable", message: "The service could not start this job. Retry shortly." }, 503);
}

/** The `error` code of a backend's refusal (`{ error, message }`), when it has one. */
function refusalCode(body: string): string | undefined {
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a backend answers its `GET /healthz` with `{ "ok": true }` in time. */
async function backendHealthy(backend: Backend): Promise<boolean> {
  const answer = await fetch(new URL("healthz", withTrailingSlash(backend.url)), {
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  }).catch(() => undefined);
  if (!answer?.ok) return false;
  const body = await answer.json<{ ok?: unknown }>().catch(() => undefined);
  return body?.ok === true;
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
