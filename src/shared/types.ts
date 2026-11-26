// API contracts shared by server and client: request schemas (validated on the server)
// and response shapes (what the server returns). Dates are ISO strings over the wire.
import { z } from "zod";
import type { UserRole, TemplateScope, CampaignCollaboratorDto } from "./auth.js";
import { TemplateScopeSchema } from "./auth.js";
export type { UserRole, TemplateScope, CampaignCollaboratorDto };
export { TemplateScopeSchema };

// ============================================================================
// PRIMITIVES
// ============================================================================

export const EmailSchema = z.string().trim().toLowerCase().email("Enter a valid email address");
export const IdSchema = z.string().min(1).max(64);

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

// ============================================================================
// CONTACTS & LISTS
// ============================================================================

export const STANDARD_CONTACT_FIELDS = ["firstName", "lastName", "company", "title", "phone", "hotelSegment", "contactPersona"] as const;
export type StandardContactField = (typeof STANDARD_CONTACT_FIELDS)[number];

// ============================================================================
// HOTEL SEGMENTS & CONTACT PERSONAS
// ============================================================================

export const HOTEL_SEGMENTS = [
  "LUXURY",
  "BOUTIQUE",
  "UPSCALE",
  "MIDSCALE",
  "BUDGET",
  "RESORT",
  "EXTENDED_STAY",
  "INDEPENDENT",
  "CO_PARTNERSHIP",
  "INSTITUTE",
  "UNKNOWN",
] as const;
export type HotelSegment = (typeof HOTEL_SEGMENTS)[number];
export const HotelSegmentSchema = z.enum(HOTEL_SEGMENTS);

export const HOTEL_SEGMENT_LABELS: Record<HotelSegment, string> = {
  LUXURY: "Luxury Hotel",
  BOUTIQUE: "Boutique Hotel",
  UPSCALE: "Upscale / Full Service",
  MIDSCALE: "Midscale / Select Service",
  BUDGET: "Budget / Economy",
  RESORT: "Resort & Destination",
  EXTENDED_STAY: "Extended Stay",
  INDEPENDENT: "Independent Hotel",
  CO_PARTNERSHIP: "Co-Partnership & Brand",
  INSTITUTE: "Institute / College (Hiring)",
  UNKNOWN: "Unknown / General",
};

export const CONTACT_PERSONAS = [
  "GENERAL_MANAGER",
  "OPERATIONS_DIRECTOR",
  "REVENUE_MANAGER",
  "SALES_MARKETING_DIRECTOR",
  "IT_DIRECTOR",
  "OWNER_OPERATOR",
  "FINANCE_PROCUREMENT",
  "PARTNERSHIP_DIRECTOR",
  "PLACEMENT_OFFICER",
  "DEAN_DIRECTOR",
  "OTHER",
  "UNKNOWN",
] as const;
export type ContactPersona = (typeof CONTACT_PERSONAS)[number];
export const ContactPersonaSchema = z.enum(CONTACT_PERSONAS);

export const CONTACT_PERSONA_LABELS: Record<ContactPersona, string> = {
  GENERAL_MANAGER: "General Manager",
  OPERATIONS_DIRECTOR: "Director of Operations",
  REVENUE_MANAGER: "Director of Revenue Management",
  SALES_MARKETING_DIRECTOR: "Director of Sales & Marketing",
  IT_DIRECTOR: "IT & Systems Director",
  OWNER_OPERATOR: "Owner / Principal",
  FINANCE_PROCUREMENT: "Finance & Procurement",
  PARTNERSHIP_DIRECTOR: "Partnership / Alliance Director",
  PLACEMENT_OFFICER: "Placement & Training Officer (Hiring)",
  DEAN_DIRECTOR: "Dean / Academic Director",
  OTHER: "Other Staff",
  UNKNOWN: "Unknown",
};

export const CUSTOM_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,49}$/;

/** camelCase merge-field name for an arbitrary column header, e.g. "Room count" -> "roomCount" */
export function toFieldName(header: string): string {
  const words = header
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let name = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join("");
  if (!name) name = "field";
  if (/^[0-9]/.test(name)) name = `f${name}`;
  return name.slice(0, 50);
}

export const ContactInputSchema = z.object({
  email: EmailSchema,
  firstName: optionalText(100),
  lastName: optionalText(100),
  company: optionalText(200),
  title: optionalText(200),
  phone: optionalText(50),
  hotelSegment: optionalText(100),
  hotelSegmentConfidence: z.coerce.number().min(0).max(1).optional().nullable(),
  hotelSegmentStatus: z.enum(["GUESSED", "VERIFIED", "MANUAL", "REJECTED"]).optional().nullable(),
  contactPersona: optionalText(100),
  contactPersonaConfidence: z.coerce.number().min(0).max(1).optional().nullable(),
  contactPersonaStatus: z.enum(["GUESSED", "VERIFIED", "MANUAL", "REJECTED"]).optional().nullable(),
  customFields: z
    .record(z.string().regex(CUSTOM_FIELD_NAME, "Field names use letters, numbers and _"), z.string().max(2000))
    .default({}),
});
export type ContactInput = z.input<typeof ContactInputSchema>;

export const ContactBatchInputSchema = ContactInputSchema.omit({ email: true }).extend({
  emails: z.array(EmailSchema).min(1).max(20).refine((emails) => new Set(emails).size === emails.length, "Remove duplicate email addresses"),
  listIds: z.array(IdSchema).max(50).default([]),
});
export type ContactBatchInput = z.input<typeof ContactBatchInputSchema>;

