// The gateway described as OpenAPI 3.0, generated from the catalog on each request, so it describes what is for sale and
// nothing else. Directories such as Circle's Agent Marketplace read it for each route's inputs and outputs. What a route
// costs, on which network and to whom is not here: the route's 402 challenge says that, for every payment it accepts.
import type { Service } from "./service";

/** A catalog schema fragment (`properties`, `required`), as x402's Bazaar extension takes it, as an object schema. */
export function objectSchema(fragment: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", ...fragment };
}

const ERROR = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
  required: ["error"],
};

/** A JSON response with its schema and, when there is one, an example. */
function json(description: string, schema: object, example?: unknown) {
  return { description, content: { "application/json": { schema, ...(example === undefined ? {} : { example }) } } };
}

/** The component name of a service's result: `Multi Review` → `MultiReviewResult`. */
function resultName(service: Service): string {
  return `${service.title.replaceAll(" ", "")}Result`;
}

export function openApiDocument(listed: readonly Service[], env: Env, origin: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const service of listed) {
    paths[service.path] = {
      post: {
        operationId: service.path.slice(1).replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()),
        summary: service.title,
        description: `${service.description} Price: ${service.price(env)} USDC; the 402 challenge says how to pay it.`,
        requestBody: {
          required: true,
          content: { "application/json": { schema: objectSchema(service.inputSchema), example: service.example.input } },
        },
        responses: {
          "202": json(
            `Paid: the job, to poll at its status_url. The result, ${resultName(service)}, comes when the job is done.`,
            objectSchema(service.outputSchema),
            service.example.output,
          ),
          "400": json("The order is not one this service takes, or the payment is not valid. Nothing is charged.", ERROR),
          "402": {
            description:
              "Payment required. The PAYMENT-REQUIRED header (base64 JSON, x402 version 2) lists the payments accepted.",
            headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } } },
          },
          "409": json("This payment was already used. Nothing more is charged.", ERROR),
          "422": json("The service refuses this order, saying why. Nothing is charged.", ERROR),
          "503": json("The service cannot take orders now. Nothing is charged; retry shortly.", ERROR),
        },
      },
    };
  }

  paths["/jobs/{id}"] = {
    get: {
      operationId: "getJob",
      summary: "A job's status, and its result once delivered",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      responses: {
        "200": json("The job: running, failed, or done with the result it was paid for.", {
          oneOf: [
            { $ref: "#/components/schemas/RunningJob" },
            { $ref: "#/components/schemas/FailedJob" },
            ...listed.map((service) => ({ $ref: `#/components/schemas/${resultName(service)}Job` })),
          ],
        }),
        "404": json("No such job.", ERROR),
      },
    },
  };

  const job = { service: { type: "string" }, created: { type: "string", format: "date-time" } };
  const schemas: Record<string, unknown> = {
    RunningJob: {
      type: "object",
      properties: { ...job, status: { type: "string", enum: ["running"] } },
      required: ["service", "created", "status"],
    },
    FailedJob: {
      type: "object",
      properties: { ...job, status: { type: "string", enum: ["failed"] }, reason: { type: "string" }, message: { type: "string" } },
      required: ["service", "created", "status", "reason"],
    },
  };
  for (const service of listed) {
    schemas[resultName(service)] = service.result.schema;
    schemas[`${resultName(service)}Job`] = {
      type: "object",
      properties: {
        ...job,
        service: { type: "string", enum: [service.path] },
        status: { type: "string", enum: ["done"] },
        result: { $ref: `#/components/schemas/${resultName(service)}` },
        transaction: { type: "string", description: "The transaction that collected the payment" },
      },
      required: ["service", "created", "status", "result", "transaction"],
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "MultiAgency x402 gateway",
      version: "1",
      description:
        "Code reviews sold per job over x402: pay with the signed payment a route's 402 challenge asks for, poll the " +
        "job, and receive the result. The payment is collected only when the result is delivered.",
    },
    servers: [{ url: origin }],
    // No route takes a login: a paid one takes the payment its 402 challenge asks for, in the request's headers.
    security: [],
    paths,
    components: { schemas },
  };
}
