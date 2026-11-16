// Create / edit a template with a live, personalized preview
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ClipboardPaste, Copy, FileUp, Paperclip, Sparkles, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { useContacts, useContactFields, useInvalidate, useTemplate } from "../../lib/queries";
import { useDebounced, useTitle, useUnsavedChanges } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { contactName, plural } from "../../lib/format";
import { cn } from "../../lib/cn";
import { PageHeader, FilterChips } from "../../components/ui/Navigation";
import { Panel } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { SelectField, TextAreaField, TextField } from "../../components/ui/Field";
import { Callout, ErrorState } from "../../components/ui/Feedback";
import { ConfirmDialog } from "../../components/ui/Overlay";
import { PageLoader } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { EmailPreview } from "../../components/email/EmailPreview";
import { UnsavedChangesDialog } from "../../components/layout/UnsavedChangesDialog";
import { TemplateWriter } from "../../components/templates/TemplateWriter";
import { STANDARD_FIELDS, contactMergeData, extractMergeFields, htmlToText, isPlainTextTemplate, plainTextToHtml, renderEmail, validateTemplate } from "@shared/merge";
import type { TemplateAttachmentDto, TemplateDto } from "@shared/types";
import type { TemplateScope } from "@shared/auth";
import type { TemplateDraftDto } from "@shared/template-writer";

interface Draft {
  name: string;
  description: string;
  category: string;
  subject: string;
  mode: "text" | "html";
  body: string; // plain text (text mode) or HTML (html mode)
  textAlt: string; // optional plain-text alternative in html mode
  scope: TemplateScope;
}

function getEmptyDraft(userName?: string, defaultScope: TemplateScope = "PERSONAL", defaultCategory = ""): Draft {
  const cleanName = userName && !/demo|founder|admin|test/i.test(userName) ? userName.trim() : "";
  return {
    name: "",
    description: "",
    category: defaultCategory,
    subject: "Ensuring frontline service execution at {{company|your hotel}}",
    mode: "text",
    body:
      "Hi {{firstName|company|Hospitality Team}},\n\n" +
      "I’m reaching out on behalf of Sehej Sharma, Founder & CEO of FocusRealm.\n\n" +
      "One of the key challenges in hospitality is ensuring that SOPs, training, and service standards defined at the corporate level are consistently followed by frontline teams across properties. Even when standards are clearly documented, ensuring that tasks are executed correctly, verified, and recorded can be difficult across multiple teams and locations.\n\n" +
      "Mise Hotel, our hospitality-focused Service Execution Platform, is designed to address this challenge by bringing SOPs, training, and operational workflows together in a mobile-first platform. It helps translate documented standards into assigned tasks, supports teams in executing them, and captures evidence of completion to improve operational visibility and accountability.\n\n" +
      "As we continue developing Mise Hotel, we would welcome the opportunity to explore a pilot with {{company|your team}} to demonstrate the platform, understand your operational requirements, and gather feedback from your team.\n\n" +
      "We are also bringing together experienced hospitality leaders for the FocusRealm Hotel Advisory Board, where industry experts can help shape Mise Hotel around the real-world needs of hotel operations, workforce training, and service delivery. Given {{company|your organization}}’s experience in the hospitality industry, we would be honoured to explore your potential involvement.\n\n" +
      "Would your team be available for a 20-minute meeting with Sehej to discuss Mise Hotel, a potential pilot, and the advisory opportunity? We would be happy to coordinate a time that suits your schedule.\n\n" +
      "Thank you for your time. We look forward to the opportunity to connect.\n\n" +
      "Best wishes,\n" +
      (cleanName ? `${cleanName}\n` : "") +
      "Founder’s Office\n" +
      "FocusRealm\n" +
      "https://misehotel.com/\n" +
      "https://focusrealm.org/",
    textAlt: "",
    scope: defaultScope,
  };
}