export const ContactListInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: optionalText(500),
  isShared: z.boolean().default(false),
});
export type ContactListInput = z.input<typeof ContactListInputSchema>;

export const ListMembersInputSchema = z.object({
  contactIds: z.array(IdSchema).min(1).max(1000),
});

export interface ContactDto {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  hotelSegment: string | null;
  hotelSegmentConfidence: number | null;
  hotelSegmentStatus: EnrichmentStatus | null;
  contactPersona: string | null;
  contactPersonaConfidence: number | null;
  contactPersonaStatus: EnrichmentStatus | null;
  customFields: Record<string, string>;
  source: string | null;
  importedAt: string;
  updatedAt: string;
  lists: { id: string; name: string }[];
  suppression: { reason: SuppressionReason; createdAt: string } | null;
}

export interface ContactListDto {
  id: string;
  name: string;
  description: string | null;
  createdById: string | null;
  isShared: boolean;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// IMPORT
// ============================================================================

/** Where an import column goes: a contact field, "fullName" (split into first/last), a custom field ("custom:<name>"), or nowhere */
export type ImportTarget = "email" | StandardContactField | "fullName" | `custom:${string}` | "ignore";

export const COALESCABLE_TARGETS = new Set<string>([
  "company",
  "phone",
  "title",
  "hotelSegment",
  "contactPersona",
]);

export const IMPORT_TARGET_LABELS: Record<"email" | StandardContactField | "fullName", string> = {
  email: "Email",
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name (split into first & last)",
  company: "Company / Hotel Name",
  title: "Job title",
  phone: "Phone",
  hotelSegment: "Hotel segment",
  contactPersona: "Contact persona",
};

export const MAX_IMPORT_ROWS = 50_000;
/** Vercel caps function request bodies at 4.5 MB; stay under it everywhere */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export const DuplicatePolicySchema = z.enum(["skip", "fill_empty", "overwrite"]);
export type DuplicatePolicy = z.infer<typeof DuplicatePolicySchema>;

export const DUPLICATE_POLICY_LABELS: Record<DuplicatePolicy, { label: string; description: string }> = {
  skip: { label: "Keep existing contacts", description: "Contacts already in FocusRealm are left untouched." },
  fill_empty: { label: "Fill in blanks only", description: "Adds missing details to existing contacts; never changes what's there." },
  overwrite: { label: "Overwrite with file values", description: "Replaces existing details with non-empty values from the file." },
};

/** Sheet selector value meaning "every sheet in the workbook, combined by column name" */
export const ALL_SHEETS = "__all__";

/** A cell with several addresses: one contact per address, or only the first */
export const MultiEmailPolicySchema = z.enum(["each", "first"]);
export type MultiEmailPolicy = z.infer<typeof MultiEmailPolicySchema>;

/** Identifies a row across sheets: "<sheet>!<row number>" */
export const rowRef = (sheet: string, row: number) => `${sheet}!${row}`;

export const ImportOptionsSchema = z.object({
  mapping: z.record(z.string(), z.string()),
  sheet: z.string().max(200).optional(),
  multiEmail: MultiEmailPolicySchema.default("each"),
  /** Person-confirmed corrections: rowRef -> email, or "" to skip that row */
  fixes: z.record(z.string().max(250), z.string().trim().max(320)).default({}),
});

export const ImportConfigSchema = ImportOptionsSchema.extend({
  duplicatePolicy: DuplicatePolicySchema.default("fill_empty"),
  listId: IdSchema.optional(),
  newListName: z.string().trim().min(1).max(100).optional(),
}).refine((c) => Object.values(c.mapping).includes("email"), { message: "Choose which column holds the email address" });
export type ImportConfig = z.input<typeof ImportConfigSchema>;

export interface ImportSheetInfo {
  name: string;
  rowCount: number;
  headers: string[];
}

export const PROSPECT_LIST_TYPES = ["HOTEL_PROSPECTS", "CO_MARKETING_PARTNERS", "GENERAL_BUSINESS"] as const;
export type ProspectListType = (typeof PROSPECT_LIST_TYPES)[number];

export interface ImportQualityBreakdown {
  score: number; // 0 to 100
  hasEmail: boolean;
  hasName: boolean;
  hasCompany: boolean;
  hasTargeting: boolean;
  essentialMissing: string[];
  recommendedMissing: string[];
  personalizationTagsReady: string[];
}

export interface ImportPreviewDto {
  fileName: string;
  /** Every non-empty sheet (one entry for CSV) */
  sheets: ImportSheetInfo[];
  /** The sheet this preview shows, or ALL_SHEETS */
  sheet: string;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
  suggestedMapping: Record<string, ImportTarget>;
  suggestedListType: ProspectListType;
  readinessScore: number;
  qualityBreakdown: ImportQualityBreakdown;
}

export interface ImportProblemRow {
  /** invalid: no usable address, row is left out unless fixed. typo: imported as written unless corrected */
  kind: "invalid" | "typo";
  ref: string;
  sheet: string;
  row: number;
  /** What the email column(s) actually contained */
  raw: string;
  /** A likely correction for the person to confirm, if one could be guessed */
  suggestion: string | null;
  /** typo rows: the address as read from the cell */
  found?: string;
  /** Name/company from the same row, to help recognise who it is */
  context: string;
  message: string;
}

/** Result of checking the email column before importing */
export interface ImportAnalysisDto {
  totalRows: number;
  /** Unique addresses that will be imported */
  contacts: number;
  /** Rows whose cell held more than one address */
  multiEmailRows: number;
  /** Rows where extra text around the address was removed */
  cleanedRows: number;
  /** Rows repaired by a confirmed correction */
  fixedRows: number;
  /** Rows the person chose to skip */
  skippedRows: number;
  /** Addresses that appear more than once in the file */
  duplicatesInFile: number;
  /** Rows needing a person: invalid ones first, then possible typos (capped; see the counts) */
  problems: ImportProblemRow[];
  problemCount: number;
  /** Valid addresses at a misspelt provider, e.g. @gmial.com */
  typoCount: number;
}

/** A row that wasn't imported; `sheet` is omitted for CSV files */
export type ImportRowError = {
  sheet?: string;
  row: number;
  message: string;
};

export interface ImportResultDto {
  id: string;
  fileName: string;
  totalRows: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  addedToList: number;
  list: { id: string; name: string } | null;
  errors: ImportRowError[];
  suppressedInFile: number;
}

// ============================================================================
// TEMPLATES
// ============================================================================

export const TemplateInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  subject: z.string().trim().min(1, "Subject is required").max(250),
  bodyHtml: z.string().min(1, "Body is required").max(200_000),
  bodyText: optionalText(100_000),
  description: optionalText(500),
  category: optionalText(100),
  scope: TemplateScopeSchema.optional(),
  campaignId: IdSchema.optional().nullable(),
});
export type TemplateInput = z.input<typeof TemplateInputSchema>;

