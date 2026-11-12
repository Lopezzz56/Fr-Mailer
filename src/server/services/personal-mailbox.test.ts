import { describe, expect, it, vi } from "vitest";
import {
  decryptMailboxPassword,
  encryptMailboxPassword,
  assignUserToMailbox,
  removeUserFromMailbox,
  updateMailboxUserAccess,
  deleteMailboxAccount,
  getMailboxCredentials,
  getMailboxCredentialsForUser,
} from "./personal-mailbox.js";
import prisma from "../db.js";

describe("personal mailbox credential encryption", () => {
  it("round-trips passwords without storing the plaintext", () => {
    const password = "space-mail-test-password";
    const encrypted = encryptMailboxPassword(password);

    expect(encrypted).not.toContain(password);
    expect(decryptMailboxPassword(encrypted)).toBe(password);
  });

  it("rejects modified ciphertext", () => {
    const encrypted = encryptMailboxPassword("space-mail-test-password");
    const parts = encrypted.split(".");
    parts[2] = `${parts[2]![0] === "a" ? "b" : "a"}${parts[2]!.slice(1)}`;

    expect(() => decryptMailboxPassword(parts.join("."))).toThrow();
  });
});

describe("shared mailbox multi-user access and authorization", () => {
  it("prevents employees from assigning mailboxes to other users", async () => {
    await expect(
      assignUserToMailbox(
        { id: "emp-1", role: "EMPLOYEE" },
        "mb-1",
        { userId: "emp-2", senderName: "Sender" }
      )
    ).rejects.toThrow("Only Founder and Founder Office can assign mailboxes to users.");
  });

  it("prevents employees from unassigning other users from a mailbox", async () => {
    await expect(
      removeUserFromMailbox(
        { id: "emp-1", role: "EMPLOYEE" },
        "mb-1",
        "emp-2"
      )
    ).rejects.toThrow("You can only remove your own mailbox access.");
  });

  it("prevents non-founders from deleting a shared mailbox account", async () => {
    await expect(
      deleteMailboxAccount(
        { id: "fo-1", role: "FOUNDER_OFFICE" },
        "mb-1"
      )
    ).rejects.toThrow("Only the Founder can disconnect an organization mailbox.");
  });

  it("prevents employees from updating another user's sender identity", async () => {
    await expect(
      updateMailboxUserAccess(
        { id: "emp-1", role: "EMPLOYEE" },
        "mb-1",
        "emp-2",
        { senderName: "Hacked Name" }
      )
    ).rejects.toThrow("You can only edit your own sender identity.");
  });

  it("resolves mailbox credentials by mailboxId and applies custom fromName", async () => {
    const rawPassword = "space-secret-pass";
    const encryptedPassword = encryptMailboxPassword(rawPassword);

    vi.spyOn(prisma.mailboxAccount, "findUnique").mockResolvedValueOnce({
      id: "mb-partnerships",
      email: "partnerships@focusrealm.com",
      fromName: "FocusRealm Partnerships",
      encryptedPassword,
      lastVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const creds = await getMailboxCredentials("mb-partnerships", "Rahul Sharma");
    expect(creds).not.toBeNull();
    expect(creds?.email).toBe("partnerships@focusrealm.com");
    expect(creds?.fromName).toBe("Rahul Sharma");
    expect(creds?.password).toBe(rawPassword);
  });

  it("resolves mailbox credentials for user via mailboxAccess", async () => {
    const rawPassword = "space-secret-pass-2";
    const encryptedPassword = encryptMailboxPassword(rawPassword);

    vi.spyOn(prisma.mailboxAccess, "findFirst").mockResolvedValueOnce({
      id: "acc-1",
      mailboxId: "mb-shared",
      userId: "user-123",
      senderName: "Priya Mehta",
      isDefault: true,
      mailbox: {
        id: "mb-shared",
        email: "team@focusrealm.com",
        fromName: "FocusRealm Team",
        encryptedPassword,
        lastVerifiedAt: new Date(),
      },
    } as any);

    const creds = await getMailboxCredentialsForUser("user-123");
    expect(creds).not.toBeNull();
    expect(creds?.email).toBe("team@focusrealm.com");
    expect(creds?.fromName).toBe("Priya Mehta");
    expect(creds?.password).toBe(rawPassword);
  });
});
