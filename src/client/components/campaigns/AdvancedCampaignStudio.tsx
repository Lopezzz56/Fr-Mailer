import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Eye,
  FileText,
  Filter,
  FlaskConical,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Split,
  Star,
  Trash2,
} from "lucide-react";
import {
  HOTEL_SEGMENTS,
  HOTEL_SEGMENT_LABELS,
  CONTACT_PERSONAS,
  CONTACT_PERSONA_LABELS,
  type CampaignDetailDto,
  type HotelSegment,
  type ContactPersona,
} from "@shared/types";
import { htmlToText, plainTextToHtml } from "@shared/merge";
import { api, errorMessage } from "../../lib/api";
import { useCampaign, useInvalidate, useLists, useMailbox, useTemplates } from "../../lib/queries";
import { useToast } from "../ui/Toast";
import { Panel, Stat } from "../ui/Card";
import { Button, ButtonLink } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { TextField, SelectField, Checkbox } from "../ui/Field";
import { Callout } from "../ui/Feedback";
import { Dialog } from "../ui/Overlay";
import { PageLoader } from "../ui/Spinner";
import { EmailPreview } from "../email/EmailPreview";
import { num, plural } from "../../lib/format";

export interface SelectedTemplateItem {
  templateId: string;
  name: string;
  subject: string;
  isFallback: boolean;
  priority: number;
}

export interface ClientTargetingRule {
  id: string;
  templateId: string;
  priority: number;
  hotelSegment: string;
  contactPersona: string;
  city: string;
  requiresVerified: boolean;
  minConfidence: number | null;
  description: string;
}

interface SimulationResult {
  total: number;
  ready: number;
  missingFields: { email: string; contactId: string; fields: string[] }[];
  templateBreakdown: { templateId: string; templateName: string; count: number; isFallback: boolean }[];
  sample: {
    contactId: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    hotelSegment?: string | null;
    contactPersona?: string | null;
    subject: string;
    html: string;
    text: string;
    missingFields: string[];
    templateId: string;
    templateName: string;
    assignmentSource: "RULE" | "FALLBACK" | "OVERRIDE";
    assignmentReason: string;
    isCustom?: boolean;
  }[];
}

const PACES = [
  { value: "5", label: "5 per minute — gentlest" },
  { value: "10", label: "10 per minute" },
  { value: "20", label: "20 per minute — recommended" },
  { value: "30", label: "30 per minute" },
  { value: "60", label: "60 per minute — fastest" },
];

