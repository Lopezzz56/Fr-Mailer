// Prisma rows -> API DTOs (src/shared/types.ts). Keeps response shapes in one place.
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { env, liveSendingBlocker } from "../config.js";
import { storedAttachments } from "../services/template-storage.js";
import type {
  CampaignCounts,
  CampaignDetailDto,
  CampaignSummaryDto,
  CampaignTemplateDto,
  ContactDto,
  ContactListDto,
  EnrichmentDto,
  SendDto,
  SuppressionDto,
  TemplateDto,
} from "../../shared/types.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function safeCampaignPausedReason(reason: string | null): string | null {
  if (!reason) return null;
  if (/Invalid `prisma\.|PrismaClient(?:KnownRequest|Initialization)Error|The table `public\./i.test(reason)) {
    return "The mailbox database migration is missing or not applied. Deploy the latest database migrations, then resume this campaign.";
  }
  return reason;
}

export function asStringRecord(value: Prisma.JsonValue | undefined): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = String(v);
  return out;
}

// ---------------------------------------------------------------------------
// Contacts & lists
// ---------------------------------------------------------------------------

export const contactInclude = {
  memberships: { include: { contactList: { select: { id: true, name: true, createdById: true, isShared: true } } } },
} satisfies Prisma.ContactInclude;

type ContactRow = Prisma.ContactGetPayload<{ include: typeof contactInclude }>;

let cachedSuppressions: { map: Map<string, { reason: any; createdAt: Date }>; expiresAt: number } | null = null;
const SUPPRESSIONS_CACHE_TTL_MS = 60_000;

export function invalidateSuppressionsCache(): void {
  cachedSuppressions = null;
}

export async function getSuppressionMap(): Promise<Map<string, { reason: any; createdAt: Date }>> {
  const now = Date.now();
  if (cachedSuppressions && cachedSuppressions.expiresAt > now) {
    return cachedSuppressions.map;
  }
  const all = await prisma.suppressionEntry.findMany({ select: { email: true, reason: true, createdAt: true } });
  const map = new Map(all.map((s) => [s.email.toLowerCase(), { reason: s.reason, createdAt: s.createdAt }]));
  cachedSuppressions = { map, expiresAt: now + SUPPRESSIONS_CACHE_TTL_MS };
  return map;
}

export async function toContactDtos(rows: ContactRow[], userId?: string): Promise<ContactDto[]> {
  if (!rows.length) return [];
  const byEmail = await getSuppressionMap();
  return rows.map((c) => {
    const s = byEmail.get(c.email.toLowerCase());
    return {
      id: c.id,
      email: c.email,
      firstName: c.firstName,
      lastName: c.lastName,
      company: c.company,
      title: c.title,
      phone: c.phone,
      hotelSegment: c.hotelSegment,
      hotelSegmentConfidence: c.hotelSegmentConfidence,
      hotelSegmentStatus: c.hotelSegmentStatus,
      contactPersona: c.contactPersona,
      contactPersonaConfidence: c.contactPersonaConfidence,
      contactPersonaStatus: c.contactPersonaStatus,
      customFields: asStringRecord(c.customFields),
      source: c.source,
      importedAt: c.importedAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      lists: c.memberships
        .filter((m) => !userId || m.contactList.createdById === userId || m.contactList.isShared)
        .map((m) => ({ id: m.contactList.id, name: m.contactList.name })),
      suppression: s ? { reason: s.reason, createdAt: s.createdAt.toISOString() } : null,
    };
  });
}

