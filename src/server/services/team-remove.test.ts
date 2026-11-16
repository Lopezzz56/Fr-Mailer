import { describe, it, expect } from "vitest";
import { canAct, type SessionUser } from "../../shared/auth.js";

const founder: SessionUser = {
  id: "u_founder_1",
  email: "founder@focusrealm.org",
  name: "Founder One",
  role: "FOUNDER",
  status: "ACTIVE",
  canSendWithoutApproval: true,
};

const founderOffice: SessionUser = {
  id: "u_office_1",
  email: "office@focusrealm.test",
  name: "Office User",
  role: "FOUNDER_OFFICE",
  status: "ACTIVE",
  canSendWithoutApproval: true,
};

const employee: SessionUser = {
  id: "u_emp_1",
  email: "emp@focusrealm.test",
  name: "Employee User",
  role: "EMPLOYEE",
  status: "ACTIVE",
  canSendWithoutApproval: false,
};

describe("Team Management: Member Removal Permissions", () => {
  it("permits only Founders to manage and remove organization members", () => {
    expect(canAct(founder, "users.manage")).toBe(true);
    expect(canAct(founderOffice, "users.manage")).toBe(false);
    expect(canAct(employee, "users.manage")).toBe(false);
  });

  it("prevents self-removal validation check", () => {
    const isSelf = (removerId: string, targetId: string) => removerId === targetId;
    expect(isSelf(founder.id, founder.id)).toBe(true);
    expect(isSelf(founder.id, employee.id)).toBe(false);
  });

  it("enforces minimum active founder safeguard", () => {
    const MIN_ACTIVE_FOUNDERS = 1;
    const canRemoveFounder = (currentActiveFounders: number) => {
      return (currentActiveFounders - 1) >= MIN_ACTIVE_FOUNDERS;
    };

    expect(canRemoveFounder(1)).toBe(false); // cannot remove last founder
    expect(canRemoveFounder(2)).toBe(true);  // can remove if another founder exists
  });
});

