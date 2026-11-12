import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  Plus,
  Star,
  Tag,
} from "lucide-react";
import { useTemplates } from "../../lib/queries";
import { useDebounced, useTitle } from "../../lib/hooks";
import { timeAgo, plural } from "../../lib/format";
import { useAuth } from "../../lib/auth";
import { PageHeader, Tabs } from "../../components/ui/Navigation";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button, ButtonLink } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Field";
import { DataTable, type Column } from "../../components/ui/DataTable";
import { EmptyState, ErrorState } from "../../components/ui/Feedback";
import type { TemplateDto } from "@shared/types";
import { extractMergeFields } from "@shared/merge";

export function TemplatesPage() {
  useTitle("Templates");
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [params, setParams] = useSearchParams();

  const requestedTab = params.get("tab") ?? "mine";
  const rawTab = ["all", "mine", "campaigns", "shared"].includes(requestedTab) ? requestedTab : "mine";
  const selectedCollectionId = params.get("collection");

  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const debouncedSearch = useDebounced(search);
  const templates = useTemplates({ search: debouncedSearch });

  const all = templates.data?.data ?? [];

  // Group templates by campaign for Campaign Collections
  const campaignCollections = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        name: string;
        status: string;
        templates: TemplateDto[];
        lastUpdated: string;
      }
    >();

    for (const t of all) {
      if (t.campaigns && t.campaigns.length > 0) {
        for (const c of t.campaigns) {
          let entry = map.get(c.id);
          if (!entry) {
            entry = {
              id: c.id,
              name: c.name,
              status: c.status,
              templates: [],
              lastUpdated: t.updatedAt,
            };
            map.set(c.id, entry);
          }
          entry.templates.push(t);
          if (new Date(t.updatedAt) > new Date(entry.lastUpdated)) {
            entry.lastUpdated = t.updatedAt;
          }
        }
      }
    }

    // Sort templates inside each campaign: fallback first, then priority, then name
    for (const c of map.values()) {
      c.templates.sort((a, b) => {
        const aRef = a.campaigns?.find((ref) => ref.id === c.id);
        const bRef = b.campaigns?.find((ref) => ref.id === c.id);
        if (aRef?.isFallback && !bRef?.isFallback) return -1;
        if (!aRef?.isFallback && bRef?.isFallback) return 1;
        const aPri = aRef?.priority ?? 99;
        const bPri = bRef?.priority ?? 99;
        if (aPri !== bPri) return aPri - bPri;
        return a.name.localeCompare(b.name);
      });
    }

    return Array.from(map.values()).sort(
      (a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
    );
  }, [all]);

  const currentCollection = useMemo(() => {
    if (!selectedCollectionId) return null;
    return campaignCollections.find((c) => c.id === selectedCollectionId) ?? null;
  }, [campaignCollections, selectedCollectionId]);

  // Categories for personal templates
  const personalCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const t of all) {
      if (t.scope === "PERSONAL" && t.category && t.category.trim()) {
        cats.add(t.category.trim());
      }
    }
    const presets = ["Outreach", "Partnerships", "Advisory", "Follow-up", "Executive"];
    for (const p of presets) cats.add(p);
    return ["All", ...Array.from(cats)];
  }, [all]);

  const personalTemplates = useMemo(() => {
    return all.filter((t) => {
      if (t.scope !== "PERSONAL") return false;
      if (selectedCategory !== "All" && (t.category || "") !== selectedCategory) return false;
      return true;
    });
  }, [all, selectedCategory]);

  const sharedTemplates = useMemo(() => {
    return all.filter((t) => t.scope === "SHARED" || t.scope === "ORGANIZATION");
  }, [all]);

  const scopeTabs = [
    { key: "mine", label: "Personal", count: all.filter((t) => t.scope === "PERSONAL").length },
    { key: "campaigns", label: "Campaign Collections", count: campaignCollections.length },
    {
      key: "shared",
      label: "Organization & Shared",
      count: all.filter((t) => t.scope === "ORGANIZATION" || t.scope === "SHARED").length,
    },
    { key: "all", label: "All Templates", count: all.length },
  ];

  // Columns for Personal Templates table
  const personalColumns: Column<TemplateDto>[] = [
    {
      key: "name",
      header: "Template",
      cell: (t) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{t.name}</p>
          <p className="truncate text-xs text-ink-subtle">{t.subject}</p>
          <div className="flex items-center gap-2 mt-1 sm:hidden">
            {t.category && (
              <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                {t.category}
              </span>
            )}
            <span className="text-2xs text-ink-muted">{timeAgo(t.updatedAt)}</span>
          </div>
        </div>
      ),
      className: "max-w-[340px]",
    },
    {
      key: "category",
      header: "Category",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (t) =>
        t.category ? (
          <Badge tone="neutral" className="inline-flex items-center gap-1">
            <Tag className="h-2.5 w-2.5 text-ink-muted" />
            {t.category}
          </Badge>
        ) : (
          <span className="text-xs text-ink-faint">General</span>
        ),
    },
    {
      key: "fields",
      header: "Personalized with",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (t) => {
        const fields = extractMergeFields(t);
        return fields.length ? (
          <span className="text-xs text-ink-muted">
            {fields.slice(0, 3).map((f) => f.name).join(", ")}
            {fields.length > 3 ? ` +${fields.length - 3}` : ""}
          </span>
        ) : (
          <span className="text-xs text-ink-faint">No merge fields</span>
        );
      },
    },
    {
      key: "used",
      header: "Attached in",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (t) => (
        <span className="text-ink-muted text-xs">
          {t.campaignCount ? plural(t.campaignCount, "campaign") : "Library only"}
        </span>
      ),
    },
    {
      key: "updated",
      header: "Last edited",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (t) => <span className="text-ink-muted text-xs">{timeAgo(t.updatedAt)}</span>,
    },
  ];

  // Columns for All Templates table
  const allColumns: Column<TemplateDto>[] = [
    {
      key: "name",
      header: "Template",
      cell: (t) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{t.name}</p>
          <p className="truncate text-xs text-ink-subtle">{t.subject}</p>
        </div>
      ),
      className: "max-w-[340px]",
    },
    {
      key: "scope",
      header: "Scope",
      cell: (t) => {
        const s = t.scope ?? "PERSONAL";
        if (s === "ORGANIZATION") return <Badge tone="gold">FocusRealm</Badge>;
        if (s === "SHARED") return <Badge tone="info">Shared</Badge>;
        if (s === "CAMPAIGN") return <Badge tone="brand">Campaign</Badge>;
        return <Badge tone="neutral">Personal</Badge>;
      },
    },
    {
      key: "category",
      header: "Category",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (t) =>
        t.category ? (
          <span className="text-xs text-ink-muted">{t.category}</span>
        ) : (
          <span className="text-xs text-ink-faint">—</span>
        ),
    },
    {
      key: "owner",
      header: "Created by",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (t) => (
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-xs text-ink-muted">
            {t.scope === "ORGANIZATION" ? "FocusRealm" : t.createdBy?.name ?? "Team"}
          </span>
          {(t.createdById === user?.id || t.createdBy?.id === user?.id) && (
            <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold text-brand">
              you
            </span>
          )}
        </div>
      ),
    },
    {
      key: "used",
      header: "Used in",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (t) => (
        <span className="text-ink-muted text-xs">
          {t.campaignCount ? plural(t.campaignCount, "campaign") : "—"}
        </span>
      ),
    },
    {
      key: "updated",
      header: "Last edited",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (t) => <span className="text-ink-muted text-xs">{timeAgo(t.updatedAt)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable email messaging with personal merge fields. Organized by personal categories, campaign collections, and organization scope."
        actions={
          can("templates.manage") && (
            <ButtonLink to="/templates/new" variant="primary" icon={<Plus className="h-4 w-4" />}>
              New template
            </ButtonLink>
          )
        }
      />

      <div className="space-y-6">
        <Tabs
          tabs={scopeTabs}
          active={rawTab}
          onChange={(t) => {
            const nextParams: Record<string, string> = {};
            if (t !== "mine") nextParams.tab = t;
            setParams(nextParams, { replace: true });
          }}
        />

        {/* TAB 1: Personal Reusable Templates */}
        {rawTab === "mine" && (
          <div className="space-y-4">
            {/* Category Filter Chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
              <span className="text-ink-muted font-medium mr-1 shrink-0 flex items-center gap-1">
                <Tag className="h-3 w-3 text-ink-faint" /> Categories:
              </span>
              {personalCategories.map((cat) => {
                const isSelected = selectedCategory === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors shrink-0 ${
                      isSelected
                        ? "bg-brand text-white shadow-xs"
                        : "bg-surface-sunken text-ink-muted hover:bg-surface-muted hover:text-ink border border-line/60"
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>

            <Card>
              <div className="border-b border-line p-4">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Search personal templates by name or subject"
                  className="w-full sm:max-w-sm"
                />
              </div>
              {templates.isError ? (
                <ErrorState error={templates.error} onRetry={() => templates.refetch()} />
              ) : (
                <DataTable
                  columns={personalColumns}
                  rows={personalTemplates}
                  rowKey={(t) => t.id}
                  loading={templates.isPending}
                  onRowClick={(t) => navigate(`/templates/${t.id}`)}
                  caption="Personal Templates"
                  empty={
                    search || selectedCategory !== "All" ? (
                      <EmptyState
                        title="No matching templates"
                        description={`No personal templates found matching "${search || selectedCategory}".`}
                      />
                    ) : (
                      <EmptyState
                        icon={FileText}
                        title="No personal templates yet"
                        description="Write reusable templates for your outreach and categorize them for quick access."
                        action={
                          can("templates.manage") && (
                            <ButtonLink to="/templates/new" variant="primary">
                              Create Personal Template
                            </ButtonLink>
                          )
                        }
                      />
                    )
                  }
                />
              )}
            </Card>
          </div>
        )}

        {/* TAB 2: Campaign Template Collections */}
        {rawTab === "campaigns" && (
          <div className="space-y-4">
            {currentCollection ? (
              /* Drill-down inside a specific campaign collection */
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
                  <div className="flex items-center gap-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<ArrowLeft className="h-3.5 w-3.5" />}
                      onClick={() => setParams({ tab: "campaigns" }, { replace: true })}
                    >
                      All Collections
                    </Button>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-ink text-sm sm:text-base">{currentCollection.name}</h3>
                        <Badge tone="brand">{currentCollection.status}</Badge>
                      </div>
                      <p className="text-xs text-ink-subtle mt-0.5">
                        {currentCollection.templates.length} {plural(currentCollection.templates.length, "template")} in this campaign collection
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <ButtonLink
                      to={`/campaigns/${currentCollection.id}`}
                      variant="secondary"
                      size="sm"
                      icon={<ExternalLink className="h-3.5 w-3.5" />}
                    >
                      Open Campaign
                    </ButtonLink>
                    <ButtonLink
                      to={`/templates/new?campaignId=${currentCollection.id}&scope=CAMPAIGN`}
                      variant="primary"
                      size="sm"
                      icon={<Plus className="h-3.5 w-3.5" />}
                    >
                      Add Template to Collection
                    </ButtonLink>
                  </div>
                </div>

                <div className="space-y-3">
                  {currentCollection.templates.map((t, idx) => {
                    const cRef = t.campaigns?.find((c) => c.id === currentCollection.id);
                    const isDefault = cRef?.isFallback;
                    const orderLabel = isDefault
                      ? "01 Initial (Default)"
                      : `0${idx + 1} Follow-up / Step ${idx}`;

                    return (
                      <div
                        key={t.id}
                        onClick={() => navigate(`/templates/${t.id}`)}
                        className="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 hover:border-brand/40 hover:shadow-2xs transition-all cursor-pointer"
                      >
                        <div className="flex items-start sm:items-center gap-3 min-w-0">
                          <span
                            className={`flex h-8 px-2.5 items-center justify-center rounded-lg text-xs font-bold shrink-0 ${
                              isDefault
                                ? "bg-brand text-white shadow-xs"
                                : "bg-surface-sunken text-ink-muted border border-line/60"
                            }`}
                          >
                            {orderLabel}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm text-ink group-hover:text-brand transition-colors truncate">
                                {t.name}
                              </span>
                              {isDefault && (
                                <Badge tone="brand" className="shrink-0 flex items-center gap-1">
                                  <Star className="h-2.5 w-2.5 fill-current" /> Primary Default
                                </Badge>
                              )}
                              {t.category && (
                                <Badge tone="neutral" className="shrink-0">
                                  {t.category}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-ink-subtle truncate mt-0.5">{t.subject || "No subject set"}</p>
                          </div>
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-line/60 text-xs text-ink-muted">
                          <span>Updated {timeAgo(t.updatedAt)}</span>
                          <span className="text-brand font-medium group-hover:underline flex items-center gap-0.5">
                            Edit <ChevronRight className="h-3.5 w-3.5" />
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* Overview of all campaign collections */
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-ink-subtle">
                    Campaign collections organize all outreach touches, follow-ups, and variants created for a specific campaign.
                  </div>
                  <ButtonLink
                    to="/campaigns/new"
                    variant="secondary"
                    size="sm"
                    icon={<Plus className="h-3.5 w-3.5" />}
                  >
                    New Campaign
                  </ButtonLink>
                </div>

                {campaignCollections.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon={Folder}
                      title="No campaign collections yet"
                      description="Templates created or attached within campaigns automatically group into dedicated campaign collections here."
                      action={
                        <ButtonLink to="/campaigns/new" variant="primary">
                          Start a Campaign
                        </ButtonLink>
                      }
                    />
                  </Card>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {campaignCollections.map((col) => {
                      return (
                        <div
                          key={col.id}
                          onClick={() => setParams({ tab: "campaigns", collection: col.id }, { replace: true })}
                          className="group relative flex flex-col justify-between rounded-xl border border-line bg-surface p-5 hover:border-brand/50 hover:shadow-sm transition-all cursor-pointer"
                        >
                          <div>
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-soft text-brand font-bold shrink-0">
                                  <Folder className="h-4 w-4" />
                                </span>
                                <h4 className="font-semibold text-sm text-ink group-hover:text-brand transition-colors truncate" title={col.name}>
                                  {col.name}
                                </h4>
                              </div>
                              <Badge tone="neutral" className="shrink-0 text-[10px]">
                                {col.status}
                              </Badge>
                            </div>

                            <p className="mt-2 text-xs font-medium text-ink-muted">
                              {col.templates.length} {plural(col.templates.length, "template")} in sequence
                            </p>

                            {/* Preview list of step templates in this collection */}
                            <div className="mt-3 space-y-1.5 border-t border-line/60 pt-3">
                              {col.templates.slice(0, 3).map((t, i) => {
                                const cRef = t.campaigns?.find((ref) => ref.id === col.id);
                                return (
                                  <div key={t.id} className="flex items-center gap-2 text-xs text-ink-subtle">
                                    <span className="font-mono text-[10px] text-ink-faint">
                                      {cRef?.isFallback ? "01" : `0${i + 1}`}
                                    </span>
                                    <span className="truncate">{t.name}</span>
                                    {cRef?.isFallback && (
                                      <Star className="h-2.5 w-2.5 text-brand shrink-0 fill-current" />
                                    )}
                                  </div>
                                );
                              })}
                              {col.templates.length > 3 && (
                                <p className="text-[11px] text-ink-faint italic pt-0.5">
                                  +{col.templates.length - 3} more templates in collection
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3 text-2xs text-ink-muted">
                            <span>Updated {timeAgo(col.lastUpdated)}</span>
                            <span className="text-brand font-semibold group-hover:underline flex items-center gap-0.5">
                              View Collection <ChevronRight className="h-3 w-3" />
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: Organization & Shared */}
        {rawTab === "shared" && (
          <Card>
            <div className="border-b border-line p-4">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search organization & shared templates"
                className="w-full sm:max-w-sm"
              />
            </div>
            {templates.isError ? (
              <ErrorState error={templates.error} onRetry={() => templates.refetch()} />
            ) : (
              <DataTable
                columns={allColumns}
                rows={sharedTemplates}
                rowKey={(t) => t.id}
                loading={templates.isPending}
                onRowClick={(t) => navigate(`/templates/${t.id}`)}
                caption="Organization & Shared Templates"
                empty={
                  <EmptyState
                    icon={FileText}
                    title="No shared templates found"
                    description="Official FocusRealm and shared team templates will appear here."
                  />
                }
              />
            )}
          </Card>
        )}

        {/* TAB 4: All Templates */}
        {rawTab === "all" && (
          <Card>
            <div className="border-b border-line p-4">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search across all templates"
                className="w-full sm:max-w-sm"
              />
            </div>
            {templates.isError ? (
              <ErrorState error={templates.error} onRetry={() => templates.refetch()} />
            ) : (
              <DataTable
                columns={allColumns}
                rows={all}
                rowKey={(t) => t.id}
                loading={templates.isPending}
                onRowClick={(t) => navigate(`/templates/${t.id}`)}
                caption="All Templates"
                empty={
                  <EmptyState
                    icon={FileText}
                    title="No templates found"
                    description="Create templates to populate your library."
                  />
                }
              />
            )}
          </Card>
        )}
      </div>
    </>
  );
}
