// Hotel segmentation and contact persona classification.
// Pure, deterministic taxonomy matching and heuristic inference.
//
// Critical rule: Guessed values are explicitly identified and never treated as verified facts.
import {
  CONTACT_PERSONAS,
  HOTEL_SEGMENTS,
  type ContactPersona,
  type EnrichmentStatus,
  type HotelSegment,
} from "../../shared/types.js";

const SEGMENT_SYNONYMS: Record<HotelSegment, string[]> = {
  LUXURY: ["luxury", "5 star", "5-star", "fivestar", "ultra luxury", "palace", "grand hotel"],
  BOUTIQUE: ["boutique", "lifestyle", "design hotel", "historic", "heritage", "maison", "chateau", "villa"],
  UPSCALE: ["upscale", "full service", "4 star", "4-star", "fourstar", "upper upscale", "premium"],
  MIDSCALE: ["midscale", "select service", "limited service", "3 star", "3-star", "threestar"],
  BUDGET: ["budget", "economy", "motel", "hostel", "inn", "lodge", "1 star", "2 star", "roadside"],
  RESORT: ["resort", "destination", "spa resort", "beach resort", "golf resort", "ski resort", "retreat"],
  EXTENDED_STAY: ["extended stay", "aparthotel", "residence", "serviced apartments", "suites", "kitchenette"],
  INDEPENDENT: ["independent", "unbranded", "private hotel", "owner operated", "single property"],
  UNKNOWN: ["unknown", "unclassified", "other", "n/a", "none"],
};

const PERSONA_SYNONYMS: Record<ContactPersona, string[]> = {
  GENERAL_MANAGER: ["general manager", "gm", "managing director", "hotel manager", "resident manager", "area gm"],
  OPERATIONS_DIRECTOR: [
    "director of operations",
    "operations director",
    "vp operations",
    "operations manager",
    "front office manager",
    "rooms division manager",
    "agm",
    "assistant general manager",
  ],
  REVENUE_MANAGER: [
    "revenue manager",
    "director of revenue",
    "director of revenue management",
    "dorms",
    "yield manager",
    "pricing manager",
    "vp revenue",
  ],
  SALES_MARKETING_DIRECTOR: [
    "director of sales",
    "director of marketing",
    "sales and marketing",
    "dosm",
    "commercial director",
    "business development",
    "sales manager",
  ],
  IT_DIRECTOR: [
    "it director",
    "director of it",
    "systems manager",
    "chief technology officer",
    "cto",
    "technology manager",
    "head of it",
    "hotel tech",
  ],
  OWNER_OPERATOR: [
    "owner",
    "co-owner",
    "principal",
    "proprietor",
    "founder",
    "asset manager",
    "partner",
    "managing partner",
    "hotel owner",
  ],
  FINANCE_PROCUREMENT: [
    "director of finance",
    "finance director",
    "financial controller",
    "controller",
    "procurement manager",
    "purchasing director",
    "chief financial officer",
    "cfo",
  ],
  OTHER: ["consultant", "coordinator", "supervisor", "specialist", "assistant", "staff"],
  UNKNOWN: ["unknown", "unclassified", "n/a", "none"],
};

function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ");
}

/** Normalize arbitrary text to a standard HotelSegment enum value */
export function normalizeHotelSegment(raw?: string | null): HotelSegment {
  if (!raw) return "UNKNOWN";
  const cleaned = normalizeText(raw);
  if (!cleaned) return "UNKNOWN";

  // Check direct exact match with enum key
  const upper = raw.toUpperCase().trim() as HotelSegment;
  if (HOTEL_SEGMENTS.includes(upper)) return upper;

  for (const [segment, synonyms] of Object.entries(SEGMENT_SYNONYMS) as [HotelSegment, string[]][]) {
    for (const syn of synonyms) {
      if (cleaned === syn || cleaned.includes(syn)) {
        return segment;
      }
    }
  }
  return "UNKNOWN";
}

/** Normalize arbitrary text to a standard ContactPersona enum value */
export function normalizeContactPersona(raw?: string | null): ContactPersona {
  if (!raw) return "UNKNOWN";
  const cleaned = normalizeText(raw);
  if (!cleaned) return "UNKNOWN";

  // Check direct exact match with enum key
  const upper = raw.toUpperCase().trim() as ContactPersona;
  if (CONTACT_PERSONAS.includes(upper)) return upper;

  for (const [persona, synonyms] of Object.entries(PERSONA_SYNONYMS) as [ContactPersona, string[]][]) {
    for (const syn of synonyms) {
      if (cleaned === syn || cleaned.includes(syn)) {
        return persona;
      }
    }
  }
  return "UNKNOWN";
}

export interface ClassificationResult<T> {
  value: T;
  confidence: number;
  status: EnrichmentStatus;
  source: string;
}

