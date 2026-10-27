import { describe, expect, it } from "vitest";
import {
  inferPersonaFromTitle,
  inferSegmentFromCompany,
  normalizeContactPersona,
  normalizeHotelSegment,
  detectProspectListType,
  computeImportQuality,
} from "./classification.js";

describe("classification service", () => {
  describe("normalizeHotelSegment", () => {
    it("maps standard and synonym strings to HotelSegment enum", () => {
      expect(normalizeHotelSegment("LUXURY")).toBe("LUXURY");
      expect(normalizeHotelSegment("5 Star Hotel")).toBe("LUXURY");
      expect(normalizeHotelSegment("Boutique")).toBe("BOUTIQUE");
      expect(normalizeHotelSegment("Beach Resort & Spa")).toBe("RESORT");
      expect(normalizeHotelSegment("Extended Stay Suites")).toBe("EXTENDED_STAY");
      expect(normalizeHotelSegment("Budget Motel")).toBe("BUDGET");
      expect(normalizeHotelSegment("Random Unknown Name")).toBe("UNKNOWN");
      expect(normalizeHotelSegment(null)).toBe("UNKNOWN");
    });
  });

  describe("normalizeContactPersona", () => {
    it("maps title or persona strings to ContactPersona enum", () => {
      expect(normalizeContactPersona("GENERAL_MANAGER")).toBe("GENERAL_MANAGER");
      expect(normalizeContactPersona("GM")).toBe("GENERAL_MANAGER");
      expect(normalizeContactPersona("Director of Operations")).toBe("OPERATIONS_DIRECTOR");
      expect(normalizeContactPersona("DOSM")).toBe("SALES_MARKETING_DIRECTOR");
      expect(normalizeContactPersona("Director of Revenue Management")).toBe("REVENUE_MANAGER");
      expect(normalizeContactPersona("Hotel Tech Manager")).toBe("IT_DIRECTOR");
      expect(normalizeContactPersona("Hotel Owner")).toBe("OWNER_OPERATOR");
      expect(normalizeContactPersona("Financial Controller")).toBe("FINANCE_PROCUREMENT");
      expect(normalizeContactPersona("Housekeeping Lead")).toBe("UNKNOWN");
    });
  });

  describe("inferPersonaFromTitle", () => {
    it("heuristically infers persona with confidence score and GUESSED status", () => {
      const gm = inferPersonaFromTitle("General Manager");
      expect(gm.value).toBe("GENERAL_MANAGER");
      expect(gm.status).toBe("GUESSED");
      expect(gm.confidence).toBeGreaterThanOrEqual(0.8);

      const rev = inferPersonaFromTitle("VP Revenue & Distribution");
      expect(rev.value).toBe("REVENUE_MANAGER");
      expect(rev.status).toBe("GUESSED");
      expect(rev.confidence).toBeGreaterThanOrEqual(0.8);

      const unk = inferPersonaFromTitle("");
      expect(unk.value).toBe("UNKNOWN");
      expect(unk.confidence).toBe(0);
    });

    it("does not treat unverified titles as verified facts", () => {
      const res = inferPersonaFromTitle("Commercial Lead");
      expect(res.status).toBe("GUESSED");
      expect(res.value).toBe("SALES_MARKETING_DIRECTOR");
    });
  });

  describe("inferSegmentFromCompany", () => {
    it("heuristically infers segment from company name and custom fields", () => {
      const resort = inferSegmentFromCompany("Grand Azure Beach Resort & Spa");
      expect(resort.value).toBe("RESORT");
      expect(resort.status).toBe("GUESSED");

      const boutique = inferSegmentFromCompany("The Parisian Heritage Maison");
      expect(boutique.value).toBe("BOUTIQUE");
      expect(boutique.status).toBe("GUESSED");

      const suites = inferSegmentFromCompany("Downtown Extended Stay Suites");
      expect(suites.value).toBe("EXTENDED_STAY");

      const unk = inferSegmentFromCompany("XYZ Global Holdings");
      expect(unk.value).toBe("UNKNOWN");
    });
  });

  describe("detectProspectListType", () => {
    it("identifies hotel prospect lists from hotel-specific headers and values", () => {
      const headers = ["Hotel Name", "Contact Email", "City", "Rooms", "Star Rating"];
      const rows = [{ "Hotel Name": "Grand Palace Hotel", "Contact Email": "gm@grandpalace.com" }];
      expect(detectProspectListType(headers, rows)).toBe("HOTEL_PROSPECTS");
    });

    it("identifies co-marketing partner lists from partnership headers", () => {
      const headers = ["Company Name", "Email", "Partner Category", "Services Provided", "Partnership Angle"];
      const rows = [{ "Company Name": "Hospitality Academy", "Email": "partner@academy.com" }];
      expect(detectProspectListType(headers, rows)).toBe("CO_MARKETING_PARTNERS");
    });

    it("defaults to general business prospects for generic lists", () => {
      const headers = ["Company", "Email", "Phone", "Notes"];
      const rows = [{ Company: "Acme Corp", Email: "contact@acme.com" }];
      expect(detectProspectListType(headers, rows)).toBe("GENERAL_BUSINESS");
    });
  });

  describe("computeImportQuality", () => {
    it("calculates readiness and personalization quality breakdown", () => {
      const headers = ["Hotel Name", "Email", "Contact Person", "Job Title", "City"];
      const mapping = {
        "Hotel Name": "company",
        Email: "email",
        "Contact Person": "name",
        "Job Title": "title",
        City: "city",
      };
      const quality = computeImportQuality(headers, mapping, "HOTEL_PROSPECTS");
      expect(quality.score).toBeGreaterThan(60);
      expect(quality.hasEmail).toBe(true);
      expect(quality.hasCompany).toBe(true);
      expect(quality.essentialMissing).toHaveLength(0);
      expect(quality.personalizationTagsReady).toContain("email");
      expect(quality.personalizationTagsReady).toContain("company");
    });
  });
});

