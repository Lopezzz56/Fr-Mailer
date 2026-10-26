import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Send } from "lucide-react";
import { useCampaigns } from "../../lib/queries";
import { useTitle } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { plural, timeAgo } from "../../lib/format";
import { PageHeader, Tabs } from "../../components/ui/Navigation";
import { Card } from "../../components/ui/Card";
import { ButtonLink } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Field";
import { DataTable, type Column } from "../../components/ui/DataTable";
import { CampaignStatusBadge } from "../../components/ui/Badge";
import { EmptyState, ErrorState } from "../../components/ui/Feedback";
import { CampaignProgress } from "../../components/campaigns/CampaignProgress";
import type { CampaignStatus, CampaignSummaryDto } from "@shared/types";

type TabKey = "all" | "draft" | "approval" | "active" | "completed" | "cancelled";
const GROUPS: Record<Exclude<TabKey, "all">, CampaignStatus[]> = {
  draft: ["DRAFT"],
  approval: ["PENDING_APPROVAL"],
  active: ["APPROVED", "SENDING", "PAUSED"],
  completed: ["COMPLETED"],
  cancelled: ["CANCELLED"],
};

export function CampaignsPage() {
  useTitle("Campaigns");
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabKey) || "all";
  const [search, setSearch] = useState("");
  const campaigns = useCampaigns({});

  const all = campaigns.data?.data ?? [];
  const count = (k: Exclude<TabKey, "all">) => all.filter((c) => GROUPS[k].includes(c.status)).length;
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((c) => (tab === "all" || GROUPS[tab].includes(c.status)) && (!q || c.name.toLowerCase().includes(q) || c.list.name.toLowerCase().includes(q)));
  }, [all, tab, search]);

  const columns: Column<CampaignSummaryDto>[] = [
    {
      key: "name",
      header: "Campaign",
      cell: (c) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{c.name}</p>
          <p className="truncate text-xs text-ink-subtle">
            {c.template.name} · {c.list.name}
          </p>
        </div>
      ),
      className: "max-w-[340px]",
    },
    { key: "status", header: "Status", cell: (c) => <CampaignStatusBadge status={c.status} /> },
    {
      key: "progress",
      header: "Recipients",
      cell: (c) => (c.counts.total ? <CampaignProgress counts={c.counts} compact /> : <span className="text-ink-muted">{plural(c.list.memberCount, "contact")} in list</span>),
    },
    { key: "owner", header: "Created by", cell: (c) => <span className="text-ink-muted">{c.createdBy?.name ?? "—"}</span> },
    { key: "updated", header: "Updated", cell: (c) => <span className="whitespace-nowrap text-ink-muted">{timeAgo(c.updatedAt)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Every campaign is reviewed and approved by a founder before it sends."
        actions={can("campaigns.manage") && <ButtonLink to="/campaigns/new" variant="primary" icon={<Plus className="h-4 w-4" />}>New campaign</ButtonLink>}
      />
      <Tabs
        className="mb-4"
        active={tab}
        onChange={(k) => setParams(k === "all" ? {} : { tab: k }, { replace: true })}
        tabs={[
          { key: "all", label: "All", count: all.length },
          { key: "draft", label: "Drafts", count: count("draft") },
          { key: "approval", label: "Awaiting approval", count: count("approval") },
          { key: "active", label: "Active", count: count("active") },
          { key: "completed", label: "Completed", count: count("completed") },
          { key: "cancelled", label: "Cancelled", count: count("cancelled") },
        ]}
      />
      <Card>
        <div className="border-b border-line p-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search campaigns or lists" className="max-w-sm" />
        </div>
        {campaigns.isError ? (
          <ErrorState error={campaigns.error} onRetry={() => campaigns.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={campaigns.data ? rows : undefined}
            rowKey={(c) => c.id}
            loading={campaigns.isPending}
            onRowClick={(c) => navigate(`/campaigns/${c.id}`)}
            caption="Campaigns"
            empty={
              all.length === 0 ? (
                <EmptyState
                  icon={Send}
                  title="No campaigns yet"
                  description="Pick a template and a list. You'll review every recipient before a founder approves it."
                  action={can("campaigns.manage") && <ButtonLink to="/campaigns/new" variant="primary">Create a campaign</ButtonLink>}
                />
              ) : (
                <EmptyState title="Nothing here" description="No campaigns match this view." />
              )
            }
          />
        )}
      </Card>
    </>
  );
}