export function toListDto(l: { id: string; name: string; description: string | null; createdById: string | null; isShared: boolean; createdAt: Date; updatedAt: Date; _count: { members: number } }): ContactListDto {
  return {
    id: l.id,
    name: l.name,
    description: l.description,
    createdById: l.createdById,
    isShared: l.isShared,
    memberCount: l._count.members,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const templateInclude = {
  _count: { select: { campaigns: true, campaignTemplates: true } },
  createdBy: { select: { id: true, name: true } },
  campaignTemplates: {
    select: {
      isFallback: true,
      priority: true,
      campaign: { select: { id: true, name: true, status: true } },
    },
  },
} satisfies Prisma.TemplateInclude;

export function toTemplateDto(t: Prisma.TemplateGetPayload<{ include?: typeof templateInclude }>): TemplateDto {
  const attachments = storedAttachments(t.attachments).map(({ id, name, contentType, size }) => ({
    id,
    name,
    contentType,
    size,
  }));
  const campaigns = (t as any).campaignTemplates
    ? (t as any).campaignTemplates.map((ct: any) => ({
        id: ct.campaign.id,
        name: ct.campaign.name,
        status: ct.campaign.status,
        isFallback: Boolean(ct.isFallback),
        priority: Number(ct.priority ?? 0),
      }))
    : [];

  return {
    id: t.id,
    name: t.name,
    subject: t.subject,
    bodyHtml: t.bodyHtml,
    bodyText: t.bodyText,
    description: t.description,
    category: (t as any).category ?? null,
    version: t.version,
    scope: ((t as any).scope as any) ?? "ORGANIZATION",
    createdById: (t as any).createdById ?? null,
    createdBy: (t as any).createdBy ? { id: (t as any).createdBy.id, name: (t as any).createdBy.name } : null,
    campaignCount: Math.max((t as any)._count?.campaigns ?? 0, (t as any)._count?.campaignTemplates ?? 0, campaigns.length),
    campaigns,
    attachments,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

const userRef = { select: { id: true, name: true } } as const;

export const campaignInclude = {
  template: { select: { id: true, name: true, subject: true, version: true } },
  contactList: { select: { id: true, name: true, _count: { select: { members: true } } } },
  createdBy: userRef,
  approvedByUser: userRef,
  approvalRequestedBy: userRef,
  collaborators: {
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  },
  campaignTemplates: {
    include: { template: { select: { id: true, name: true, subject: true, version: true } } },
    orderBy: { priority: "asc" },
  },
  rules: {
    include: { template: { select: { id: true, name: true } } },
    orderBy: { priority: "asc" },
  },
  sequenceSteps: {
    include: { template: { select: { id: true, name: true, subject: true } } },
    orderBy: { stepIndex: "asc" },
  },
  _count: { select: { recipientOverrides: true } },
} satisfies Prisma.CampaignInclude;

export const campaignSummaryInclude = {
  template: { select: { id: true, name: true, subject: true, version: true } },
  contactList: { select: { id: true, name: true, _count: { select: { members: true } } } },
  createdBy: userRef,
  approvedByUser: userRef,
  collaborators: {
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  },
} satisfies Prisma.CampaignInclude;

export type CampaignSummaryRow = Prisma.CampaignGetPayload<{ include: typeof campaignSummaryInclude }>;
type CampaignRow = Prisma.CampaignGetPayload<{ include: typeof campaignInclude }>;

const emptyCounts = (): CampaignCounts => ({
  total: 0,
  pending: 0,
  sent: 0,
  failed: 0,
  unknown: 0,
  skipped: 0,
  cancelled: 0,
  bounced: 0,
  replied: 0,
  unsubscribed: 0,
  uniqueRecipients: 0,
  uniqueReached: 0,
  uniqueReplied: 0,
  uniqueBounced: 0,
  uniqueUnsubscribed: 0,
});

export async function loadCampaignCounts(campaignIds: string[]): Promise<Map<string, CampaignCounts>> {
  const map = new Map<string, CampaignCounts>(campaignIds.map((id) => [id, emptyCounts()]));
  if (!campaignIds.length) return map;

  const rows = await prisma.$queryRaw<{
    campaignId: string;
    total: bigint;
    pending: bigint;
    sent: bigint;
    failed: bigint;
    unknown: bigint;
    skipped: bigint;
    cancelled: bigint;
    bounced: bigint;
    replied: bigint;
    unsubscribed: bigint;
    uniqueRecipients: bigint;
    uniqueReached: bigint;
    uniqueReplied: bigint;
    uniqueBounced: bigint;
    uniqueUnsubscribed: bigint;
  }[]>`
    SELECT "campaignId",
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status IN ('PENDING', 'CLAIMED')) as pending,
           COUNT(*) FILTER (WHERE status = 'SENT') as sent,
           COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
           COUNT(*) FILTER (WHERE status = 'UNKNOWN') as unknown,
           COUNT(*) FILTER (WHERE status = 'SKIPPED') as skipped,
           COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled,
           COUNT("bouncedAt") as bounced,
           COUNT("repliedAt") as replied,
           COUNT("unsubscribedAt") as unsubscribed,
           COUNT(DISTINCT lower(email)) as "uniqueRecipients",
           COUNT(DISTINCT lower(email)) FILTER (WHERE status = 'SENT') as "uniqueReached",
           COUNT(DISTINCT lower(email)) FILTER (WHERE "repliedAt" IS NOT NULL) as "uniqueReplied",
           COUNT(DISTINCT lower(email)) FILTER (WHERE "bouncedAt" IS NOT NULL) as "uniqueBounced",
           COUNT(DISTINCT lower(email)) FILTER (WHERE "unsubscribedAt" IS NOT NULL) as "uniqueUnsubscribed"
    FROM sends
    WHERE "campaignId" = ANY(${campaignIds})
    GROUP BY "campaignId"`;

  for (const row of rows) {
    const c = map.get(row.campaignId);
    if (!c) continue;
    c.total = Number(row.total);
    c.pending = Number(row.pending);
    c.sent = Number(row.sent);
    c.failed = Number(row.failed);
    c.unknown = Number(row.unknown);
    c.skipped = Number(row.skipped);
    c.cancelled = Number(row.cancelled);
    c.bounced = Number(row.bounced);
    c.replied = Number(row.replied);
    c.unsubscribed = Number(row.unsubscribed);
    c.uniqueRecipients = Number(row.uniqueRecipients);
    c.uniqueReached = Number(row.uniqueReached);
    c.uniqueReplied = Number(row.uniqueReplied);
    c.uniqueBounced = Number(row.uniqueBounced);
    c.uniqueUnsubscribed = Number(row.uniqueUnsubscribed);
  }
  return map;
}

export function toCampaignSummary(c: CampaignSummaryRow | CampaignRow, counts: CampaignCounts): CampaignSummaryDto {
  const collaborators = (c as any).collaborators
    ? (c as any).collaborators.map((col: any) => ({
        id: col.id,
        campaignId: col.campaignId,
        userId: col.userId,
        userName: col.user?.name ?? "",
        userEmail: col.user?.email ?? "",
        role: col.role,
        addedAt: col.addedAt.toISOString(),
      }))
    : undefined;

  return {
    id: c.id,
    name: c.name,
    status: c.status,
    outreachType: ((c as any).outreachType as any) ?? "CUSTOMER_OUTREACH",
    template: c.template,
    list: { id: c.contactList.id, name: c.contactList.name, memberCount: c.contactList._count.members },
    counts,
    mailboxId: (c as any).mailboxId ?? null,
    createdById: (c as any).createdById ?? null,
    createdBy: c.createdBy,
    approvedBy: c.approvedByUser,
    approvalRole: (c as any).approvalRole ?? null,
    collaborators,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    approvedAt: iso(c.approvedAt),
    startedAt: iso(c.startedAt),
    completedAt: iso(c.completedAt),
    pausedReason: safeCampaignPausedReason(c.pausedReason),
  };
}

export async function toCampaignSummaries(rows: (CampaignSummaryRow | CampaignRow)[]): Promise<CampaignSummaryDto[]> {
  const counts = await loadCampaignCounts(rows.map((r) => r.id));
  return rows.map((r) => toCampaignSummary(r, counts.get(r.id)!));
}

export async function toCampaignDetail(c: CampaignRow): Promise<CampaignDetailDto> {
  const counts = (await loadCampaignCounts([c.id])).get(c.id)!;
  const templateMap = new Map<string, CampaignTemplateDto>();
  for (const ct of c.campaignTemplates) {
    templateMap.set(ct.templateId, {
      id: ct.id,
      campaignId: ct.campaignId,
      templateId: ct.templateId,
      name: ct.template.name,
      subject: ct.template.subject,
      version: ct.template.version,
      isFallback: ct.isFallback,
      priority: ct.priority,
    });
  }
  for (const st of c.sequenceSteps) {
    if (!templateMap.has(st.templateId) && st.template) {
      templateMap.set(st.templateId, {
        id: `step-${st.id}`,
        campaignId: c.id,
        templateId: st.templateId,
        name: st.template.name,
        subject: st.template.subject,
        version: 1,
        isFallback: false,
        priority: 0,
      });
    }
  }
  if (templateMap.size === 0 && c.template) {
    templateMap.set(c.template.id, {
      id: `default-${c.template.id}`,
      campaignId: c.id,
      templateId: c.template.id,
      name: c.template.name,
      subject: c.template.subject,
      version: c.template.version,
      isFallback: true,
      priority: 0,
    });
  }
  const templates = Array.from(templateMap.values());

  const rules = c.rules.map((r) => ({
    id: r.id,
    campaignId: r.campaignId,
    templateId: r.templateId,
    templateName: r.template.name,
    priority: r.priority,
    hotelSegment: r.hotelSegment,
    contactPersona: r.contactPersona,
    requiresVerified: r.requiresVerified,
    minConfidence: r.minConfidence,
    city: r.city,
    description: r.description,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  return {
    ...toCampaignSummary(c, counts),
    description: c.description,
    fromName: c.fromName,
    fromEmail: c.fromEmail ?? env.SMTP_FROM_EMAIL ?? null,
    replyTo: c.replyTo,
    sendRatePerMinute: c.sendRatePerMinute,
    approvalRequestedBy: c.approvalRequestedBy,
    approvalRequestedAt: iso(c.approvalRequestedAt),
    cancelledAt: iso(c.cancelledAt),
    snapshot: c.subject && c.bodyHtml ? { subject: c.subject, bodyHtml: c.bodyHtml, bodyText: c.bodyText } : null,
    liveSendingBlocker: liveSendingBlocker(),
    automationMode: c.automationMode,
    sequenceSteps: c.sequenceSteps.map((st) => ({
      id: st.id,
      campaignId: st.campaignId,
      stepIndex: st.stepIndex,
      purpose: st.purpose,
      delayDays: st.delayDays,
      delayBusinessDaysOnly: st.delayBusinessDaysOnly,
      subjectMode: st.subjectMode as "THREADED" | "STANDALONE",
      customSubject: st.customSubject,
      templateId: st.templateId,
      templateName: st.template.name,
      templateSubject: st.template.subject,
      promptInstructions: st.promptInstructions,
      createdAt: st.createdAt.toISOString(),
      updatedAt: st.updatedAt.toISOString(),
    })),
    templates,
    rules,
    overridesCount: c._count.recipientOverrides,
  };
}

export function toSendDto(s: {
  id: string;
  email: string;
  contactId: string | null;
  subject?: string | null;
  status: SendDto["status"];
  skipReason: string | null;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  bouncedAt: Date | null;
  repliedAt: Date | null;
  unsubscribedAt: Date | null;
  updatedAt: Date;
  templateId?: string | null;
  templateVersion?: number | null;
  assignmentReason?: string | null;
  stepIndex?: number;
  scheduledFor?: Date | null;
  approvedAt?: Date | null;
  inReplyToId?: string | null;
  isCustom?: boolean;
  contact?: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
  } | null;
  conversation?: {
    id: string;
    status: any;
    snippet?: string | null;
    outcome?: string | null;
    meetingAt?: Date | null;
  } | null;
}): SendDto {
  return {
    id: s.id,
    email: s.email,
    contactId: s.contactId,
    subject: s.subject ?? null,
    status: s.status,
    skipReason: s.skipReason,
    attempts: s.attempts,
    lastError: s.lastError,
    sentAt: iso(s.sentAt),
    bouncedAt: iso(s.bouncedAt),
    repliedAt: iso(s.repliedAt),
    unsubscribedAt: iso(s.unsubscribedAt),
    updatedAt: s.updatedAt.toISOString(),
    templateId: s.templateId ?? null,
    templateVersion: s.templateVersion ?? null,
    assignmentReason: s.assignmentReason ?? null,
    stepIndex: s.stepIndex ?? 0,
    scheduledFor: iso(s.scheduledFor),
    approvedAt: iso(s.approvedAt),
    inReplyToId: s.inReplyToId ?? null,
    isCustom: Boolean(s.isCustom),
    contact: s.contact
      ? {
          firstName: s.contact.firstName ?? null,
          lastName: s.contact.lastName ?? null,
          company: s.contact.company ?? null,
        }
      : null,
    conversation: s.conversation
      ? {
          id: s.conversation.id,
          status: s.conversation.status,
          snippet: s.conversation.snippet ?? null,
          outcome: s.conversation.outcome ?? null,
          meetingAt: iso(s.conversation.meetingAt),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Suppressions & enrichment
// ---------------------------------------------------------------------------

export function toSuppressionDto(s: { id: string; email: string; reason: SuppressionDto["reason"]; source: string; metadata: Prisma.JsonValue; createdAt: Date }): SuppressionDto {
  const meta = asStringRecord(s.metadata);
  return { id: s.id, email: s.email, reason: s.reason, source: s.source, note: meta.note ?? null, createdAt: s.createdAt.toISOString() };
}

export function toEnrichmentDto(
  e: Prisma.EnrichmentGetPayload<object>,
  currentValue: string | null
): EnrichmentDto {
  const evidence = asStringRecord(e.evidence);
  return {
    id: e.id,
    contactId: e.contactId,
    field: e.field,
    value: e.value,
    source: e.source,
    url: evidence.url ?? null,
    note: evidence.note ?? null,
    confidence: e.confidence,
    status: e.status,
    verifiedBy: e.verifiedBy,
    verifiedAt: iso(e.verifiedAt),
    appliedAt: iso(e.appliedAt),
    currentValue,
    createdAt: e.createdAt.toISOString(),
  };
}
