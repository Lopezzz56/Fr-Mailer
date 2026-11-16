import { describe, it, expect } from "vitest";
import type { NotificationType, NotificationItemDto } from "../../shared/types.js";

describe("Notification vs Activity Log Separation", () => {
  it("defines only actionable notification types", () => {
    const actionableTypes: NotificationType[] = [
      "INBOUND_REPLY",
      "FOLLOW_UP_DUE",
      "APPROVAL_REQUIRED",
      "CAMPAIGN_COMPLETED",
      "CAMPAIGN_FAILED",
      "MAILBOX_ISSUE",
      "OUTREACH_ASSIGNMENT",
      "IMPORTANT_OUTCOME",
    ];

    expect(actionableTypes).toHaveLength(8);

    // Routine events must NOT be in notification types
    const routineActions = [
      "campaign.create",
      "template.edit",
      "contact.import",
      "send.dispatched",
      "user.login",
    ];

    for (const routine of routineActions) {
      expect(actionableTypes).not.toContain(routine);
    }
  });

  it("formats actionable notifications with valid routes and sensible timestamps", () => {
    const now = new Date();
    const item: NotificationItemDto = {
      id: "reply-123",
      type: "INBOUND_REPLY",
      category: "reply",
      title: "Inbound reply from John Doe",
      description: '"We would love to learn more about FocusRealm."',
      time: now.toISOString(),
      tone: "action",
      link: "/campaigns/camp_1?tab=recipients&filter=replied",
      linkLabel: "View reply",
      entityId: "send_123",
    };

    expect(item.type).toBe("INBOUND_REPLY");
    expect(item.tone).toBe("action");
    expect(item.link).toContain("/campaigns/camp_1");
    expect(new Date(item.time).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("correctly identifies high-value positive outcomes for prominent notifications", () => {
    const isPositiveOutcome = (classification?: string, sentiment?: string, meetingBooked?: boolean) => {
      return (
        classification === "POSITIVE" ||
        sentiment === "positive" ||
        Boolean(meetingBooked)
      );
    };

    expect(isPositiveOutcome("POSITIVE", undefined, false)).toBe(true);
    expect(isPositiveOutcome(undefined, "positive", false)).toBe(true);
    expect(isPositiveOutcome("NEUTRAL", "neutral", true)).toBe(true);
    expect(isPositiveOutcome("OUT_OF_OFFICE", "neutral", false)).toBe(false);
  });

  it("maintains separation between notifications and audit log entries", () => {
    // Notifications require action/attention
    const notification: NotificationItemDto = {
      id: "approval-1",
      type: "APPROVAL_REQUIRED",
      category: "approval",
      title: "Approval required: Hotel Partnerships Q4",
      description: "Submitted by Demo Employee · Ready for review",
      time: new Date().toISOString(),
      tone: "action",
      link: "/campaigns/camp_1?tab=review",
      linkLabel: "Review & approve",
    };

    // Audit log records routine user operations for compliance/history
    const auditRecord = {
      id: "audit-1",
      action: "template.update",
      summary: "Updated template 'Initial Outreach Pitch'",
      entityType: "template",
      entityId: "tpl_1",
      createdAt: new Date().toISOString(),
    };

    expect(notification.category).toBe("approval");
    expect(notification.link).toBe("/campaigns/camp_1?tab=review");
    expect(auditRecord.action).toBe("template.update");
  });
});

