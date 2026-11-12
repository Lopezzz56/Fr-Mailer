import { describe, expect, it } from "vitest";
import { safeCampaignPausedReason, toTemplateDto } from "./serialize.js";

describe("safeCampaignPausedReason", () => {
  it("replaces persisted Prisma schema errors with an actionable message", () => {
    expect(
      safeCampaignPausedReason(
        "Campaign owner mailbox credentials are unavailable: Invalid `prisma.userMailbox.findFirst()` invocation. The table `public.user_mailboxes` does not exist in the current database."
      )
    ).toBe("The mailbox database migration is missing or not applied. Deploy the latest database migrations, then resume this campaign.");
  });

  it("preserves ordinary campaign pause reasons", () => {
    expect(safeCampaignPausedReason("Couldn't sign in to the mailbox. Check the SMTP password, then resume."))
      .toBe("Couldn't sign in to the mailbox. Check the SMTP password, then resume.");
  });
});

describe("toTemplateDto", () => {
  it("serializes category, scope, and campaign collection references", () => {
    const raw: any = {
      id: "tpl_123",
      name: "Sehej Follow-up 1",
      subject: "Following up on hospitality execution",
      bodyHtml: "<p>Hi {{firstName}}</p>",
      bodyText: "Hi {{firstName}}",
      description: "Follow-up for luxury hotel GMs",
      category: "Follow-up",
      version: 2,
      scope: "CAMPAIGN",
      createdById: "usr_1",
      createdBy: { id: "usr_1", name: "Frank Lopes" },
      attachments: null,
      createdAt: new Date("2026-11-12T10:00:00Z"),
      updatedAt: new Date("2026-11-12T10:30:00Z"),
      campaignTemplates: [
        {
          id: "ct_1",
          campaignId: "cmp_456",
          templateId: "tpl_123",
          isFallback: false,
          priority: 1,
          campaign: {
            id: "cmp_456",
            name: "Sehej's Outreach",
            status: "DRAFT",
          },
        },
      ],
      _count: {
        campaigns: 1,
        campaignTemplates: 1,
      },
    };

    const dto = toTemplateDto(raw);

    expect(dto.id).toBe("tpl_123");
    expect(dto.name).toBe("Sehej Follow-up 1");
    expect(dto.category).toBe("Follow-up");
    expect(dto.scope).toBe("CAMPAIGN");
    expect(dto.campaigns).toHaveLength(1);
    expect(dto.campaigns![0]).toEqual({
      id: "cmp_456",
      name: "Sehej's Outreach",
      status: "DRAFT",
      isFallback: false,
      priority: 1,
    });
    expect(dto.campaignCount).toBe(1);
  });
});

