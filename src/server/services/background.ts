// Background work for serverless deployments (Vercel), where no process stays alive between requests.
//
// Each wake-up runs a single bounded sending cycle under a global database lease ("sender"), checks
// due inboxes for replies/bounces, and coordinates eligible sends across all mailboxes within their
// independent 300/24h budgets and pacing limits before exiting cleanly ahead of Vercel's timeout.
//
// No recursive HTTP self-invocation is used; repeated external /api/internal/tick wake-ups resume any
// remaining queued work automatically.
// Self-hosted servers don't use this: they run SendWorker.start() and InboxMonitor continuously.
import { waitUntil } from "@vercel/functions";
import { isServerless } from "../config.js";
import {
  acquireLease,
  recoverInterruptedSends,
  releaseLease,
  SendWorker,
  type MailboxCycleStats,
} from "./send-worker.js";
import { anyInboxDue, checkAllInboxes } from "./inbox-monitor.js";

// Must stay safely below the function's maxDuration (vercel.json: 300s) with room for SMTP handoff & cleanup
export const EXECUTION_BUDGET_MS = 240_000;
const LEASE_MS = EXECUTION_BUDGET_MS + 90_000;
// Older than any function can live: safe to mark interrupted CLAIMS as UNKNOWN
const STALE_CLAIM_MS = 15 * 60_000;

export interface SenderCycleResult {
  ran: boolean;
  reason?: string;
  stoppedBecause?: "budget" | "idle" | "limit";
  totalSent: number;
  handled: number;
  inboxChecked: boolean;
  durationMs: number;
  mailboxes: MailboxCycleStats[];
}

export async function runSenderCycle(budgetMs = EXECUTION_BUDGET_MS): Promise<SenderCycleResult> {
  const startedAt = Date.now();
  await recoverInterruptedSends(STALE_CLAIM_MS);

  const owner = await acquireLease("sender", LEASE_MS);
  if (!owner) {
    return {
      ran: false,
      reason: "Another sender worker cycle is already running.",
      totalSent: 0,
      handled: 0,
      inboxChecked: false,
      durationMs: Date.now() - startedAt,
      mailboxes: [],
    };
  }

  try {
    let inboxChecked = false;
    if (await anyInboxDue()) {
      await checkAllInboxes(true);
      inboxChecked = true;
    }

    const result = await new SendWorker().runFor(budgetMs);
    return {
      ran: true,
      stoppedBecause: result.stoppedBecause,
      totalSent: result.totalSent,
      handled: result.handled,
      inboxChecked,
      durationMs: Date.now() - startedAt,
      mailboxes: result.mailboxes,
    };
  } finally {
    await releaseLease("sender", owner);
  }
}

/** Runs one non-recursive background cycle after a user-initiated HTTP response is sent */
export function wakeServerlessSender() {
  waitUntil(
    runSenderCycle().catch((err) => console.error("[background] sender cycle failed:", (err as Error).message))
  );
}

/** Call after user actions that create sendable work (start, resume, retry). No-op on self-hosted servers. */
export function kickBackground() {
  if (isServerless) wakeServerlessSender();
}
