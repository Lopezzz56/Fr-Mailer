import { describe, expect, it } from "vitest";
import {
  selectTemplateForRecipient,
  type EligibleTemplate,
  type RecipientProfile,
  type SelectionContext,
  type SelectionRule,
} from "./template-selection.js";

describe("template selection service", () => {
  const tGeneral: EligibleTemplate = {
    id: "t-general",
    name: "General Outreach",
    subject: "Hello {{firstName}}",
    bodyHtml: "<p>Hello</p>",
    version: 1,
    isFallback: true,
  };

  const tLuxuryGM: EligibleTemplate = {
    id: "t-luxury-gm",
    name: "Luxury GM Briefing",
    subject: "Luxury Strategy for {{company}}",
    bodyHtml: "<p>Luxury GM</p>",
    version: 1,
  };

  const tBoutique: EligibleTemplate = {
    id: "t-boutique",
    name: "Boutique Experience",
    subject: "Boutique Hospitality",
    bodyHtml: "<p>Boutique</p>",
    version: 1,
  };

  const tRevenue: EligibleTemplate = {
    id: "t-revenue",
    name: "RevPAR Maximization",
    subject: "RevPAR strategy",
    bodyHtml: "<p>Revenue</p>",
    version: 1,
  };

  const templates = [tGeneral, tLuxuryGM, tBoutique, tRevenue];

  it("selects fallback template when no rules match", () => {
    const recipient: RecipientProfile = {
      id: "c-1",
      email: "unknown@motel.test",
      hotelSegment: "BUDGET",
      contactPersona: "OTHER",
    };
    const context: SelectionContext = {
      templates,
      rules: [],
      defaultTemplateId: "t-general",
    };

    const result = selectTemplateForRecipient(recipient, context);
    expect(result.templateId).toBe("t-general");
    expect(result.assignmentSource).toBe("FALLBACK");
    expect(result.explanation).toContain("Fallback template: no rule matched");
  });

  it("selects template matching rule by segment and persona", () => {
    const recipient: RecipientProfile = {
      id: "c-2",
      email: "gm@luxury.test",
      hotelSegment: "LUXURY",
      contactPersona: "GENERAL_MANAGER",
    };
    const rule: SelectionRule = {
      id: "rule-1",
      templateId: "t-luxury-gm",
      priority: 1,
      hotelSegment: "LUXURY",
      contactPersona: "GENERAL_MANAGER",
      description: "Luxury GMs",
    };
    const context: SelectionContext = {
      templates,
      rules: [rule],
      defaultTemplateId: "t-general",
    };

    const result = selectTemplateForRecipient(recipient, context);
    expect(result.templateId).toBe("t-luxury-gm");
    expect(result.assignmentSource).toBe("RULE");
    expect(result.ruleId).toBe("rule-1");
    expect(result.explanation).toContain("Rule #1 (Luxury GMs): matched Segment 'LUXURY', Persona 'GENERAL_MANAGER'");
  });

  it("evaluates rules in order of priority (lower number first)", () => {
    const recipient: RecipientProfile = {
      id: "c-3",
      email: "gm@boutique.test",
      hotelSegment: "BOUTIQUE",
      contactPersona: "GENERAL_MANAGER",
    };
    // Rule 1: High priority matches BOUTIQUE
    const rule1: SelectionRule = {
      id: "rule-1",
      templateId: "t-boutique",
      priority: 1,
      hotelSegment: "BOUTIQUE",
      description: "Boutique Focus",
    };
    // Rule 2: Lower priority matches GENERAL_MANAGER
    const rule2: SelectionRule = {
      id: "rule-2",
      templateId: "t-luxury-gm",
      priority: 2,
      contactPersona: "GENERAL_MANAGER",
      description: "GM Focus",
    };

    // Even if array order is reversed, priority 1 must win
    const context: SelectionContext = {
      templates,
      rules: [rule2, rule1],
      defaultTemplateId: "t-general",
    };

    const result = selectTemplateForRecipient(recipient, context);
    expect(result.templateId).toBe("t-boutique");
    expect(result.rulePriority).toBe(1);
    expect(result.explanation).toContain("Rule #1 (Boutique Focus)");
  });

  it("respects requiresVerified and does not treat guesses as verified facts", () => {
    const guessedRecipient: RecipientProfile = {
      id: "c-4",
      email: "guess@hotel.test",
      hotelSegment: "LUXURY",
      hotelSegmentStatus: "GUESSED",
      hotelSegmentConfidence: 0.6,
      contactPersona: "GENERAL_MANAGER",
      contactPersonaStatus: "GUESSED",
    };
    const rule: SelectionRule = {
      id: "rule-verified",
      templateId: "t-luxury-gm",
      priority: 1,
      hotelSegment: "LUXURY",
      requiresVerified: true,
      description: "Verified Luxury Properties Only",
    };
    const context: SelectionContext = {
      templates,
      rules: [rule],
      defaultTemplateId: "t-general",
    };

    // Since recipient status is GUESSED, rule fails and recipient falls back to fallback template!
    const unverifiedResult = selectTemplateForRecipient(guessedRecipient, context);
    expect(unverifiedResult.templateId).toBe("t-general");
    expect(unverifiedResult.assignmentSource).toBe("FALLBACK");

    // Once verified by a person, rule matches!
    const verifiedRecipient: RecipientProfile = {
      ...guessedRecipient,
      hotelSegmentStatus: "VERIFIED",
      hotelSegmentConfidence: 1.0,
    };
    const verifiedResult = selectTemplateForRecipient(verifiedRecipient, context);
    expect(verifiedResult.templateId).toBe("t-luxury-gm");
    expect(verifiedResult.assignmentSource).toBe("RULE");
    expect(verifiedResult.explanation).toContain("[verified]");
  });

  it("enforces minConfidence threshold", () => {
    const lowConfidenceRecipient: RecipientProfile = {
      id: "c-5",
      email: "low@hotel.test",
      contactPersona: "REVENUE_MANAGER",
      contactPersonaConfidence: 0.4,
    };
    const rule: SelectionRule = {
      id: "rule-conf",
      templateId: "t-revenue",
      priority: 1,
      contactPersona: "REVENUE_MANAGER",
      minConfidence: 0.8,
    };
    const context: SelectionContext = {
      templates,
      rules: [rule],
      defaultTemplateId: "t-general",
    };

    // 0.4 < 0.8 -> falls back
    const result = selectTemplateForRecipient(lowConfidenceRecipient, context);
    expect(result.templateId).toBe("t-general");

    // 0.85 >= 0.8 -> matches
    const highConfResult = selectTemplateForRecipient(
      { ...lowConfidenceRecipient, contactPersonaConfidence: 0.85 },
      context
    );
    expect(highConfResult.templateId).toBe("t-revenue");
  });

  it("prioritizes manual override over rule matches with auditable explanation", () => {
    const recipient: RecipientProfile = {
      id: "c-6",
      email: "special@hotel.test",
      hotelSegment: "LUXURY",
      contactPersona: "GENERAL_MANAGER",
    };
    const rule: SelectionRule = {
      id: "rule-1",
      templateId: "t-luxury-gm",
      priority: 1,
      hotelSegment: "LUXURY",
    };
    const overrides = new Map([
      ["c-6", { contactId: "c-6", templateId: "t-boutique", reason: "Requested boutique angle on call" }],
    ]);

    const context: SelectionContext = {
      templates,
      rules: [rule],
      overrides,
      defaultTemplateId: "t-general",
    };

    const result = selectTemplateForRecipient(recipient, context);
    expect(result.templateId).toBe("t-boutique");
    expect(result.assignmentSource).toBe("OVERRIDE");
    expect(result.explanation).toBe("Manual override: Requested boutique angle on call");
  });
});
