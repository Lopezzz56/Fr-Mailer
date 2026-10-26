import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Copy, Inbox, Mail, UserPlus } from "lucide-react";
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
import { RequirePermission } from "../../components/layout/RequireAuth";
import { PERMISSIONS, PERMISSION_LABELS, ROLE_DESCRIPTIONS, ROLE_LABELS, hasPermission, PASSWORD_MIN_LENGTH, type TeamMemberDto, type UserRole } from "@shared/auth";

type TabKey = "mailbox" | "team" | "activity" | "account";

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

function MailboxTab() {
  const mailbox = useMailbox();
  const { can } = useAuth();
  const invalidate = useInvalidate();
  const test = useMutation({ mutationFn: () => api.post("/api/mailbox/test-smtp") });
  const inbox = useMutation({ mutationFn: () => api.post<{ processed?: { bounces: number; replies: number } }>("/api/mailbox/check-inbox"), onSettled: () => invalidate("mailbox", "campaigns", "overview") });

  if (mailbox.isPending) return <PageLoader />;
  if (mailbox.isError) return <ErrorState error={mailbox.error} onRetry={() => mailbox.refetch()} />;
  const m = mailbox.data.data;

  return (
    <div className="space-y-6">
      <Panel
        title="Sending mailbox"
        description="The SpaceMail account every campaign and test is sent from."
        actions={m.smtp.configured && <Button size="sm" icon={<Mail className="h-4 w-4" />} onClick={() => test.mutate()} loading={test.isPending}>Test connection</Button>}
      >
        {m.smtp.configured ? (
          <DescriptionList
            items={[
              { label: "Sends as", value: `${m.smtp.fromName} <${m.smtp.fromEmail}>` },
              { label: "Signs in as", value: m.smtp.user ?? "—" },
              { label: "Server", value: `${m.smtp.host}:${m.smtp.port} · ${m.smtp.secure ? "TLS" : "STARTTLS"}` },
              { label: "Links in emails point to", value: m.publicUrl },
            ]}
          />
        ) : (
          <Callout tone="warning" title="Not configured">Set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM_EMAIL in the server's .env file, then restart.</Callout>
        )}
        {test.isSuccess && <p className="mt-4 flex items-center gap-2 text-[13px] text-success"><CheckCircle2 className="h-4 w-4" /> Signed in successfully. No email was sent.</p>}
        {test.isError && <Callout tone="danger" className="mt-4">{errorMessage(test.error)}</Callout>}
        <p className="mt-5 border-t border-line pt-4 text-xs text-ink-subtle">Mailbox credentials live in the server's environment file and are never shown or edited here.</p>
      </Panel>

      <Panel title="Sending">
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            {m.liveSendingEnabled ? <Badge tone="success" dot>Live sending on</Badge> : <Badge tone="warning" dot>Live sending off</Badge>}
            <span className="text-[13px] text-ink-muted">
              {m.liveSendingEnabled ? "Approved campaigns can send to their recipients." : m.liveSendingBlocker}
            </span>
          </div>
          {!m.liveSendingEnabled && m.smtp.configured && (
            <p className="text-xs text-ink-subtle">To turn it on, set <code className="rounded bg-surface-sunken px-1">ALLOW_LIVE_SENDING=true</code> in .env and restart the server. Test emails work either way.</p>
          )}
          <div>
            <div className="mb-1.5 flex justify-between text-[13px]">
              <span className="text-ink-muted">Sent in the last 24 hours</span>
              <span className="tabular text-ink">{num(m.sentLast24h)} of {num(m.dailyLimit)}</span>
            </div>
            <ProgressBar segments={[{ value: m.sentLast24h, className: "bg-brand", label: "Sent" }, { value: Math.max(0, m.dailyLimit - m.sentLast24h), className: "bg-transparent", label: "Remaining" }]} />
            <p className="mt-1.5 text-xs text-ink-subtle">When the limit is reached, sending waits and continues automatically. Change it with DAILY_SEND_LIMIT.</p>
          </div>
        </div>
      </Panel>

      <Panel
        title="Bounce & reply detection"
        description="Reads the mailbox's inbox (read-only) to find bounce reports and replies to your campaigns."
        actions={can("settings.manage") && m.imap.configured && <Button size="sm" icon={<Inbox className="h-4 w-4" />} onClick={() => inbox.mutate()} loading={inbox.isPending}>Check inbox now</Button>}
      >
        <div className="space-y-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-3">
            {m.imap.enabled ? <Badge tone="success" dot>Automatic checks on</Badge> : m.imap.configured ? <Badge tone="neutral" dot>Automatic checks off</Badge> : <Badge tone="warning" dot>Not configured</Badge>}
            {m.imap.configured && <span className="text-ink-muted">{m.imap.host}:{m.imap.port}</span>}
          </div>
          {m.imap.lastCheckedAt && <p className="text-ink-muted">Last checked {timeAgo(m.imap.lastCheckedAt)}.</p>}
          {m.imap.lastError && <Callout tone="danger" title="Last check failed">{m.imap.lastError}</Callout>}
          {inbox.isSuccess && <p className="flex items-center gap-2 text-success"><CheckCircle2 className="h-4 w-4" /> Inbox checked.</p>}
          {inbox.isError && <Callout tone="danger">{errorMessage(inbox.error)}</Callout>}
          {!m.imap.enabled && m.imap.configured && <p className="text-xs text-ink-subtle">Set <code className="rounded bg-surface-sunken px-1">IMAP_POLL_ENABLED=true</code> to check automatically every few minutes. Hard bounces are added to the suppression list.</p>}
        </div>
      </Panel>
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
  const [form, setForm] = useState({ email: "", name: "", role: "EMPLOYEE" as UserRole, sendEmail: true });
  const invalidate = useInvalidate();
  const invite = useMutation({
    mutationFn: () => api.post<{ inviteUrl: string; emailed: boolean }>("/api/users/invite", form),
    onSuccess: async (res) => {
      await invalidate("team");
      setForm({ email: "", name: "", role: "EMPLOYEE", sendEmail: true });
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
        <SelectField label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })} options={[{ value: "EMPLOYEE", label: "Employee" }, { value: "FOUNDER", label: "Founder" }]} hint={ROLE_DESCRIPTIONS[form.role]} />
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
  const [confirm, setConfirm] = useState<{ member: TeamMemberDto; action: "disable" | "enable" | "founder" | "employee" } | null>(null);

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
  const confirmText = confirm && {
    disable: { title: `Disable ${confirm.member.name}?`, description: "They're signed out and can't sign in. Their history stays.", label: "Disable", body: { status: "DISABLED" } },
    enable: { title: `Re-enable ${confirm.member.name}?`, description: "They can sign in again with their password.", label: "Enable", body: { status: "ACTIVE" } },
    founder: { title: `Make ${confirm.member.name} a founder?`, description: "Founders can approve campaigns and manage the team and settings.", label: "Make founder", body: { role: "FOUNDER" } },
    employee: { title: `Change ${confirm.member.name} to employee?`, description: "They'll no longer be able to approve campaigns or manage the team.", label: "Change role", body: { role: "EMPLOYEE" } },
  }[confirm.action];

  return (
    <div className="space-y-6">
      <Panel
        title="Team"
        description="Founders approve campaigns; employees prepare them."
        flush
        actions={manage && <Button variant="primary" size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setInviting(true)}>Invite</Button>}
      >
        {team.isPending ? (
          <PageLoader />
        ) : team.isError ? (
          <ErrorState error={team.error} onRetry={() => team.refetch()} />
        ) : (
          <ul className="divide-y divide-line">
            {team.data.data.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-5 py-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-navy text-xs font-semibold text-white">{initials(m.name)}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">
                    {m.name} {m.id === user?.id && <span className="font-normal text-ink-subtle">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-ink-subtle">
                    {m.email} · {m.status === "INVITED" ? `invited${m.invitedBy ? ` by ${m.invitedBy}` : ""} ${timeAgo(m.createdAt)}` : m.lastLoginAt ? `last signed in ${timeAgo(m.lastLoginAt)}` : "hasn't signed in"}
                  </p>
                </div>
                <Badge tone={m.role === "FOUNDER" ? "info" : "neutral"}>{ROLE_LABELS[m.role]}</Badge>
                {m.status !== "ACTIVE" && <Badge tone={m.status === "INVITED" ? "warning" : "danger"}>{m.status === "INVITED" ? "Invite pending" : "Disabled"}</Badge>}
                {manage && m.id !== user?.id && (
                  <ActionMenu
                    items={[
                      { label: "Make founder", onSelect: () => setConfirm({ member: m, action: "founder" }), hidden: m.role === "FOUNDER" || m.status === "DISABLED" },
                      { label: "Change to employee", onSelect: () => setConfirm({ member: m, action: "employee" }), hidden: m.role === "EMPLOYEE" },
                      { label: "Resend invite", onSelect: () => resendInvite.mutate(m), hidden: m.status !== "INVITED" },
                      { label: "Send password reset link", onSelect: () => reset.mutate(m), hidden: m.status !== "ACTIVE" },
                      { label: "Re-enable", onSelect: () => setConfirm({ member: m, action: "enable" }), hidden: m.status !== "DISABLED" },
                      { label: "Disable", tone: "danger", onSelect: () => setConfirm({ member: m, action: "disable" }), hidden: m.status !== "ACTIVE" },
                    ]}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="What each role can do" flush>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line bg-surface-muted text-left text-xs font-medium text-ink-subtle">
              <th className="py-2.5 pl-5">Permission</th>
              <th className="w-28 py-2.5 text-center">Founder</th>
              <th className="w-28 py-2.5 pr-5 text-center">Employee</th>
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.filter((p) => !p.endsWith(".view")).map((p) => (
              <tr key={p} className="border-b border-line last:border-0">
                <td className="py-2.5 pl-5 text-ink-muted">{PERMISSION_LABELS[p]}</td>
                <td className="py-2.5 text-center">{hasPermission("FOUNDER", p) ? <CheckCircle2 className="inline h-4 w-4 text-success" aria-label="Yes" /> : <span className="text-ink-faint" aria-label="No">—</span>}</td>
                <td className="py-2.5 pr-5 text-center">{hasPermission("EMPLOYEE", p) ? <CheckCircle2 className="inline h-4 w-4 text-success" aria-label="Yes" /> : <span className="text-ink-faint" aria-label="No">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const { user } = useAuth();
  const toast = useToast();
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
        <DescriptionList items={[{ label: "Name", value: user?.name }, { label: "Email", value: user?.email }, { label: "Role", value: user && ROLE_LABELS[user.role] }]} />
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
  const { can } = useAuth();
  const tab = (["mailbox", "team", "activity", "account"].includes(tabParam ?? "") ? tabParam : "mailbox") as TabKey;
  useTitle("Settings");
  return (
    <>
      <PageHeader title="Settings" description="Mailbox, team and your account." />
      <Tabs
        className="mb-6"
        active={tab}
        onChange={(t) => navigate(`/settings/${t}`, { replace: true })}
        tabs={[
          { key: "mailbox", label: "Mailbox" },
          { key: "team", label: "Team" },
          ...(can("audit.view") ? [{ key: "activity" as const, label: "Activity" }] : []),
          { key: "account", label: "Your account" },
        ]}
      />
      {tab === "mailbox" && <MailboxTab />}
      {tab === "team" && <TeamTab />}
      {tab === "activity" && <RequirePermission permission="audit.view"><ActivityTab /></RequirePermission>}
      {tab === "account" && <AccountTab />}
    </>
  );
}