export function AdvancedCampaignStudio({
  campaignId,
  onDone,
}: {
  campaignId?: string;
  onDone?: (id: string) => void;
}) {
  const isNew = !campaignId;
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate();

  const templatesQuery = useTemplates();
  const listsQuery = useLists();
  const mailboxQuery = useMailbox();
  const existingQuery = useCampaign(campaignId ?? "");

  // Form Basic Info
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contactListId, setContactListId] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [sendRatePerMinute, setSendRatePerMinute] = useState("20");

  // Multi-Templates State
  const [selectedTemplates, setSelectedTemplates] = useState<SelectedTemplateItem[]>([]);
  const [addTemplateModalOpen, setAddTemplateModalOpen] = useState(false);
  const [templateToAddId, setTemplateToAddId] = useState("");

  // Targeting Rules State
  const [rules, setRules] = useState<ClientTargetingRule[]>([]);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState<{
    templateId: string;
    priority: number;
    hotelSegment: string;
    contactPersona: string;
    city: string;
    requiresVerified: boolean;
    minConfidence: string;
    description: string;
  }>({
    templateId: "",
    priority: 1,
    hotelSegment: "",
    contactPersona: "",
    city: "",
    requiresVerified: false,
    minConfidence: "",
    description: "",
  });

  // Preview & Editor Dialog State
  const [previewSample, setPreviewSample] = useState<SimulationResult["sample"][0] | null>(null);
  const [previewTab, setPreviewTab] = useState<"preview" | "edit">("preview");
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [isSavingOverride, setIsSavingOverride] = useState(false);
  const [isResettingOverride, setIsResettingOverride] = useState(false);

  const openPreview = (sample: SimulationResult["sample"][0]) => {
    setPreviewSample(sample);
    setEditSubject(sample.subject);
    setEditBody(sample.text || htmlToText(sample.html));
    setPreviewTab("preview");
  };

  const senderInitializedRef = useRef(false);

  // Initialize from mailbox / existing campaign
  useEffect(() => {
    if (isNew && mailboxQuery.data && !senderInitializedRef.current) {
      senderInitializedRef.current = true;
      setFromName(mailboxQuery.data.data.smtp.fromName || "FocusRealm");
    }
    if (!isNew && existingQuery.data && !senderInitializedRef.current) {
      senderInitializedRef.current = true;
      const c = existingQuery.data.data;
      setName(c.name);
      setDescription(c.description ?? "");
      setContactListId(c.list.id);
      setFromName(c.fromName);
      setReplyTo(c.replyTo ?? "");
      setSendRatePerMinute(String(c.sendRatePerMinute));

      if (c.templates && c.templates.length > 0) {
        setSelectedTemplates(
          c.templates.map((t) => ({
            templateId: t.templateId,
            name: t.name,
            subject: t.subject,
            isFallback: t.isFallback,
            priority: t.priority,
          }))
        );
      } else if (c.template) {
        setSelectedTemplates([
          {
            templateId: c.template.id,
            name: c.template.name,
            subject: "",
            isFallback: true,
            priority: 0,
          },
        ]);
      }

      if (c.rules && c.rules.length > 0) {
        setRules(
          c.rules.map((r) => ({
            id: r.id,
            templateId: r.templateId,
            priority: r.priority,
            hotelSegment: r.hotelSegment ?? "",
            contactPersona: r.contactPersona ?? "",
            city: r.city ?? "",
            requiresVerified: r.requiresVerified,
            minConfidence: r.minConfidence,
            description: r.description ?? "",
          }))
        );
      }
    }
  }, [isNew, mailboxQuery.data, existingQuery.data]);

  // Auto-seed first template if empty and templates query loaded
  useEffect(() => {
    if (isNew && selectedTemplates.length === 0 && templatesQuery.data?.data && templatesQuery.data.data.length > 0) {
      const first = templatesQuery.data.data[0]!;
      setSelectedTemplates([
        {
          templateId: first.id,
          name: first.name,
          subject: first.subject,
          isFallback: true,
          priority: 0,
        },
      ]);
    }
  }, [isNew, selectedTemplates.length, templatesQuery.data]);

  // Auto-seed first contact list if empty and lists query loaded
  useEffect(() => {
    if (isNew && !contactListId && listsQuery.data?.data && listsQuery.data.data.length > 0) {
      setContactListId(listsQuery.data.data[0]!.id);
    }
  }, [isNew, contactListId, listsQuery.data]);

  // Simulation Query for live recipient & template distribution analysis
  const simulationQuery = useQuery({
    queryKey: ["campaign-simulation", campaignId, contactListId, selectedTemplates, rules],
    queryFn: async () => {
      if (!contactListId || selectedTemplates.length === 0) return null;
      const fallback = selectedTemplates.find((t) => t.isFallback) ?? selectedTemplates[0]!;
      const res = await api.post<SimulationResult>("/api/campaigns/preview-simulation", {
        contactListId,
        campaignId,
        templates: selectedTemplates.map((t) => ({
          templateId: t.templateId,
          isFallback: t.isFallback,
          priority: t.priority,
        })),
        rules: rules.map((r) => ({
          templateId: r.templateId,
          priority: r.priority,
          hotelSegment: r.hotelSegment || undefined,
          contactPersona: r.contactPersona || undefined,
          city: r.city || undefined,
          requiresVerified: r.requiresVerified,
          minConfidence: r.minConfidence,
          description: r.description || undefined,
        })),
        defaultTemplateId: fallback.templateId,
      });
      return res.data;
    },
    enabled: Boolean(contactListId && selectedTemplates.length > 0),
    staleTime: 5000,
  });

  // Template Management Helpers
  const makeFallback = (templateId: string) => {
    setSelectedTemplates((prev) =>
      prev.map((t) => ({
        ...t,
        isFallback: t.templateId === templateId,
      }))
    );
  };

  const removeTemplate = (templateId: string) => {
    if (selectedTemplates.length <= 1) {
      toast.error("Campaign requires at least one template.");
      return;
    }
    const filtered = selectedTemplates.filter((t) => t.templateId !== templateId);
    if (!filtered.some((t) => t.isFallback) && filtered.length > 0) {
      filtered[0]!.isFallback = true;
    }
    setSelectedTemplates(filtered);
    // Remove rules that target this removed template
    setRules((prev) => prev.filter((r) => r.templateId !== templateId));
  };

  const addTemplate = () => {
    if (!templateToAddId) return;
    const t = templatesQuery.data?.data.find((item) => item.id === templateToAddId);
    if (!t) return;
    setSelectedTemplates((prev) => [
      ...prev,
      {
        templateId: t.id,
        name: t.name,
        subject: t.subject,
        isFallback: false,
        priority: prev.length,
      },
    ]);
    setTemplateToAddId("");
    setAddTemplateModalOpen(false);
  };

  // Rule Management Helpers
  const openNewRuleModal = () => {
    const fallbackTemplateId = selectedTemplates[0]?.templateId ?? "";
    setEditingRuleId(null);
    setRuleForm({
      templateId: fallbackTemplateId,
      priority: rules.length + 1,
      hotelSegment: "",
      contactPersona: "",
      city: "",
      requiresVerified: false,
      minConfidence: "",
      description: "",
    });
    setRuleModalOpen(true);
  };

  const openEditRuleModal = (rule: ClientTargetingRule) => {
    setEditingRuleId(rule.id);
    setRuleForm({
      templateId: rule.templateId,
      priority: rule.priority,
      hotelSegment: rule.hotelSegment,
      contactPersona: rule.contactPersona,
      city: rule.city,
      requiresVerified: rule.requiresVerified,
      minConfidence: rule.minConfidence !== null && rule.minConfidence !== undefined ? String(rule.minConfidence) : "",
      description: rule.description,
    });
    setRuleModalOpen(true);
  };

  const saveRule = () => {
    if (!ruleForm.templateId) {
      toast.error("Choose a target template for this rule.");
      return;
    }
    const parsedMinConf = ruleForm.minConfidence.trim() ? parseFloat(ruleForm.minConfidence) : null;

    if (editingRuleId) {
      setRules((prev) =>
        prev
          .map((r) =>
            r.id === editingRuleId
              ? {
                  ...r,
                  templateId: ruleForm.templateId,
                  priority: ruleForm.priority,
                  hotelSegment: ruleForm.hotelSegment,
                  contactPersona: ruleForm.contactPersona,
                  city: ruleForm.city.trim(),
                  requiresVerified: ruleForm.requiresVerified,
                  minConfidence: parsedMinConf,
                  description: ruleForm.description.trim(),
                }
              : r
          )
          .sort((a, b) => a.priority - b.priority)
      );
    } else {
      const newRule: ClientTargetingRule = {
        id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        templateId: ruleForm.templateId,
        priority: ruleForm.priority,
        hotelSegment: ruleForm.hotelSegment,
        contactPersona: ruleForm.contactPersona,
        city: ruleForm.city.trim(),
        requiresVerified: ruleForm.requiresVerified,
        minConfidence: parsedMinConf,
        description: ruleForm.description.trim(),
      };
      setRules((prev) => [...prev, newRule].sort((a, b) => a.priority - b.priority));
    }

    setRuleModalOpen(false);
  };

  const deleteRule = (ruleId: string) => {
    setRules((prev) => prev.filter((r) => r.id !== ruleId));
  };

  const applyRulePreset = (hotelSegment: string, contactPersona: string, desc: string, city: string = "") => {
    const targetTemplateId = selectedTemplates.find((t) => !t.isFallback)?.templateId || selectedTemplates[0]?.templateId || "";
    setEditingRuleId(null);
    setRuleForm({
      templateId: targetTemplateId,
      priority: rules.length + 1,
      hotelSegment,
      contactPersona,
      city,
      requiresVerified: false,
      minConfidence: "",
      description: desc,
    });
    setRuleModalOpen(true);
  };

  // Test Send State & Helpers
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testRecipientEmail, setTestRecipientEmail] = useState("");
  const [testContactId, setTestContactId] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const openTestModal = () => {
    setTestRecipientEmail(mailboxQuery.data?.data.smtp.fromEmail ?? "s265.frank@gmail.com");
    if (simulationQuery.data?.sample && simulationQuery.data.sample.length > 0) {
      setTestContactId(simulationQuery.data.sample[0]!.contactId);
    }
    setTestResult(null);
    setTestModalOpen(true);
  };

  const executeTestSend = async () => {
    if (!testRecipientEmail.trim()) {
      toast.error("Please enter a test recipient email address.");
      return;
    }
    setTestSending(true);
    setTestResult(null);
    try {
      let targetCampaignId = campaignId;
      if (!targetCampaignId) {
        const saved = await saveMutation.mutateAsync();
        targetCampaignId = saved.id;
      }
      const res = await api.post<{ results: { to: string; ok: boolean; error?: string }[]; renderedFor: string | null }>(
        `/api/campaigns/${targetCampaignId}/test`,
        {
          to: [testRecipientEmail.trim()],
          contactId: testContactId || undefined,
        }
      );
      const failed = res.data.results.filter((r) => !r.ok);
      if (failed.length) {
        setTestResult({ ok: false, message: failed.map((f) => f.error).join(", ") });
      } else {
        setTestResult({
          ok: true,
          message: `Test email sent to ${testRecipientEmail}! Rendered for: ${res.data.renderedFor ?? "sample contact"}. Check your inbox.`,
        });
        toast.success("Test email sent!", `Delivered to ${testRecipientEmail}.`);
      }
    } catch (err) {
      setTestResult({ ok: false, message: errorMessage(err) });
    } finally {
      setTestSending(false);
    }
  };

  // Save Campaign Mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Please enter a campaign name.");
      if (!contactListId) throw new Error("Please select a target contact list.");
      if (selectedTemplates.length === 0) throw new Error("Select at least one email template.");

      const fallback = selectedTemplates.find((t) => t.isFallback) ?? selectedTemplates[0]!;

      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        contactListId,
        templateId: fallback.templateId,
        fromName: fromName.trim() || mailboxQuery.data?.data.smtp.fromName || "FocusRealm",
        replyTo: replyTo.trim() || null,
        sendRatePerMinute: parseInt(sendRatePerMinute, 10) || 20,
        templates: selectedTemplates.map((t) => ({
          templateId: t.templateId,
          isFallback: t.isFallback,
          priority: t.priority,
        })),
        rules: rules.map((r) => ({
          templateId: r.templateId,
          priority: r.priority,
          hotelSegment: r.hotelSegment || undefined,
          contactPersona: r.contactPersona || undefined,
          city: r.city || undefined,
          requiresVerified: r.requiresVerified,
          minConfidence: r.minConfidence,
          description: r.description || undefined,
        })),
      };

      if (isNew) {
        const res = await api.post<CampaignDetailDto>("/api/campaigns", payload);
        return res.data;
      } else {
        const res = await api.patch<CampaignDetailDto>(`/api/campaigns/${campaignId}`, payload);
        return res.data;
      }
    },
    onSuccess: async (campaign) => {
      await invalidate("campaigns", "overview");
      toast.success(isNew ? "Multi-template campaign created!" : "Campaign updated successfully.");
      if (onDone) {
        onDone(campaign.id);
      } else {
        navigate(`/campaigns/${campaign.id}`);
      }
    },
    onError: (err) => {
      toast.error("Couldn't save campaign", errorMessage(err));
    },
  });

  const availableToAdd = (templatesQuery.data?.data ?? []).filter(
    (t) => !selectedTemplates.some((st) => st.templateId === t.id)
  );

  const listOptions = (listsQuery.data?.data ?? []).map((l) => ({
    value: l.id,
    label: `${l.name} (${plural(l.memberCount, "contact")})`,
  }));

  const selectedList = listsQuery.data?.data.find((l) => l.id === contactListId);
  const sim = simulationQuery.data;

  return (
    <div className="space-y-6">
      {/* 1. Audience & Sender Settings */}
      <Panel
        title="1. Campaign Details & Target Audience"
        description="Select the recipient audience list and configure sender identification."
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Campaign Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Goa Luxury Resorts — General Managers Q4"
              required
            />
            <SelectField
              label="Send to Contact List"
              value={contactListId}
              onChange={(e) => setContactListId(e.target.value)}
              options={listOptions}
              placeholder={listsQuery.isPending ? "Loading lists…" : "Choose a contact list"}
              hint={
                selectedList
                  ? `${num(selectedList.memberCount)} contacts in this list`
                  : undefined
              }
            />
          </div>

          <TextField
            label="Internal Note"
            optional
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Goal, context, or outreach objective for founder approval"
          />

          <div className="grid gap-4 sm:grid-cols-3 pt-2">
            <div>
              <TextField
                label="Sender Display Name"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                placeholder="e.g. Founder’s Office, Sehej Sharma, FocusRealm"
                hint={
                  mailboxQuery.data?.data.smtp.fromEmail ? (
                    <span className="flex items-center justify-between gap-1 text-[11px]">
                      <span>Sends from: <strong className="font-semibold text-ink">{mailboxQuery.data.data.smtp.fromEmail}</strong></span>
                      <ButtonLink to="/settings/mailbox" size="sm" variant="ghost" className="text-primary hover:underline text-[11px] p-0 h-auto">Settings</ButtonLink>
                    </span>
                  ) : "Configured mailbox"
                }
              />
              <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-subtle">
                <span className="text-[10px] uppercase font-semibold text-ink-muted">Quick:</span>
                {["Founder’s Office", "FocusRealm", "Sehej Sharma"].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setFromName(preset)}
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                      fromName === preset
                        ? "bg-primary text-white"
                        : "bg-canvas-subtle text-ink-muted hover:bg-line hover:text-ink"
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
            <TextField
              label="Reply-To"
              optional
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="defaults to sender mailbox"
            />
            <SelectField
              label="Sending Pace"
              value={sendRatePerMinute}
              onChange={(e) => setSendRatePerMinute(e.target.value)}
              options={PACES}
            />
          </div>
        </div>
      </Panel>

      {/* 2. Multi-Template Selection */}
      <Panel
        title="2. Eligible Email Templates"
        description="Select multiple email templates. Contacts matching targeting rules will receive their specific template; unmatched contacts receive the default fallback."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={async () => {
                const refreshed = await templatesQuery.refetch();
                const latestTemplates = refreshed.data?.data ?? templatesQuery.data?.data ?? [];
                const currentIds = new Set(selectedTemplates.map((t) => t.templateId));
                const remaining = latestTemplates.filter((t) => !currentIds.has(t.id));
                if (remaining.length > 0) {
                  setTemplateToAddId(remaining[0]!.id);
                }
                setAddTemplateModalOpen(true);
              }}
            >
              Add Template
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className={`h-3.5 w-3.5 ${templatesQuery.isFetching ? "animate-spin" : ""}`} />}
              onClick={() => {
                templatesQuery.refetch();
                toast.success("Templates refreshed", "Fetched latest templates from your workspace.");
              }}
              title="Refresh workspace templates"
            >
              Refresh
            </Button>
            <ButtonLink
              to="/templates/new"
              size="sm"
              target="_blank"
              icon={<FileText className="h-3.5 w-3.5" />}
            >
              Write New
            </ButtonLink>
          </div>
        }
      >
        <div className="space-y-3">
          {selectedTemplates.length === 0 ? (
            <Callout tone="warning" title="No templates selected">
              Please select at least one email template to send.
            </Callout>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {selectedTemplates.map((t) => {
                return (
                  <div
                    key={t.templateId}
                    className={`relative flex flex-col justify-between rounded-lg border p-4 transition-all ${
                      t.isFallback
                        ? "border-brand/40 bg-brand-soft/20 shadow-sm"
                        : "border-line bg-surface hover:border-line-strong"
                    }`}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-semibold text-sm text-ink truncate" title={t.name}>
                          {t.name}
                        </span>
                        {t.isFallback ? (
                          <Badge tone="brand" className="shrink-0 flex items-center gap-1">
                            <Star className="h-3 w-3 fill-current" /> Fallback
                          </Badge>
                        ) : (
                          <Badge tone="neutral" className="shrink-0">
                            Eligible
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-ink-subtle">
                        {t.subject || "No subject set"}
                      </p>
                    </div>

                    <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3 text-xs">
                      {!t.isFallback ? (
                        <button
                          type="button"
                          className="link text-xs font-medium"
                          onClick={() => makeFallback(t.templateId)}
                        >
                          Make Fallback
                        </button>
                      ) : (
                        <span className="text-ink-subtle text-[11px]">Primary Default</span>
                      )}

                      {selectedTemplates.length > 1 && (
                        <button
                          type="button"
                          className="text-danger hover:underline text-xs flex items-center gap-1"
                          onClick={() => removeTemplate(t.templateId)}
                        >
                          <Trash2 className="h-3 w-3" /> Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Panel>

      {/* 3. Segment & Persona Targeting Rules */}
      <Panel
        title="3. Segment & Persona Targeting Rules"
        description="Rules route contacts matching specific criteria to their dedicated template. Contacts not matching any rule automatically receive the Fallback template."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={openNewRuleModal}
            disabled={selectedTemplates.length === 0}
          >
            Add Targeting Rule
          </Button>
        }
      >
        <div className="space-y-4">
          {/* Visual Targeting Guide & Quick Presets */}
          <div className="rounded-lg bg-brand-soft/20 border border-brand/20 p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white text-[11px] font-bold">
                  ?
                </span>
                <h4 className="text-xs font-semibold text-ink">How Targeting Rules Work (Simple Guide)</h4>
              </div>
              <span className="text-[11px] font-medium text-brand">Top-to-Bottom Priority &bull; First Match Wins</span>
            </div>
            <p className="text-xs text-ink-muted leading-relaxed">
              Targeting rules let you send different templates to different audiences in the same list.
              When a recipient matches Rule #1, they get that template immediately. If not, the system tests Rule #2.
              Anyone who doesn't match any rule automatically receives your primary <strong>Fallback Template</strong> (
              <span className="text-brand font-medium">
                {selectedTemplates.find((t) => t.isFallback)?.name ?? "Primary Default"}
              </span>
              ).
            </p>

            <div className="mt-3 pt-3 border-t border-brand/10">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[11px] font-semibold text-ink-subtle uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3 text-brand" /> Quick 1-Click Presets:
                </span>
                <span className="text-[11px] text-ink-subtle italic">Click to pre-fill a targeting rule</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="text-xs"
                  onClick={() => applyRulePreset("LUXURY_RESORT", "", "Luxury Hotels & Resorts")}
                  disabled={selectedTemplates.length === 0}
                >
                  🏨 Target Luxury & Resorts
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="text-xs"
                  onClick={() => applyRulePreset("", "GENERAL_MANAGER", "General Managers")}
                  disabled={selectedTemplates.length === 0}
                >
                  👔 Target General Managers
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="text-xs"
                  onClick={() => applyRulePreset("OTHER", "FOUNDER_OWNER", "Partners & Agency Founders")}
                  disabled={selectedTemplates.length === 0}
                >
                  🤝 Target Partners & Agencies
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="text-xs"
                  onClick={() => applyRulePreset("", "", "Specific City Focus", "Goa")}
                  disabled={selectedTemplates.length === 0}
                >
                  📍 Target by City
                </Button>
              </div>
            </div>
          </div>

        {rules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface-muted/30 p-6 text-center text-xs text-ink-muted">
            <Filter className="mx-auto mb-2 h-5 w-5 text-ink-faint" />
            <p className="font-medium text-ink">No specific targeting rules configured</p>
            <p className="mt-1 text-ink-subtle">
              All contacts in the selected list will receive the default fallback template.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={openNewRuleModal}
              disabled={selectedTemplates.length === 0}
            >
              Configure First Rule
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-line rounded-lg border border-line bg-surface overflow-hidden">
            {rules.map((rule, idx) => {
              const targetTemplate = selectedTemplates.find((t) => t.templateId === rule.templateId);
              return (
                <div key={rule.id} className="flex flex-wrap items-center justify-between gap-3 p-3.5 text-xs">
                  <div className="flex items-center gap-3">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-muted font-bold text-ink-subtle text-[11px]">
                      #{idx + 1}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ink">
                          Send: <strong className="text-brand">{targetTemplate?.name ?? "Unknown Template"}</strong>
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-ink-muted">
                        {rule.hotelSegment && (
                          <Badge tone="info">
                            {HOTEL_SEGMENT_LABELS[rule.hotelSegment as HotelSegment] ?? rule.hotelSegment}
                          </Badge>
                        )}
                        {rule.contactPersona && (
                          <Badge tone="neutral">
                            {CONTACT_PERSONA_LABELS[rule.contactPersona as ContactPersona] ?? rule.contactPersona}
                          </Badge>
                        )}
                        {rule.city && <Badge tone="neutral">City: {rule.city}</Badge>}
                        {rule.requiresVerified && (
                          <Badge tone="success" className="flex items-center gap-1">
                            <ShieldCheck className="h-3 w-3" /> Verified Only
                          </Badge>
                        )}
                        {rule.minConfidence !== null && rule.minConfidence !== undefined && (
                          <Badge tone="neutral">Conf: &ge; {Math.round(rule.minConfidence * 100)}%</Badge>
                        )}
                        {!rule.hotelSegment && !rule.contactPersona && !rule.city && (
                          <span className="text-ink-subtle italic">Matches all contacts in priority</span>
                        )}
                      </div>
                      {rule.description && (
                        <p className="mt-0.5 text-[11px] text-ink-subtle italic">{rule.description}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => openEditRuleModal(rule)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={() => deleteRule(rule.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>
      </Panel>

      {/* 4. Live Recipient & Template Analysis */}
      <Panel
        title="4. Live Recipient & Template Analysis"
        description="Real-time distribution breakdown and simulated matching for the selected audience."
        actions={
          sim && sim.sample && sim.sample.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              icon={<FlaskConical className="h-3.5 w-3.5" />}
              onClick={openTestModal}
            >
              Send Test Email
            </Button>
          )
        }
      >
        {simulationQuery.isPending ? (
          <div className="py-8">
            <PageLoader label="Simulating recipient distribution against rules…" />
          </div>
        ) : simulationQuery.isError ? (
          <Callout tone="danger" title="Unable to simulate distribution">
            {errorMessage(simulationQuery.error)}
          </Callout>
        ) : !sim ? (
          <p className="text-xs text-ink-subtle">Select an audience list and template to preview distribution.</p>
        ) : (
          <div className="space-y-6">
            {/* Distribution Summary Stats */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Total in list" value={num(sim.total)} />
              <Stat
                label="Deliverable"
                value={num(sim.ready)}
                tone={sim.ready ? "success" : "warning"}
              />
              <Stat
                label="Missing Info"
                value={num(sim.missingFields.length)}
                tone={sim.missingFields.length ? "warning" : "default"}
              />
              <Stat
                label="Eligible Templates"
                value={num(selectedTemplates.length)}
              />
            </div>

            {/* Template Distribution Breakdown Cards */}
            {sim.templateBreakdown && sim.templateBreakdown.length > 0 && (
              <div className="rounded-lg border border-line bg-surface-muted/30 p-4">
                <div className="flex items-center gap-2 mb-3 text-[13px] font-medium text-ink">
                  <Split className="h-4 w-4 text-brand" />
                  <span>Template Distribution Matrix</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {sim.templateBreakdown.map((tb) => {
                    const pct = Math.round((tb.count / Math.max(1, sim.ready)) * 100);
                    return (
                      <div
                        key={tb.templateId}
                        className="flex flex-col justify-between rounded-md border border-line bg-surface p-3 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-ink truncate" title={tb.templateName}>
                            {tb.templateName}
                            {tb.isFallback ? " (Fallback)" : ""}
                          </span>
                          <Badge tone={tb.isFallback ? "neutral" : "brand"}>{pct}%</Badge>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-ink-subtle">
                          <span>{plural(tb.count, "recipient")}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Missing Info Warning */}
            {sim.missingFields.length > 0 && (
              <Callout tone="warning" title={`${plural(sim.missingFields.length, "contact")} have missing merge fields`}>
                They will be skipped during sending. Add fallback values in the template or update the contacts.
              </Callout>
            )}

            {/* Sample Recipient Matching Table */}
            {sim.sample && sim.sample.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                  Sample Recipient Matches ({sim.sample.length} of {sim.total})
                </p>
                <div className="overflow-x-auto rounded-lg border border-line bg-surface">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-line bg-surface-muted/60 text-ink-subtle font-medium">
                        <th className="p-3">Recipient</th>
                        <th className="p-3">Hotel Segment</th>
                        <th className="p-3">Persona</th>
                        <th className="p-3">Assigned Template</th>
                        <th className="p-3">Status</th>
                        <th className="p-3">Matching Reason</th>
                        <th className="p-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {sim.sample.map((row) => (
                        <tr key={row.email} className="hover:bg-surface-muted/20">
                          <td className="p-3 font-medium text-ink">
                            <div>{row.email}</div>
                            {row.company && (
                              <div className="text-[11px] text-ink-subtle">{row.company}</div>
                            )}
                          </td>
                          <td className="p-3 text-ink-muted">
                            {row.hotelSegment ? (
                              <Badge tone="info">
                                {HOTEL_SEGMENT_LABELS[row.hotelSegment as HotelSegment] ?? row.hotelSegment}
                              </Badge>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="p-3 text-ink-muted">
                            {row.contactPersona ? (
                              <Badge tone="neutral">
                                {CONTACT_PERSONA_LABELS[row.contactPersona as ContactPersona] ?? row.contactPersona}
                              </Badge>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="p-3">
                            <span className="font-semibold text-ink">{row.templateName}</span>
                          </td>
                          <td className="p-3">
                            {row.isCustom ? (
                              <Badge tone="brand">Customized</Badge>
                            ) : (
                              <Badge tone="neutral">Generated</Badge>
                            )}
                          </td>
                          <td className="p-3 text-ink-subtle text-[11px]">
                            {row.assignmentReason}
                          </td>
                          <td className="p-3 text-right">
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<Eye className="h-3 w-3" />}
                              onClick={() => openPreview(row)}
                            >
                              Preview & Edit
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* Action Footer */}
      <div className="flex items-center justify-between rounded-lg border border-line bg-surface p-4">
        <ButtonLink to="/campaigns" variant="secondary">
          Cancel
        </ButtonLink>

        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            icon={<FlaskConical className="h-4 w-4" />}
            onClick={openTestModal}
            disabled={selectedTemplates.length === 0 || !contactListId}
          >
            Send Test Email
          </Button>

          <Button
            variant="primary"
            loading={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            icon={<Send className="h-4 w-4" />}
          >
            {isNew ? "Create Multi-Template Campaign" : "Save Changes"}
          </Button>
        </div>
      </div>

      {/* Dialog: Add Template */}
      <Dialog
        open={addTemplateModalOpen}
        onClose={() => setAddTemplateModalOpen(false)}
        title="Add Email Template"
        description="Choose another template from your workspace to include in this campaign."
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddTemplateModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={addTemplate} disabled={!templateToAddId || availableToAdd.length === 0}>
              Add to Campaign
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink">Workspace Template</span>
            <button
              type="button"
              className="text-xs text-brand hover:underline flex items-center gap-1"
              onClick={async () => {
                const refreshed = await templatesQuery.refetch();
                const latest = refreshed.data?.data ?? [];
                const currentIds = new Set(selectedTemplates.map((t) => t.templateId));
                const remaining = latest.filter((t) => !currentIds.has(t.id));
                if (remaining.length > 0 && !remaining.some((t) => t.id === templateToAddId)) {
                  setTemplateToAddId(remaining[0]!.id);
                }
                toast.success("Templates updated", `Found ${latest.length} workspace templates.`);
              }}
            >
              <RefreshCw className={`h-3 w-3 ${templatesQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh list
            </button>
          </div>
          {availableToAdd.length > 0 ? (
            <SelectField
              aria-label="Workspace Template"
              value={templateToAddId}
              onChange={(e) => setTemplateToAddId(e.target.value)}
              options={availableToAdd.map((t) => ({
                value: t.id,
                label: `${t.name}${t.subject ? ` — "${t.subject}"` : ""}`,
              }))}
              placeholder="Select a template"
            />
          ) : (
            <div className="rounded-lg border border-line bg-surface-muted p-4 text-center">
              <p className="text-sm font-medium text-ink">All templates are already added to this campaign.</p>
              <p className="mt-1 text-xs text-ink-subtle">
                Create a new template in the editor, then click <strong>Refresh list</strong> above.
              </p>
            </div>
          )}
        </div>
      </Dialog>

      {/* Dialog: Add/Edit Targeting Rule */}
      <Dialog
        open={ruleModalOpen}
        onClose={() => setRuleModalOpen(false)}
        title={editingRuleId ? "Edit Targeting Rule" : "Add Targeting Rule"}
        description="Route contacts matching specific hotel segments, personas, or verification criteria to a dedicated template."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRuleModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveRule}>
              {editingRuleId ? "Update Rule" : "Add Rule"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {/* Plain-English Rule Summary */}
          <div className="rounded-lg bg-surface-muted/60 border border-line p-3 text-xs space-y-1">
            <span className="font-semibold text-ink flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-brand" />
              Plain-English Rule Summary:
            </span>
            <p className="text-ink-muted leading-relaxed">
              IF a contact has{" "}
              <strong>{ruleForm.hotelSegment ? HOTEL_SEGMENT_LABELS[ruleForm.hotelSegment as HotelSegment] : "any hotel segment"}</strong>
              {ruleForm.contactPersona && <> and persona is <strong>{CONTACT_PERSONA_LABELS[ruleForm.contactPersona as ContactPersona]}</strong></>}
              {ruleForm.city && <> and city is <strong>"{ruleForm.city}"</strong></>}
              {ruleForm.requiresVerified && <> (verified records only)</>}
              &nbsp;&rarr; THEN immediately send{" "}
              <strong className="text-brand">
                {selectedTemplates.find((t) => t.templateId === ruleForm.templateId)?.name || "chosen template"}
              </strong>
              . Otherwise, proceed to subsequent rules or fallback.
            </p>
          </div>

          <SelectField
            label="Send Template"
            value={ruleForm.templateId}
            onChange={(e) => setRuleForm((f) => ({ ...f, templateId: e.target.value }))}
            options={selectedTemplates.map((t) => ({ value: t.templateId, label: t.name }))}
            required
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Priority Order"
              type="number"
              value={String(ruleForm.priority)}
              onChange={(e) => setRuleForm((f) => ({ ...f, priority: parseInt(e.target.value, 10) || 1 }))}
              hint="Rules are tested from lowest number to highest."
            />
            <TextField
              label="City Filter"
              optional
              value={ruleForm.city}
              onChange={(e) => setRuleForm((f) => ({ ...f, city: e.target.value }))}
              placeholder="e.g. Mumbai, Goa"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Target Hotel Segment"
              optional
              value={ruleForm.hotelSegment}
              onChange={(e) => setRuleForm((f) => ({ ...f, hotelSegment: e.target.value }))}
              options={[
                { value: "", label: "Any hotel segment" },
                ...HOTEL_SEGMENTS.map((seg) => ({
                  value: seg,
                  label: HOTEL_SEGMENT_LABELS[seg],
                })),
              ]}
            />
            <SelectField
              label="Target Contact Persona"
              optional
              value={ruleForm.contactPersona}
              onChange={(e) => setRuleForm((f) => ({ ...f, contactPersona: e.target.value }))}
              options={[
                { value: "", label: "Any persona / title" },
                ...CONTACT_PERSONAS.map((p) => ({
                  value: p,
                  label: CONTACT_PERSONA_LABELS[p],
                })),
              ]}
            />
          </div>

          <div className="rounded-lg border border-line bg-surface-muted/30 p-3 space-y-3">
            <Checkbox
              checked={ruleForm.requiresVerified}
              onChange={(e) => setRuleForm((f) => ({ ...f, requiresVerified: e.target.checked }))}
              label="Require Verified Status"
              description="Only contacts with human or source-verified attributes will match this rule."
            />
            <TextField
              label="Minimum Confidence Score (0.0 – 1.0)"
              optional
              placeholder="e.g. 0.70"
              value={ruleForm.minConfidence}
              onChange={(e) => setRuleForm((f) => ({ ...f, minConfidence: e.target.value }))}
            />
          </div>

          <TextField
            label="Rule Description / Note"
            optional
            value={ruleForm.description}
            onChange={(e) => setRuleForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="e.g. Luxury Resort General Managers in Goa"
          />
        </div>
      </Dialog>

      {/* Dialog: Send Test Email */}
      <Dialog
        open={testModalOpen}
        onClose={() => setTestModalOpen(false)}
        title="Send Test Email"
        description="Verify how the actual email appears in an inbox before launching live outreach."
        footer={
          <>
            <Button variant="secondary" onClick={() => setTestModalOpen(false)} disabled={testSending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={testSending}
              onClick={executeTestSend}
              icon={<FlaskConical className="h-4 w-4" />}
            >
              Send Test Now
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-xs">
          {testResult && (
            <Callout tone={testResult.ok ? "success" : "danger"}>
              {testResult.message}
            </Callout>
          )}

          <div className="rounded-lg bg-brand-soft/20 border border-brand/20 p-3 text-ink-muted">
            <p>
              💡 <strong>Safety note:</strong> Test emails are sent with <code>[Test]</code> prepended to the subject and are strictly dispatched only to your designated test address. Real campaign recipients are never emailed during a test.
            </p>
          </div>

          <TextField
            label="Send Test To Email Address"
            value={testRecipientEmail}
            onChange={(e) => setTestRecipientEmail(e.target.value)}
            placeholder="e.g. your-email@gmail.com"
            hint="The inbox where you will receive the rendered test email"
            required
          />

          {sim?.sample && sim.sample.length > 0 && (
            <SelectField
              label="Render personalization using data from"
              value={testContactId}
              onChange={(e) => setTestContactId(e.target.value)}
              options={sim.sample.map((s) => ({
                value: s.contactId,
                label: `${s.email} (${s.company || "No company"}) — Template: ${s.templateName}`,
              }))}
              hint="Choose a sample contact to verify merge fields (name, company, segment, etc.)"
            />
          )}

          {testContactId && sim?.sample && (
            <div className="rounded border border-line bg-surface p-3 space-y-1.5">
              <span className="font-semibold text-ink block">Selected Recipient Rule Matching:</span>
              {(() => {
                const sample = sim.sample.find((s) => s.contactId === testContactId);
                if (!sample) return null;
                return (
                  <div className="text-ink-muted space-y-1">
                    <div>Template: <strong className="text-brand">{sample.templateName}</strong></div>
                    <div>Reason: <span className="italic">{sample.assignmentReason}</span></div>
                    <div>Subject Preview: <span className="font-medium text-ink">{sample.subject}</span></div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </Dialog>

      {/* Dialog: Rendered Email Preview & Recipient Editor */}
      {previewSample && (() => {
        const sampleIndex = sim?.sample ? sim.sample.findIndex((s) => s.contactId === previewSample.contactId) : -1;
        const hasPrev = sampleIndex > 0;
        const hasNext = sim?.sample && sampleIndex >= 0 && sampleIndex < sim.sample.length - 1;

        const navigateTo = (newIndex: number) => {
          if (!sim?.sample || newIndex < 0 || newIndex >= sim.sample.length) return;
          const nextRecipient = sim.sample[newIndex]!;
          setPreviewSample(nextRecipient);
          setEditSubject(nextRecipient.subject);
          setEditBody(nextRecipient.text || htmlToText(nextRecipient.html));
        };

        const handleSaveOverride = async () => {
          if (!editSubject.trim()) {
            toast.error("Subject line cannot be empty.");
            return;
          }
          if (!editBody.trim()) {
            toast.error("Email body cannot be empty.");
            return;
          }
          setIsSavingOverride(true);
          try {
            if (campaignId) {
              await api.post(`/api/campaigns/${campaignId}/overrides`, {
                contactId: previewSample.contactId,
                templateId: previewSample.templateId,
                customSubject: editSubject.trim(),
                customBodyHtml: plainTextToHtml(editBody.trim()),
                customBodyText: editBody.trim(),
                isCustom: true,
                reason: "Customized by user in campaign preview",
              });
              await simulationQuery.refetch();
            }
            setPreviewSample((prev) =>
              prev
                ? {
                    ...prev,
                    subject: editSubject.trim(),
                    text: editBody.trim(),
                    html: plainTextToHtml(editBody.trim()),
                    isCustom: true,
                    assignmentReason: "Customized by user",
                  }
                : null
            );
            toast.success(`Custom version saved for ${previewSample.email}`);
            setPreviewTab("preview");
          } catch (err) {
            toast.error(`Failed to save custom override: ${errorMessage(err)}`);
          } finally {
            setIsSavingOverride(false);
          }
        };

        const handleResetOverride = async () => {
          setIsResettingOverride(true);
          try {
            if (campaignId) {
              await api.delete(`/api/campaigns/${campaignId}/overrides/${previewSample.contactId}`);
              const res = await simulationQuery.refetch();
              const updated = res.data?.sample.find((s) => s.contactId === previewSample.contactId);
              if (updated) {
                setPreviewSample(updated);
                setEditSubject(updated.subject);
                setEditBody(updated.text || htmlToText(updated.html));
              }
            }
            toast.success(`Reset ${previewSample.email} back to template generated default.`);
            setPreviewTab("preview");
          } catch (err) {
            toast.error(`Failed to reset: ${errorMessage(err)}`);
          } finally {
            setIsResettingOverride(false);
          }
        };

        return (
          <Dialog
            open
            onClose={() => setPreviewSample(null)}
            title={`Outreach Preview: ${previewSample.email}`}
            description={
              <div className="flex flex-wrap items-center gap-2 mt-1 text-xs">
                <span>Template: <strong className="text-brand">{previewSample.templateName}</strong></span>
                <span>•</span>
                <span className="text-ink-subtle">{previewSample.assignmentReason}</span>
                {previewSample.isCustom ? (
                  <Badge tone="brand">Customized by User</Badge>
                ) : (
                  <Badge tone="success">Generated by Intelligence</Badge>
                )}
              </div>
            }
            size="lg"
            footer={
              <div className="flex flex-wrap items-center justify-between gap-3 w-full">
                {/* Navigation */}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!hasPrev}
                    onClick={() => navigateTo(sampleIndex - 1)}
                  >
                    &larr; Prev
                  </Button>
                  <span className="text-xs text-ink-subtle">
                    {sampleIndex + 1} of {sim?.sample.length ?? 1}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!hasNext}
                    onClick={() => navigateTo(sampleIndex + 1)}
                  >
                    Next &rarr;
                  </Button>
                </div>

                {/* Mode Buttons */}
                <div className="flex items-center gap-2">
                  {previewTab === "edit" ? (
                    <>
                      {previewSample.isCustom && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={isResettingOverride}
                          onClick={handleResetOverride}
                        >
                          Reset to Default
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setPreviewTab("preview")}
                      >
                        Cancel Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={isSavingOverride}
                        onClick={handleSaveOverride}
                      >
                        Save Custom Version
                      </Button>
                    </>
                  ) : (
                    <>
                      {previewSample.isCustom && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={isResettingOverride}
                          onClick={handleResetOverride}
                        >
                          Reset to Default
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setPreviewTab("edit")}
                      >
                        Edit Email
                      </Button>
                      <Button variant="secondary" onClick={() => setPreviewSample(null)}>
                        Close
                      </Button>
                    </>
                  )}
                </div>
              </div>
            }
          >
            <div className="space-y-4">
              {/* Tab Selector */}
              <div className="flex items-center gap-2 border-b border-line pb-2">
                <button
                  type="button"
                  onClick={() => setPreviewTab("preview")}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    previewTab === "preview"
                      ? "bg-brand text-white shadow-sm"
                      : "text-ink-muted hover:text-ink hover:bg-surface-muted"
                  }`}
                >
                  Rendered Preview
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewTab("edit")}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    previewTab === "edit"
                      ? "bg-brand text-white shadow-sm"
                      : "text-ink-muted hover:text-ink hover:bg-surface-muted"
                  }`}
                >
                  Edit Subject & Body
                </button>
              </div>

              {previewTab === "preview" && (
                <EmailPreview
                  from={`${fromName || "FocusRealm"} <${mailboxQuery.data?.data.smtp.fromEmail ?? "namaste@misehotel.com"}>`}
                  to={previewSample.email}
                  subject={previewSample.subject}
                  html={previewSample.html}
                  text={previewSample.text}
                />
              )}

              {previewTab === "edit" && (
                <div className="space-y-3">
                  <div className="rounded-md bg-brand-soft/20 border border-brand/20 p-2.5 text-xs text-ink-muted">
                    💡 <strong>Manual Override:</strong> Any subject or body edits saved here are permanently tied to this recipient ({previewSample.email}). They will never be overwritten by template re-renders or automated rules during campaign approval and sending.
                  </div>

                  <TextField
                    label="Subject Line"
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    required
                  />

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-ink block">Email Body</label>
                    <textarea
                      rows={12}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      className="w-full rounded-md border border-line bg-surface p-3 font-mono text-xs text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand leading-relaxed"
                    />
                    <p className="text-[11px] text-ink-subtle">
                      Paragraph breaks are preserved. URLs will automatically become clickable links in HTML emails.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Dialog>
        );
      })()}
    </div>
  );
}
