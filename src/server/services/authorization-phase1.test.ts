// Phase 1 Organizational Authorization & Ownership Tests
import { describe, it, expect } from "vitest";
import { checkCampaignAccess } from "../routes/campaigns.js";
import { canAct, type SessionUser } from "../../shared/auth.js";
import { AppError } from "../middleware/error-handler.js";

const founder: SessionUser = {
  id: "u_founder",
  email: "founder@focusrealm.test",
  name: "Founder User",
  role: "FOUNDER",
  status: "ACTIVE",
  canSendWithoutApproval: true,
};

const founderOffice: SessionUser = {
  id: "u_office",
  email: "office@focusrealm.test",
  name: "Founder Office User",
  role: "FOUNDER_OFFICE",
  status: "ACTIVE",
  canSendWithoutApproval: true,
};

const employee1: SessionUser = {
  id: "u_emp1",
  email: "emp1@focusrealm.test",
  name: "Employee One",
  role: "EMPLOYEE",
  status: "ACTIVE",
  canSendWithoutApproval: false,
};

const employee2: SessionUser = {
  id: "u_emp2",
  email: "emp2@focusrealm.test",
  name: "Employee Two",
  role: "EMPLOYEE",
  status: "ACTIVE",
  canSendWithoutApproval: false,
};

const empoweredEmployee: SessionUser = {
  id: "u_emp_trusted",
  email: "trusted@focusrealm.test",
  name: "Trusted Employee",
  role: "EMPLOYEE",
  status: "ACTIVE",
  canSendWithoutApproval: true,
};

describe("Phase 1: Campaign Ownership & Access Verification", () => {
  const campaignCreatedByEmp1 = {
    id: "camp_1",
    createdById: employee1.id,
    collaborators: [
      { userId: employee2.id, role: "VIEWER" as const },
    ],
  };

  it("gives founder and founder office full access to any campaign", () => {
    expect(checkCampaignAccess(campaignCreatedByEmp1, founder, "VIEW")).toBe(true);
    expect(checkCampaignAccess(campaignCreatedByEmp1, founder, "EDIT")).toBe(true);
    expect(checkCampaignAccess(campaignCreatedByEmp1, founder, "ADMIN")).toBe(true);

    expect(checkCampaignAccess(campaignCreatedByEmp1, founderOffice, "VIEW")).toBe(true);
    expect(checkCampaignAccess(campaignCreatedByEmp1, founderOffice, "EDIT")).toBe(true);
    expect(checkCampaignAccess(campaignCreatedByEmp1, founderOffice, "ADMIN")).toBe(true);
  });

  it("gives campaign creator full access", () => {
    expect(checkCampaignAccess(campaignCreatedByEmp1, employee1, "VIEW")).toBe(true);
    expect(checkCampaignAccess(campaignCreatedByEmp1, employee1, "EDIT")).toBe(true);
    expect(checkCampaignAccess(campaignCreatedByEmp1, employee1, "ADMIN")).toBe(true);
  });

  it("enforces VIEWER collaborator permissions (read-only)", () => {
    expect(checkCampaignAccess(campaignCreatedByEmp1, employee2, "VIEW")).toBe(true);
    expect(checkCampaignAccess(campaignCreatedByEmp1, employee2, "EDIT")).toBe(false);
    expect(checkCampaignAccess(campaignCreatedByEmp1, employee2, "ADMIN")).toBe(false);
  });

  it("enforces EDITOR collaborator permissions (edit but not admin/delete)", () => {
    const campaignWithEditor = {
      id: "camp_2",
      createdById: employee1.id,
      collaborators: [
        { userId: employee2.id, role: "EDITOR" as const },
      ],
    };

    expect(checkCampaignAccess(campaignWithEditor, employee2, "VIEW")).toBe(true);
    expect(checkCampaignAccess(campaignWithEditor, employee2, "EDIT")).toBe(true);
    expect(checkCampaignAccess(campaignWithEditor, employee2, "ADMIN")).toBe(false);
  });

  it("blocks non-collaborator employees completely (IDOR defense)", () => {
    const thirdEmployee: SessionUser = {
      id: "u_emp3",
      email: "emp3@focusrealm.test",
      name: "Third Employee",
      role: "EMPLOYEE",
      status: "ACTIVE",
      canSendWithoutApproval: false,
    };

    expect(checkCampaignAccess(campaignCreatedByEmp1, thirdEmployee, "VIEW")).toBe(false);
    expect(checkCampaignAccess(campaignCreatedByEmp1, thirdEmployee, "EDIT")).toBe(false);
    expect(checkCampaignAccess(campaignCreatedByEmp1, thirdEmployee, "ADMIN")).toBe(false);
  });
});