/** Infer contact persona from their job title heuristically */
export function inferPersonaFromTitle(title?: string | null): ClassificationResult<ContactPersona> {
  if (!title || !title.trim()) {
    return { value: "UNKNOWN", confidence: 0, status: "GUESSED", source: "unspecified_title" };
  }
  const cleaned = normalizeText(title);

  // Check word boundaries / prefixes / acronyms
  if (/\bgm\b/.test(cleaned) || /\bgeneral manager\b/.test(cleaned) || /\bhotel manager\b/.test(cleaned)) {
    return { value: "GENERAL_MANAGER", confidence: 0.85, status: "GUESSED", source: "title_heuristic" };
  }
  if (/\b(revenue|yield|pricing)\b/.test(cleaned)) {
    return { value: "REVENUE_MANAGER", confidence: 0.85, status: "GUESSED", source: "title_heuristic" };
  }
  if (/\b(sales|marketing|dosm|commercial)\b/.test(cleaned)) {
    return { value: "SALES_MARKETING_DIRECTOR", confidence: 0.85, status: "GUESSED", source: "title_heuristic" };
  }
  if (/\b(operations|rooms|front office|agm)\b/.test(cleaned)) {
    return { value: "OPERATIONS_DIRECTOR", confidence: 0.8, status: "GUESSED", source: "title_heuristic" };
  }
  if (/\b(it|systems|technology|cto|software|tech)\b/.test(cleaned)) {
    return { value: "IT_DIRECTOR", confidence: 0.8, status: "GUESSED", source: "title_heuristic" };
  }
  if (/\b(owner|proprietor|founder|principal|asset manager)\b/.test(cleaned)) {
    return { value: "OWNER_OPERATOR", confidence: 0.85, status: "GUESSED", source: "title_heuristic" };
  }
  if (/\b(finance|financial|controller|procurement|purchasing|cfo)\b/.test(cleaned)) {
    return { value: "FINANCE_PROCUREMENT", confidence: 0.8, status: "GUESSED", source: "title_heuristic" };
  }

  const normalized = normalizeContactPersona(title);
  if (normalized !== "UNKNOWN") {
    return { value: normalized, confidence: 0.7, status: "GUESSED", source: "title_heuristic" };
  }
  return { value: "UNKNOWN", confidence: 0.2, status: "GUESSED", source: "unrecognized_title" };
}

/** Infer hotel segment from property name or custom fields */
export function inferSegmentFromCompany(
  company?: string | null,
  customFields: Record<string, string> = {}
): ClassificationResult<HotelSegment> {
  const hints = [company, customFields.propertyType, customFields.segment, customFields.stars, customFields.category]
    .filter(Boolean)
    .join(" ");

  if (!hints.trim()) {
    return { value: "UNKNOWN", confidence: 0, status: "GUESSED", source: "unspecified_property" };
  }
  const cleaned = normalizeText(hints);

  if (/\b(resort|beach|spa|golf|ski|retreat|island)\b/.test(cleaned)) {
    return { value: "RESORT", confidence: 0.75, status: "GUESSED", source: "property_name_heuristic" };
  }
  if (/\b(extended stay|suites|aparthotel|residence|serviced)\b/.test(cleaned)) {
    return { value: "EXTENDED_STAY", confidence: 0.75, status: "GUESSED", source: "property_name_heuristic" };
  }
  if (/\b(boutique|design|lifestyle|historic|heritage|maison|chateau)\b/.test(cleaned)) {
    return { value: "BOUTIQUE", confidence: 0.7, status: "GUESSED", source: "property_name_heuristic" };
  }
  if (/\b(luxury|5 star|five star|palace|st regis|ritz|four seasons)\b/.test(cleaned)) {
    return { value: "LUXURY", confidence: 0.8, status: "GUESSED", source: "property_name_heuristic" };
  }
  if (/\b(motel|hostel|inn|lodge|budget|economy|1 star|2 star)\b/.test(cleaned)) {
    return { value: "BUDGET", confidence: 0.65, status: "GUESSED", source: "property_name_heuristic" };
  }
  if (/\b(upscale|hilton|marriott|sheraton|hyatt|westin|radisson)\b/.test(cleaned)) {
    return { value: "UPSCALE", confidence: 0.65, status: "GUESSED", source: "property_name_heuristic" };
  }
  if (/\b(midscale|hampton|holiday inn|courtyard|ibis|best western)\b/.test(cleaned)) {
    return { value: "MIDSCALE", confidence: 0.65, status: "GUESSED", source: "property_name_heuristic" };
  }

  const normalized = normalizeHotelSegment(hints);
  if (normalized !== "UNKNOWN") {
    return { value: normalized, confidence: 0.6, status: "GUESSED", source: "property_name_heuristic" };
  }
  return { value: "UNKNOWN", confidence: 0.2, status: "GUESSED", source: "unrecognized_property" };
}
