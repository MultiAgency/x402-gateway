import Ajv from "ajv";
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { services } from "../src/catalog";

type Media = { schema: object; example: unknown };
type Operation = {
  requestBody?: { content: { "application/json": Media } };
  responses: Record<string, { content?: { "application/json": Media } }>;
};
type Document = {
  openapi: string;
  security: unknown[];
  servers: { url: string }[];
  paths: Record<string, { post?: Operation; get?: Operation }>;
  components: { schemas: Record<string, object> };
};

async function openApi(): Promise<Document> {
  const answer = await exports.default.fetch("https://gateway.test/openapi.json");
  expect(answer.status).toBe(200);
  return answer.json();
}

// OpenAPI 3.0's schema dialect has a few keywords of its own (`nullable`); Ajv need not know them to check an example.
const ajv = new Ajv({ strict: false });

test("the OpenAPI document lists every service for sale, with the order it takes and the job it answers", async () => {
  const document = await openApi();
  expect(document.openapi).toBe("3.0.3");
  expect(document.servers).toEqual([{ url: "https://gateway.test" }]);
  // No route takes a login: a paid one takes the payment its 402 challenge asks for.
  expect(document.security).toEqual([]);
  for (const service of services) {
    const sale = document.paths[service.path]!.post!;
    const order = sale.requestBody!.content["application/json"];
    expect(ajv.validate(order.schema, order.example), `${service.path} order`).toBe(true);
    const job = sale.responses["202"]!.content!["application/json"];
    expect(ajv.validate(job.schema, job.example), `${service.path} job`).toBe(true);
    expect(Object.keys(sale.responses)).toEqual(expect.arrayContaining(["202", "400", "402", "409", "422", "503"]));
  }
});

test("what each service finally delivers is described, and its example fits the description", async () => {
  const { components, paths } = await openApi();
  for (const service of services) {
    const schema = components.schemas[`${service.title.replaceAll(" ", "")}Result`]!;
    expect(ajv.validate(schema, service.result.example), `${service.path} result`).toBe(true);
    expect(Object.keys((schema as { properties: object }).properties).length).toBeGreaterThan(0);
  }
  // Polling a job: running, failed, or done with one of the services' results.
  expect(paths["/jobs/{id}"]!.get!.responses["200"]).toBeDefined();
});

test("Multi Review's result is described with the fields Multi Review delivers", async () => {
  const { components } = await openApi();
  const result = components.schemas.MultiReviewResult as { properties: Record<string, unknown>; required: string[] };
  expect(Object.keys(result.properties).sort()).toEqual(["checked", "findings", "head", "skipped", "summary", "verification"]);
});
