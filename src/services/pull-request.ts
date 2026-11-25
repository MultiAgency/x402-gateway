import { z } from "zod";

const PULL_REQUEST = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;

/** A request naming one GitHub pull request by URL, as review backends take it: `{ repo, pr }`. */
export const PullRequestInput = z
  .object({ pull_request: z.string().trim().regex(PULL_REQUEST, "must be a GitHub pull request URL") })
  .transform(({ pull_request }) => {
    const [, repo, number] = PULL_REQUEST.exec(pull_request)!;
    return { repo, pr: Number(number) };
  });

/** What a pull request review is ordered with. */
export const pullRequestListing = {
  example: {
    input: { pull_request: "https://github.com/octocat/Hello-World/pull/1" },
  },
  inputSchema: {
    properties: {
      pull_request: {
        type: "string",
        description: "URL of an open pull request in a public GitHub repository",
      },
    },
    required: ["pull_request"],
  },
};
