import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Plus } from "lucide-react";
import { useTemplates } from "../../lib/queries";
import { useDebounced, useTitle } from "../../lib/hooks";
import { timeAgo, plural } from "../../lib/format";
import { useAuth } from "../../lib/auth";
import { PageHeader } from "../../components/ui/Navigation";
import { Card } from "../../components/ui/Card";
import { ButtonLink } from "../../components/ui/Button";
import { SearchInput } from "../../components/ui/Field";
import { DataTable, type Column } from "../../components/ui/DataTable";
import { EmptyState, ErrorState } from "../../components/ui/Feedback";
import type { TemplateDto } from "@shared/types";
import { extractMergeFields } from "@shared/merge";

export function TemplatesPage() {
  useTitle("Templates");
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const templates = useTemplates(useDebounced(search));

  const columns: Column<TemplateDto>[] = [
    {
      key: "name",
      header: "Template",
      cell: (t) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{t.name}</p>
          <p className="truncate text-xs text-ink-subtle">{t.subject}</p>
        </div>
      ),
      className: "max-w-[420px]",
    },
    {
      key: "fields",
      header: "Personalized with",
      cell: (t) => {
        const fields = extractMergeFields(t);
        return fields.length ? (
          <span className="text-xs text-ink-muted">{fields.slice(0, 3).map((f) => f.name).join(", ")}{fields.length > 3 ? ` +${fields.length - 3}` : ""}</span>
        ) : (
          <span className="text-xs text-ink-faint">No merge fields</span>
        );
      },
    },
    { key: "used", header: "Used in", cell: (t) => <span className="text-ink-muted">{t.campaignCount ? plural(t.campaignCount, "campaign") : "—"}</span> },
    { key: "updated", header: "Last edited", cell: (t) => <span className="text-ink-muted">{timeAgo(t.updatedAt)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable emails with personal fields. Campaigns lock a copy when they're approved."
        actions={can("templates.manage") && <ButtonLink to="/templates/new" variant="primary" icon={<Plus className="h-4 w-4" />}>New template</ButtonLink>}
      />
      <Card>
        <div className="border-b border-line p-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name or subject" className="max-w-sm" />
        </div>
        {templates.isError ? (
          <ErrorState error={templates.error} onRetry={() => templates.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={templates.data?.data}
            rowKey={(t) => t.id}
            loading={templates.isPending}
            onRowClick={(t) => navigate(`/templates/${t.id}`)}
            caption="Templates"
            empty={
              search ? (
                <EmptyState title="No matching templates" description="Try a different search." />
              ) : (
                <EmptyState
                  icon={FileText}
                  title="No templates yet"
                  description="Write the email once, with fields like {{firstName}}, and reuse it across campaigns."
                  action={can("templates.manage") && <ButtonLink to="/templates/new" variant="primary">Write your first template</ButtonLink>}
                />
              )
            }
          />
        )}
      </Card>
    </>
  );
}
