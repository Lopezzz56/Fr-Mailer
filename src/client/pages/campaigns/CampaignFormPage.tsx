// New campaign / edit draft
import { useEffect, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, errorMessage } from "../../lib/api";
import { useCampaign, useInvalidate, useLists, useMailbox, useTemplates } from "../../lib/queries";
import { useTitle, useUnsavedChanges } from "../../lib/hooks";
import { plural } from "../../lib/format";
import { PageHeader } from "../../components/ui/Navigation";
import { Panel } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { SelectField, TextField } from "../../components/ui/Field";
import { Callout, ErrorState } from "../../components/ui/Feedback";
import { PageLoader } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { UnsavedChangesDialog } from "../../components/layout/UnsavedChangesDialog";
import { CampaignInputSchema, type CampaignDetailDto } from "@shared/types";

interface Form {
  name: string;
  description: string;
  templateId: string;
  contactListId: string;
  fromName: string;
  replyTo: string;
  sendRatePerMinute: string;
}

const PACES = [
  { value: "5", label: "5 per minute — gentlest" },
  { value: "10", label: "10 per minute" },
  { value: "20", label: "20 per minute — recommended" },
  { value: "30", label: "30 per minute" },
  { value: "60", label: "60 per minute — fastest" },
];

export function CampaignFormPage() {
  const { id } = useParams();
  const isNew = !id;
  useTitle(isNew ? "New campaign" : "Edit campaign");
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate();
  const templates = useTemplates();
  const lists = useLists();
  const mailbox = useMailbox();
  const existing = useCampaign(id ?? "");

  const [form, setForm] = useState<Form | null>(null);
  const [initial, setInitial] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});

  useEffect(() => {
    if (form) return;
    if (isNew && mailbox.data) {
      const f: Form = { name: "", description: "", templateId: "", contactListId: "", fromName: mailbox.data.data.smtp.fromName, replyTo: "", sendRatePerMinute: "20" };
      setForm(f);
      setInitial(f);
    }
    if (!isNew && existing.data) {
      const c = existing.data.data;
      const f: Form = { name: c.name, description: c.description ?? "", templateId: c.template.id, contactListId: c.list.id, fromName: c.fromName, replyTo: c.replyTo ?? "", sendRatePerMinute: String(c.sendRatePerMinute) };
      setForm(f);
      setInitial(f);
    }
  }, [isNew, mailbox.data, existing.data, form]);

  const dirty = Boolean(form && initial && JSON.stringify(form) !== JSON.stringify(initial));
  const blocker = useUnsavedChanges(dirty);

  const save = useMutation({
    mutationFn: (body: unknown) => (isNew ? api.post<CampaignDetailDto>("/api/campaigns", body) : api.patch<CampaignDetailDto>(`/api/campaigns/${id}`, body)),
    onSuccess: async (res) => {
      flushSync(() => setInitial(form));
      await invalidate("campaigns", "overview");
      toast.success(isNew ? "Campaign created" : "Changes saved");
      navigate(`/campaigns/${res.data.id}`, { replace: true });
    },
  });

  if (!isNew && existing.isError) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />;
  if (!isNew && existing.data && existing.data.data.status !== "DRAFT") {
    return (
      <>
        <PageHeader back={{ to: `/campaigns/${id}`, label: existing.data.data.name }} title="Edit campaign" />
        <Callout tone="info">Only drafts can be edited. Return it to draft first, or duplicate it.</Callout>
      </>
    );
  }
  if (!form) return <PageLoader />;

  const set = (key: keyof Form, value: string) => {
    setForm((f) => ({ ...f!, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = CampaignInputSchema.safeParse({ ...form, description: form.description || null, replyTo: form.replyTo || null });
    if (!parsed.success) {
      const f = parsed.error.flatten().fieldErrors as Partial<Record<keyof Form, string[]>>;
      setErrors(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === "templateId" ? "Choose a template." : k === "contactListId" ? "Choose a list." : v?.[0]])));
      return;
    }
    save.mutate(parsed.data);
  };

  const templateOptions = (templates.data?.data ?? []).map((t) => ({ value: t.id, label: t.name }));
  const listOptions = (lists.data?.data ?? []).map((l) => ({ value: l.id, label: `${l.name} (${plural(l.memberCount, "contact")})` }));
  const selectedList = lists.data?.data.find((l) => l.id === form.contactListId);
  const fromEmail = mailbox.data?.data.smtp.fromEmail;

  return (
    <>
      <PageHeader
        back={isNew ? { to: "/campaigns", label: "Campaigns" } : { to: `/campaigns/${id}`, label: existing.data?.data.name ?? "Campaign" }}
        title={isNew ? "New campaign" : "Edit campaign"}
        description="Nothing sends until a founder approves it."
      />
      <form onSubmit={submit} noValidate className="max-w-3xl space-y-6">
        <Panel title="Campaign">
          <div className="space-y-4">
            <TextField label="Name" value={form.name} onChange={(e) => set("name", e.target.value)} error={errors.name} placeholder="e.g. Goa boutique hotels — November" autoFocus={isNew} />
            <TextField label="Internal note" optional value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Goal or context for approvers" />
          </div>
        </Panel>

        <Panel title="Content & recipients">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <SelectField label="Template" value={form.templateId} onChange={(e) => set("templateId", e.target.value)} options={templateOptions} placeholder={templates.isPending ? "Loading…" : "Choose a template"} error={errors.templateId} />
              <p className="mt-1.5 text-xs text-ink-subtle">
                {templateOptions.length === 0 && !templates.isPending ? "No templates yet. " : ""}
                <Link to="/templates/new" className="link">Write a new template</Link>
              </p>
            </div>
            <div>
              <SelectField label="Send to list" value={form.contactListId} onChange={(e) => set("contactListId", e.target.value)} options={listOptions} placeholder={lists.isPending ? "Loading…" : "Choose a list"} error={errors.contactListId} />
              <p className="mt-1.5 text-xs text-ink-subtle">
                {selectedList?.memberCount === 0 ? <span className="text-warning">This list is empty. </span> : ""}
                <Link to="/contacts/import" className="link">Import contacts</Link>
              </p>
            </div>
          </div>
        </Panel>

        <Panel title="Sender">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Sender name" value={form.fromName} onChange={(e) => set("fromName", e.target.value)} error={errors.fromName} hint={fromEmail ? `Sends from ${fromEmail}` : "The sending mailbox isn't configured yet."} />
            <TextField label="Reply-to address" optional type="email" value={form.replyTo} onChange={(e) => set("replyTo", e.target.value)} error={errors.replyTo} hint="Replies go to the sending mailbox if left empty." />
            <SelectField label="Sending pace" value={form.sendRatePerMinute} onChange={(e) => set("sendRatePerMinute", e.target.value)} options={PACES} hint="Slower pacing is gentler on your mailbox's reputation." />
          </div>
        </Panel>

        {save.isError && <Callout tone="danger" title="Couldn't save">{errorMessage(save.error)}</Callout>}
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(isNew ? "/campaigns" : `/campaigns/${id}`)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {isNew ? "Create draft" : "Save changes"}
          </Button>
        </div>
      </form>
      <UnsavedChangesDialog blocker={blocker} />
    </>
  );
}
