// /api/internal/tick — wakes the serverless sending worker to process queued outreach safely.
// Called by Vercel Cron or an external scheduler (every ~15–20 minutes) with
// "Authorization: Bearer <CRON_SECRET>". Runs one bounded cycle under the global sender lease
// and returns per-mailbox sending and budget statistics without recursive self-calls.
import crypto from "crypto";
import { Router, type Request } from "express";
import { env, isServerless } from "../config.js";
import { AppError, asyncHandler } from "../middleware/error-handler.js";
import { runSenderCycle, wakeServerlessSender } from "../services/background.js";

export const internalRouter = Router();

function authorized(req: Request): boolean {
  if (!env.CRON_SECRET) return false;
  const given = Buffer.from(req.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

internalRouter.all(
  "/tick",
  asyncHandler(async (req, res, next) => {
    if (!env.CRON_SECRET) {
      return next(new AppError("NOT_CONFIGURED", "CRON_SECRET isn't set on the server.", 503));
    }
    if (!authorized(req)) {
      return next(AppError.unauthorized("BAD_CRON_SECRET", "Not authorized."));
    }
    if (!isServerless) {
      return res.json({
        success: true,
        data: {
          ran: false,
          started: false,
          reason: "This server runs a continuous worker; ticks aren't needed.",
        },
      });
    }
    if (req.query.async === "true") {
      wakeServerlessSender();
      return res.status(202).json({ success: true, data: { started: true } });
    }
    const result = await runSenderCycle();
    res.json({ success: true, data: result });
  })
);
