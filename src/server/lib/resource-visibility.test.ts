import { describe, expect, it } from "vitest";
import { canAccessList, canAccessTemplate, visibleListsWhere, visibleTemplatesWhere } from "./resource-visibility.js";

describe("resource visibility", () => {
  it("keeps personal templates private for every role and exposes explicitly shared templates", () => {
    const personal = { id: "template-1", scope: "PERSONAL", createdById: "founder-1" };
    const shared = { id: "template-2", scope: "SHARED", createdById: "founder-1" };

    expect(canAccessTemplate(personal, { id: "founder-1" })).toBe(true);
    expect(canAccessTemplate(personal, { id: "founder-2" })).toBe(false);
    expect(canAccessTemplate(shared, { id: "founder-2" })).toBe(true);
    expect(visibleTemplatesWhere("founder-2")).toMatchObject({
      OR: expect.arrayContaining([
        { scope: "PERSONAL", createdById: "founder-2" },
        { scope: "SHARED" },
        { scope: "ORGANIZATION" },
      ]),
    });
  });

  it("shows a list only to its owner or when shared, including migrated legacy lists", () => {
    const personal = { id: "list-1", createdById: "founder-1", isShared: false };
    const shared = { id: "list-2", createdById: "founder-1", isShared: true };
    const legacy = { id: "list-3", createdById: null, isShared: true };
    const unsharedOrphan = { id: "list-4", createdById: null, isShared: false };

    expect(canAccessList(personal, { id: "founder-1" })).toBe(true);
    expect(canAccessList(personal, { id: "founder-2" })).toBe(false);
    expect(canAccessList(shared, { id: "founder-2" })).toBe(true);
    expect(canAccessList(legacy, { id: "founder-2" })).toBe(true);
    expect(canAccessList(unsharedOrphan, { id: "founder-2" })).toBe(false);
    expect(visibleListsWhere("founder-2")).toMatchObject({
      OR: expect.arrayContaining([
        { createdById: "founder-2" },
        { isShared: true },
      ]),
    });
  });
});
