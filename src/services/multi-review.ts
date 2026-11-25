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
  },
  PullRequestInput,
  (env) => ({ url: env.MULTI_REVIEW_URL, token: env.MULTI_REVIEW_TOKEN }),
  60 * 60,
);