function fromTemplate(t: TemplateDto): Draft {
  const plain = isPlainTextTemplate(t);
  return {
    name: t.name,
    description: t.description ?? "",
    category: t.category ?? "",
    subject: t.subject,
    mode: plain ? "text" : "html",
    body: plain ? t.bodyText! : t.bodyHtml,
    textAlt: plain ? "" : (t.bodyText ?? ""),
    scope: t.scope ?? "PERSONAL",
  };
}

function toParts(d: Draft) {
  return d.mode === "text"
    ? { subject: d.subject, bodyHtml: plainTextToHtml(d.body), bodyText: d.body }
    : { subject: d.subject, bodyHtml: d.body, bodyText: d.textAlt.trim() ? d.textAlt : null };
}

const SAMPLE = { firstName: "Alex", lastName: "Morgan", fullName: "Alex Morgan", email: "alex@example.com", company: "Seaside Hotel", title: "General Manager", phone: "+91 98200 00000" };

export function TemplateEditorPage({
  embedded = false,
  onSaved,
  onCancel,
  initialScope,
  initialCategory,
  initialTemplateId,
  campaignId,
  cancelLabel = "Back to Campaign Templates",
}: {
  embedded?: boolean;
  onSaved?: (template: TemplateDto) => void;
  onCancel?: () => void;
  initialScope?: TemplateScope;
  initialCategory?: string;
  initialTemplateId?: string;
  campaignId?: string;
  cancelLabel?: string;
}) {
  const { id } = useParams();
  const effectiveId = embedded ? initialTemplateId : (id ?? initialTemplateId);
  const [persistedId, setPersistedId] = useState<string>();
  const templateId = effectiveId ?? persistedId;
  const isNew = !templateId;
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate();
  const { user, can } = useAuth();
  const readOnly = !can("templates.manage");
  const template = useTemplate(templateId);
  const fields = useContactFields();

  const [draft, setDraft] = useState<Draft | null>(() =>
    isNew
      ? getEmptyDraft(
          user?.name,
          initialScope ?? (campaignId ? "CAMPAIGN" : "PERSONAL"),
          initialCategory ?? ""
        )
      : null
  );
  const [saved, setSaved] = useState<Draft | null>(() =>
    isNew
      ? getEmptyDraft(
          user?.name,
          initialScope ?? (campaignId ? "CAMPAIGN" : "PERSONAL"),
          initialCategory ?? ""
        )
      : null
  );
  const [touched, setTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [writerOpen, setWriterOpen] = useState(false);
  const [writerTab, setWriterTab] = useState<"personal" | "ai" | "starter">("personal");
  const [pendingDraft, setPendingDraft] = useState<TemplateDraftDto | null>(null);
  const [attachments, setAttachments] = useState<TemplateAttachmentDto[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  const [createdDuringFlow, setCreatedDuringFlow] = useState(false);
  const focused = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; key: "subject" | "body" | "textAlt" } | null>(null);
  const currentIdRef = useRef(effectiveId);

  useEffect(() => {
    if (currentIdRef.current !== effectiveId) {
      currentIdRef.current = effectiveId;
      if (isNew) {
        const next = getEmptyDraft(
          user?.name,
          initialScope ?? (campaignId ? "CAMPAIGN" : "PERSONAL"),
          initialCategory ?? ""
        );
        setDraft(next);
        setSaved(next);
        setTouched(false);
      } else {
        setDraft(null);
        setSaved(null);
        setTouched(false);
      }
    }
  }, [effectiveId, isNew, user?.name, initialScope, campaignId, initialCategory]);

  useEffect(() => {
    if (isNew && draft && !touched && user?.name && !draft.body.includes(user.name)) {
      const cleanName = user.name && !/demo|founder|admin|test/i.test(user.name) ? user.name.trim() : "";
      if (cleanName) {
        const next = getEmptyDraft(
          cleanName,
          initialScope ?? (campaignId ? "CAMPAIGN" : "PERSONAL"),
          initialCategory ?? ""
        );
        setDraft(next);
        setSaved(next);
      }
    }
  }, [isNew, user?.name, touched, draft, initialScope, campaignId, initialCategory]);

  useEffect(() => {
    if (template.data && !draft) {
      const d = fromTemplate(template.data.data);
      setDraft(d);
      setSaved(d);
    }
  }, [template.data, draft]);
  useEffect(() => {
    if (template.data) setAttachments(template.data.data.attachments ?? []);
  }, [template.data]);

  useTitle(embedded ? "New campaign" : isNew ? "New template" : (template.data?.data.name ?? "Template"));
  const dirty = Boolean((draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)) || pendingAttachments.length > 0);
  const blocker = useUnsavedChanges(dirty);

  // Preview recipient
  const [recipientSearch, setRecipientSearch] = useState("");
  const [recipientId, setRecipientId] = useState<string>("sample");
  const contacts = useContacts({ page: 1, search: useDebounced(recipientSearch) });
  const recipient = contacts.data?.data.find((c) => c.id === recipientId);

  const parts = draft ? toParts(draft) : null;
  const errors = parts ? validateTemplate(parts) : [];
  const preview = useMemo(() => {
    if (!parts) return null;
    return renderEmail(parts, recipient ? contactMergeData(recipient) : SAMPLE);
  }, [parts?.subject, parts?.bodyHtml, parts?.bodyText, recipient]); // eslint-disable-line react-hooks/exhaustive-deps
  const used = parts ? extractMergeFields(parts) : [];

  const save = useMutation({
    mutationFn: async () => {
      const creating = !templateId;
      const body = {
        name: draft!.name,
        description: draft!.description || null,
        category: draft!.category.trim() || null,
        scope: draft!.scope,
        campaignId: campaignId || null,
        ...toParts(draft!),
      };
      let savedTemplate = creating
        ? (await api.post<TemplateDto>("/api/templates", body)).data
        : dirty
          ? (await api.patch<TemplateDto>(`/api/templates/${templateId}`, body)).data
          : template.data!.data;

      if (creating) {
        setPersistedId(savedTemplate.id);
        setCreatedDuringFlow(true);
      }

      for (const file of pendingAttachments) {
        const form = new FormData();
        form.append("file", file);
        const uploaded = await api.upload<TemplateAttachmentDto>(`/api/templates/${savedTemplate.id}/attachments`, form);
        const attachment = uploaded.data;
        savedTemplate = { ...savedTemplate, attachments: [...savedTemplate.attachments, attachment] };
        setAttachments((current) => [...current, attachment]);
        setPendingAttachments((current) => current.filter((queued) => queued !== file));
      }

      return { template: savedTemplate, created: creating || createdDuringFlow };
    },
    onSuccess: async ({ template: savedTemplate, created }) => {
      const updatedDraft = { ...draft!, name: savedTemplate.name };
      flushSync(() => {
        setDraft(updatedDraft);
        setSaved(updatedDraft);
      });
      await invalidate("templates", "campaigns");
      toast.success(created ? "Template created" : "Template saved");
      if (embedded && onSaved) {
        onSaved(savedTemplate);
      } else if (created) {
        navigate(`/templates/${savedTemplate.id}`, { replace: true });
      }
    },
    onError: (err) => toast.error("Could not save template", errorMessage(err)),
  });
  const duplicate = useMutation({
    mutationFn: () => api.post<TemplateDto>(`/api/templates/${id}/duplicate`),
    onSuccess: async (res) => {
      await invalidate("templates");
      toast.success("Template duplicated", res.data.name);
      setDraft(null);
      navigate(`/templates/${res.data.id}`);
    },
    onError: (err) => toast.error("Couldn't duplicate", errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/templates/${id}`),
    onSuccess: async () => {
      flushSync(() => setSaved(draft));
      await invalidate("templates");
      toast.success("Template deleted");
      navigate("/templates");
    },
  });

  if (!isNew && template.isError) return <ErrorState error={template.error} onRetry={() => template.refetch()} />;
  if (!draft || !parts || !preview) return <PageLoader />;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d!, [key]: value }));
  const insertField = (name: string) => {
    const token = `{{${name}}}`;
    const target = focused.current ?? null;
    const key = target?.key ?? "body";
    const el = target?.el;
    const value = draft[key];
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    set(key, value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const track = (key: "subject" | "body" | "textAlt") => ({
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => (focused.current = { el: e.currentTarget, key }),
  });

  const applyDraft = (g: TemplateDraftDto) => {
    setDraft((d) => ({
      ...d!,
      name: d?.name?.trim() ? d.name : (g.name || "AI Outreach Template"),
      mode: "text",
      subject: g.subject,
      body: g.body,
      textAlt: "",
    }));
    setTouched(true);
    setPendingDraft(null);
    setWriterOpen(false);
    toast.success("Draft applied to editor", "Your template has been updated. Review and save when ready.");
  };

  const offerDraft = (g: TemplateDraftDto) => {
    applyDraft(g);
  };

  const nameError = touched && !draft.name.trim() ? "Give the template a name." : null;
  const canSave = !readOnly && (dirty || pendingAttachments.length > 0) && errors.length === 0 && draft.name.trim() !== "";
  const customFields = (fields.data?.data ?? []).filter((f) => !STANDARD_FIELDS.some((s) => s.name === f.name));
  const hasContent = Boolean(draft.body.trim());

  return (
    <>
      <PageHeader
        back={embedded ? undefined : { to: "/templates", label: "Templates" }}
        title={isNew ? "New template" : draft.name || "Untitled template"}
        description={isNew ? "Write it once; personalize it for every recipient." : template.data && `Version ${template.data.data.version} · used in ${plural(template.data.data.campaignCount, "campaign")}`}
        hideGlobalControls={embedded}
        actions={
          (!readOnly || embedded) && (
            <>
              {embedded && <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button>}
              {!readOnly && <>
              <Button
                variant="secondary"
                icon={<ClipboardPaste className="h-4 w-4" />}
                onClick={() => {
                  setWriterTab("personal");
                  setWriterOpen(true);
                }}
              >
                Paste AI Draft
              </Button>
              <Button
                icon={<Sparkles className="h-4 w-4" />}
                onClick={() => {
                  setWriterTab("ai");
                  setWriterOpen(true);
                }}
              >
                Write with AI
              </Button>
              {!isNew && (
                <>
                  <Button icon={<Copy className="h-4 w-4" />} onClick={() => duplicate.mutate()} loading={duplicate.isPending}>
                    Duplicate
                  </Button>
                  <Button variant="danger-ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </Button>
                </>
              )}
              <Button
                variant="primary"
                disabled={!canSave}
                loading={save.isPending}
                onClick={() => {
                  setTouched(true);
                  if (draft.name.trim() && errors.length === 0) save.mutate();
                }}
              >
                {isNew ? "Create template" : dirty ? "Save changes" : "Saved"}
              </Button>
              </>}
            </>
          )
        }
      />

      {readOnly && <Callout className="mb-6">You can view templates. Editing needs the templates permission.</Callout>}
      {save.isError && <Callout tone="danger" className="mb-6" title="Couldn't save the template">{errorMessage(save.error)}</Callout>}
      {!isNew && template.data && template.data.data.campaignCount > 0 && dirty && (
        <Callout tone="info" className="mb-6">Campaigns that are already approved keep the version they approved. Drafts will use your changes.</Callout>
      )}

      {/* Top Details & Attachments Bar */}
      <div className="mb-6 space-y-4">
        <Panel
          title="Template Details"
          description="Basic settings, categorization, visibility, and optional attachments."
        >
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <TextField
                label="Template name"
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                onBlur={() => setTouched(true)}
                error={nameError}
                placeholder="e.g. Hotel partnership intro"
                disabled={readOnly}
              />
              <div className="space-y-1.5">
                <TextField
                  label="Category / Folder"
                  optional
                  value={draft.category}
                  onChange={(e) => set("category", e.target.value)}
                  placeholder="e.g. Outreach, Partnerships, Advisory"
                  disabled={readOnly}
                />
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-[11px] text-ink-subtle">Quick tag:</span>
                  {["Outreach", "Partnerships", "Advisory", "Follow-up", "Executive"].map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      disabled={readOnly}
                      onClick={() => set("category", cat)}
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                        draft.category === cat
                          ? "bg-brand text-white"
                          : "bg-surface-muted text-ink-subtle hover:bg-surface-sunken hover:text-ink"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>
              <SelectField
                label="Scope & Visibility"
                value={draft.scope}
                onChange={(e) => set("scope", e.target.value as TemplateScope)}
                options={[
                  { value: "PERSONAL", label: "Personal (Only you)" },
                  { value: "SHARED", label: "Shared (Collaborators & team)" },
                  ...(can("templates.manage_org")
                    ? [{ value: "ORGANIZATION", label: "FocusRealm Official (Organization-wide standard)" }]
                    : []),
                  ...(embedded || draft.scope === "CAMPAIGN"
                    ? [{ value: "CAMPAIGN", label: "Campaign Collection (Specific to this campaign)" }]
                    : []),
                ]}
                hint={
                  draft.scope === "ORGANIZATION"
                    ? "Official FocusRealm template available organization-wide across all campaigns."
                    : draft.scope === "SHARED"
                    ? "Teammates can view and use this template in their campaigns."
                    : draft.scope === "CAMPAIGN"
                    ? "Belongs specifically to this campaign's template collection."
                    : "Private to your account."
                }
                disabled={readOnly}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2 pt-2 border-t border-line/60">
              <TextField
                label="Internal note"
                optional
                value={draft.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="When to use this template, target audience or context"
                disabled={readOnly}
              />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-[13px] font-medium text-ink">Attachments</label>
                    <span className="ml-1 text-xs text-ink-subtle">(Max 5 files, 20 MB total)</span>
                  </div>
                  {!readOnly && (
                    <label
                      htmlFor="template-attachments"
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:border-brand hover:text-brand"
                    >
                      <FileUp className="h-3.5 w-3.5" /> Attach files
                    </label>
                  )}
                </div>
                {pendingAttachments.length > 0 && (
                  <p className="text-[11px] text-amber-700 font-medium">
                    {pendingAttachments.length} file{pendingAttachments.length > 1 ? "s" : ""} selected &mdash; will be uploaded when you click &ldquo;{isNew ? "Create template" : "Save changes"}&rdquo;.
                  </p>
                )}
                <input
                  type="file"
                  accept=".pdf,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  className="sr-only"
                  id="template-attachments"
                  disabled={readOnly}
                  onChange={(event) => {
                    const picked = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    const currentSize = attachments.reduce((sum, item) => sum + item.size, 0) +
                      pendingAttachments.reduce((sum, item) => sum + item.size, 0);
                    if (attachments.length + pendingAttachments.length + picked.length > 5) {
                      toast.error("A template can have up to 5 attachments.");
                      return;
                    }
                    if (currentSize + picked.reduce((sum, item) => sum + item.size, 0) > 20 * 1024 * 1024 ||
                      picked.some((item) => item.size > 10 * 1024 * 1024)) {
                      toast.error("Each attachment must be 10 MB or less, with a 20 MB total per template.");
                      return;
                    }
                    if (picked.some((item) => !/\.(pdf|ppt|pptx|png|jpe?g|gif|webp)$/i.test(item.name))) {
                      toast.error("Only PDF, PPT, PPTX, and image attachments are supported.");
                      return;
                    }
                    setPendingAttachments((current) => [...current, ...picked]);
                  }}
                />
                {attachments.length + pendingAttachments.length > 0 ? (
                  <ul className="flex flex-wrap gap-2">
                    {attachments.map((attachment) => (
                      <li key={attachment.id} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink">
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
                        <span className="max-w-[160px] truncate">{attachment.name}</span>
                        {!readOnly && (
                          <button
                            type="button"
                            className="ml-1 rounded p-0.5 text-ink-subtle hover:text-danger"
                            aria-label={`Remove ${attachment.name}`}
                            onClick={async () => {
                              try {
                                await api.delete(`/api/templates/${templateId}/attachments/${attachment.id}`);
                                setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                                await invalidate("templates");
                              } catch (error) {
                                toast.error("Couldn't remove attachment", errorMessage(error));
                              }
                            }}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </li>
                    ))}
                    {pendingAttachments.map((file, index) => (
                      <li key={`${file.name}-${file.lastModified}-${index}`} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-muted px-2 py-1 text-xs text-ink">
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-brand" />
                        <span className="max-w-[160px] truncate">{file.name}</span>
                        <span className="rounded bg-brand-soft px-1.5 py-0.2 text-[10px] font-medium text-brand">Will save on submit</span>
                        <button type="button" className="ml-1 rounded p-0.5 text-ink-subtle hover:text-danger" aria-label={`Remove ${file.name}`} onClick={() => setPendingAttachments((current) => current.filter((_, i) => i !== index))}>
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-ink-subtle">No attachments added to this template.</p>
                )}
              </div>
            </div>
          </div>
        </Panel>
      </div>

      {/* Adjacent Side-by-Side Email Editor & Live Preview */}
      <div className="grid gap-6 items-start lg:grid-cols-2">
        {/* Left Column: Email Composition */}
        <div className="space-y-6">
          <Panel
            title="Email"
            actions={
              <FilterChips
                label="Email format"
                value={draft.mode}
                onChange={(mode) => {
                  if (mode === draft.mode) return;
                  setDraft((d) => (mode === "html" ? { ...d!, mode, body: plainTextToHtml(d!.body), textAlt: d!.body } : { ...d!, mode, body: d!.textAlt || d!.body.replace(/<[^>]+>/g, ""), textAlt: "" }));
                }}
                options={[
                  { key: "text", label: "Plain text" },
                  { key: "html", label: "HTML" },
                ]}
              />
            }
          >
            <div className="space-y-4">
              {!readOnly && !hasContent && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand/20 bg-brand-soft/60 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                    <p className="text-[13px] text-ink-muted">
                      <span className="font-medium text-ink">Not sure where to start?</span> Describe the email and get a personalised draft, or pick a starter.
                    </p>
                  </div>
                  <Button size="sm" variant="primary" onClick={() => setWriterOpen(true)}>Write it for me</Button>
                </div>
              )}
              <TextField label="Subject" value={draft.subject} onChange={(e) => set("subject", e.target.value)} placeholder="e.g. A quick idea for {{company}}" disabled={readOnly} {...track("subject")} />
              <TextAreaField
                label={draft.mode === "text" ? "Message" : "HTML body"}
                hint={draft.mode === "text" ? "Leave a blank line between paragraphs. Links become clickable. An unsubscribe line is added automatically." : "Paste or write HTML. An unsubscribe footer is added automatically."}
                value={draft.body}
                onChange={(e) => set("body", e.target.value)}
                rows={draft.mode === "text" ? 14 : 18}
                className={cn(draft.mode === "html" && "font-mono text-[13px]")}
                disabled={readOnly}
                {...track("body")}
              />
              {draft.mode === "html" && (
                <TextAreaField
                  label="Plain-text version"
                  optional
                  hint="Shown by mail apps that don't display HTML. Leave empty to generate it from the HTML."
                  value={draft.textAlt}
                  onChange={(e) => set("textAlt", e.target.value)}
                  rows={5}
                  disabled={readOnly}
                  {...track("textAlt")}
                />
              )}

              {!readOnly && (
                <div>
                  <p className="mb-2 text-[13px] font-medium">Insert a personal field</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[...STANDARD_FIELDS.map((f) => ({ name: f.name, label: f.label })), ...customFields.map((f) => ({ name: f.name, label: f.name }))].map((f) => (
                      <button
                        key={f.name}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => insertField(f.name)}
                        className="rounded-md border border-line bg-surface-muted px-2 py-1 text-xs text-ink-muted hover:border-brand hover:bg-brand-soft hover:text-brand-ink"
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2.5 rounded-lg border border-brand/20 bg-brand-soft/20 p-3 text-xs text-ink-muted space-y-1">
                    <span className="font-semibold text-ink flex items-center gap-1.5">
                      💡 How Merge Fields &amp; Fallbacks Work:
                    </span>
                    <ul className="list-disc pl-4 space-y-1 text-ink-muted">
                      <li>
                        <strong>Single fallback:</strong> <code className="rounded bg-surface px-1 border border-line">{"{{firstName|there}}"}</code> &mdash; uses firstName if present, otherwise "there".
                      </li>
                      <li>
                        <strong>Chained fallback:</strong> <code className="rounded bg-surface px-1 border border-line">{"{{firstName|company|Hospitality Team}}"}</code> &mdash; uses firstName; if missing uses company; if both missing uses "Hospitality Team".
                      </li>
                      <li>
                        <strong>Required fields:</strong> <code className="rounded bg-surface px-1 border border-line">{"{{company}}"}</code> without a fallback is strictly required; recipients missing it are safely reported before sending.
                      </li>
                    </ul>
                  </div>
                </div>
              )}

              {errors.length > 0 && (
                <Callout tone="danger" title="Fix before saving">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </Callout>
              )}
            </div>
          </Panel>
        </div>

        {/* Right Column: Live Comparison Preview (Sticky for easy reference while editing) */}
        <div className="space-y-4 lg:sticky lg:top-6">
          <Panel
            title="Preview"
            description="Exactly what a recipient sees, before the unsubscribe footer."
            bodyClassName="space-y-4"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Find a contact" value={recipientSearch} onChange={(e) => setRecipientSearch(e.target.value)} placeholder="Search name or email" />
              <SelectField
                label="Preview as"
                value={recipientId}
                onChange={(e) => setRecipientId(e.target.value)}
                options={[{ value: "sample", label: "Sample person (Alex Morgan)" }, ...(contacts.data?.data ?? []).map((c) => ({ value: c.id, label: contactName(c) ? `${contactName(c)} · ${c.email}` : c.email }))]}
              />
            </div>
            {preview.missingFields.length > 0 && (
              <Callout tone="warning" title={`${recipient ? "This contact" : "The sample"} is missing ${preview.missingFields.join(", ")}`}>
                Recipients without these values would be skipped. Add a fallback, or fill the data in.
              </Callout>
            )}
            <EmailPreview to={recipient?.email ?? SAMPLE.email} subject={preview.subject} html={preview.html} text={preview.text} height={460} />
            {used.length > 0 && (
              <p className="text-xs text-ink-subtle">
                Uses: {used.map((f) => (f.required ? f.name : `${f.name} (optional)`)).join(", ")}
              </p>
            )}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Delete this template?"
        description={remove.isError ? errorMessage(remove.error) : "This can't be undone. Templates used by a campaign can't be deleted."}
        confirmLabel="Delete template"
      />
      {!readOnly && (
        <TemplateWriter
          open={writerOpen}
          initialTab={writerTab}
          onClose={() => setWriterOpen(false)}
          currentDraft={{ subject: draft.subject, body: draft.mode === "text" ? draft.body : draft.textAlt || htmlToText(draft.body) }}
          onUse={offerDraft}
        />
      )}
      <ConfirmDialog
        open={pendingDraft !== null}
        onClose={() => setPendingDraft(null)}
        onConfirm={() => pendingDraft && applyDraft(pendingDraft)}
        title="Replace the subject and message?"
        description="The draft replaces what's in the editor now. You can still leave without saving to keep the saved version."
        confirmLabel="Replace"
        tone="primary"
      />
      <UnsavedChangesDialog blocker={blocker} />
    </>
  );
}
