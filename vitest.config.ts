import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A file's first request starts the Worker, which takes seconds on a busy machine; Vitest's 5 s default then fails
    // whichever test happens to make it. No test waits on purpose: the network is faked.
    testTimeout: 30_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Tests charge on Base Sepolia through a fake facilitator (test/network.ts); nothing leaves the process.
        bindings: {
          X402_ENVIRONMENT: "development",
          CDP_API_KEY_ID: "test-key",
          // A throwaway Ed25519 key in the SDK's format, used only to sign JWTs the fake facilitator ignores.
          CDP_API_KEY_SECRET: "rRBX7RnAH1bxAkGxgsMsyluXrp+KTLZZX4ymYx/EgUjS8hnzGvMTaqYkj2izEdiZ7egeMJA4uUzfJx9Es6koFQ==",
          NEARAI_API_KEY: "test-nearai",
          MULTI_REVIEW_URL: "https://multi-review.test",
          MULTI_REVIEW_TOKEN: "multi-review-token",
          PRIVATE_INVESTIGATOR_URL: "https://private-investigator.test",
          PRIVATE_INVESTIGATOR_TOKEN: "private-investigator-token",
          SALES_TOKEN: "sales-token",
          // Long enough for a backend that wakes after a few health checks; short enough that one that never does
          // fails its test quickly.
          BACKEND_WAKE_SECONDS: "1",
        },
      },
    }),
  ],
});
