// Deterministic template selection engine for campaigns with multiple email templates.
//
// Evaluates manual overrides, priority-ordered rules (hotel segment, contact persona,
// verified status, minimum confidence, city), and fallback templates.
//
// Critical rules:
// - Never send emails from this selection service.
// - Pure, deterministic, auditable decisions with human-readable explanations.
// - Do not treat unverified/guessed attributes as verified facts.
import type { EnrichmentStatus } from "../../shared/types.js";
import { normalizeContactPersona, normalizeHotelSegment } from "./classification.js";

export interface RecipientProfile {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  hotelSegment?: string | null;
  hotelSegmentConfidence?: number | null;
  hotelSegmentStatus?: EnrichmentStatus | null;
  contactPersona?: string | null;
  contactPersonaConfidence?: number | null;
  contactPersonaStatus?: EnrichmentStatus | null;
  customFields?: Record<string, string>;
}

export interface EligibleTemplate {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string | null;
  version: number;
  isFallback?: boolean;
}

export interface SelectionRule {
  id: string;
  templateId: string;
  priority: number;
  hotelSegment?: string | null;
  contactPersona?: string | null;
  requiresVerified?: boolean;
  minConfidence?: number | null;
  city?: string | null;
  description?: string | null;
}

export interface RecipientOverride {
  contactId: string;
  templateId: string;
  reason?: string | null;
}

export interface TemplateSelectionResult {
  templateId: string;
  templateName: string;
  template: EligibleTemplate;
  assignmentSource: "OVERRIDE" | "RULE" | "FALLBACK";
  ruleId: string | null;
  rulePriority: number | null;
  explanation: string;
}

export interface SelectionContext {
  templates: EligibleTemplate[];
  rules: SelectionRule[];
  overrides?: Map<string, RecipientOverride> | Record<string, RecipientOverride>;
  defaultTemplateId: string;
}

function isVerifiedStatus(status?: EnrichmentStatus | null): boolean {
  return status === "VERIFIED" || status === "MANUAL";
}

/**
 * Select the appropriate template for a recipient deterministically.
 * Does not send emails or modify the database.
 */
export function selectTemplateForRecipient(
  recipient: RecipientProfile,
  context: SelectionContext
): TemplateSelectionResult {
  const { templates, rules, overrides, defaultTemplateId } = context;

  if (!templates.length) {
    throw new Error("Cannot select template: no eligible templates provided for this campaign.");
  }

  const templateMap = new Map<string, EligibleTemplate>(templates.map((t) => [t.id, t]));
  const fallbackTemplate =
    templates.find((t) => t.isFallback) ??
    templateMap.get(defaultTemplateId) ??
    templates[0]!;

  // -------------------------------------------------------------------------
  // 1. Check manual override for this contact
  // -------------------------------------------------------------------------
  const override =
    overrides instanceof Map
      ? overrides.get(recipient.id)
      : overrides?.[recipient.id];

  if (override) {
    const overriddenTemplate = templateMap.get(override.templateId);
    if (overriddenTemplate) {
      const reasonDetail = override.reason ? `: ${override.reason}` : "";
      return {
        templateId: overriddenTemplate.id,
        templateName: overriddenTemplate.name,
        template: overriddenTemplate,
        assignmentSource: "OVERRIDE",
        ruleId: null,
        rulePriority: null,
        explanation: `Manual override${reasonDetail}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 2. Evaluate priority rules (ascending: priority 1 comes before priority 2)
  // -------------------------------------------------------------------------
  const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    const targetTemplate = templateMap.get(rule.templateId);
    if (!targetTemplate) {
      // Rule points to an archived or removed template; skip
      continue;
    }

    const matchReasons: string[] = [];
    let ruleMatched = true;

    // Check Hotel Segment
    if (rule.hotelSegment && rule.hotelSegment.trim()) {
      const expectedSegment = normalizeHotelSegment(rule.hotelSegment);
      const recipientSegment = normalizeHotelSegment(recipient.hotelSegment);

      if (expectedSegment !== recipientSegment) {
        ruleMatched = false;
      } else {
        if (rule.requiresVerified && !isVerifiedStatus(recipient.hotelSegmentStatus)) {
          ruleMatched = false;
        } else if (
          rule.minConfidence !== null &&
          rule.minConfidence !== undefined &&
          (recipient.hotelSegmentConfidence ?? 0) < rule.minConfidence
        ) {
          ruleMatched = false;
        } else {
          const verifiedBadge = isVerifiedStatus(recipient.hotelSegmentStatus) ? " [verified]" : "";
          matchReasons.push(`Segment '${rule.hotelSegment}'${verifiedBadge}`);
        }
      }
    }

    if (!ruleMatched) continue;

    // Check Contact Persona
    if (rule.contactPersona && rule.contactPersona.trim()) {
      const expectedPersona = normalizeContactPersona(rule.contactPersona);
      const recipientPersona = normalizeContactPersona(recipient.contactPersona);

      if (expectedPersona !== recipientPersona) {
        ruleMatched = false;
      } else {
        if (rule.requiresVerified && !isVerifiedStatus(recipient.contactPersonaStatus)) {
          ruleMatched = false;
        } else if (
          rule.minConfidence !== null &&
          rule.minConfidence !== undefined &&
          (recipient.contactPersonaConfidence ?? 0) < rule.minConfidence
        ) {
          ruleMatched = false;
        } else {
          const verifiedBadge = isVerifiedStatus(recipient.contactPersonaStatus) ? " [verified]" : "";
          matchReasons.push(`Persona '${rule.contactPersona}'${verifiedBadge}`);
        }
      }
    }

    if (!ruleMatched) continue;

    // Check City
    if (rule.city && rule.city.trim()) {
      const recipientCity = recipient.customFields?.city ?? "";
      if (recipientCity.toLowerCase().trim() !== rule.city.toLowerCase().trim()) {
        ruleMatched = false;
      } else {
        matchReasons.push(`City '${rule.city}'`);
      }
    }

    if (ruleMatched && matchReasons.length > 0) {
      const desc = rule.description ? ` (${rule.description})` : "";
      return {
        templateId: targetTemplate.id,
        templateName: targetTemplate.name,
        template: targetTemplate,
        assignmentSource: "RULE",
        ruleId: rule.id,
        rulePriority: rule.priority,
        explanation: `Rule #${rule.priority}${desc}: matched ${matchReasons.join(", ")}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 3. Fallback handling
  // -------------------------------------------------------------------------
  const segLabel = recipient.hotelSegment ? `Segment '${recipient.hotelSegment}'` : "no segment";
  const perLabel = recipient.contactPersona ? `Persona '${recipient.contactPersona}'` : "no persona";
  return {
    templateId: fallbackTemplate.id,
    templateName: fallbackTemplate.name,
    template: fallbackTemplate,
    assignmentSource: "FALLBACK",
    ruleId: null,
    rulePriority: null,
    explanation: `Fallback template: no rule matched for ${segLabel} and ${perLabel}`,
  };
}

/**
 * Batch-evaluate template assignments for a list of campaign recipients.
 * Returns map of contactId -> TemplateSelectionResult.
 */
export function evaluateCampaignRecipients(
  recipients: RecipientProfile[],
  context: SelectionContext
): Map<string, TemplateSelectionResult> {
  const results = new Map<string, TemplateSelectionResult>();
  for (const r of recipients) {
    results.set(r.id, selectTemplateForRecipient(r, context));
  }
  return results;
}
