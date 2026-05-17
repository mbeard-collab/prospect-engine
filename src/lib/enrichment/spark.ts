import "server-only";
import type { SignalProvider } from "./types";

// Real Spark integration depends on GovSpend's internal Spark API surface,
// which isn't documented in the spec. Scaffolded as a stub — wire in when
// the API contract and key are available. For now the mock provider is used.
export function createSparkProvider(apiKey: string): SignalProvider {
  void apiKey;
  return {
    name: "spark",
    async fetchSignal() {
      throw new Error(
        "Spark client not yet implemented — provide API contract docs to wire it in",
      );
    },
  };
}
