import type { Service } from "./service";
import { multiReview } from "./services/multi-review";
import { privateInvestigator } from "./services/private-investigator";
import { snippetReview } from "./services/snippet-review";

/** Everything this gateway can sell. Adding a service means adding it here. */
export const services: readonly Service[] = [snippetReview, privateInvestigator, multiReview];
