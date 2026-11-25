import { gateway } from "./app";
import { paywall } from "./paywall";

export { Claim } from "./claims";
export { Job } from "./jobs";
export { Sales } from "./sales";

export default gateway(paywall);
