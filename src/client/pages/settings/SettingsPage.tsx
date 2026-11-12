import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Copy, Inbox, Mail, UserPlus, Plus, Trash2, Edit2 } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { useActivity, useInvalidate, useMailbox, useTeam } from "../../lib/queries";
import { copyText, useTitle } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { formatDateTime, initials, num, timeAgo } from "../../lib/format";
import { PageHeader, Tabs, ActionMenu } from "../../components/ui/Navigation";
import { DescriptionList, Panel } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Checkbox, SelectField, TextField } from "../../components/ui/Field";
import { Callout, ErrorState, ProgressBar } from "../../components/ui/Feedback";
import { Pagination } from "../../components/ui/DataTable";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { PageLoader } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { ThemeToggle } from "../../components/ui/ThemeToggle";
import { PERMISSIONS, PERMISSION_LABELS, ROLE_DESCRIPTIONS, ROLE_LABELS, hasPermission, PASSWORD_MIN_LENGTH, type TeamMemberDto, type UserRole } from "@shared/auth";
import type { MailboxAccountDto } from "@shared/types";

type TabKey = "mailbox" | "team" | "activity" | "account";

// ---------------------------------------------------------------------------
// Mailbox Components
// ---------------------------------------------------------------------------

function ConnectMailboxDialog({
  open,
  onClose,
  initialEmail,
  initialFromName,
}: {
  open: boolean;
  onClose: () => void;
  initialEmail?: string;
  initialFromName?: string;
}) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState(initialFromName ?? "FocusRealm");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const invalidate = useInvalidate();
  const team = useTeam();

  const connect = useMutation({
    mutationFn: () =>
      api.post<{ mailboxId: string; email: string; fromName: string }>("/api/mailbox/connect", {
        email: email.trim(),
        password: password.trim() || undefined,
        fromName: fromName.trim(),
        assignUserIds: selectedUserIds,
      }),
    onSuccess: (res) => {
      toast.success(
        "Mailbox connected",
        `${res.data.fromName} <${res.data.email}> has been verified and configured for outreach.`
      );
      invalidate("mailbox", "overview", "campaigns");
      onClose();
      setEmail("");
      setPassword("");
      setSelectedUserIds([]);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!connect.isPending}
      title={initialEmail ? "Update Mailbox Credentials" : "Connect SpaceMail Mailbox"}
      description="Connect your SpaceMail email account. SMTP and IMAP connections are verified immediately."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={connect.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setError(null);
              connect.mutate();
            }}
            loading={connect.isPending}
            disabled={!email.trim() || (!initialEmail && !password.trim()) || !fromName.trim()}
          >
            {initialEmail ? "Update & Verify" : "Verify & Connect"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="SpaceMail Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g. outreach@focusrealm.com"
            hint="The shared SpaceMail address"
            required
            disabled={Boolean(initialEmail)}
          />
          <TextField
            label="Default Display Name"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="e.g. FocusRealm or Founder's Office"
            hint="Fallback sender name"
            required
          />
        </div>
        <TextField
          label="SpaceMail Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={initialEmail ? "Leave blank to keep existing password" : "Enter SpaceMail account password"}
          hint={initialEmail ? "Only enter if changing the SpaceMail password." : "Stored securely encrypted. Never exposed."}
          required={!initialEmail}
        />

        {team.data?.data && team.data.data.length > 0 && !initialEmail && (
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-ink-subtle">
              Assign Team Members (Optional)
            </label>
            <p className="mb-2 text-xs text-ink-subtle">
              Select team members who can immediately dispatch campaigns through this mailbox:
            </p>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-line divide-y divide-line bg-canvas">
              {team.data.data
                .filter((m) => m.status === "ACTIVE")
                .map((m) => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center justify-between px-3 py-2 text-xs hover:bg-surface-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedUserIds.includes(m.id)}
                        onChange={() => toggleUser(m.id)}
                        className="rounded border-line text-primary focus:ring-primary"
                      />
                      <span className="font-medium text-ink">{m.name}</span>
                      <span className="text-ink-subtle">({m.email})</span>
                    </div>
                    <Badge tone={m.role === "FOUNDER" ? "info" : m.role === "FOUNDER_OFFICE" ? "gold" : "neutral"}>
                      {ROLE_LABELS[m.role]}
                    </Badge>
                  </label>
                ))}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function AssignUserModal({
  open,
  mailbox,
  onClose,
}: {
  open: boolean;
  mailbox: MailboxAccountDto | null;
  onClose: () => void;
}) {
  const [userId, setUserId] = useState("");
  const [senderName, setSenderName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const invalidate = useInvalidate();
  const team = useTeam(Boolean(open));

  const alreadyAssignedUserIds = new Set(mailbox?.assignedUsers.map((u) => u.userId) ?? []);
  const availableMembers = (team.data?.data ?? []).filter(
    (m) => m.status === "ACTIVE" && !alreadyAssignedUserIds.has(m.id)
  );

  const handleSelectUser = (id: string) => {
    setUserId(id);
    const member = availableMembers.find((m) => m.id === id);
    if (member) {
      setSenderName(member.senderName || member.name || mailbox?.fromName || "");
    }
  };

  const assign = useMutation({
    mutationFn: () =>
      api.post(`/api/mailbox/${mailbox?.id}/assign-user`, {
        userId,
        senderName: senderName.trim() || undefined,
        isDefault,
      }),
    onSuccess: () => {
      toast.success("User assigned to mailbox", `${senderName || "User"} can now send campaigns using ${mailbox?.email}.`);
      invalidate("mailbox", "overview");
      onClose();
      setUserId("");
      setSenderName("");
      setIsDefault(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <Dialog
      open={open && Boolean(mailbox)}
      onClose={onClose}
      dismissable={!assign.isPending}
      title={`Assign Team Member to ${mailbox?.email}`}
      description="Authorize a team member to send campaigns through this SpaceMail mailbox with their own sender display name."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={assign.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setError(null);
              assign.mutate();
            }}
            loading={assign.isPending}
            disabled={!userId || !senderName.trim()}
          >
            Assign Access
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        {availableMembers.length === 0 ? (
          <p className="text-xs text-ink-subtle">
            All active team members have already been assigned to this mailbox.
          </p>
        ) : (
          <>
            <SelectField
              label="Select Team Member"
              value={userId}
              onChange={(e) => handleSelectUser(e.target.value)}
              options={[
                { value: "", label: "Choose team member..." },
                ...availableMembers.map((m) => ({
                  value: m.id,
                  label: `${m.name} (${m.email}) — ${ROLE_LABELS[m.role]}`,
                })),
              ]}
              required
            />
            <TextField
              label="Sender Display Name"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="e.g. Rahul Sharma"
              hint="The friendly name recipients see in their inbox"
              required
            />
            <Checkbox
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              label="Set as default sending mailbox for this user"
              description="Automatically selected when this user creates a new campaign."
            />
          </>
        )}
      </div>
    </Dialog>
  );
}

function EditSenderNameDialog({
  open,
  mailboxId,
  mailboxEmail,
  userId,
  userName,
  currentSenderName,
  isDefault,
  canToggleDefault = true,
  onClose,
}: {
  open: boolean;
  mailboxId: string;
  mailboxEmail: string;
  userId: string;
  userName: string;
  currentSenderName: string;
  isDefault: boolean;
  canToggleDefault?: boolean;
  onClose: () => void;
}) {
  const [senderName, setSenderName] = useState(currentSenderName);
  const [makeDefault, setMakeDefault] = useState(isDefault);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const invalidate = useInvalidate();

  const update = useMutation({
    mutationFn: () =>
      api.patch(`/api/mailbox/${mailboxId}/users/${userId}`, {
        senderName: senderName.trim(),
        ...(canToggleDefault ? { isDefault: makeDefault } : {}),
      }),
    onSuccess: () => {
      toast.success("Sender name updated", `Display name set to "${senderName}" for ${mailboxEmail}.`);
      invalidate("mailbox", "overview");
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!update.isPending}
      title="Edit Sender Display Name"
      description={`Set the display name for ${userName} when sending from ${mailboxEmail}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setError(null);
              update.mutate();
            }}
            loading={update.isPending}
            disabled={!senderName.trim()}
          >
            Save Changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <TextField
          label="Sender Display Name"
          value={senderName}
          onChange={(e) => setSenderName(e.target.value)}
          placeholder="e.g. Sehej Sharma"
          hint={`Recipients will see: "${senderName || "Name"}" <${mailboxEmail}>`}
          required
        />
        {canToggleDefault && (
          <Checkbox
            checked={makeDefault}
            onChange={(e) => setMakeDefault(e.target.checked)}
            label="Set as default sending mailbox for this user"
            description="Use this mailbox automatically for new campaigns."
          />
        )}
      </div>
    </Dialog>
  );
}

function MailboxTab() {
  const mailbox = useMailbox();
  const { user, can } = useAuth();
  const invalidate = useInvalidate();
  const toast = useToast();

  const [connectOpen, setConnectOpen] = useState(false);
  const [assignTargetMailbox, setAssignTargetMailbox] = useState<MailboxAccountDto | null>(null);
  const [editSenderTarget, setEditSenderTarget] = useState<{
    mailboxId: string;
    mailboxEmail: string;
    userId: string;
    userName: string;
    currentSenderName: string;
    isDefault: boolean;
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<MailboxAccountDto | null>(null);
  const [removeUserConfirm, setRemoveUserConfirm] = useState<{
    mailboxId: string;
    mailboxEmail: string;
    userId: string;
    userName: string;
  } | null>(null);

  const [testingMailboxId, setTestingMailboxId] = useState<string | null>(null);
  const [checkingInboxMailboxId, setCheckingInboxMailboxId] = useState<string | null>(null);

  const isEmployee = user?.role === "EMPLOYEE";
  const isFounder = user?.role === "FOUNDER";
  const canManageSettings = can("settings.manage");

  const testConnection = useMutation({
    mutationFn: (mailboxId?: string) => api.post("/api/mailbox/test-smtp", { mailboxId }),
    onSuccess: () => {
      toast.success("Connection verified", "Signed in to SpaceMail SMTP and IMAP successfully. No emails were sent.");
      setTestingMailboxId(null);
    },
    onError: (err) => {
      toast.error("Connection check failed", errorMessage(err));
      setTestingMailboxId(null);
    },
  });

  const checkInbox = useMutation({
    mutationFn: (mailboxId?: string) =>
      api.post<{ processed?: { bounces: number; replies: number } }>("/api/mailbox/check-inbox", { mailboxId }),
    onSuccess: (res) => {
      const p = res.data.processed;
      toast.success(
        "Inbox checked",
        p ? `Found ${p.replies} replies and ${p.bounces} bounces.` : "No new messages."
      );
      setCheckingInboxMailboxId(null);
      invalidate("mailbox", "campaigns", "overview");
    },
    onError: (err) => {
      toast.error("Inbox check failed", errorMessage(err));
      setCheckingInboxMailboxId(null);
    },
  });

  const removeUserAccess = useMutation({
    mutationFn: ({ mailboxId, userId }: { mailboxId: string; userId: string }) =>
      api.delete(`/api/mailbox/${mailboxId}/users/${userId}`),
    onSuccess: () => {
      toast.success("Access removed", "The user can no longer send campaigns from this mailbox.");
      invalidate("mailbox", "overview");
      setRemoveUserConfirm(null);
    },
    onError: (err) => toast.error("Could not remove access", errorMessage(err)),
  });

  const deleteMailbox = useMutation({
    mutationFn: (mailboxId: string) => api.delete(`/api/mailbox/${mailboxId}`),
    onSuccess: () => {
      toast.success("Mailbox removed", "The mailbox has been disconnected.");
      invalidate("mailbox", "overview");
      setDeleteConfirm(null);
    },
    onError: (err) => toast.error("Could not delete mailbox", errorMessage(err)),
  });

  const toggleLiveSending = useMutation({
    mutationFn: (enabled: boolean) =>
      api.post<{ success: boolean; allowLiveSending: boolean }>("/api/mailbox/live-sending", { enabled }),
    onSuccess: (res) => {
      toast.success(
        res.data.allowLiveSending ? "Live sending turned ON" : "Live sending turned OFF",
        res.data.allowLiveSending
          ? "Approved campaigns can now send through their authorized mailboxes."
          : "Sending is paused until a founder turns it back on."
      );
      invalidate("mailbox", "overview");
    },
    onError: (err) => toast.error("Could not change live sending", errorMessage(err)),
  });

  if (mailbox.isPending) return <PageLoader />;
  if (mailbox.isError) return <ErrorState error={mailbox.error} onRetry={() => mailbox.refetch()} />;
  const m = mailbox.data.data;

  return (
    <div className="space-y-6">
      {/* Founder / Founder's Office: All Workspace Mailboxes */}
      {!isEmployee ? (
        <Panel
          title="Workspace Mailboxes"
          description="Shared SpaceMail mailboxes available across FocusRealm. Multiple team members can be authorized to send from a single mailbox with their own display name."
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setConnectOpen(true)}
            >
              Connect Mailbox
            </Button>
          }
        >
          {!m.allMailboxes || m.allMailboxes.length === 0 ? (
            <div className="py-8 text-center">
              <Mail className="mx-auto h-10 w-10 text-ink-subtle/50 mb-3" />
              <h4 className="text-sm font-semibold text-ink">No workspace mailboxes connected</h4>
              <p className="mt-1 text-xs text-ink-subtle max-w-sm mx-auto">
                Connect a SpaceMail email account to allow team members to send personalized outreach campaigns.
              </p>
              <Button
                variant="primary"
                size="sm"
                className="mt-4"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setConnectOpen(true)}
              >
                Connect First Mailbox
              </Button>
            </div>
          ) : (
            <div className="space-y-6">
              {m.allMailboxes.map((acc) => (
                <div key={acc.id} className="rounded-xl border border-line bg-surface overflow-hidden shadow-xs">
                  {/* Mailbox Header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line bg-surface-muted/40 px-4 sm:px-5 py-3.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Mail className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-ink text-sm sm:text-base truncate">{acc.email}</span>
                          <Badge tone="success" dot>Active</Badge>
                        </div>
                        <p className="text-xs text-ink-subtle truncate">
                          Default sender: <span className="font-medium text-ink">{acc.fromName}</span>
                          {acc.lastVerifiedAt && ` · Verified ${timeAgo(acc.lastVerifiedAt)}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<UserPlus className="h-3.5 w-3.5" />}
                        onClick={() => setAssignTargetMailbox(acc)}
                      >
                        Assign member
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Mail className="h-3.5 w-3.5" />}
                        loading={testingMailboxId === acc.id}
                        onClick={() => {
                          setTestingMailboxId(acc.id);
                          testConnection.mutate(acc.id);
                        }}
                      >
                        Test
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Inbox className="h-3.5 w-3.5" />}
                        loading={checkingInboxMailboxId === acc.id}
                        onClick={() => {
                          setCheckingInboxMailboxId(acc.id);
                          checkInbox.mutate(acc.id);
                        }}
                      >
                        Check Inbox
                      </Button>
                      {isFounder && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger hover:bg-danger/10"
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          onClick={() => setDeleteConfirm(acc)}
                          aria-label="Delete mailbox"
                        />
                      )}
                    </div>
                  </div>

                  {/* Authorized Senders Sub-table */}
                  <div className="p-4 sm:p-5">
                    <div className="mb-3 flex items-center justify-between">
                      <h5 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                        Authorized Senders ({acc.assignedUsers.length})
                      </h5>
                      <span className="text-[11px] text-ink-faint">
                        Each member sends with their configured sender display name
                      </span>
                    </div>

                    {acc.assignedUsers.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-line p-4 text-center">
                        <p className="text-xs text-ink-subtle">
                          No team members are assigned to this mailbox yet.
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="mt-2 text-primary text-xs"
                          icon={<UserPlus className="h-3 w-3" />}
                          onClick={() => setAssignTargetMailbox(acc)}
                        >
                          Assign first member
                        </Button>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-line text-left text-ink-subtle">
                              <th className="pb-2 font-medium">Team Member</th>
                              <th className="pb-2 font-medium">Role</th>
                              <th className="pb-2 font-medium">Outreach Identity (From Header)</th>
                              <th className="pb-2 font-medium text-center">Default</th>
                              <th className="pb-2 font-medium text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line/60">
                            {acc.assignedUsers.map((u) => (
                              <tr key={u.userId} className="hover:bg-surface-muted/30">
                                <td className="py-2.5">
                                  <div className="flex items-center gap-2">
                                    <span className="flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                                      {initials(u.userName)}
                                    </span>
                                    <div>
                                      <p className="font-semibold text-ink">
                                        {u.userName} {u.userId === user?.id && <span className="font-normal text-ink-subtle">(you)</span>}
                                      </p>
                                      <p className="text-[11px] text-ink-subtle">
                                        {u.employeeId ? `${u.employeeId} · ` : ""}{u.userEmail}
                                      </p>
                                    </div>
                                  </div>
                                </td>
                                <td className="py-2.5">
                                  <Badge tone={u.userRole === "FOUNDER" ? "info" : u.userRole === "FOUNDER_OFFICE" ? "gold" : "neutral"}>
                                    {ROLE_LABELS[u.userRole]}
                                  </Badge>
                                </td>
                                <td className="py-2.5">
                                  <span className="font-medium text-ink">
                                    "{u.senderName || acc.fromName}"
                                  </span>{" "}
                                  <span className="text-ink-subtle">&lt;{acc.email}&gt;</span>
                                </td>
                                <td className="py-2.5 text-center">
                                  {u.isDefault ? (
                                    <Badge tone="info">Default</Badge>
                                  ) : (
                                    <span className="text-ink-faint">—</span>
                                  )}
                                </td>
                                <td className="py-2.5 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-xs"
                                      icon={<Edit2 className="h-3 w-3" />}
                                      onClick={() =>
                                        setEditSenderTarget({
                                          mailboxId: acc.id,
                                          mailboxEmail: acc.email,
                                          userId: u.userId,
                                          userName: u.userName,
                                          currentSenderName: u.senderName || acc.fromName,
                                          isDefault: u.isDefault,
                                        })
                                      }
                                    >
                                      Edit name
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-xs text-danger hover:bg-danger/10"
                                      icon={<Trash2 className="h-3 w-3" />}
                                      onClick={() =>
                                        setRemoveUserConfirm({
                                          mailboxId: acc.id,
                                          mailboxEmail: acc.email,
                                          userId: u.userId,
                                          userName: u.userName,
                                        })
                                      }
                                    >
                                      Remove
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      ) : (
        /* Employee View: Assigned Mailboxes */
        <Panel
          title="Your Assigned Mailboxes"
          description="You have been authorized by the Founder's Office to send outreach campaigns through these SpaceMail mailboxes. When creating campaigns, you can choose which mailbox to send from."
        >
          {!m.accessibleMailboxes || m.accessibleMailboxes.length === 0 ? (
            <Callout tone="warning" title="No sending mailbox assigned">
              You do not currently have any sending mailboxes assigned to your account. Reach out to Founder's Office or a Founder to be granted access to an outreach mailbox. In the meantime, you can still create contact lists, templates, and drafts.
            </Callout>
          ) : (
            <div className="space-y-4">
              {m.accessibleMailboxes.map((mb) => (
                <div key={mb.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-line bg-surface p-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Mail className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-ink text-sm sm:text-base truncate">{mb.email}</span>
                        {mb.isDefault && <Badge tone="info">Default Mailbox</Badge>}
                      </div>
                      <p className="text-xs text-ink-subtle mt-0.5 truncate">
                        Sends as: <span className="font-medium text-ink">"{mb.senderName}" &lt;{mb.email}&gt;</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Edit2 className="h-3.5 w-3.5" />}
                      onClick={() =>
                        setEditSenderTarget({
                          mailboxId: mb.id,
                          mailboxEmail: mb.email,
                          userId: user!.id,
                          userName: user!.name,
                          currentSenderName: mb.senderName,
                          isDefault: mb.isDefault,
                        })
                      }
                    >
                      Edit Display Name
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Mail className="h-3.5 w-3.5" />}
                      loading={testingMailboxId === mb.id}
                      onClick={() => {
                        setTestingMailboxId(mb.id);
                        testConnection.mutate(mb.id);
                      }}
                    >
                      Test connection
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {/* Live Sending & Limits (Founders & Authorized Managers) */}
      {canManageSettings && (
        <Panel
          title="Live Sending & Limits"
          description="Controls whether approved campaigns can send live emails or remain in safe draft mode."
          actions={
            <Button
              size="sm"
              variant={m.liveSendingEnabled ? "secondary" : "primary"}
              loading={toggleLiveSending.isPending}
              onClick={() => toggleLiveSending.mutate(!m.liveSendingEnabled)}
            >
              {m.liveSendingEnabled ? "Turn Off Live Sending" : "Turn On Live Sending"}
            </Button>
          }
        >
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              {m.liveSendingEnabled ? (
                <Badge tone="success" dot>Live sending is ON</Badge>
              ) : (
                <Badge tone="warning" dot>Live sending is OFF</Badge>
              )}
              <span className="text-[13px] text-ink-muted">
                {m.liveSendingEnabled
                  ? "Approved campaigns can immediately dispatch live emails to recipients."
                  : (m.liveSendingBlocker || "Live sending is locked. Test emails can still be sent.")}
              </span>
            </div>
            <div>
              <div className="mb-1.5 flex justify-between text-[13px]">
                <span className="text-ink-muted">Sent in the last 24 hours</span>
                <span className="tabular text-ink">{num(m.sentLast24h)} of {num(m.dailyLimit)}</span>
              </div>
              <ProgressBar segments={[{ value: m.sentLast24h, className: "bg-brand", label: "Sent" }, { value: Math.max(0, m.dailyLimit - m.sentLast24h), className: "bg-transparent", label: "Remaining" }]} />
              <p className="mt-1.5 text-xs text-ink-subtle">When the daily limit is reached, sending waits and continues automatically.</p>
            </div>
          </div>
        </Panel>
      )}

      {/* Bounce & Reply Detection (IMAP) */}
      <Panel
        title="Bounce & reply detection"
        description="Reads the active mailbox inbox (read-only) to find bounce reports and replies to your campaigns."
        actions={
          m.imap.configured && (
            <Button
              size="sm"
              icon={<Inbox className="h-4 w-4" />}
              onClick={() => checkInbox.mutate(undefined)}
              loading={checkingInboxMailboxId === "default" || checkInbox.isPending}
            >
              Check inbox now
            </Button>
          )
        }
      >
        <div className="space-y-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-3">
            {m.imap.enabled ? <Badge tone="success" dot>Automatic checks on</Badge> : m.imap.configured ? <Badge tone="neutral" dot>Automatic checks off</Badge> : <Badge tone="warning" dot>Not configured</Badge>}
            {m.imap.configured && <span className="text-ink-muted">{m.imap.host}:{m.imap.port}</span>}
          </div>
          {m.imap.lastCheckedAt && <p className="text-ink-muted">Last checked {timeAgo(m.imap.lastCheckedAt)}.</p>}
          {m.imap.lastError && <Callout tone="danger" title="Last check failed">{m.imap.lastError}</Callout>}
          {!m.imap.enabled && m.imap.configured && (
            <p className="text-xs text-ink-subtle">
              Automatic inbox checks are disabled. The inbox can still be checked manually; enable polling in server settings for automatic reply and bounce detection.
            </p>
          )}
        </div>
      </Panel>

      {/* Team Mailbox Health */}
      {m.teamMailboxHealth && (
        <Panel title="Team mailbox setup" description="Mailbox readiness across active team members.">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted">
            <span>{num(m.teamMailboxHealth.connectedMailboxes)} of {num(m.teamMailboxHealth.activeUsers)} mailboxes connected</span>
            {m.teamMailboxHealth.inboxErrors > 0 && <span className="text-danger">{num(m.teamMailboxHealth.inboxErrors)} inbox connection problems</span>}
            {m.teamMailboxHealth.inboxesNotChecked > 0 && <span>{num(m.teamMailboxHealth.inboxesNotChecked)} inboxes not checked yet</span>}
          </div>
        </Panel>
      )}

      {/* Modals */}
      <ConnectMailboxDialog open={connectOpen} onClose={() => setConnectOpen(false)} />

      <AssignUserModal
        open={Boolean(assignTargetMailbox)}
        mailbox={assignTargetMailbox}
        onClose={() => setAssignTargetMailbox(null)}
      />

      {editSenderTarget && (
        <EditSenderNameDialog
          open={Boolean(editSenderTarget)}
          mailboxId={editSenderTarget.mailboxId}
          mailboxEmail={editSenderTarget.mailboxEmail}
          userId={editSenderTarget.userId}
          userName={editSenderTarget.userName}
          currentSenderName={editSenderTarget.currentSenderName}
          isDefault={editSenderTarget.isDefault}
          canToggleDefault={!isEmployee || canManageSettings}
          onClose={() => setEditSenderTarget(null)}
        />
      )}

      {removeUserConfirm && (
        <ConfirmDialog
          open
          onClose={() => setRemoveUserConfirm(null)}
          onConfirm={() =>
            removeUserAccess.mutate({
              mailboxId: removeUserConfirm.mailboxId,
              userId: removeUserConfirm.userId,
            })
          }
          loading={removeUserAccess.isPending}
          tone="danger"
          title={`Remove access for ${removeUserConfirm.userName}?`}
          description={`They will no longer be able to send outreach campaigns through ${removeUserConfirm.mailboxEmail}.`}
          confirmLabel="Remove Access"
        />
      )}

      {deleteConfirm && (
        <ConfirmDialog
          open
          onClose={() => setDeleteConfirm(null)}
          onConfirm={() => deleteMailbox.mutate(deleteConfirm.id)}
          loading={deleteMailbox.isPending}
          tone="danger"
          title={`Disconnect mailbox ${deleteConfirm.email}?`}
          description="This will remove the mailbox credentials and unassign all team members from this sending address. Existing campaigns and sending history are preserved."
          confirmLabel="Disconnect Mailbox"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

function LinkResult({ title, url, emailed, onClose }: { title: string; url: string; emailed: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onClose={onClose} title={title} description={emailed ? "We emailed this link. You can also share it directly." : "Share this link with them directly. It works once."} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="flex gap-2">
        <input readOnly value={url} className="control h-9 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button icon={<Copy className="h-4 w-4" />} onClick={async () => setCopied(await copyText(url))}>{copied ? "Copied" : "Copy"}</Button>
      </div>
    </Dialog>
  );
}

function InviteDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: (r: { inviteUrl: string; emailed: boolean }) => void }) {
  const [form, setForm] = useState({
    email: "",
    name: "",
    role: "EMPLOYEE" as UserRole,
    canSendWithoutApproval: false,
    sendEmail: true,
  });
  const invalidate = useInvalidate();
  const invite = useMutation({
    mutationFn: () => api.post<{ inviteUrl: string; emailed: boolean }>("/api/users/invite", form),
    onSuccess: async (res) => {
      await invalidate("team");
      setForm({ email: "", name: "", role: "EMPLOYEE", canSendWithoutApproval: false, sendEmail: true });
      onInvited(res.data);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!invite.isPending}
      title="Invite a teammate"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => invite.mutate()} loading={invite.isPending} disabled={!form.email || !form.name}>Create invite</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-autofocus />
          <TextField label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <SelectField
          label="Role"
          value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
          options={[
            { value: "EMPLOYEE", label: "Employee (Outreach Creator)" },
            { value: "FOUNDER_OFFICE", label: "Founder's Office (Operations & Approvals)" },
            { value: "FOUNDER", label: "Founder (Full Administrator)" },
          ]}
          hint={ROLE_DESCRIPTIONS[form.role]}
        />
        {form.role === "EMPLOYEE" && (
          <Checkbox
            checked={form.canSendWithoutApproval}
            onChange={(e) => setForm({ ...form, canSendWithoutApproval: e.target.checked })}
            label="Allow direct sending without prior approval"
            description="Permits this employee to start approved campaigns without waiting for Founder's Office sign-off."
          />
        )}
        <Checkbox checked={form.sendEmail} onChange={(e) => setForm({ ...form, sendEmail: e.target.checked })} label="Email the invite from the mailbox" description="You'll get a link to share either way." />
        {invite.isError && <Callout tone="danger">{errorMessage(invite.error)}</Callout>}
      </div>
    </Dialog>
  );
}

function TeamTab() {
  const { user, can } = useAuth();
  const team = useTeam();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ title: string; url: string; emailed: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{
    member: TeamMemberDto;
    action: "disable" | "enable" | "founder" | "founder_office" | "employee" | "grant_send" | "revoke_send";
  } | null>(null);

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.patch(`/api/users/${id}`, body),
    onSuccess: async () => {
      await invalidate("team");
      toast.success("Team updated");
      setConfirm(null);
    },
    onError: (err) => toast.error("Couldn't update", errorMessage(err)),
  });
  const reset = useMutation({
    mutationFn: (m: TeamMemberDto) => api.post<{ resetUrl: string; emailed: boolean }>(`/api/users/${m.id}/reset-link`, { sendEmail: true }),
    onSuccess: (res, m) => setLink({ title: `Password reset link for ${m.name}`, url: res.data.resetUrl, emailed: res.data.emailed }),
    onError: (err) => toast.error("Couldn't create link", errorMessage(err)),
  });
  const resendInvite = useMutation({
    mutationFn: (m: TeamMemberDto) => api.post<{ inviteUrl: string; emailed: boolean }>("/api/users/invite", { email: m.email, name: m.name, role: m.role, sendEmail: true }),
    onSuccess: (res, m) => setLink({ title: `New invite link for ${m.name}`, url: res.data.inviteUrl, emailed: res.data.emailed }),
    onError: (err) => toast.error("Couldn't create invite", errorMessage(err)),
  });

  const manage = can("users.manage");
  const canGrantSend = can("users.grant_send");
  const isFounder = user?.role === "FOUNDER";

  const confirmText = confirm && {
    disable: { title: `Disable ${confirm.member.name}?`, description: "They're signed out and can't sign in. Their history stays.", label: "Disable", body: { status: "DISABLED" } },
    enable: { title: `Re-enable ${confirm.member.name}?`, description: "They can sign in again with their password.", label: "Enable", body: { status: "ACTIVE" } },
    founder: { title: `Make ${confirm.member.name} a founder?`, description: "Founders have full administrative control over all organization settings and mailbox credentials.", label: "Make founder", body: { role: "FOUNDER" } },
    founder_office: { title: `Assign ${confirm.member.name} to Founder's Office?`, description: "Founder's Office manages operational campaigns, reviews approvals, and coordinates team sending.", label: "Assign to Founder's Office", body: { role: "FOUNDER_OFFICE" } },
    employee: { title: `Change ${confirm.member.name} to employee?`, description: "They will focus on preparing campaigns and contacts, and sending will require approval.", label: "Change to employee", body: { role: "EMPLOYEE" } },
    grant_send: { title: `Enable direct sending for ${confirm.member.name}?`, description: "This employee will be permitted to start sending approved campaigns without waiting for approval.", label: "Enable Direct Send", body: { canSendWithoutApproval: true } },
    revoke_send: { title: `Require approval for ${confirm.member.name}?`, description: "This employee's campaigns will require review and approval from Founder's Office before sending.", label: "Require Approval", body: { canSendWithoutApproval: false } },
  }[confirm.action];

  return (
    <div className="space-y-6">
      <Panel
        title="Team & Roles"
        description="FocusRealm organization members, permissions, and sending approvals."
        flush
        actions={manage && <Button variant="primary" size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setInviting(true)}>Invite teammate</Button>}
      >
        {team.isPending ? (
          <PageLoader />
        ) : team.isError ? (
          <ErrorState error={team.error} onRetry={() => team.refetch()} />
        ) : (
          <ul className="divide-y divide-line">
            {team.data.data.map((m) => (
              <li key={m.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-5 py-3.5">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-full bg-gradient-to-br from-[#1E5AE6] to-[#0B142E] text-xs font-bold text-white shadow-xs ring-1 ring-white/20 dark:from-[#3B82F6] dark:to-[#0D1527] dark:ring-white/25">
                    {initials(m.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-ink">
                      {m.name} {m.id === user?.id && <span className="font-normal text-ink-subtle">(you)</span>}
                    </p>
                    <p className="truncate text-xs text-ink-subtle">
                      {m.email} · {m.status === "INVITED" ? `invited${m.invitedBy ? ` by ${m.invitedBy}` : ""} ${timeAgo(m.createdAt)}` : m.lastLoginAt ? `last signed in ${timeAgo(m.lastLoginAt)}` : "hasn't signed in"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 self-start sm:self-center pl-12 sm:pl-0 flex-wrap">
                  <Badge tone={m.role === "FOUNDER" ? "info" : m.role === "FOUNDER_OFFICE" ? "gold" : "neutral"}>
                    {ROLE_LABELS[m.role]}
                  </Badge>
                  {m.role === "EMPLOYEE" && m.canSendWithoutApproval && (
                    <Badge tone="success">Direct Send</Badge>
                  )}
                  {m.status !== "ACTIVE" && <Badge tone={m.status === "INVITED" ? "warning" : "danger"}>{m.status === "INVITED" ? "Invite pending" : "Disabled"}</Badge>}
                  {(manage || canGrantSend) && m.id !== user?.id && (
                    <ActionMenu
                      items={[
                        { label: "Make Founder", onSelect: () => setConfirm({ member: m, action: "founder" }), hidden: !isFounder || m.role === "FOUNDER" || m.status === "DISABLED" },
                        { label: "Assign to Founder's Office", onSelect: () => setConfirm({ member: m, action: "founder_office" }), hidden: !isFounder || m.role === "FOUNDER_OFFICE" || m.status === "DISABLED" },
                        { label: "Change to Employee", onSelect: () => setConfirm({ member: m, action: "employee" }), hidden: !isFounder || m.role === "EMPLOYEE" },
                        { label: "Enable Direct Sending", onSelect: () => setConfirm({ member: m, action: "grant_send" }), hidden: !canGrantSend || m.role !== "EMPLOYEE" || m.canSendWithoutApproval || m.status === "DISABLED" },
                        { label: "Require Approval to Send", onSelect: () => setConfirm({ member: m, action: "revoke_send" }), hidden: !canGrantSend || m.role !== "EMPLOYEE" || !m.canSendWithoutApproval || m.status === "DISABLED" },
                        { label: "Resend invite", onSelect: () => resendInvite.mutate(m), hidden: !manage || m.status !== "INVITED" },
                        { label: "Send password reset link", onSelect: () => reset.mutate(m), hidden: !manage || m.status !== "ACTIVE" },
                        { label: "Re-enable account", onSelect: () => setConfirm({ member: m, action: "enable" }), hidden: !manage || m.status !== "DISABLED" },
                        { label: "Disable account", tone: "danger", onSelect: () => setConfirm({ member: m, action: "disable" }), hidden: !manage || m.status !== "ACTIVE" },
                      ]}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Role Capabilities & Responsibilities" flush>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-ink-subtle">
                <th className="py-2.5 pl-5">Capability / Permission</th>
                <th className="w-28 py-2.5 text-center">Founder</th>
                <th className="w-32 py-2.5 text-center">Founder's Office</th>
                <th className="w-28 py-2.5 pr-5 text-center">Employee</th>
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.filter((p) => !p.endsWith(".view")).map((p) => (
                <tr key={p} className="border-b border-line last:border-0 hover:bg-surface-muted/30">
                  <td className="py-2.5 pl-5 text-ink-muted">{PERMISSION_LABELS[p]}</td>
                  <td className="py-2.5 text-center">{hasPermission("FOUNDER", p) ? <CheckCircle2 className="inline h-4 w-4 text-success" aria-label="Yes" /> : <span className="text-ink-faint" aria-label="No">—</span>}</td>
                  <td className="py-2.5 text-center">{hasPermission("FOUNDER_OFFICE", p) ? <CheckCircle2 className="inline h-4 w-4 text-success" aria-label="Yes" /> : <span className="text-ink-faint" aria-label="No">—</span>}</td>
                  <td className="py-2.5 pr-5 text-center">{hasPermission("EMPLOYEE", p) ? <CheckCircle2 className="inline h-4 w-4 text-success" aria-label="Yes" /> : <span className="text-ink-faint" aria-label="No">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <InviteDialog open={inviting} onClose={() => setInviting(false)} onInvited={(r) => { setInviting(false); setLink({ title: "Invite created", url: r.inviteUrl, emailed: r.emailed }); }} />
      {link && <LinkResult {...link} onClose={() => setLink(null)} />}
      {confirm && confirmText && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => update.mutate({ id: confirm.member.id, body: confirmText.body })}
          loading={update.isPending}
          tone={confirm.action === "disable" ? "danger" : "primary"}
          title={confirmText.title}
          description={confirmText.description}
          confirmLabel={confirmText.label}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity & account
// ---------------------------------------------------------------------------

function ActivityTab() {
  const [page, setPage] = useState(1);
  const activity = useActivity(page);
  if (activity.isPending) return <PageLoader />;
  if (activity.isError) return <ErrorState error={activity.error} onRetry={() => activity.refetch()} />;
  return (
    <Panel title="Activity" description="Who did what. Sign-ins are left out." flush>
      {activity.data.data.length ? (
        <ul className="divide-y divide-line">
          {activity.data.data.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-4 px-5 py-3 text-[13px]">
              <p>
                <span className="font-medium">{a.user?.name ?? "System"}</span> <span className="text-ink-muted">{a.summary}</span>
              </p>
              <span className="shrink-0 whitespace-nowrap text-xs text-ink-subtle" title={formatDateTime(a.createdAt)}>{timeAgo(a.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 py-8 text-center text-[13px] text-ink-subtle">Nothing recorded yet.</p>
      )}
      <Pagination pagination={activity.data.pagination} onPage={setPage} />
    </Panel>
  );
}

function AccountTab() {
  const { user, refresh } = useAuth();
  const toast = useToast();

  const [senderName, setSenderName] = useState(user?.senderName ?? user?.name ?? "");
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const updateProfile = useMutation({
    mutationFn: () =>
      api.patch("/api/auth/me", {
        senderName: senderName.trim() || null,
      }),
    onSuccess: async () => {
      await refresh();
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 3000);
      toast.success("Sender name updated", "Your display name for new campaigns has been saved.");
    },
    onError: (err) => setProfileError(errorMessage(err)),
  });

  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: () => api.post("/api/auth/password", { currentPassword: form.currentPassword, newPassword: form.newPassword }),
    onSuccess: () => {
      toast.success("Password changed", "Other devices were signed out.");
      setForm({ currentPassword: "", newPassword: "", confirm: "" });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const submit = () => {
    if (form.newPassword.length < PASSWORD_MIN_LENGTH) return setError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
    if (form.newPassword !== form.confirm) return setError("The new passwords don't match.");
    setError(null);
    change.mutate();
  };
  return (
    <div className="max-w-2xl space-y-6">
      <Panel title="Profile">
        <DescriptionList
          items={[
            { label: "Name", value: user?.name },
            { label: "Login Email", value: user?.email },
            { label: "Role", value: user && ROLE_LABELS[user.role] },
          ]}
        />
      </Panel>

      <Panel title="Appearance" description="Choose how FocusRealm looks to you.">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-ink">Interface Theme</p>
            <p className="text-xs text-ink-subtle mt-0.5">Toggle between Light workspace and Dark luxury theme.</p>
          </div>
          <ThemeToggle />
        </div>
      </Panel>

      <Panel
        title="Default sender name"
        description="Your connected SpaceMail mailbox provides the sender email. Set the display name used for new campaigns."
      >
        <div className="space-y-4">
          {profileError && <Callout tone="danger">{profileError}</Callout>}
          {profileSaved && (
            <p className="text-xs text-success flex items-center gap-1">
              <CheckCircle2 className="h-4 w-4" /> Sender name saved.
            </p>
          )}
          <TextField
            label="Sender display name"
            value={senderName}
            onChange={(e) => setSenderName(e.target.value)}
            placeholder={user?.name || "e.g. Sehej Sharma"}
            hint="Name shown to recipients in their inbox"
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              loading={updateProfile.isPending}
              onClick={() => updateProfile.mutate()}
            >
              Save sender name
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="Change password">
        <div className="space-y-4">
          <TextField label="Current password" type="password" autoComplete="current-password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="New password" type="password" autoComplete="new-password" value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} />
            <TextField label="Confirm new password" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </div>
          {error && <Callout tone="danger">{error}</Callout>}
          <div className="flex justify-end">
            <Button variant="primary" onClick={submit} loading={change.isPending} disabled={!form.currentPassword || !form.newPassword}>Change password</Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

export function SettingsPage() {
  const { tab: tabParam } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();

  const canTeam = can("users.view");

  const defaultTab = "mailbox";
  let tab: TabKey = (["mailbox", "team", "activity", "account"].includes(tabParam ?? "") ? tabParam : defaultTab) as TabKey;
  if (tab === "team" && !canTeam) tab = defaultTab;

  useTitle("Settings");

  const tabs = [
    { key: "mailbox" as const, label: user?.role === "EMPLOYEE" ? "Your Mailbox" : "Mailboxes" },
    ...(canTeam ? [{ key: "team" as const, label: "Team & Roles" }] : []),
    { key: "activity" as const, label: user?.role === "EMPLOYEE" ? "Your Activity" : "Activity Log" },
    { key: "account" as const, label: "Your account" },
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        description={
          user?.role === "FOUNDER"
            ? "Workspace mailboxes, organization team members, and outreach controls."
            : user?.role === "FOUNDER_OFFICE"
            ? "Mailboxes, team members, operations log, and sending identity."
            : "Your assigned sending mailboxes and account settings."
        }
      />
      <Tabs
        className="mb-6"
        active={tab}
        onChange={(t) => navigate(`/settings/${t}`, { replace: true })}
        tabs={tabs}
      />
      {tab === "mailbox" && <MailboxTab />}
      {tab === "team" && <TeamTab />}
      {tab === "activity" && <ActivityTab />}
      {tab === "account" && <AccountTab />}
    </>
  );
}
