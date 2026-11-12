import { describe, it, expect } from "vitest";
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission, canAct, PERMISSION_LABELS } from "./auth.js";

describe("role permissions", () => {
  it("gives founders every permission", () => {
    for (const p of PERMISSIONS) expect(hasPermission("FOUNDER", p)).toBe(true);
  });

  it("gives founder office operational management permissions but not founder admin", () => {
    expect(hasPermission("FOUNDER_OFFICE", "campaigns.approve")).toBe(true);
    expect(hasPermission("FOUNDER_OFFICE", "campaigns.control")).toBe(true);
    expect(hasPermission("FOUNDER_OFFICE", "campaigns.share")).toBe(true);
    expect(hasPermission("FOUNDER_OFFICE", "templates.manage_org")).toBe(true);
    expect(hasPermission("FOUNDER_OFFICE", "users.grant_send")).toBe(true);
    expect(hasPermission("FOUNDER_OFFICE", "audit.view")).toBe(true);

    // Founder-only admin restrictions
    expect(hasPermission("FOUNDER_OFFICE", "users.manage")).toBe(false);
    expect(hasPermission("FOUNDER_OFFICE", "mailbox.manage")).toBe(false);
    expect(hasPermission("FOUNDER_OFFICE", "settings.manage")).toBe(false);
    expect(hasPermission("FOUNDER_OFFICE", "suppressions.remove")).toBe(false);
  });

  it("keeps the approval gate, send control, and admin actions off default employees", () => {
    expect(hasPermission("EMPLOYEE", "campaigns.approve")).toBe(false);
    expect(hasPermission("EMPLOYEE", "campaigns.control")).toBe(false);
    expect(hasPermission("EMPLOYEE", "templates.manage_org")).toBe(false);
    expect(hasPermission("EMPLOYEE", "users.grant_send")).toBe(false);
    expect(hasPermission("EMPLOYEE", "users.manage")).toBe(false);
    expect(hasPermission("EMPLOYEE", "mailbox.manage")).toBe(false);
    expect(hasPermission("EMPLOYEE", "settings.manage")).toBe(false);
    expect(hasPermission("EMPLOYEE", "suppressions.remove")).toBe(false);
    expect(hasPermission("EMPLOYEE", "audit.view")).toBe(false);
  });

  it("lets employees do day-to-day creation and collaboration work", () => {
    expect(hasPermission("EMPLOYEE", "contacts.manage")).toBe(true);
    expect(hasPermission("EMPLOYEE", "templates.manage")).toBe(true);
    expect(hasPermission("EMPLOYEE", "campaigns.manage")).toBe(true);
    expect(hasPermission("EMPLOYEE", "campaigns.share")).toBe(true);
    expect(hasPermission("EMPLOYEE", "campaigns.request_approval")).toBe(true);
    expect(hasPermission("EMPLOYEE", "campaigns.send_test")).toBe(true);
    expect(hasPermission("EMPLOYEE", "suppressions.add")).toBe(true);
  });

  it("empowers employees with canSendWithoutApproval to control sending", () => {
    const regularEmp = { role: "EMPLOYEE" as const, status: "ACTIVE" as const, canSendWithoutApproval: false };
    const empoweredEmp = { role: "EMPLOYEE" as const, status: "ACTIVE" as const, canSendWithoutApproval: true };

    expect(canAct(regularEmp, "campaigns.control")).toBe(false);
    expect(canAct(regularEmp, "campaigns.approve")).toBe(false);

    expect(canAct(empoweredEmp, "campaigns.control")).toBe(true);
    expect(canAct(empoweredEmp, "campaigns.approve")).toBe(true);
    // Still cannot do organization admin actions
    expect(canAct(empoweredEmp, "users.manage")).toBe(false);
    expect(canAct(empoweredEmp, "mailbox.manage")).toBe(false);
  });

  it("only grants employees and founder office a subset of founder permissions", () => {
    for (const p of ROLE_PERMISSIONS.EMPLOYEE) expect(ROLE_PERMISSIONS.FOUNDER.has(p)).toBe(true);
    for (const p of ROLE_PERMISSIONS.FOUNDER_OFFICE) expect(ROLE_PERMISSIONS.FOUNDER.has(p)).toBe(true);
  });

  it("labels every permission", () => {
    for (const p of PERMISSIONS) expect(PERMISSION_LABELS[p]).toBeTruthy();
  });

  it("denies everything to users who are not active", () => {
    expect(canAct({ role: "FOUNDER", status: "DISABLED" }, "campaigns.view")).toBe(false);
    expect(canAct({ role: "FOUNDER", status: "INVITED" }, "campaigns.approve")).toBe(false);
    expect(canAct({ role: "FOUNDER", status: "ACTIVE" }, "campaigns.approve")).toBe(true);
    expect(canAct({ role: "FOUNDER_OFFICE", status: "ACTIVE" }, "campaigns.approve")).toBe(true);
  });
});
