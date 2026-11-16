// Notifications API route
import { Router } from "express";
import { asyncHandler } from "../middleware/error-handler.js";
import { ok } from "../lib/http.js";
import { getActionableNotifications } from "../services/notification-service.js";

export const notificationsRouter = Router();

notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const notifications = await getActionableNotifications(user);
    ok(res, notifications);
  })
);

