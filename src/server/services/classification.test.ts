import { describe, expect, it } from "vitest";
import {
  inferPersonaFromTitle,
  inferSegmentFromCompany,
  normalizeContactPersona,
  normalizeHotelSegment,
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
});
