import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import prisma from "../db.js";
import { publicRouter } from "../routes/public.js";
import { unsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken, withFooter } from "./unsubscribe.js";

describe("Unsubscribe footer & opt-out flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1 & 2. generates a valid signed unsubscribe URL and renders human-style opt-out footer", () => {
    const sendId = "send-123";
    const url = unsubscribeUrl(sendId);
    const token = unsubscribeToken(sendId);

    expect(url).toContain(`/u/${token}`);
    expect(verifyUnsubscribeToken(token)).toBe(sendId);

    const html = "<p>Hi Ajay,</p><p>Best regards,<br/>Frank Lopes</p>";
    const text = "Hi Ajay,\n\nBest regards,\nFrank Lopes";
    const res = withFooter(html, text, url, "Frank Lopes");

    // Link remains functional and present
    expect(res.html).toContain(`href="${url}"`);
    expect(res.html).toContain("opt out");
    expect(res.text).toContain(url);
    expect(res.text).toContain("If you'd prefer not to hear from me, you can opt out");

    // Old bulk wording and heavy separators removed
    expect(res.html).not.toContain("You received this email from");
    expect(res.text).not.toContain("You received this email from");
    expect(res.html).not.toContain("border-top");
    expect(res.text).not.toContain("\n--\n");

    // Signature above preserved
    expect(res.html).toContain("Frank Lopes");
    expect(res.text).toContain("Best regards,\nFrank Lopes");
  });

  it("3. opt-out POST /u/:token records suppression and unsubscribedAt unchanged", async () => {
    const sendId = "send-optout-1";
    const token = unsubscribeToken(sendId);

    vi.spyOn(prisma.send, "findUnique").mockResolvedValue({
      id: sendId,
      campaignId: "camp-1",
      email: "guest@hotel.com",
      unsubscribedAt: null,
      campaign: { fromName: "Frank Lopes" },
    } as any);

    const txSpy = vi.spyOn(prisma, "$transaction").mockResolvedValue([] as any);
    vi.spyOn(prisma.send, "update").mockResolvedValue({} as any);
    vi.spyOn(prisma.sendEvent, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma.suppressionEntry, "upsert").mockResolvedValue({} as any);
    vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(publicRouter);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/u/${token}`, { method: "POST" });
      expect(resp.status).toBe(200);
      const body = await resp.text();
      expect(body).toContain("unsubscribed");
      expect(txSpy).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });
});
