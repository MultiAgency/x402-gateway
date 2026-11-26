import { job } from "../service";
import { PullRequestInput, pullRequestListing } from "./pull-request";

export const multiReview = job(
  {
    ...pullRequestListing,
    path: "/multi-review",
    title: "Multi Review",
    description:
      "In-depth AI review of a public GitHub pull request. An agent checks out the repository, reads the " +
      "change in context, follows the repository's own review rules, and verifies each finding before " +
      "reporting it. Returns a job to poll; the finished review lists findings with file, line, severity " +
      "and a suggested fix. Takes several minutes. Charged only when the review is delivered.",
    price: (env) => env.MULTI_REVIEW_PRICE,
    result: {
      // As Multi Review delivers it: `ReportData` in MultiAgency/code-review, src/report.ts.
      schema: {
        type: "object",
        properties: {
          head: { type: "string", description: "The commit that was reviewed" },
          summary: { type: "string" },
          verification: {
            type: "string",
            enum: ["verified", "unverified", "skipped"],
            description: "Whether a second pass checked every finding",
          },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "integer" },
                severity: { type: "string", enum: ["high", "medium", "low"] },
                category: {
                  type: "string",
                  enum: [
                    "correctness",
                    "security",
                    "concurrency",
                    "memory_safety",
                    "compatibility",
                    "resource_leak",
                    "error_handling",
                    "performance",
                    "other",
                  ],
                },
                title: { type: "string" },
                body: { type: "string" },
                existing_code: { type: "string", description: "The code the finding is about, as it is" },
                suggestion: { type: "string" },
                fix_code: { type: "string", description: "Replacement for existing_code, when the fix is that exact" },
              },
              required: ["file", "line", "severity", "category", "title", "body", "existing_code"],
            },
          },
          checked: { type: "array", items: { type: "string" }, description: "What the review says it traced" },
          skipped: { type: "integer", description: "Changed files left out: lockfiles, build output, vendored code" },
        },
        required: ["head", "summary", "verification", "findings", "checked", "skipped"],
      },
      example: {
        head: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
        summary: "Adds a loop that sums cart prices; it reads one item past the end.",
        verification: "verified",
        findings: [
          {
            file: "src/cart.js",
            line: 3,
            severity: "high",
            category: "correctness",
            title: "Loop reads past the end of items",
            body: "`i <= items.length` reads `items[items.length]`, which is undefined, so `.price` throws.",
            existing_code: "for (let i = 0; i <= items.length; i++) sum += items[i].price;",
            fix_code: "for (let i = 0; i < items.length; i++) sum += items[i].price;",
          },
        ],
        checked: ["total() loop bounds", "callers of total()"],
        skipped: 0,
      },
    },
  },
  PullRequestInput,
  (env) => ({ url: env.MULTI_REVIEW_URL, token: env.MULTI_REVIEW_TOKEN }),
  60 * 60,
);