export interface TemplateCampaignRef {
  id: string;
  name: string;
  status: string;
  isFallback?: boolean;
  priority?: number;
}

export interface TemplateDto {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  description: string | null;
  category: string | null;
  version: number;
  scope: TemplateScope;
  createdById: string | null;
  createdBy?: UserRef | null;
  campaignCount: number;
  campaigns?: TemplateCampaignRef[];
  attachments: TemplateAttachmentDto[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplateAttachmentDto {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

// ============================================================================
// CAMPAIGNS & SENDS
// ============================================================================

export const CampaignStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "SENDING",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const CAMPAIGN_AUTOMATION_MODES = ["MANUAL", "APPROVAL_REQUIRED", "AUTOMATIC"] as const;
export type CampaignAutomationMode = (typeof CAMPAIGN_AUTOMATION_MODES)[number];
export const CampaignAutomationModeSchema = z.enum(CAMPAIGN_AUTOMATION_MODES);

export const CAMPAIGN_OUTREACH_TYPES = [
  "CUSTOMER_OUTREACH",
  "PARTNERSHIPS",
  "ADVISORS",
  "HIRING_TALENT",
  "PRESS_MEDIA",
  "OTHER",
] as const;
export type CampaignOutreachType = (typeof CAMPAIGN_OUTREACH_TYPES)[number];
export const CampaignOutreachTypeSchema = z.enum(CAMPAIGN_OUTREACH_TYPES);

export const CAMPAIGN_OUTREACH_TYPE_LABELS: Record<CampaignOutreachType, string> = {
  CUSTOMER_OUTREACH: "Customer Outreach",
  PARTNERSHIPS: "Partnerships",
  ADVISORS: "Advisors",
  HIRING_TALENT: "Hiring & Talent",
  PRESS_MEDIA: "Press & Media",
  OTHER: "Other",
};

export const CAMPAIGN_AUTOMATION_MODE_LABELS: Record<CampaignAutomationMode, { label: string; description: string }> = {
  MANUAL: {
    label: "Manual",
    description: "You review, draft, and trigger each email manually.",
  },
  APPROVAL_REQUIRED: {
    label: "Approval required",
    description: "System prepares and schedules follow-ups when due, but waits for explicit approval before sending each one.",
  },
  AUTOMATIC: {
    label: "Automatic follow-ups",
    description: "Approved sequence steps are sent automatically when due and all stopping conditions are satisfied.",
  },
};

export const RECIPIENT_SEQUENCE_STATES = [
  "PENDING_INITIAL",
  "INITIAL_SENT",
  "FOLLOW_UP_SCHEDULED",
  "AWAITING_APPROVAL",
  "FOLLOW_UP_SENT",
  "REPLY_RECEIVED",
  "BOUNCED",
  "SUPPRESSED",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
] as const;
export type RecipientSequenceState = (typeof RECIPIENT_SEQUENCE_STATES)[number];
export const RecipientSequenceStateSchema = z.enum(RECIPIENT_SEQUENCE_STATES);

export const RECIPIENT_SEQUENCE_STATE_LABELS: Record<RecipientSequenceState, { label: string; tone: "brand" | "neutral" | "success" | "warning" | "danger" | "info" }> = {
  PENDING_INITIAL: { label: "Pending Initial Send", tone: "neutral" },
  INITIAL_SENT: { label: "Initial Sent", tone: "brand" },
  FOLLOW_UP_SCHEDULED: { label: "Follow-up Scheduled", tone: "info" },
  AWAITING_APPROVAL: { label: "Awaiting Approval", tone: "warning" },
  FOLLOW_UP_SENT: { label: "Follow-up Sent", tone: "brand" },
  REPLY_RECEIVED: { label: "Reply Received — Action Required", tone: "success" },
  BOUNCED: { label: "Bounced", tone: "danger" },
  SUPPRESSED: { label: "Suppressed", tone: "danger" },
  PAUSED: { label: "Sequence Paused", tone: "warning" },
  COMPLETED: { label: "Sequence Completed", tone: "neutral" },
  CANCELLED: { label: "Sequence Cancelled", tone: "neutral" },
};

export const SequenceStepInputSchema = z.object({
  stepIndex: z.coerce.number().int().min(0),
  purpose: z.string().trim().min(1, "Purpose is required").max(100),
  delayDays: z.coerce.number().int().min(0).max(60).default(3),
  delayBusinessDaysOnly: z.boolean().default(true),
  subjectMode: z.enum(["THREADED", "STANDALONE"]).default("THREADED"),
  customSubject: z.string().trim().max(250).optional().nullable(),
  templateId: IdSchema,
  promptInstructions: z.string().trim().max(2000).optional().nullable(),
});
export type SequenceStepInput = z.infer<typeof SequenceStepInputSchema>;

export interface SequenceStepDto {
  id: string;
  campaignId: string;
  stepIndex: number;
  purpose: string;
  delayDays: number;
  delayBusinessDaysOnly: boolean;
  subjectMode: "THREADED" | "STANDALONE";
  customSubject: string | null;
  templateId: string;
  templateName: string;
  templateSubject: string;
  promptInstructions: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignRecipientStateDto {
  id: string;
  campaignId: string;
  contactId: string | null;
  email: string;
  state: RecipientSequenceState;
  currentStepIndex: number;
  nextActionAt: string | null;
  nextStepIndex: number | null;
  pausedReason: string | null;
  cancelledReason: string | null;
  lastSentAt: string | null;
  lastMessageId: string | null;
  repliedAt: string | null;
  bouncedAt: string | null;
  unsubscribedAt: string | null;
  history?: {
    sendId: string;
    stepIndex: number;
    subject: string;
    sentAt: string | null;
    status: string;
    messageId: string;
  }[];
}

export const DeliveryStatusSchema = z.enum(["PENDING", "CLAIMED", "SENT", "FAILED", "UNKNOWN", "SKIPPED", "CANCELLED"]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const DEFAULT_SEND_RATE_PER_MINUTE = 10;
export const MAX_MAILBOX_SEND_RATE_PER_MINUTE = 10;

export const CampaignInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: optionalText(500),
  outreachType: CampaignOutreachTypeSchema.default("CUSTOMER_OUTREACH"),
  templateId: IdSchema,
  contactListId: IdSchema,
  fromName: z.string().trim().min(1, "Sender name is required").max(100),
  fromEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid sender email address")
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  mailboxId: IdSchema.optional().nullable(),
  replyTo: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid reply-to address")
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  sendRatePerMinute: z.coerce.number().int().min(1).max(120).default(DEFAULT_SEND_RATE_PER_MINUTE),
  automationMode: CampaignAutomationModeSchema.default("APPROVAL_REQUIRED"),
  sequenceSteps: z.array(SequenceStepInputSchema).optional(),
  templates: z
    .array(
      z.object({
        templateId: IdSchema,
        isFallback: z.boolean().default(false),
        priority: z.coerce.number().int().default(0),
      })
    )
    .optional(),
  rules: z
    .array(
      z.object({
        templateId: IdSchema,
        priority: z.coerce.number().int().min(1).default(1),
        hotelSegment: optionalText(100),
        contactPersona: optionalText(100),
        requiresVerified: z.boolean().default(false),
        minConfidence: z.coerce.number().min(0).max(1).optional().nullable(),
        city: optionalText(100),
        description: optionalText(500),
      })
    )
    .optional(),
});
export type CampaignInput = z.input<typeof CampaignInputSchema>;

export const TestSendInputSchema = z.object({
  to: z.array(EmailSchema).min(1, "Add at least one address").max(5, "Up to 5 test addresses"),
  contactId: IdSchema.optional(),
  dryRun: z.boolean().default(false),
});
export type TestSendInput = z.input<typeof TestSendInputSchema>;

export interface UserRef {
  id: string;
  name: string;
}

export interface CampaignCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  unknown: number;
  skipped: number;
  cancelled: number;
  bounced: number;
  replied: number;
  unsubscribed: number;
  uniqueRecipients?: number;
  uniqueReached?: number;
  uniqueReplied?: number;
  uniqueBounced?: number;
  uniqueUnsubscribed?: number;
}

export interface CampaignSummaryDto {
  id: string;
  name: string;
  status: CampaignStatus;
  outreachType: CampaignOutreachType;
  template: { id: string; name: string };
  list: { id: string; name: string; memberCount: number };
  counts: CampaignCounts;
  mailboxId?: string | null;
  createdById?: string | null;
  createdBy: UserRef | null;
  approvedBy: UserRef | null;
  approvalRole?: UserRole | null;
  collaborators?: CampaignCollaboratorDto[];
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  pausedReason: string | null;
}

export interface CampaignTemplateDto {
  id: string;
  campaignId: string;
  templateId: string;
  name: string;
  subject: string;
  version: number;
  isFallback: boolean;
  priority: number;
}

export const CampaignTemplateInputSchema = z.object({
  templateId: IdSchema,
  isFallback: z.boolean().default(false),
  priority: z.coerce.number().int().default(0),
});
export type CampaignTemplateInput = z.input<typeof CampaignTemplateInputSchema>;

export const CampaignRuleInputSchema = z.object({
  templateId: IdSchema,
  priority: z.coerce.number().int().min(1).default(1),
  hotelSegment: optionalText(100),
  contactPersona: optionalText(100),
  requiresVerified: z.boolean().default(false),
  minConfidence: z.coerce.number().min(0).max(1).optional().nullable(),
  city: optionalText(100),
  description: optionalText(500),
});
export type CampaignRuleInput = z.input<typeof CampaignRuleInputSchema>;

export interface CampaignRuleDto {
  id: string;
  campaignId: string;
  templateId: string;
  templateName: string;
  priority: number;
  hotelSegment: string | null;
  contactPersona: string | null;
  requiresVerified: boolean;
  minConfidence: number | null;
  city: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CampaignRecipientOverrideInputSchema = z.object({
  contactId: IdSchema,
  templateId: IdSchema.optional(),
  reason: optionalText(500),
  customSubject: z.string().trim().max(500).optional().nullable(),
  customBodyHtml: z.string().trim().max(50000).optional().nullable(),
  customBodyText: z.string().trim().max(50000).optional().nullable(),
  isCustom: z.boolean().default(false),
});
export type CampaignRecipientOverrideInput = z.input<typeof CampaignRecipientOverrideInputSchema>;

export interface CampaignRecipientOverrideDto {
  id: string;
  campaignId: string;
  contactId: string;
  contactEmail: string;
  templateId: string;
  templateName: string;
  reason: string | null;
  customSubject: string | null;
  customBodyHtml: string | null;
  customBodyText: string | null;
  isCustom: boolean;
  createdAt: string;
}

export interface ReviewRecipientSample {
  contactId: string;
  email: string;
  subject: string;
  html: string;
  text: string;
  missingFields: string[];
  templateId: string;
  templateName: string;
  assignmentSource: "OVERRIDE" | "RULE" | "FALLBACK";
  assignmentReason: string;
  attachments?: string[];
  isCustom?: boolean;
}

export interface TemplateBreakdownItem {
  templateId: string;
  templateName: string;
  count: number;
  isFallback: boolean;
}

export interface CampaignDetailDto extends CampaignSummaryDto {
  description: string | null;
  fromName: string;
  fromEmail: string | null;
  replyTo: string | null;
  sendRatePerMinute: number;
  approvalRequestedBy: UserRef | null;
  approvalRequestedAt: string | null;
  cancelledAt: string | null;
  /** Frozen content after approval; null while editable */
  snapshot: { subject: string; bodyHtml: string; bodyText: string | null } | null;
  liveSendingBlocker: string | null;
  automationMode: CampaignAutomationMode;
  sequenceSteps: SequenceStepDto[];
  templates: CampaignTemplateDto[];
  rules: CampaignRuleDto[];
  overridesCount: number;
}

export interface RecipientIssue {
  email: string;
  contactId: string | null;
  reason: string;
}

/** Pre-approval check of every recipient against the current templates and rules */
export interface CampaignReviewDto {
  total: number;
  ready: number;
  templateErrors: string[];
  missingFields: { email: string; contactId: string; fields: string[] }[];
  suppressed: RecipientIssue[];
  issueCount: number;
  sample: ReviewRecipientSample[];
  templateBreakdown: TemplateBreakdownItem[];
  rulesCount: number;
  /** Fingerprint of the template content reviewed; approval must echo it back */
  contentHash: string;
}

export const ApproveInputSchema = z.object({
  contentHash: z.string().min(1),
  ready: z.number().int().nonnegative(),
});

export interface SendDto {
  id: string;
  email: string;
  contactId: string | null;
  subject?: string | null;
  status: DeliveryStatus;
  skipReason: string | null;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  bouncedAt: string | null;
  repliedAt: string | null;
  unsubscribedAt: string | null;
  updatedAt: string;
  templateId?: string | null;
  templateVersion?: number | null;
  assignmentReason?: string | null;
  stepIndex: number;
  scheduledFor: string | null;
  approvedAt: string | null;
  inReplyToId: string | null;
  isCustom: boolean;
  contact?: {
    firstName: string | null;
    lastName: string | null;
    company: string | null;
  } | null;
  conversation?: {
    id: string;
    status: ConversationStatus;
    snippet?: string | null;
    outcome?: string | null;
    meetingAt?: string | null;
  } | null;
}

export interface CampaignRecipientSummaryDto {
  campaignId: string;
  email: string;
  contactId: string | null;
  contact: {
    firstName: string | null;
    lastName: string | null;
    company: string | null;
  } | null;
  emailsSent: number;
  stepsCompleted: number;
  stepsTotal: number;
  deliverySummary: DeliveryStatus | "AWAITING_APPROVAL" | "SCHEDULED";
  recipientState: RecipientSequenceState | null;
  currentConversation: {
    id: string;
    status: ConversationStatus;
    snippet: string | null;
    outcome: string | null;
    meetingAt: string | null;
    lastMessageAt: string;
  } | null;
  conversationCount: number;
  lastActivityAt: string | null;
  lastActivityLabel: string;
  nextActionAt: string | null;
  nextActionLabel: string;
  progressLabel: string;
  timeline: SendDto[];
  primarySendId: string;
}

export interface CampaignRecipientsResponseDto {
  items: CampaignRecipientSummaryDto[];
  deliveryCounts: Record<string, number>;
  conversationCounts: {
    total: number;
    counts: Record<ConversationStatus, number>;
  };
}

export interface CampaignAnalyticsSummaryDto {
  campaignId: string;
  campaignName: string;
  totalRecipients: number;
  totalSends?: number;
  uniqueReachedCount?: number;
  totalInboundMessages?: number;
  attemptedSends: number;
  providerAcceptedCount: number;
  bouncedCount: number;
  repliedCount: number;
  positiveRepliesCount: number;
  meetingsBookedCount: number;
  unsubscribedCount: number;
  rates: {
    bounceRate: number;
    replyRate: number;
    positiveReplyRate: number;
    meetingRate: number;
    unsubscribeRate: number;
    positiveOutcomeRate?: number;
  };
  byTemplate: {
    templateId: string;
    templateName: string;
    templateVersion: number;
    assignedCount: number;
    sentCount: number;
    repliedCount: number;
    positiveRepliesCount: number;
    meetingsBookedCount: number;
    replyRate?: number;
  }[];
  byHotelSegment: {
    segment: string;
    assignedCount: number;
    sentCount: number;
    repliedCount: number;
    positiveRepliesCount: number;
    meetingsBookedCount: number;
  }[];
  byContactPersona: {
    persona: string;
    assignedCount: number;
    sentCount: number;
    repliedCount: number;
    positiveRepliesCount: number;
    meetingsBookedCount: number;
  }[];
  bySequenceStep?: {
    stepIndex: number;
    purpose: string;
    assignedCount: number;
    recipientsReached?: number;
    sentCount: number;
    repliedCount: number;
    positiveRepliesCount: number;
    meetingsBookedCount: number;
    bouncedCount: number;
    replyRate: number;
  }[];
  timeline?: {
    date: string;
    sent: number;
    replied: number;
    bounced: number;
  }[];
  outcomeBreakdown?: {
    noResponse: number;
    replied: number;
    interested: number;
    notInterested: number;
    meetingBooked: number;
    bounced: number;
    unsubscribed: number;
    pending: number;
  };
}

export interface TemplatePerformanceItemDto {
  templateId: string;
  templateName: string;
  currentVersion: number;
  subject: string;
  assignedCount: number;
  attemptedCount: number;
  providerAcceptedCount: number;
  deliveredCount: number;
  failedCount: number;
  bouncedCount: number;
  repliedCount: number;
  positiveRepliesCount: number;
  negativeRepliesCount: number;
  neutralRepliesCount: number;
  outOfOfficeCount: number;
  meetingsBookedCount: number;
  unsubscribedCount: number;
  deliveryRate: number;
  replyRate: number;
  positiveReplyRate: number;
  meetingRate: number;
  unsubscribeRate: number;
  isLimitedData: boolean;
  bySegment: {
    segment: string;
    deliveredCount: number;
    repliedCount: number;
    replyRate: number;
    meetingsCount: number;
  }[];
  byPersona: {
    persona: string;
    deliveredCount: number;
    repliedCount: number;
    replyRate: number;
    meetingsCount: number;
  }[];
}

export interface ActionableInsightDto {
  type: "top_performer" | "audience_gap" | "conversion_leak" | "low_sample_warning" | "reply_theme";
  category: "OBSERVATION" | "HYPOTHESIS";
  title: string;
  description: string;
  metricBadge?: string;
  recommendation?: string;
}

export interface WorkspaceTemplateAnalyticsDto {
  overview: {
    totalTemplatesEvaluated: number;
    totalAssigned: number;
    totalAttempted: number;
    totalProviderAccepted: number;
    totalDelivered: number;
    totalBounced: number;
    totalReplies: number;
    totalPositiveReplies: number;
    totalMeetingsBooked: number;
    overallDeliveryRate: number;
    overallReplyRate: number;
    overallMeetingRate: number;
  };
  templates: TemplatePerformanceItemDto[];
  insights: ActionableInsightDto[];
  availableFilters: {
    campaigns: { id: string; name: string }[];
    segments: string[];
    personas: string[];
  };
}

export const TemplateAnalyticsQuerySchema = z.object({
  campaignId: z.string().optional(),
  dateRange: z.enum(["7d", "30d", "90d", "all"]).default("all").optional(),
  hotelSegment: z.string().optional(),
  contactPersona: z.string().optional(),
  templateId: z.string().optional(),
});
export type TemplateAnalyticsQuery = z.infer<typeof TemplateAnalyticsQuerySchema>;


// ============================================================================
// SUPPRESSIONS
// ============================================================================

export const SuppressionReasonSchema = z.enum([
  "HARD_BOUNCE",
  "SOFT_BOUNCE",
  "SPAM_COMPLAINT",
  "UNSUBSCRIBE",
  "MANUAL",
  "INVALID_EMAIL",
  "DOMAIN_SUPPRESSION",
]);
export type SuppressionReason = z.infer<typeof SuppressionReasonSchema>;

export const SUPPRESSION_REASON_LABELS: Record<SuppressionReason, string> = {
  HARD_BOUNCE: "Bounced",
  SOFT_BOUNCE: "Soft bounce",
  SPAM_COMPLAINT: "Spam complaint",
  UNSUBSCRIBE: "Unsubscribed",
  MANUAL: "Added manually",
  INVALID_EMAIL: "Invalid address",
  DOMAIN_SUPPRESSION: "Domain blocked",
};

export const SuppressionInputSchema = z.object({
  email: EmailSchema,
  reason: z.enum(["MANUAL", "UNSUBSCRIBE", "SPAM_COMPLAINT", "INVALID_EMAIL"]).default("MANUAL"),
  note: optionalText(500),
});
export type SuppressionInput = z.input<typeof SuppressionInputSchema>;

export interface SuppressionDto {
  id: string;
  email: string;
  reason: SuppressionReason;
  source: string;
  note: string | null;
  createdAt: string;
}

// ============================================================================
// ENRICHMENT
// ============================================================================

export const EnrichmentStatusSchema = z.enum(["GUESSED", "VERIFIED", "MANUAL", "REJECTED"]);
export type EnrichmentStatus = z.infer<typeof EnrichmentStatusSchema>;

export const EnrichmentInputSchema = z.object({
  field: z.string().trim().regex(CUSTOM_FIELD_NAME, "Field names use letters, numbers and _"),
  value: z.string().trim().min(1, "Value is required").max(2000),
  source: z.string().trim().min(1, "Say where this came from").max(100),
  url: z.string().trim().url("Enter a full link, starting with https://").optional().or(z.literal("").transform(() => undefined)),
  note: optionalText(1000),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
  /** I checked this myself against the source */
  verified: z.boolean().default(false),
});
export type EnrichmentInput = z.input<typeof EnrichmentInputSchema>;

export interface EnrichmentDto {
  id: string;
  contactId: string;
  field: string;
  value: string;
  source: string;
  url: string | null;
  note: string | null;
  confidence: number;
  status: EnrichmentStatus;
  verifiedBy: string | null;
  verifiedAt: string | null;
  appliedAt: string | null;
  /** What the contact currently holds for this field */
  currentValue: string | null;
  createdAt: string;
}

// ============================================================================
// OVERVIEW, MAILBOX, ACTIVITY
// ============================================================================

export interface MailboxAssignedUserDto {
  userId: string;
  userName: string;
  userEmail: string;
  userRole: UserRole;
  employeeId?: string | null;
  senderName: string | null;
  isDefault: boolean;
  assignedAt: string;
}

export interface MailboxAccountDto {
  id: string;
  email: string;
  fromName: string;
  lastVerifiedAt: string;
  createdAt: string;
  assignedUsers: MailboxAssignedUserDto[];
}

export interface UserAccessibleMailboxDto {
  id: string;
  email: string;
  fromName: string;
  senderName: string;
  isDefault: boolean;
  lastVerifiedAt: string;
}

export const ConnectMailboxInputSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(1024).optional(),
  fromName: z.string().trim().min(1, "Sender display name is required").max(100),
  assignUserIds: z.array(IdSchema).optional(),
});
export type ConnectMailboxInput = z.infer<typeof ConnectMailboxInputSchema>;

export const AssignMailboxUserInputSchema = z.object({
  userId: IdSchema,
  senderName: optionalText(100),
  isDefault: z.boolean().default(false),
});
export type AssignMailboxUserInput = z.infer<typeof AssignMailboxUserInputSchema>;

export const UpdateMailboxUserInputSchema = z.object({
  senderName: optionalText(100),
  isDefault: z.boolean().default(false),
});
export type UpdateMailboxUserInput = z.infer<typeof UpdateMailboxUserInputSchema>;

export interface MailboxBudgetUsageDto {
  mailboxId: string | null;
  email: string;
  fromName: string;
  sentLast24h: number;
  dailyLimit: number;
  remainingBudget: number;
  activeCampaigns: number;
  pendingSends: number;
}

export interface MailboxStatusDto {
  smtp: { configured: boolean; host: string | null; port: number; secure: boolean; user: string | null; fromEmail: string | null; fromName: string };
  imap: {
    configured: boolean;
    enabled: boolean;
    host: string | null;
    port: number;
    lastCheckedAt: string | null;
    lastError: string | null;
    unmatchedReplies?: { from: string; subject: string; snippet: string; date: string; detectedSentiment: string }[];
  };
  teamMailboxHealth?: {
    activeUsers: number;
    connectedMailboxes: number;
    inboxErrors: number;
    inboxesNotChecked: number;
  };
  accessibleMailboxes?: UserAccessibleMailboxDto[];
  allMailboxes?: MailboxAccountDto[];
  mailboxesUsage?: MailboxBudgetUsageDto[];
  liveSendingEnabled: boolean;
  liveSendingBlocker: string | null;
  dailyLimit: number;
  sentLast24h: number;
  publicUrl: string;
}

export const OverviewFilterQuerySchema = z.object({
  dateRange: z.enum(["7d", "30d", "90d", "all"]).default("30d"),
  outreachType: CampaignOutreachTypeSchema.optional(),
  ownerId: z.string().optional(),
});
export type OverviewFilterQuery = z.infer<typeof OverviewFilterQuerySchema>;

export interface OutreachTypeMetricDto {
  outreachType: CampaignOutreachType;
  label: string;
  reached: number;
  replies: number;
  replyRate: number;
  positiveOutcomes: number;
  positiveRate: number;
  activeCampaigns: number;
  totalCampaigns: number;
}

export interface TeamOutreachMetricDto {
  userId: string;
  userName: string;
  userEmail: string;
  userRole: UserRole;
  assigned: number;
  reached: number;
  replies: number;
  replyRate: number;
  positiveOutcomes: number;
  positiveRate: number;
  pendingWork: {
    pendingApprovals: number;
    dueFollowUps: number;
    deliveryExceptions: number;
    total: number;
  };
}

export interface DailyActivityTrendDto {
  date: string;
  label: string;
  reached: number;
  replies: number;
  positiveOutcomes: number;
}

export interface OutreachFunnelDto {
  reached: number;
  replies: number;
  positiveOutcomes: number;
  meetings: number;
  replyRate: number;
  positiveRate: number;
  meetingRate: number;
  overallConversionRate: number;
}

export interface AttentionItemDto {
  id: string;
  type: "OVERDUE_FOLLOW_UP" | "UNANSWERED_REPLY" | "PENDING_APPROVAL" | "MAILBOX_ISSUE" | "DELIVERY_EXCEPTION" | "MEETING_COORDINATION" | "OVERDUE_ACTION";
  title: string;
  subtitle: string;
  link: string;
  linkLabel: string;
  severity: "high" | "medium" | "low";
  createdAt?: string;
}

export interface ConversationStatusBreakdownDto {
  needsReply: number;
  waitingForContact: number;
  meetingCoordination: number;
  meetingScheduled: number;
  interested: number;
  notInterested: number;
  closed: number;
  totalConversations: number;
}

export interface ActiveCampaignOutreachDto extends CampaignSummaryDto {
  outreachType: CampaignOutreachType;
  positiveOutcomes: number;
  meetingsBooked: number;
}

export interface OverviewExecutiveKpisDto {
  totalReached: number;
  previousReached: number;
  replies: number;
  previousReplies: number;
  replyRate: number;
  positiveOutcomes: number;
  previousPositiveOutcomes: number;
  positiveRate: number;
  activeOutreachCampaigns: number;
  totalCampaigns: number;
}

export interface OverviewDto {
  counts: { contacts: number; lists: number; templates: number; suppressed: number };
  mailbox: Pick<MailboxStatusDto, "liveSendingEnabled" | "liveSendingBlocker" | "dailyLimit" | "sentLast24h"> & { smtpConfigured: boolean };
  awaitingApproval: CampaignSummaryDto[];
  inProgress: CampaignSummaryDto[];
  needsAttention: { campaign: { id: string; name: string }; failed: number; unknown: number }[];
  recent: CampaignSummaryDto[];
  last30Days: {
    started: number;
    sent: number;
    bounced: number;
    replied: number;
    positiveReplies: number;
    meetingsBooked: number;
    unsubscribed: number;
  };
  previous30Days: OverviewDto["last30Days"];
  kpis?: OverviewExecutiveKpisDto;
  funnel?: OutreachFunnelDto;
  outreachByType?: OutreachTypeMetricDto[];
  teamOutreach?: TeamOutreachMetricDto[];
  activityTrend?: DailyActivityTrendDto[];
  conversationBreakdown?: ConversationStatusBreakdownDto;
  actionableAttention?: AttentionItemDto[];
  activeCampaigns?: ActiveCampaignOutreachDto[];
  availableFilters?: {
    owners: { id: string; name: string }[];
    outreachTypes: { value: CampaignOutreachType; label: string }[];
  };
}

export interface WorkspaceQueueSendDto {
  id: string;
  campaignId: string;
  campaignName: string;
  contactId: string | null;
  contactName: string | null;
  email: string;
  status: DeliveryStatus;
  stepIndex: number;
  lastError: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  scheduledFor: string | null;
  subject?: string | null;
  classification?: string | null;
  snippet?: string | null;
}

export interface WorkspaceQueueDto {
  campaigns: CampaignSummaryDto[];
  pendingApproval: CampaignSummaryDto[];
  readyToSend?: CampaignSummaryDto[];
  drafts?: CampaignSummaryDto[];
  campaignsNeedingAttention: CampaignSummaryDto[];
  replies: WorkspaceQueueSendDto[];
  dueFollowUps: WorkspaceQueueSendDto[];
  failedSends: WorkspaceQueueSendDto[];
  unknownSends: WorkspaceQueueSendDto[];
  counts: {
    replies: number;
    dueFollowUps: number;
    failedSends: number;
    unknownSends: number;
    pendingApproval?: number;
    readyToSend?: number;
  };
}

export interface ActivityDto {
  id: string;
  action: string;
  summary: string;
  entityType: string | null;
  entityId: string | null;
  user: UserRef | null;
  createdAt: string;
}

export type NotificationType =
  | "INBOUND_REPLY"
  | "FOLLOW_UP_DUE"
  | "APPROVAL_REQUIRED"
  | "CAMPAIGN_COMPLETED"
  | "CAMPAIGN_FAILED"
  | "MAILBOX_ISSUE"
  | "OUTREACH_ASSIGNMENT"
  | "IMPORTANT_OUTCOME";

export interface NotificationItemDto {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  time: string;
  tone: "alert" | "warning" | "action" | "info" | "success";
  link: string;
  linkLabel?: string;
  category: "reply" | "follow_up" | "approval" | "campaign" | "mailbox" | "assignment" | "outcome";
  entityId?: string;
}

export type ConversationStatus =
  | "NEEDS_REPLY"
  | "WAITING_FOR_CONTACT"
  | "MEETING_COORDINATION"
  | "MEETING_SCHEDULED"
  | "INTERESTED"
  | "NOT_INTERESTED"
  | "CLOSED";

export type MessageDirection = "INBOUND" | "OUTBOUND";

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  NEEDS_REPLY: "Needs Reply",
  WAITING_FOR_CONTACT: "Waiting for Contact",
  MEETING_COORDINATION: "Meeting Coordination",
  MEETING_SCHEDULED: "Meeting Scheduled",
  INTERESTED: "Interested",
  NOT_INTERESTED: "Not Interested",
  CLOSED: "Closed",
};

export const CONVERSATION_STATUS_TONES: Record<ConversationStatus, "warning" | "info" | "brand" | "success" | "neutral" | "danger"> = {
  NEEDS_REPLY: "warning",
  WAITING_FOR_CONTACT: "info",
  MEETING_COORDINATION: "brand",
  MEETING_SCHEDULED: "success",
  INTERESTED: "success",
  NOT_INTERESTED: "danger",
  CLOSED: "neutral",
};

export interface ConversationMessageDto {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  senderEmail: string;
  senderName: string | null;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  bodyText: string;
  cleanBody?: string;
  quotedText?: string | null;
  bodyHtml: string | null;
  snippet: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  sentAt: string;
  sendId: string | null;
  attachments: unknown[];
  createdAt: string;
}

export interface ConversationDto {
  id: string;
  campaignId: string;
  campaignName?: string;
  contactId: string | null;
  contactName?: string | null;
  recipientEmail: string;
  ownerId: string | null;
  ownerName?: string | null;
  initialSendId: string | null;
  status: ConversationStatus;
  subject: string;
  sentiment: string | null;
  snippet: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  meetingAt: string | null;
  meetingNotes: string | null;
  outcome: string | null;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  messages?: ConversationMessageDto[];
}


