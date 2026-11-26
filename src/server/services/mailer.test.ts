import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nodemailer from "nodemailer";
import * as config from "../config.js";

const waitUntilSpy = vi.fn();
vi.mock("@vercel/functions", () => ({
  waitUntil: (...args: unknown[]) => waitUntilSpy(...args),
}));
import {
  closeTransport,
  enqueueAppendToSent,
  getTransport,
  setSentAppender,
  setTransport,
  type SmtpMailboxCredentials,
} from "./mailer.js";

const mailboxA: SmtpMailboxCredentials = {
  accountId: "mb-a",
  userId: "user-1",
  email: "a@focusrealm.org",
  password: "secret",
  fromName: "Mailbox A",
  smtpHost: "mail.spacemail.com",
  smtpPort: 465,
  smtpSecure: true,
  imapHost: "mail.spacemail.com",
  imapPort: 993,
};

const mailboxB: SmtpMailboxCredentials = {
  ...mailboxA,
  accountId: "mb-b",
  email: "b@focusrealm.org",
  fromName: "Mailbox B",
};

describe("SmtpTransport & non-blocking serialized appendToSent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setTransport(null);
    setSentAppender(null);
    closeTransport();
  });

  afterEach(() => {
    setSentAppender(null);
    closeTransport();
    vi.useRealTimers();
  });

  it("1 & 2. send() resolves immediately after SMTP handoff even when appendToSent() is slow, and append still executes", async () => {
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ response: "250 2.0.0 OK" }),
      verify: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    } as any);

    let resolveAppend!: () => void;
    const appendStarted = new Promise<void>((res) => {
      setSentAppender(
        vi.fn().mockImplementation(
          () =>
            new Promise<void>((done) => {
              res();
              resolveAppend = done;
            })
        )
      );
    });

    const start = Date.now();
    const res = await getTransport(mailboxA).send({
      to: "lead@hotel.com",
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      fromName: "Mailbox A",
    });
    const elapsed = Date.now() - start;

    expect(res.response).toBe("250 2.0.0 OK");
    expect(elapsed).toBeLessThan(200);

    await appendStarted;
    resolveAppend();
  });

  it("3. serializes concurrent appends for the same mailbox (max 1 active)", async () => {
    let activeForMailbox = 0;
    let maxActive = 0;
    const order: string[] = [];

    setSentAppender(async (mailOptions) => {
      activeForMailbox++;
      maxActive = Math.max(maxActive, activeForMailbox);
      order.push(`start:${String(mailOptions.to)}`);
      await new Promise((r) => setTimeout(r, 25));
      order.push(`end:${String(mailOptions.to)}`);
      activeForMailbox--;
    });

    const p1 = enqueueAppendToSent({ to: "one@hotel.com" }, { host: "mail.spacemail.com", port: 993, user: "a@focusrealm.org", pass: "pw" });
    const p2 = enqueueAppendToSent({ to: "two@hotel.com" }, { host: "mail.spacemail.com", port: 993, user: "a@focusrealm.org", pass: "pw" });

    await Promise.all([p1, p2]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "start:one@hotel.com",
      "end:one@hotel.com",
      "start:two@hotel.com",
      "end:two@hotel.com",
    ]);
  });

  it("4. allows different mailboxes to append independently without blocking each other", async () => {
    let activeTotal = 0;
    let maxConcurrent = 0;
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });

    let bFinishedBeforeA = false;
    let aFinished = false;

    setSentAppender(async (_opts, creds) => {
      activeTotal++;
      maxConcurrent = Math.max(maxConcurrent, activeTotal);
      if (creds.user === mailboxA.email) {
        await gateA;
        aFinished = true;
      } else {
        bFinishedBeforeA = !aFinished;
      }
      activeTotal--;
    });

    const pA = enqueueAppendToSent({ to: "a@hotel.com" }, { host: "mail.spacemail.com", port: 993, user: mailboxA.email, pass: "pw" });
    const pB = enqueueAppendToSent({ to: "b@hotel.com" }, { host: "mail.spacemail.com", port: 993, user: mailboxB.email, pass: "pw" });

    await pB;
    expect(bFinishedBeforeA).toBe(true);
    expect(maxConcurrent).toBe(2);

    releaseA();
    await pA;
  });

  it("5 & 6. append timeout and rejection only log a warning and never reject or fail the email", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Case A: hangs past 6s timeout
    setSentAppender(() => new Promise<void>(() => {}));
    const timeoutPromise = enqueueAppendToSent(
      { to: "slow@hotel.com" },
      { host: "mail.spacemail.com", port: 993, user: mailboxA.email, pass: "pw" }
    );
    await vi.advanceTimersByTimeAsync(6_001);
    await expect(timeoutPromise).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith("[mailer] Could not append to Sent folder:", "IMAP append timeout (6s)");

    // Case B: immediate rejection
    setSentAppender(async () => {
      throw new Error("IMAP connection reset");
    });
    const rejectPromise = enqueueAppendToSent(
      { to: "err@hotel.com" },
      { host: "mail.spacemail.com", port: 993, user: mailboxA.email, pass: "pw" }
    );
    await expect(rejectPromise).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith("[mailer] Could not append to Sent folder:", "IMAP connection reset");
  });

  it("6b. registers background append with Vercel waitUntil when running serverless", async () => {
    vi.spyOn(config, "isServerless", "get").mockReturnValue(true);
    waitUntilSpy.mockClear();
    setSentAppender(async () => {});

    await enqueueAppendToSent(
      { to: "serverless@hotel.com" },
      { host: "mail.spacemail.com", port: 993, user: mailboxA.email, pass: "pw" }
    );

    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    expect(waitUntilSpy.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it("7. sender throughput is not delayed by slow Sent-folder append", async () => {
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ response: "250 2.0.0 OK" }),
      verify: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    } as any);

    // Simulate 5-second IMAP append per send
    const pendingAppends: Promise<void>[] = [];
    setSentAppender(() => {
      const p = new Promise<void>((r) => setTimeout(r, 5_000));
      pendingAppends.push(p);
      return p;
    });

    const transport = getTransport(mailboxA);
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await transport.send({
        to: `lead${i}@hotel.com`,
        subject: "Hello",
        html: "<p>Hi</p>",
        text: "Hi",
        fromName: "Mailbox A",
      });
    }
    const elapsedMs = Date.now() - start;

    // 5 sends would have taken >= 25,000ms synchronously; non-blocking finishes in < 200ms
    expect(elapsedMs).toBeLessThan(200);
  });
});