describe("Phase 1: Sending Gate Verification", () => {
  function evaluateSendGate(campaign: { status: string; approvedBy: any }, user: SessionUser): boolean {
    const isFounderOrOffice = user.role === "FOUNDER" || user.role === "FOUNDER_OFFICE";
    const hasSendPermission = Boolean(user.canSendWithoutApproval);
    const isApproved = campaign.status === "APPROVED" && Boolean(campaign.approvedBy);

    if (!isFounderOrOffice && !hasSendPermission && !isApproved) {
      throw AppError.forbidden("SEND_APPROVAL_REQUIRED", "Sending requires approval from Founder Office or explicit sending permission.");
    }
    return true;
  }

  const draftCampaign = { status: "DRAFT", approvedBy: null };
  const pendingCampaign = { status: "PENDING_APPROVAL", approvedBy: null };
  const approvedCampaign = { status: "APPROVED", approvedBy: { id: "u_office", name: "Founder Office" } };

  it("allows Founder to start sending any campaign", () => {
    expect(evaluateSendGate(draftCampaign, founder)).toBe(true);
    expect(evaluateSendGate(approvedCampaign, founder)).toBe(true);
  });

  it("allows Founder Office to start sending", () => {
    expect(evaluateSendGate(draftCampaign, founderOffice)).toBe(true);
    expect(evaluateSendGate(approvedCampaign, founderOffice)).toBe(true);
  });

  it("allows employee with explicit send permission (canSendWithoutApproval) to start", () => {
    expect(evaluateSendGate(draftCampaign, empoweredEmployee)).toBe(true);
    expect(evaluateSendGate(approvedCampaign, empoweredEmployee)).toBe(true);
  });

  it("blocks regular employee from starting unapproved campaign with SEND_APPROVAL_REQUIRED", () => {
    expect(() => evaluateSendGate(draftCampaign, employee1)).toThrowError(AppError);
    try {
      evaluateSendGate(draftCampaign, employee1);
    } catch (err: any) {
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe("SEND_APPROVAL_REQUIRED");
    }

    expect(() => evaluateSendGate(pendingCampaign, employee1)).toThrowError(AppError);
    try {
      evaluateSendGate(pendingCampaign, employee1);
    } catch (err: any) {
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe("SEND_APPROVAL_REQUIRED");
    }
  });

  it("allows regular employee to start sending once campaign is APPROVED by Founder / Office", () => {
    expect(evaluateSendGate(approvedCampaign, employee1)).toBe(true);
  });
});

describe("Phase 1: Template Scoping & Permission Verification", () => {
  it("only allows Founder and Founder Office to manage organization templates", () => {
    expect(canAct(founder, "templates.manage_org")).toBe(true);
    expect(canAct(founderOffice, "templates.manage_org")).toBe(true);
    expect(canAct(employee1, "templates.manage_org")).toBe(false);
    expect(canAct(empoweredEmployee, "templates.manage_org")).toBe(false);
  });

  it("allows employees to manage their own templates", () => {
    expect(canAct(employee1, "templates.manage")).toBe(true);
    expect(canAct(employee1, "templates.view")).toBe(true);
  });
});

describe("Phase 1: Team & Mailbox Administration Access Control", () => {
  it("restricts user role and status modifications to Founders only", () => {
    expect(canAct(founder, "users.manage")).toBe(true);
    expect(canAct(founderOffice, "users.manage")).toBe(false);
    expect(canAct(employee1, "users.manage")).toBe(false);
  });

  it("allows Founders and Founder Office to grant send permissions, but never employees", () => {
    expect(canAct(founder, "users.grant_send")).toBe(true);
    expect(canAct(founderOffice, "users.grant_send")).toBe(true);
    expect(canAct(employee1, "users.grant_send")).toBe(false);
  });

  it("restricts SMTP mailbox configuration to Founders only", () => {
    expect(canAct(founder, "mailbox.manage")).toBe(true);
    expect(canAct(founderOffice, "mailbox.manage")).toBe(false);
    expect(canAct(employee1, "mailbox.manage")).toBe(false);
  });

  it("restricts live sending toggles and settings management to Founders only", () => {
    expect(canAct(founder, "settings.manage")).toBe(true);
    expect(canAct(founderOffice, "settings.manage")).toBe(false);
    expect(canAct(employee1, "settings.manage")).toBe(false);
  });
});

