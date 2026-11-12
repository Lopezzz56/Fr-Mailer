import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Send } from "lucide-react";
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
import type { CampaignSummaryDto } from "@shared/types";

type TabKey = "all" | "mine" | "shared" | "active" | "completed" | "draft";

export function CampaignsPage() {
  useTitle("Campaigns");
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [params, setParams] = useSearchParams();

  const requestedTab = params.get("tab") as TabKey | null;
  const tab: TabKey = requestedTab && ["all", "mine", "shared", "active", "completed", "draft"].includes(requestedTab)
    ? requestedTab
    : "all";
  const [search, setSearch] = useState("");
  const campaigns = useCampaigns({});

  const all = campaigns.data?.data ?? [];

  const myCount = all.filter((c) => c.createdById === user?.id || c.createdBy?.id === user?.id).length;
  const sharedCount = all.filter((c) => Boolean(c.createdById && c.createdById !== user?.id)).length;
  const activeCount = all.filter((c) => ["APPROVED", "SENDING", "PAUSED"].includes(c.status)).length;
  const draftCount = all.filter((c) => c.status === "DRAFT").length;
  const completedCount = all.filter((c) => c.status === "COMPLETED").length;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((c) => {
      if (q && !c.name.toLowerCase().includes(q) && !c.list.name.toLowerCase().includes(q) && !(c.template?.name || "").toLowerCase().includes(q)) {
        return false;
      }
      if (tab === "mine") return c.createdById === user?.id || c.createdBy?.id === user?.id;
      if (tab === "shared") return Boolean(c.createdById && c.createdById !== user?.id);
      if (tab === "draft") return c.status === "DRAFT";
      if (tab === "active") return ["APPROVED", "SENDING", "PAUSED"].includes(c.status);
      if (tab === "completed") return c.status === "COMPLETED";
      return true;
    });
  }, [all, tab, search, user?.id]);

  const tabs = [
    { key: "all" as const, label: "All", count: all.length },
    { key: "mine" as const, label: "Mine", count: myCount },
    { key: "shared" as const, label: "Shared", count: sharedCount },
    { key: "active" as const, label: "Active", count: activeCount },
    { key: "completed" as const, label: "Completed", count: completedCount },
    { key: "draft" as const, label: "Drafts", count: draftCount },
  ];

  const columns: Column<CampaignSummaryDto>[] = [
    {
      key: "name",
      header: "Campaign",
      cell: (c) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{c.name}</p>
          <p className="truncate text-xs text-ink-subtle">
            {c.template.name} · {c.list.name}
          </p>
          <p className="truncate text-2xs text-ink-muted sm:hidden mt-0.5">
            {c.counts.total ? `${c.counts.sent} of ${c.counts.total - c.counts.skipped} sent` : plural(c.list.memberCount, "contact")} · {timeAgo(c.updatedAt)}
          </p>
        </div>
      ),
      className: "max-w-[340px]",
    },
    { key: "status", header: "Status", cell: (c) => <CampaignStatusBadge status={c.status} /> },
    {
      key: "progress",
      header: "Recipients",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (c) =>
        c.counts.total ? (
          <CampaignProgress counts={c.counts} compact />
        ) : (
          <span className="text-ink-muted">{plural(c.list.memberCount, "contact")} in list</span>
        ),
    },
    {
      key: "owner",
      header: "Created by",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (c) => (
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-ink-muted">{c.createdBy?.name ?? "Team"}</span>
          {(c.createdById === user?.id || c.createdBy?.id === user?.id) && (
            <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold text-brand">
              you
            </span>
          )}
        </div>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (c) => <span className="whitespace-nowrap text-ink-muted">{timeAgo(c.updatedAt)}</span>
    },
  ];

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Plan outreach, review delivery, and follow campaign progress."
        actions={can("campaigns.manage") && <ButtonLink to="/campaigns/new" variant="primary" icon={<Send className="h-4 w-4" />}>New campaign</ButtonLink>}
      />

      <Tabs
        className="mb-5"
        active={tab}
        onChange={(key) => setParams(key === "all" ? {} : { tab: key }, { replace: true })}
        tabs={tabs}
      />

      <Card>
        <div className="border-b border-line p-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search campaigns or lists" className="w-full sm:max-w-sm" />
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
                  description="Create a campaign to start personalized outreach."
                  action={can("campaigns.manage") && <ButtonLink to="/campaigns/new" variant="primary">New campaign</ButtonLink>}
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
