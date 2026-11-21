import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "../db.js";
import {
  findOrCreateConversation,
  recordInboundReplyToConversation,
  recordOutboundReplyToConversation,
  updateConversation,
  toConversationDto,
  toConversationMessageDto,
} from "./conversation-service.js";

describe("Conversation & Outreach Operations Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Conversation Foundation & Creation", () => {
    it("creates a conversation with initial outbound send as root message", async () => {
      const campaignId = "camp-advisory-1";
      const recipientEmail = "ajay@sarovarhotels.com";
      const sendId = "send-1";

      const mockSend = {
        id: sendId,
        campaignId,
        email: recipientEmail,
        contactId: "contact-ajay",
        sentByUserId: "user-frank",
        subject: "Exploring an Advisory Role with MISE",
        text: "Hi Ajay, reaching out from FocusRealm...",
        html: "<p>Hi Ajay...</p>",
        messageId: "<msg-initial@focusrealm.org>",
        sentAt: new Date("2026-11-13T02:13:00Z"),
        createdAt: new Date("2026-11-13T02:13:00Z"),
        campaign: {
          fromEmail: "founderoffice@focusrealm.org",
          fromName: "Frank Lopes",
          createdById: "user-frank",
        },
      };

      const mockCreatedConv = {
        id: "conv-1",
        campaignId,
        recipientEmail,
        contactId: "contact-ajay",
        ownerId: "user-frank",
        initialSendId: sendId,
        status: "NEEDS_REPLY",
        subject: "Exploring an Advisory Role with MISE",
        sentiment: null,
        snippet: null,
        nextAction: null,
        nextActionDueAt: null,
        meetingAt: null,
        meetingNotes: null,
        outcome: null,
        lastMessageAt: new Date("2026-11-13T02:13:00Z"),
        createdAt: new Date("2026-11-13T02:13:00Z"),
        updatedAt: new Date("2026-11-13T02:13:00Z"),
        messages: [],
      };

      vi.spyOn(prisma.conversation, "findUnique")
        .mockResolvedValueOnce(null) // first check: not found
        .mockResolvedValueOnce(mockCreatedConv as any); // subsequent lookup

      vi.spyOn(prisma.send, "findUnique").mockResolvedValue(mockSend as any);
      vi.spyOn(prisma.conversation, "create").mockResolvedValue(mockCreatedConv as any);
      const msgCreateSpy = vi.spyOn(prisma.conversationMessage, "create").mockResolvedValue({} as any);
      vi.spyOn(prisma.conversation, "findUniqueOrThrow").mockResolvedValue({
        ...mockCreatedConv,
        messages: [
          {
            id: "msg-root",
            conversationId: "conv-1",
            direction: "OUTBOUND",
            senderEmail: "founderoffice@focusrealm.org",
            senderName: "Frank Lopes",
            recipientEmail,
            recipientName: null,
            subject: mockSend.subject,
            bodyText: mockSend.text,
            bodyHtml: mockSend.html,
            snippet: "Hi Ajay, reaching out from FocusRealm...",
            messageId: mockSend.messageId,
            inReplyTo: null,
            references: null,
            sentAt: mockSend.sentAt,
            sendId,
            attachments: [],
            createdAt: mockSend.createdAt,
          },
        ],
      } as any);

      const conv = await findOrCreateConversation({
        campaignId,
        recipientEmail,
        initialSendId: sendId,
      });

      expect(conv.id).toBe("conv-1");
      expect(msgCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            conversationId: "conv-1",
            direction: "OUTBOUND",
            senderEmail: "founderoffice@focusrealm.org",
            recipientEmail,
            messageId: "<msg-initial@focusrealm.org>",
          }),
        })
      );
    });
  });

  describe("2. Multi-Turn Thread Matching & Reply Ingestion", () => {
    it("records first reply, sets isFirstReply: true, and updates status to NEEDS_REPLY", async () => {
      const campaignId = "camp-1";
      const recipientEmail = "ajay@sarovarhotels.com";

      const mockExistingConv = {
        id: "conv-1",
        campaignId,
        recipientEmail,
        status: "WAITING_FOR_CONTACT",
        subject: "Advisory Role",
        messages: [
          {
            id: "m-1",
            direction: "OUTBOUND",
            sentAt: new Date("2026-11-13T02:00:00Z"),
          },
        ],
      };

      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValue(mockExistingConv as any);
      vi.spyOn(prisma.conversationMessage, "findUnique").mockResolvedValue(null);
      const msgCreateSpy = vi.spyOn(prisma.conversationMessage, "create").mockResolvedValue({} as any);
      const convUpdateSpy = vi.spyOn(prisma.conversation, "update").mockResolvedValue({} as any);

      const result = await recordInboundReplyToConversation({
        campaignId,
        recipientEmail,
        fromEmail: recipientEmail,
        fromName: "Ajay K. Bakaya",
        subject: "Re: Advisory Role",
        bodyText: "Perhaps an initial 5 minutes just to understand what you plan.",
        snippet: "Perhaps an initial 5 minutes...",
        messageId: "<reply-1@sarovarhotels.com>",
        inReplyTo: "<msg-initial@focusrealm.org>",
        classification: "POSITIVE",
      });

      expect(result.isFirstReply).toBe(true);
      expect(msgCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            direction: "INBOUND",
            senderEmail: recipientEmail,
            bodyText: "Perhaps an initial 5 minutes just to understand what you plan.",
            inReplyTo: "<msg-initial@focusrealm.org>",
          }),
        })
      );
      expect(convUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "conv-1" },
          data: expect.objectContaining({
            status: "NEEDS_REPLY",
            sentiment: "POSITIVE",
          }),
        })
      );
    });

    it("records subsequent reply in the same thread with isFirstReply: false", async () => {
      const campaignId = "camp-1";
      const recipientEmail = "ajay@sarovarhotels.com";

      // Conversation already has 1 outbound and 1 inbound reply
      const mockExistingConv = {
        id: "conv-1",
        campaignId,
        recipientEmail,
        status: "WAITING_FOR_CONTACT",
        subject: "Advisory Role",
        messages: [
          { id: "m-1", direction: "OUTBOUND", sentAt: new Date("2026-11-13T02:00:00Z") },
          { id: "m-2", direction: "INBOUND", sentAt: new Date("2026-11-17T14:22:00Z") },
          { id: "m-3", direction: "OUTBOUND", sentAt: new Date("2026-11-17T15:00:00Z") },
        ],
      };

      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValue(mockExistingConv as any);
      vi.spyOn(prisma.conversationMessage, "findUnique").mockResolvedValue(null);
      vi.spyOn(prisma.conversationMessage, "create").mockResolvedValue({} as any);
      vi.spyOn(prisma.conversation, "update").mockResolvedValue({} as any);

      const result = await recordInboundReplyToConversation({
        campaignId,
        recipientEmail,
        fromEmail: recipientEmail,
        subject: "Re: Advisory Role",
        bodyText: "Thursday 4pm works best for me.",
        snippet: "Thursday 4pm works best for me.",
        messageId: "<reply-2@sarovarhotels.com>",
        inReplyTo: "<inapp-reply-1@focusrealm.org>",
        classification: "POSITIVE",
      });

      expect(result.isFirstReply).toBe(false);
      expect(result.conversationId).toBe("conv-1");
    });

    it("deduplicates identical messageId without creating duplicate messages", async () => {
      const campaignId = "camp-1";
      const recipientEmail = "ajay@sarovarhotels.com";

      const mockExistingConv = {
        id: "conv-1",
        campaignId,
        recipientEmail,
        status: "NEEDS_REPLY",
        subject: "Advisory Role",
        messages: [{ id: "m-1", direction: "OUTBOUND" }],
      };

      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValue(mockExistingConv as any);
      // Already exists in conversationMessage
      vi.spyOn(prisma.conversationMessage, "findUnique").mockResolvedValue({
        id: "already-stored-msg",
      } as any);
      const msgCreateSpy = vi.spyOn(prisma.conversationMessage, "create");

      const result = await recordInboundReplyToConversation({
        campaignId,
        recipientEmail,
        fromEmail: recipientEmail,
        subject: "Re: Advisory Role",
        bodyText: "Perhaps an initial 5 minutes...",
        messageId: "<reply-1@sarovarhotels.com>",
      });

      expect(result.conversationId).toBe("conv-1");
      expect(result.isFirstReply).toBe(false);
      expect(msgCreateSpy).not.toHaveBeenCalled();
    });
  });

  describe("3. Operational Status Lifecycle & Meeting Coordination", () => {
    it("updates conversation operational status to MEETING_COORDINATION with target meeting time", async () => {
      const convId = "conv-1";
      const meetingTime = new Date("2026-11-20T14:00:00Z");

      const updateSpy = vi.spyOn(prisma.conversation, "update").mockResolvedValue({
        id: convId,
        campaignId: "c-1",
        recipientEmail: "ajay@sarovarhotels.com",
        contactId: null,
        ownerId: "user-1",
        initialSendId: null,
        status: "MEETING_COORDINATION",
        subject: "Advisory Role",
        sentiment: "POSITIVE",
        snippet: null,
        nextAction: "Send Google Meet invite for 15-min intro call",
        nextActionDueAt: new Date("2026-11-19T10:00:00Z"),
        meetingAt: meetingTime,
        meetingNotes: "Introductory chat on advisory scope",
        outcome: null,
        lastMessageAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [],
        campaign: { id: "c-1", name: "Advisory - 1" },
        contact: null,
        owner: { id: "user-1", name: "Frank Lopes", email: "founderoffice@focusrealm.org" },
      } as any);

      const updated = await updateConversation(convId, {
        status: "MEETING_COORDINATION",
        nextAction: "Send Google Meet invite for 15-min intro call",
        nextActionDueAt: new Date("2026-11-19T10:00:00Z"),
        meetingAt: meetingTime,
        meetingNotes: "Introductory chat on advisory scope",
      });

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: convId },
          data: expect.objectContaining({
            status: "MEETING_COORDINATION",
            nextAction: "Send Google Meet invite for 15-min intro call",
            meetingAt: meetingTime,
            meetingNotes: "Introductory chat on advisory scope",
          }),
        })
      );
      expect(updated.status).toBe("MEETING_COORDINATION");
      expect(updated.meetingNotes).toBe("Introductory chat on advisory scope");
    });

    it("appends outbound reply and transitions status to WAITING_FOR_CONTACT", async () => {
      const convId = "conv-1";
      vi.spyOn(prisma.conversationMessage, "create").mockResolvedValue({
        id: "msg-out-2",
        conversationId: convId,
        direction: "OUTBOUND",
        senderEmail: "founderoffice@focusrealm.org",
        senderName: "Frank Lopes",
        recipientEmail: "ajay@sarovarhotels.com",
        subject: "Re: Advisory Role",
        bodyText: "Sounds great Ajay, does Friday at 2pm work?",
        sentAt: new Date(),
      } as any);

      const convUpdateSpy = vi.spyOn(prisma.conversation, "update").mockResolvedValue({} as any);

      await recordOutboundReplyToConversation({
        conversationId: convId,
        senderEmail: "founderoffice@focusrealm.org",
        senderName: "Frank Lopes",
        recipientEmail: "ajay@sarovarhotels.com",
        subject: "Re: Advisory Role",
        bodyText: "Sounds great Ajay, does Friday at 2pm work?",
      });

      expect(convUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: convId },
          data: expect.objectContaining({
            status: "WAITING_FOR_CONTACT",
          }),
        })
      );
    });
  });

  describe("4. DTO Serialization & Data Preservation", () => {
    it("serializes conversation and message payloads into typed DTOs", () => {
      const now = new Date();
      const msgDto = toConversationMessageDto({
        id: "m-1",
        conversationId: "conv-1",
        direction: "INBOUND",
        senderEmail: "ajay@sarovarhotels.com",
        senderName: "Ajay",
        recipientEmail: "founderoffice@focusrealm.org",
        recipientName: "Frank",
        subject: "Re: Hello",
        bodyText: "Let's talk",
        bodyHtml: "<p>Let's talk</p>",
        snippet: "Let's talk",
        messageId: "<msg-1@sarovar.com>",
        inReplyTo: "<orig@fr.org>",
        references: "<orig@fr.org>",
        sentAt: now,
        sendId: "send-1",
        attachments: [],
        createdAt: now,
      });

      expect(msgDto.direction).toBe("INBOUND");
      expect(msgDto.inReplyTo).toBe("<orig@fr.org>");

      const convDto = toConversationDto({
        id: "conv-1",
        campaignId: "c-1",
        recipientEmail: "ajay@sarovarhotels.com",
        contactId: "ct-1",
        ownerId: "u-1",
        initialSendId: "send-1",
        status: "NEEDS_REPLY",
        subject: "Advisory Outreach",
        sentiment: "POSITIVE",
        snippet: "Let's talk",
        nextAction: "Schedule call",
        nextActionDueAt: now,
        meetingAt: null,
        meetingNotes: null,
        outcome: null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
        messages: [],
        campaign: { id: "c-1", name: "Campaign 1" },
        contact: { id: "ct-1", firstName: "Ajay", lastName: "Bakaya" },
        owner: { id: "u-1", name: "Frank", email: "frank@fr.org" },
      });

      expect(convDto.contactName).toBe("Ajay Bakaya");
      expect(convDto.campaignName).toBe("Campaign 1");
      expect(convDto.status).toBe("NEEDS_REPLY");
    });
  });

  describe("5. Historical Reply Backfilling & SendEvent Sync", () => {
    it("backfills historical reply events into conversation messages when found", async () => {
      const campaignId = "camp-hist-1";
      const recipientEmail = "hist@example.com";
      const sendId = "send-hist-1";

      const mockSend = {
        id: sendId,
        campaignId,
        email: recipientEmail,
        subject: "Initial Outreach",
        text: "Outreach text",
        messageId: "<hist-init@focusrealm.org>",
        sentAt: new Date("2026-11-10T10:00:00Z"),
        campaign: { fromEmail: "founderoffice@focusrealm.org" },
      };

      const mockConv = {
        id: "conv-hist-1",
        campaignId,
        recipientEmail,
        status: "NEEDS_REPLY",
        messages: [],
      };

      vi.spyOn(prisma.send, "findUnique").mockResolvedValue(mockSend as any);
      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce(null);
      vi.spyOn(prisma.conversation, "create").mockResolvedValue(mockConv as any);

      const msgCreateSpy = vi.spyOn(prisma.conversationMessage, "create").mockResolvedValue({} as any);
      vi.spyOn(prisma.sendEvent, "findMany").mockResolvedValue([
        {
          id: "evt-reply-1",
          sendId,
          type: "REPLY",
          occurredAt: new Date("2026-11-12T14:00:00Z"),
          detail: {
            from: "Hist <hist@example.com>",
            subject: "Re: Initial Outreach",
            snippet: "I am interested, let us connect next week.",
            messageId: "<hist-reply@example.com>",
          },
        } as any,
      ]);

      vi.spyOn(prisma.conversation, "findUniqueOrThrow").mockResolvedValue({
        ...mockConv,
        messages: [
          { direction: "OUTBOUND", id: "m-out" },
          { direction: "INBOUND", id: "m-in" },
        ],
      } as any);

      const conv = await findOrCreateConversation({
        campaignId,
        recipientEmail,
        initialSendId: sendId,
      });

      expect(conv.id).toBe("conv-hist-1");
      // Created outbound send AND backfilled inbound reply
      expect(msgCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            direction: "INBOUND",
            senderEmail: "hist@example.com",
            snippet: "I am interested, let us connect next week.",
          }),
        })
      );
    });

    it("syncs SendEvent detail when conversation outcome is updated to INTERESTED or MEETING_SCHEDULED", async () => {
      const convId = "conv-sync-1";
      const sendId = "send-sync-1";

      const updatedConv = {
        id: convId,
        campaignId: "c-1",
        recipientEmail: "lead@example.com",
        initialSendId: sendId,
        status: "INTERESTED",
        subject: "Outreach Lead",
        outcome: "Requested 15-min call",
        meetingAt: new Date("2026-11-20T10:00:00Z"),
        lastMessageAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [],
      };

      vi.spyOn(prisma.conversation, "update").mockResolvedValue(updatedConv as any);
      vi.spyOn(prisma.sendEvent, "findFirst").mockResolvedValue({
        id: "evt-1",
        sendId,
        type: "REPLY",
        detail: { classification: "NEUTRAL" },
      } as any);

      const eventUpdateSpy = vi.spyOn(prisma.sendEvent, "update").mockResolvedValue({} as any);

      await updateConversation(convId, {
        status: "INTERESTED",
        outcome: "Requested 15-min call",
      });

      expect(eventUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "evt-1" },
          data: expect.objectContaining({
            detail: expect.objectContaining({
              classification: "POSITIVE",
              conversationStatus: "INTERESTED",
              userOutcome: "Requested 15-min call",
            }),
          }),
        })
      );
    });
  });

  describe("5. Quoted Content Extraction in Conversation Messages", () => {
    it("extracts cleanBody and quotedText in toConversationMessageDto for Ajay K. Bakaya reply", () => {
      const mockMsg = {
        id: "msg-ajay-3",
        conversationId: "conv-1",
        direction: "INBOUND",
        senderEmail: "ajay@sarovarhotels.com",
        senderName: "Ajay K. Bakaya",
        recipientEmail: "founderoffice@focusrealm.org",
        recipientName: "Frank Lopes",
        subject: "Re: Exploring an Advisory Role with MISE",
        bodyText:
          "3pm please Frank.\n\najay\n\nFrom: founderoffice@focusrealm.org <founderoffice@focusrealm.org>\nDate: Tuesday, 17 November 2026 at 4:52 PM\nTo: Ajay K. Bakaya <ajay@sarovarhotels.com>\nSubject: Re: Exploring an Advisory Role with MISE\nTommorrow works",
        bodyHtml: "<p>3pm please Frank.</p>",
        snippet: "3pm please Frank.",
        messageId: "<reply-3@sarovarhotels.com>",
        inReplyTo: "<msg-frank@focusrealm.org>",
        references: "<msg-frank@focusrealm.org>",
        sentAt: new Date("2026-11-18T05:29:52Z"),
        sendId: "send-1",
        attachments: [],
        createdAt: new Date("2026-11-18T05:29:52Z"),
      };

      const dto = toConversationMessageDto(mockMsg as any);

      expect(dto.cleanBody).toBe("3pm please Frank.\n\najay");
      expect(dto.quotedText).toContain("From: founderoffice@focusrealm.org");
      expect(dto.bodyText).toBe(mockMsg.bodyText); // Raw content preserved in full
    });
  });

  describe("6. Campaign Recipients Serialization & Conversation Association", () => {
    it("includes contact details and conversation outcome status in toSendDto", async () => {
      const { toSendDto } = await import("../lib/serialize.js");

      const mockSend = {
        id: "send-ajay",
        email: "ajay@sarovarhotels.com",
        contactId: "contact-ajay",
        subject: "Exploring an Advisory Role with MISE",
        status: "SENT" as const,
        skipReason: null,
        attempts: 1,
        lastError: null,
        sentAt: new Date("2026-11-13T02:13:00Z"),
        bouncedAt: null,
        repliedAt: new Date("2026-11-17T08:44:00Z"),
        unsubscribedAt: null,
        updatedAt: new Date("2026-11-18T05:29:52Z"),
        templateId: "tpl-1",
        templateVersion: 1,
        assignmentReason: null,
        stepIndex: 0,
        scheduledFor: null,
        approvedAt: null,
        inReplyToId: null,
        isCustom: false,
        contact: {
          firstName: "Ajay",
          lastName: "Bakaya",
          company: "Sarovar Hotels",
        },
        conversation: {
          id: "conv-ajay",
          status: "MEETING_SCHEDULED" as const,
          snippet: "3pm please Frank.",
          outcome: "Meeting booked for tomorrow 3pm",
          meetingAt: new Date("2026-11-19T09:30:00Z"),
        },
      };

      const dto = toSendDto(mockSend);

      expect(dto.email).toBe("ajay@sarovarhotels.com");
      expect(dto.contact).toEqual({
        firstName: "Ajay",
        lastName: "Bakaya",
        company: "Sarovar Hotels",
      });
      expect(dto.conversation).toBeDefined();
      expect(dto.conversation?.status).toBe("MEETING_SCHEDULED");
      expect(dto.conversation?.outcome).toBe("Meeting booked for tomorrow 3pm");
      expect(dto.conversation?.meetingAt).toBe(new Date("2026-11-19T09:30:00Z").toISOString());
    });

    it("returns null for conversation when recipient has no conversation yet", async () => {
      const { toSendDto } = await import("../lib/serialize.js");

      const mockSend = {
        id: "send-no-conv",
        email: "prospect@example.com",
        contactId: null,
        status: "PENDING" as const,
        skipReason: null,
        attempts: 0,
        lastError: null,
        sentAt: null,
        bouncedAt: null,
        repliedAt: null,
        unsubscribedAt: null,
        updatedAt: new Date(),
        stepIndex: 0,
        scheduledFor: new Date("2026-11-25T10:00:00Z"),
        approvedAt: null,
        inReplyToId: null,
        isCustom: false,
        contact: null,
        conversation: null,
      };

      const dto = toSendDto(mockSend);

      expect(dto.conversation).toBeNull();
      expect(dto.contact).toBeNull();
    });
  });
});

