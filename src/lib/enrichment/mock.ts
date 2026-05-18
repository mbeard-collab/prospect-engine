import type {
  ContactProvider,
  ContactTier,
  EnrichedContact,
  EnrichedSignal,
  SignalProvider,
  SignalType,
} from "./types";

// Deterministic mocks. Same company name always yields the same contacts and
// signal so demos look stable. Names + titles drawn from
// ~/Downloads/GovSpend_Prospecting_Files/govspend-prospecting/references/03-persona-contacts.md.

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const FIRST_NAMES = [
  "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Sam", "Riley", "Jamie",
  "Avery", "Quinn", "Drew", "Reese", "Cameron", "Hayden", "Skyler",
];
const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
  "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson",
  "Anderson", "Thomas",
];

const EXEC_TITLES = [
  "VP Public Sector",
  "VP Government Sales",
  "CRO",
  "VP Strategic Accounts",
  "VP Business Development",
];
const MANAGER_TITLES = [
  "Director of Public Sector",
  "Director of Government Sales",
  "Capture Director",
  "Regional Sales Manager, SLED",
  "BD Manager, Public Sector",
];
const IC_TITLES = [
  "Government Account Executive",
  "SLED Account Executive",
  "State and Local AE",
  "Public Sector BDR",
  "Higher Ed AE",
];

const TITLES_BY_TIER: Record<ContactTier, string[]> = {
  exec: EXEC_TITLES,
  manager: MANAGER_TITLES,
  ic: IC_TITLES,
};

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

function emailDomain(website: string | null, companyName: string): string {
  if (website) {
    return website.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  }
  return (
    companyName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 20) + ".com"
  );
}

export function createMockContactProvider(): ContactProvider {
  return {
    name: "mock",
    async fetchContacts({ companyName, website }) {
      const seed = hash(companyName);
      const out: EnrichedContact[] = [];

      const domain = emailDomain(website, companyName);

      for (const [i, tier] of (["exec", "manager", "ic"] as ContactTier[]).entries()) {
        const first = pick(FIRST_NAMES, seed + i * 7);
        const last = pick(LAST_NAMES, seed + i * 13);
        const title = pick(TITLES_BY_TIER[tier], seed + i * 19);

        out.push({
          name: `${first} ${last}`,
          title,
          tier,
          email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
          linkedin: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${(seed + i).toString(36).slice(0, 6)}`,
          rationale: tier === "exec"
            ? "Owns public-sector revenue strategy."
            : tier === "manager"
              ? "Direct line manager for SLED account execs."
              : "Day-to-day quota carrier for state-and-local accounts.",
          sources: ["mock"],
        });
      }

      return out;
    },
  };
}

// ── Signals mock ─────────────────────────────────────────────────────────

const AGENCIES = [
  ["City of Austin", "TX"],
  ["County of Maricopa", "AZ"],
  ["State of Colorado, Dept. of Transportation", "CO"],
  ["Miami-Dade County Public Schools", "FL"],
  ["State of Virginia, Dept. of Health", "VA"],
  ["City of Seattle", "WA"],
  ["Cook County", "IL"],
  ["State of Georgia, Dept. of Public Safety", "GA"],
  ["Los Angeles County Metropolitan Transportation Authority", "CA"],
  ["State of Ohio, Dept. of Administrative Services", "OH"],
] as const;

const COMPETITOR_VENDORS = [
  "Tyler Technologies",
  "Granicus",
  "OpenGov",
  "Accela",
  "CivicPlus",
  "NEOGOV",
  "Esri",
  "Motorola Solutions",
];

const SIGNAL_TYPES: SignalType[] = [
  "open_bid",
  "expiring_contract",
  "po_breadcrumb",
  "meeting",
  "spend_pattern",
];

function buildSignal(seed: number, companyName: string): EnrichedSignal {
  const type = SIGNAL_TYPES[seed % SIGNAL_TYPES.length];
  // Defensive: % can produce negatives on a signed seed; force unsigned.
  const agencyIdx = ((seed >>> 3) % AGENCIES.length + AGENCIES.length) % AGENCIES.length;
  const vendorIdx = ((seed >>> 5) % COMPETITOR_VENDORS.length + COMPETITOR_VENDORS.length) % COMPETITOR_VENDORS.length;
  const agencyEntry = AGENCIES[agencyIdx] ?? AGENCIES[0];
  const [agencyName, agencyState] = agencyEntry;
  const vendor = COMPETITOR_VENDORS[vendorIdx] ?? COMPETITOR_VENDORS[0];
  const today = new Date();
  const future = new Date(today);
  future.setDate(today.getDate() + 30 + ((seed >> 7) % 120));
  const signalDate = future.toISOString().slice(0, 10);

  switch (type) {
    case "open_bid":
      return {
        type,
        agencyName,
        agencyState,
        vendorName: null,
        summary: `${agencyName} has an open RFP for a software platform in the category ${companyName} sells into. Deadline ${signalDate}.`,
        sourceLink: `https://example-procurement.gov/bid/${seed.toString(36)}`,
        signalDate,
      };
    case "expiring_contract":
      return {
        type,
        agencyName,
        agencyState,
        vendorName: vendor,
        summary: `${vendor} contract with ${agencyName} expires ${signalDate} — likely rebid window opens 90 days prior.`,
        sourceLink: `https://example-spark.govspend.com/contract/${seed.toString(36)}`,
        signalDate,
      };
    case "po_breadcrumb":
      return {
        type,
        agencyName,
        agencyState,
        vendorName: vendor,
        summary: `Recent PO from ${agencyName} to ${vendor} references a 12-month subscription renewal — useful timing intel.`,
        sourceLink: `https://example-spark.govspend.com/po/${seed.toString(36)}`,
        signalDate,
      };
    case "meeting":
      return {
        type,
        agencyName,
        agencyState,
        vendorName: null,
        summary: `${agencyName} council agenda discusses upgrading the platform in ${companyName}'s category — budget cycle FY${(today.getFullYear() + 1) % 100}.`,
        sourceLink: `https://example-meetings.gov/${seed.toString(36)}`,
        signalDate,
      };
    case "spend_pattern":
      return {
        type,
        agencyName: null,
        agencyState: null,
        vendorName: vendor,
        summary: `Multi-state spend pattern: 7 agencies across 4 states purchased ${vendor}'s category in the last 18 months. ${companyName} could displace where contracts expire.`,
        sourceLink: `https://example-spark.govspend.com/spend/${seed.toString(36)}`,
        signalDate: null,
      };
  }
}

export function createMockSignalProvider(): SignalProvider {
  return {
    name: "mock",
    async fetchSignal({ companyName }) {
      const seed = hash(companyName);
      return buildSignal(seed, companyName);
    },
  };
}
