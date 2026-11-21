import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "../db.js";
import { _applyClassification, type ImapState } from "./inbox-monitor.js";
import type { IncomingMessage } from "./inbox-classifier.js";
import * as sequenceService from "./sequence-service.js";

describe("Inbox Bounce Handling & Idempotency", () => {
  const baseMessage: IncomingMessage = {
    from: "Mail Delivery System <MAILER-DAEMON@mail.spacemail.com>",
    subject: "Undelivered Mail Returned to Sender",
    headers: {},
    text: "",
    attachments: [],
    date: new Date("2026-11-19T10:00:00Z"),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("handles Final-Recipient hard bounce by updating Send to FAILED, creating suppression, and stopping sequence", async () => {
    const failedEmail = "ghost@example.com";
    const sendId = "send-1";
    const campaignId = "camp-1";

    const mockSend = {
      id: sendId,
      campaignId,
      email: failedEmail,
      status: "SENT",
      bouncedAt: null,
      messageId: "<test-msg-1@focusrealm.org>",
    };

    vi.spyOn(prisma.send, "findMany").mockResolvedValue([mockSend as any]);
    vi.spyOn(prisma.sendEvent, "findFirst").mockResolvedValue(null);

    const updateSpy = vi.fn().mockResolvedValue({});
    const upsertSuppressionSpy = vi.fn().mockResolvedValue({});
    const stopSequenceSpy = vi.spyOn(sequenceService, "stopSequenceForRecipient").mockResolvedValue(1);

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const tx = {
        sendEvent: { create: vi.fn().mockResolvedValue({}) },
        send: { update: updateSpy },
        suppressionEntry: { upsert: upsertSuppressionSpy },
      };
      return cb(tx);
    });

    const msg: IncomingMessage = {
      ...baseMessage,
      attachments: [
        {
          contentType: "message/delivery-status",
          content: `Final-Recipient: rfc822; ${failedEmail}\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown`,
        },
        {
          contentType: "text/rfc822-headers",
          content: "Message-ID: <test-msg-1@focusrealm.org>\nSubject: Outreach",
        },
      ],
    };

    const outcome = await _applyClassification(msg, "focusrealm.org");
    expect(outcome).toBe("bounce");

    // 1. Send status updated to FAILED and bouncedAt set
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sendId },
        data: expect.objectContaining({
          status: "FAILED",
          bouncedAt: msg.date,
        }),
      })
    );

    // 2. HARD_BOUNCE suppressionEntry created
    expect(upsertSuppressionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: failedEmail },
        create: expect.objectContaining({
          email: failedEmail,
          reason: "HARD_BOUNCE",
        }),
      })
    );

    // 3. Future sequence steps stopped
    expect(stopSequenceSpy).toHaveBeenCalledWith(
      campaignId,
      failedEmail,
      expect.stringContaining("Hard bounce"),
      "BOUNCED",
      expect.anything()
    );
  });

  it("handles X-Failed-Recipients fallback matching to active Send", async () => {
    const failedEmail = "haria@adityahospitality.com";
    const sendId = "send-2";
    const campaignId = "camp-sehej";

    // No messageId in headers, so findMany by messageId returns empty
    vi.spyOn(prisma.send, "findMany").mockResolvedValue([]);

    // Fallback findFirst by recipient email returns the active send
    vi.spyOn(prisma.send, "findFirst").mockResolvedValue({
      id: sendId,
      campaignId,
      email: failedEmail,
      status: "SENT",
      bouncedAt: null,
      messageId: "<sehej-1@focusrealm.org>",
    } as any);

    vi.spyOn(prisma.sendEvent, "findFirst").mockResolvedValue(null);

    const updateSpy = vi.fn().mockResolvedValue({});
    const upsertSuppressionSpy = vi.fn().mockResolvedValue({});
    vi.spyOn(sequenceService, "stopSequenceForRecipient").mockResolvedValue(1);

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const tx = {
        sendEvent: { create: vi.fn().mockResolvedValue({}) },
        send: { update: updateSpy },
        suppressionEntry: { upsert: upsertSuppressionSpy },
      };
      return cb(tx);
    });

    const msg: IncomingMessage = {
      ...baseMessage,
      headers: { "x-failed-recipients": failedEmail },
      text: "550 5.1.1 Recipient address rejected: User unknown",
    };

    const outcome = await _applyClassification(msg, "focusrealm.org");
    expect(outcome).toBe("bounce");

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sendId },
        data: expect.objectContaining({
          status: "FAILED",
          bouncedAt: msg.date,
        }),
      })
    );
    expect(upsertSuppressionSpy).toHaveBeenCalled();
  });

  it("handles body-only recipient delivery failure matching to Send", async () => {
    const failedEmail = "abhimanyu.c@chokhidhani.com";
    const sendId = "send-3";
    const campaignId = "camp-sehej";

    vi.spyOn(prisma.send, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.send, "findFirst").mockResolvedValue({
      id: sendId,
      campaignId,
      email: failedEmail,
      status: "SENT",
      bouncedAt: null,
      messageId: "<sehej-3@focusrealm.org>",
    } as any);

    vi.spyOn(prisma.sendEvent, "findFirst").mockResolvedValue(null);

    const updateSpy = vi.fn().mockResolvedValue({});
    const upsertSuppressionSpy = vi.fn().mockResolvedValue({});
    vi.spyOn(sequenceService, "stopSequenceForRecipient").mockResolvedValue(1);

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const tx = {
        sendEvent: { create: vi.fn().mockResolvedValue({}) },
        send: { update: updateSpy },
        suppressionEntry: { upsert: upsertSuppressionSpy },
      };
      return cb(tx);
    });

    const msg: IncomingMessage = {
      ...baseMessage,
      headers: {},
      text: `The following address(es) failed:
  ${failedEmail}
    550 5.1.1 Recipient address rejected`,
    };

    const outcome = await _applyClassification(msg, "focusrealm.org");
    expect(outcome).toBe("bounce");

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sendId },
        data: expect.objectContaining({
          status: "FAILED",
        }),
      })
    );
  });

  it("handles soft bounce by recording SOFT_BOUNCE event without suppressing or marking FAILED", async () => {
    const recipient = "temp-delay@example.com";
    const sendId = "send-soft-1";

    const mockSend = {
      id: sendId,
      campaignId: "camp-soft",
      email: recipient,
      status: "SENT",
      bouncedAt: null,
      messageId: "<soft-msg@focusrealm.org>",
    };

    vi.spyOn(prisma.send, "findMany").mockResolvedValue([mockSend as any]);
    vi.spyOn(prisma.sendEvent, "findFirst").mockResolvedValue(null);

    const createEventSpy = vi.fn().mockResolvedValue({});
    const updateSendSpy = vi.fn().mockResolvedValue({});
    const upsertSuppressionSpy = vi.fn().mockResolvedValue({});
    const stopSequenceSpy = vi.spyOn(sequenceService, "stopSequenceForRecipient");

    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => {
      const tx = {
        sendEvent: { create: createEventSpy },
        send: { update: updateSendSpy },
        suppressionEntry: { upsert: upsertSuppressionSpy },
      };
      return cb(tx);
    });

    const msg: IncomingMessage = {
      ...baseMessage,
      attachments: [
        {
          contentType: "message/delivery-status",
          content: `Final-Recipient: rfc822; ${recipient}\nAction: delayed\nStatus: 4.4.7\nDiagnostic-Code: smtp; 451 4.4.0 Temporary server error`,
        },
        {
          contentType: "text/rfc822-headers",
          content: "Message-ID: <soft-msg@focusrealm.org>",
        },
      ],
    };

    const outcome = await _applyClassification(msg, "focusrealm.org");
    expect(outcome).toBe("bounce");

    // SOFT_BOUNCE event created
    expect(createEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sendId,
          type: "SOFT_BOUNCE",
        }),
      })
    );

    // No suppression, no Send update to FAILED, no sequence cancellation
    expect(updateSendSpy).not.toHaveBeenCalled();
    expect(upsertSuppressionSpy).not.toHaveBeenCalled();
    expect(stopSequenceSpy).not.toHaveBeenCalled();
  });

  it("stores unmatched bounce into unmatchedBounces instead of silently dropping", async () => {
    vi.spyOn(prisma.send, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.send, "findFirst").mockResolvedValue(null); // Unknown recipient

    let savedState: ImapState | null = null;
    vi.spyOn(prisma.setting, "findUnique").mockResolvedValue({
      id: "s-imap",
      key: "imap.state",
      value: { unmatchedBounces: [] },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    (vi.spyOn(prisma.setting, "upsert") as any).mockImplementation(async (args: any) => {
      savedState = args.update.value;
      return {} as any;
    });

    const msg: IncomingMessage = {
      ...baseMessage,
      text: "The following address(es) failed:\n  unknown-person@externaldomain.com\n550 5.1.1 User unknown",
    };

    const outcome = await _applyClassification(msg, "focusrealm.org");
    expect(outcome).toBeNull();

    expect(savedState).not.toBeNull();
    expect(savedState!.unmatchedBounces).toHaveLength(1);
    expect(savedState!.unmatchedBounces![0].recipient).toBe("unknown-person@externaldomain.com");
    expect(savedState!.unmatchedBounces![0].hard).toBe(true);
  });

  it("is idempotent: reprocessing the same bounce does not duplicate events or suppressions", async () => {
    const sendId = "send-dup-bounce";
    const mockSend = {
      id: sendId,
      campaignId: "camp-dup",
      email: "already-bounced@example.com",
      status: "FAILED",
      bouncedAt: new Date("2026-11-19T09:00:00Z"),
      messageId: "<dup-msg@focusrealm.org>",
    };

    vi.spyOn(prisma.send, "findMany").mockResolvedValue([mockSend as any]);
    // Already has HARD_BOUNCE event
    vi.spyOn(prisma.sendEvent, "findFirst").mockResolvedValue({ id: "evt-existing" } as any);

    const txSpy = vi.spyOn(prisma, "$transaction");

    const msg: IncomingMessage = {
      ...baseMessage,
      attachments: [
        {
          contentType: "message/delivery-status",
          content: "Final-Recipient: rfc822; already-bounced@example.com\nStatus: 5.1.1",
        },
        {
          contentType: "text/rfc822-headers",
          content: "Message-ID: <dup-msg@focusrealm.org>",
        },
      ],
    };

    const outcome = await _applyClassification(msg, "focusrealm.org");
    expect(outcome).toBe("bounce");
    expect(txSpy).not.toHaveBeenCalled();
  });
});
