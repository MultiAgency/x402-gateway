import { job } from "../service";
import { PullRequestInput, pullRequestListing } from "./pull-request";

export const privateInvestigator = job(
  {
    ...pullRequestListing,
    path: "/private-investigator",
    title: "Private Investigator",
    description:
      "AI review of a public GitHub pull request by a model running in an attested hardware enclave, with " +
      "a receipt anyone can verify. The model reads the diff and the head commit, and every reply it gives " +
      "is signed by its enclave. Returns a job to poll; the finished review lists findings with file, line " +
      "and severity, plus the receipt and its hash. Takes a few minutes. Charged only when the review is " +
      "delivered.",
    price: (env) => env.PRIVATE_INVESTIGATOR_PRICE,
    result: {
      // As Private Investigator delivers it: `purchasedReview` in MultiAgency/private-ai, purchase/purchase.mjs.
      schema: {
        type: "object",
        properties: {
          head: { type: "string", description: "The commit that was reviewed" },
          model: { type: "string" },
          summary: { type: "string" },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                line: { type: "integer" },
                pass: { type: "string" },
                severity: { type: "string" },
                body: { type: "string" },
              },
              required: ["path", "line", "severity", "body"],
            },
          },
          note: { type: "string", description: "What the review does and does not establish" },
          receipt: { type: "string", description: "The enclave-signed receipt, as exact JSON text" },
          receipt_sha256: { type: "string", description: "SHA-256 of receipt, to check one against the other" },
          checker: { type: "string", description: "Where to verify the receipt" },
        },
        required: ["head", "model", "summary", "findings", "receipt", "receipt_sha256"],
      },
      example: {
        head: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
        model: "claude-opus-5-5",
        summary: "Adds a loop that sums cart prices; it reads one item past the end.",
        findings: [
          {
            path: "src/cart.js",
            line: 3,
            pass: "Bugs",
            severity: "high",
            body: "`i <= items.length` reads one item past the end, so `.price` throws.",
          },
        ],
        note: "The receipt shows which model reviewed which commit; it does not show the review is right.",
        receipt: '{"subject":{"head_sha":"7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"},"model":"claude-opus-5-5"}',
        receipt_sha256: "4c1fd3a8e0b6c5d2f9a7e1b3c5d7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3",
        checker: "https://private-investigator.example/verify",
      },
    },
  },
  PullRequestInput,
  (env) => ({ url: env.PRIVATE_INVESTIGATOR_URL, token: env.PRIVATE_INVESTIGATOR_TOKEN }),
  // Two attempts of 15 minutes each (purchase/purchase.mjs in MultiAgency/private-ai), plus time in its queue.
  60 * 60,
);
