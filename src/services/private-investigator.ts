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
  },
  PullRequestInput,
  (env) => ({ url: env.PRIVATE_INVESTIGATOR_URL, token: env.PRIVATE_INVESTIGATOR_TOKEN }),
  // Two attempts of 15 minutes each (purchase/purchase.mjs in MultiAgency/private-ai), plus time in its queue.
  60 * 60,
);
