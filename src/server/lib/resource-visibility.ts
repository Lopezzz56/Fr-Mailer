import type { Prisma } from "@prisma/client";
import { AppError } from "../middleware/error-handler.js";

type UserIdentity = { id: string };
type TemplateVisibility = { id: string; scope: string; createdById: string | null };
type ListVisibility = { id: string; createdById: string | null; isShared: boolean };

export function visibleTemplatesWhere(userId: string): Prisma.TemplateWhereInput {
  return {
    OR: [
      { scope: "ORGANIZATION" },
      { scope: "SHARED" },
      { scope: "PERSONAL", createdById: userId },
      { scope: "CAMPAIGN", createdById: userId },
    ],
  };
}

export function canAccessTemplate(template: TemplateVisibility, user: UserIdentity): boolean {
  return !["PERSONAL", "CAMPAIGN"].includes(template.scope) || template.createdById === user.id;
}

export function assertTemplateAccessible(template: TemplateVisibility | null, user: UserIdentity): asserts template is TemplateVisibility {
  if (!template || !canAccessTemplate(template, user)) {
    throw AppError.notFound("TEMPLATE_NOT_FOUND", "That template no longer exists.");
  }
}

export function visibleListsWhere(userId: string): Prisma.ContactListWhereInput {
  return {
    OR: [
      { createdById: userId },
      { isShared: true },
    ],
  };
}

export function canAccessList(list: ListVisibility, user: UserIdentity): boolean {
  return list.createdById === user.id || list.isShared;
}

export function assertListAccessible(list: ListVisibility | null, user: UserIdentity): asserts list is ListVisibility {
  if (!list || !canAccessList(list, user)) {
    throw AppError.notFound("LIST_NOT_FOUND", "That list no longer exists.");
  }
}

export function assertListEditable(list: ListVisibility | null, user: UserIdentity & { role?: string }): asserts list is ListVisibility {
  assertListAccessible(list, user);
  if (list.createdById !== user.id && !(list.createdById === null && user.role !== "EMPLOYEE")) {
    throw AppError.notFound("LIST_NOT_FOUND", "That list no longer exists.");
  }
}
