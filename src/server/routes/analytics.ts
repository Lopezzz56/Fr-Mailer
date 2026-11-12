// Analytics routes: Template comparison, attribution, and performance insights
import { Router } from "express";
import { asyncHandler } from "../middleware/error-handler.js";
import { requirePermission } from "../middleware/session.js";
import { ok } from "../lib/http.js";
import { getCampaignAnalytics, getWorkspaceTemplateAnalytics } from "../services/analytics-service.js";
import { IdSchema, TemplateAnalyticsQuerySchema } from "../../shared/types.js";
import prisma from "../db.js";
import { assertTemplateAccessible } from "../lib/resource-visibility.js";

const router = Router();

router.get(
  "/templates",
  requirePermission("templates.view"),
  asyncHandler(async (req, res) => {
    const query = TemplateAnalyticsQuerySchema.parse(req.query);
    if (query.templateId) {
      const template = await prisma.template.findUnique({ where: { id: query.templateId } });
      assertTemplateAccessible(template, req.user!);
    }
    const data = await getWorkspaceTemplateAnalytics(req.user!.id, query);
    ok(res, data);
  })
);

router.get(
  "/campaigns/:id",
  requirePermission("campaigns.view"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const data = await getCampaignAnalytics(id);
    ok(res, data);
  })
);

export default router;
