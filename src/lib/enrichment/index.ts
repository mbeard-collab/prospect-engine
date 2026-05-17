import "server-only";
import { createAnthropicWebSearchContactsProvider } from "./anthropic-web-search-contacts";
import {
  createAnthropicCompetitorProvider,
  createNullCompetitorProvider,
} from "./competitors";
import { createMockContactProvider, createMockSignalProvider } from "./mock";
import { createSparkMcpProvider } from "./spark-mcp";
import { createWebSearchContactsProvider } from "./web-search-contacts";
import { createZoomInfoMcpProvider } from "./zoominfo-mcp";
import { createZoomInfoRestProvider } from "./zoominfo-rest";
import type {
  CompetitorProvider,
  ContactProvider,
  SignalProvider,
} from "./types";

// Compose multiple ContactProviders into a single fallback chain. The first
// provider that returns at least 1 contact wins; we stop there. Name is the
// combined chain (used to display "Sources tried" in the UI). Returned
// contacts are tagged with the winning provider's name so the DB row's
// `source` field tells you which path actually produced the contact.
function chainContactProviders(...providers: ContactProvider[]): ContactProvider {
  if (providers.length === 1) {
    const p = providers[0];
    return {
      name: p.name,
      async fetchContacts(input) {
        const out = await p.fetchContacts(input);
        return out.map((c) => ({ ...c, source: c.source ?? p.name }));
      },
    };
  }
  return {
    name: providers.map((p) => p.name).join(" → "),
    async fetchContacts(input) {
      for (const p of providers) {
        try {
          const out = await p.fetchContacts(input);
          if (out.length > 0) {
            return out.map((c) => ({ ...c, source: c.source ?? p.name }));
          }
        } catch (e) {
          console.error(
            `Contact provider "${p.name}" threw for ${input.companyName}; trying next.`,
            e,
          );
        }
      }
      return [];
    },
  };
}

export type {
  CompetitorProvider,
  ContactProvider,
  ContactTier,
  EnrichedCompetitors,
  EnrichedContact,
  EnrichedSignal,
  SignalProvider,
  SignalType,
} from "./types";

let contactCached: ContactProvider | null = null;
let signalCached: SignalProvider | null = null;
let competitorCached: CompetitorProvider | null = null;

export function getContactProvider(): ContactProvider {
  if (contactCached) return contactCached;

  const privateKeyPem = process.env.ZOOMINFO_API_KEY?.trim();
  const username = process.env.ZOOMINFO_USERNAME?.trim();
  const clientId = process.env.ZOOMINFO_CLIENT_ID?.trim();
  const anthropicKey = process.env.PROSPECT_ANTHROPIC_KEY?.trim();
  const braveKey = process.env.BRAVE_API_KEY?.trim();
  const mcpUrl = process.env.ZOOMINFO_MCP_URL?.trim();
  const mcpToken = process.env.ZOOMINFO_MCP_TOKEN?.trim();

  const chain: ContactProvider[] = [];

  // Primary: ZoomInfo REST API with PKI JWT auth + Claude picker.
  if (privateKeyPem && username && clientId && anthropicKey) {
    chain.push(
      createZoomInfoRestProvider({
        privateKeyPem,
        username,
        clientId,
        anthropicKey,
      }),
    );
  }

  // Secondary fallback: Anthropic's built-in web_search tool. Better LinkedIn
  // and small-company coverage than Brave, slightly more expensive per call.
  if (anthropicKey) {
    chain.push(createAnthropicWebSearchContactsProvider({ anthropicKey }));
  }

  // Tertiary fallback: Brave web search + Claude orchestration. Cheaper than
  // Anthropic's web_search but thinner LinkedIn coverage.
  if (braveKey && anthropicKey) {
    chain.push(createWebSearchContactsProvider({ braveKey, anthropicKey }));
  }

  // Quaternary fallback: ZoomInfo MCP (OAuth-protected — skipped on most accounts).
  if (mcpUrl && mcpToken && anthropicKey) {
    chain.push(createZoomInfoMcpProvider({ url: mcpUrl, token: mcpToken, anthropicKey }));
  }

  contactCached = chain.length > 0 ? chainContactProviders(...chain) : createMockContactProvider();
  return contactCached;
}

export function getCompetitorProvider(): CompetitorProvider {
  if (competitorCached) return competitorCached;
  const anthropicKey = process.env.PROSPECT_ANTHROPIC_KEY?.trim();
  if (anthropicKey) {
    competitorCached = createAnthropicCompetitorProvider({ anthropicKey });
  } else {
    competitorCached = createNullCompetitorProvider();
  }
  return competitorCached;
}

export function getSignalProvider(): SignalProvider {
  if (signalCached) return signalCached;
  const mcpUrl = process.env.SPARK_MCP_URL?.trim();
  const mcpToken = process.env.SPARK_MCP_TOKEN?.trim();
  const anthropicKey = process.env.PROSPECT_ANTHROPIC_KEY?.trim();
  if (mcpUrl && mcpToken && anthropicKey) {
    signalCached = createSparkMcpProvider({
      url: mcpUrl,
      token: mcpToken,
      anthropicKey,
    });
  } else {
    signalCached = createMockSignalProvider();
  }
  return signalCached;
}
