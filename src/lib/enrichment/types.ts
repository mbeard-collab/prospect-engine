export type ContactTier = "exec" | "manager" | "ic";

export type EnrichedContact = {
  name: string;
  title: string;
  tier: ContactTier;
  email: string | null;
  linkedin: string | null;
  rationale: string | null;
  // Provenance: one entry per provider that found this contact. When
  // multiple providers find the same person (e.g. ZoomInfo and LinkedIn
  // both surface Joe Smith), the aggregator merges them into one record
  // and unions the sources. Providers set this themselves to the name of
  // their own provider (e.g. ["zoominfo-rest"]).
  sources: string[];
};

export type SignalType =
  | "open_bid"
  | "expiring_contract"
  | "po_breadcrumb"
  | "meeting"
  | "spend_pattern";

export type EnrichedSignal = {
  type: SignalType;
  agencyName: string | null;
  agencyState: string | null;
  vendorName: string | null;
  summary: string;
  sourceLink: string | null;
  signalDate: string | null;
};

export type ContactProvider = {
  name: string;
  fetchContacts(input: {
    companyName: string;
    website: string | null;
    industryGuess?: string | null;
    primaryValueDriver?: string | null;
  }): Promise<EnrichedContact[]>;
};

export type SignalProvider = {
  name: string;
  fetchSignal(input: {
    companyName: string;
    industryGuess: string | null;
  }): Promise<EnrichedSignal | null>;
};

// Stage 2.5: three named competitors plus a one-sentence note. Returned as a
// single object per company (or null if the provider couldn't find evidence).
// Cached on companies.competitors with 90-day TTL.
export type EnrichedCompetitors = {
  names: string[];
  note: string;
};

export type CompetitorProvider = {
  name: string;
  fetchCompetitors(input: {
    companyName: string;
    website: string | null;
    industryGuess: string | null;
    primaryValueDriver: string | null;
  }): Promise<EnrichedCompetitors | null>;
};
