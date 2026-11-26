import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { services } from "./catalog";
import { jobById, Outcome } from "./jobs";
import { openApiDocument } from "./openapi";
import type { Paywall } from "./paywall";
import { sales } from "./sales";
import type { Gateway } from "./service";

const MAX_OUTCOME_BYTES = 1024 * 1024;

/** The gateway's routes, with `paywall` holding the payment for each service's job until the job delivers. */
export function gateway(paywall: Paywall): Hono<Gateway> {
  const app = new Hono<Gateway>();

  app.get("/", (c) =>
    c.json({
      protocol: "x402",
      services: services
        .filter((service) => service.available(c.env))
        .map((service) => ({
          title: service.title,
          description: service.description,
          method: "POST",
          url: new URL(service.path, c.req.url).href,
          price: `${service.price(c.env)} USDC`,
        })),
    }),
  );

  // The listed services as OpenAPI, for directories that read each route's inputs and outputs (Circle's).
  app.get("/openapi.json", (c) =>
    c.json(openApiDocument(services.filter((service) => service.available(c.env)), c.env, new URL(c.req.url).origin)),
  );

  // Whether every listed service can serve now: 503 when one can't, for uptime monitors. Says nothing more about a
  // backend than whether it is up.
  app.get("/healthz", async (c) => {
    const listed = services.filter((service) => service.available(c.env));
    const health = await Promise.all(listed.map(async (service) => [service.path, await service.healthy(c.env)] as const));
    const ok = health.every(([, healthy]) => healthy);
    return c.json({ ok, services: Object.fromEntries(health) }, ok ? 200 : 503);
  });

  // A job's id is unguessable and is handed only to its buyer, so knowing it is the right to read it.
  app.get("/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const job = await jobById(c.env, id)?.view();
    return job ? c.json({ id, ...job }) : c.json({ error: "not_found" }, 404);
  });

  // Called by the backend that ran the job, with the token it was given when the job started.
  const outcomeLimit = bodyLimit({ maxSize: MAX_OUTCOME_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) });
  app.post("/jobs/:id/outcome", outcomeLimit, async (c) => {
    const token = bearer(c.req.header("authorization"));
    const job = jobById(c.env, c.req.param("id"));
    if (!token || !job) return c.json({ error: "not_found" }, 404);
    const outcome = Outcome.safeParse(await c.req.json().catch(() => undefined));
    if (!outcome.success) return c.json({ error: "invalid_request", issues: outcome.error.issues }, 400);

    const recorded = await job.finish(token, outcome.data);
    if (recorded === "missing") return c.json({ error: "not_found" }, 404);
    if (recorded === "unauthorized") return c.json({ error: "unauthorized" }, 401);
    return c.body(null, 204);
  });

  // How every job ended, per service, channel and outcome: business data, so only for the holder of SALES_TOKEN.
  app.get("/sales", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!token || !(await sameSecret(token, c.env.SALES_TOKEN))) return c.json({ error: "unauthorized" }, 401);
    return c.json({ sales: await sales(c.env).summary() });
  });

  // Input is validated after the paywall so an unpaid probe always sees the 402 challenge.
  for (const service of services) {
    app.post(service.path, paywall, async (c) => {
      if (!service.available(c.env)) return c.notFound();
      return service.serve(await c.req.json().catch(() => undefined), c);
    });
  }

  app.onError((error, c) => {
    console.error(JSON.stringify({ message: "request failed", path: c.req.path, error: String(error) }));
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

/** The token of an `Authorization: Bearer <token>` header, if it is one. */
function bearer(header: string | undefined): string | undefined {
  return /^Bearer (.+)$/.exec(header ?? "")?.[1];
}

/** Compares two secrets in constant time, by their digests so their lengths don't show. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return crypto.subtle.timingSafeEqual(await digest(given), await digest(expected));
}
