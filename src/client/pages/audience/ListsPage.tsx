import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ListChecks, Plus, Upload } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { useInvalidate, useLists } from "../../lib/queries";
import { useTitle } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { num, timeAgo } from "../../lib/format";
import { PageHeader, ActionMenu, Tabs } from "../../components/ui/Navigation";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button, ButtonLink } from "../../components/ui/Button";
import { DataTable, type Column } from "../../components/ui/DataTable";
import { EmptyState, ErrorState } from "../../components/ui/Feedback";
import { TextAreaField, TextField } from "../../components/ui/Field";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { PageLoader } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { NewListDialog, NewContactDialog } from "../../components/contacts/ContactDialogs";
import { ContactsTable } from "../../components/contacts/ContactsTable";
import type { ContactListDto } from "@shared/types";

export function ListsPage({ embedded = false }: { embedded?: boolean }) {
  useTitle(embedded ? "Contacts" : "Lists");
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("scope") ?? "mine";
  const activeTab = ["mine", "shared", "all"].includes(requestedTab) ? requestedTab : "mine";
  const lists = useLists();
  const [creating, setCreating] = useState(false);
  const allLists = lists.data?.data ?? [];
  const mine = allLists.filter((list) => list.createdById === user?.id);
  const shared = allLists.filter((list) => list.isShared && list.createdById !== user?.id);
  const rows = activeTab === "mine" ? mine : activeTab === "shared" ? shared : allLists;

  const tabs = [
    { key: "mine", label: "My lists", count: mine.length },
    { key: "shared", label: "Shared", count: shared.length },
    { key: "all", label: "All", count: allLists.length },
  ];

  const columns: Column<ContactListDto>[] = [
    {
      key: "name",
      header: "List",
      cell: (l) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{l.name}</p>
          {l.description && <p className="truncate text-xs text-ink-subtle">{l.description}</p>}
          <p className="truncate text-2xs text-ink-muted sm:hidden mt-0.5">Updated {timeAgo(l.updatedAt)}</p>
        </div>
      ),
      className: "max-w-[420px]",
    },
    {
      key: "sharing",
      header: "Sharing",
      cell: (l) => <Badge tone={l.isShared ? "info" : "neutral"}>{l.isShared ? "Shared" : "Only me"}</Badge>,
    },
    { key: "members", header: "Contacts", cell: (l) => <span className="tabular font-medium">{num(l.memberCount)}</span> },
    {
      key: "updated",
      header: "Updated",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (l) => <span className="text-ink-muted">{timeAgo(l.updatedAt)}</span>
    },
  ];

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">Lists</h2>
            <p className="mt-0.5 text-xs text-ink-subtle">Audiences for campaigns. A contact can belong to several lists.</p>
          </div>
          {can("contacts.manage") && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New list</Button>}
        </div>
      ) : (
        <PageHeader
          title="Lists"
          description="Audiences for campaigns. A contact can belong to several lists."
          actions={
            can("contacts.manage") && (
              <>
                <ButtonLink to="/contacts/import" icon={<Upload className="h-4 w-4" />}>Import into a list</ButtonLink>
                <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New list</Button>
              </>
            )
          }
        />
      )}
      <div className="mb-5">
        <Tabs
          tabs={tabs}
          active={activeTab}
          onChange={(tab) => {
            const next = new URLSearchParams(params);
            if (tab === "mine") next.delete("scope");
            else next.set("scope", tab);
            setParams(next, { replace: true });
          }}
        />
      </div>
      <Card>
        {lists.isError ? (
          <ErrorState error={lists.error} onRetry={() => lists.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(l) => l.id}
            loading={lists.isPending}
            onRowClick={(l) => navigate(`/lists/${l.id}`)}
            caption="Lists"
            empty={<EmptyState icon={ListChecks} title="No lists yet" description="Create a list, or import a file straight into a new one." action={can("contacts.manage") && <Button variant="primary" onClick={() => setCreating(true)}>Create a list</Button>} />}
          />
        )}
      </Card>
      <NewListDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function EditListDialog({ list, onClose }: { list: ContactListDto; onClose: () => void }) {
  const [name, setName] = useState(list.name);
  const [description, setDescription] = useState(list.description ?? "");
  const [isShared, setIsShared] = useState(list.isShared);
  const invalidate = useInvalidate();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.patch(`/api/lists/${list.id}`, { name, description: description || null, isShared }),
    onSuccess: async () => {
      await invalidate("lists", "contacts");
      toast.success("List updated");
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!save.isPending}
      title="Edit list"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextAreaField label="Description" optional value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <label className="flex items-start gap-2 text-[13px] text-ink-muted">
          <input type="checkbox" checked={isShared} onChange={(event) => setIsShared(event.target.checked)} className="mt-0.5 accent-brand" />
          <span>Share this list with the organization</span>
        </label>
        {save.isError && <p className="text-xs text-danger">{errorMessage(save.error)}</p>}
      </div>
    </Dialog>
  );
}

export function ListDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const toast = useToast();
  const invalidate = useInvalidate();
  const lists = useLists();
  const list = lists.data?.data.find((l) => l.id === id);
  const canManageList = Boolean(
    list &&
    can("contacts.manage") &&
    (list.createdById === user?.id || (!list.createdById && list.isShared && user?.role !== "EMPLOYEE"))
  );
  const [dialog, setDialog] = useState<null | "edit" | "delete" | "add">(null);
  useTitle(list?.name ?? "List");
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/lists/${id}`),
    onSuccess: async () => {
      await invalidate("lists", "contacts");
      toast.success("List deleted");
      navigate("/contacts?view=lists");
    },
  });

  if (lists.isPending) return <PageLoader />;
  if (lists.isError) return <ErrorState error={lists.error} onRetry={() => lists.refetch()} />;
  if (!list) return <EmptyState title="This list no longer exists" action={<ButtonLink to="/contacts?view=lists">Back to lists</ButtonLink>} />;

  return (
    <>
      <PageHeader
        back={{ to: "/contacts?view=lists", label: "Lists" }}
        title={list.name}
        description={list.description ?? `${num(list.memberCount)} contacts`}
        actions={
          can("contacts.manage") && (
            <>
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => setDialog("add")}>Add contact</Button>
              <ButtonLink to={`/contacts/import?list=${list.id}`} variant="primary" icon={<Upload className="h-4 w-4" />}>Import into this list</ButtonLink>
              {canManageList && (
                <ActionMenu
                  items={[
                    { label: "Rename / sharing", onSelect: () => setDialog("edit") },
                    { label: "Delete list", tone: "danger", onSelect: () => setDialog("delete") },
                  ]}
                />
              )}
            </>
          )
        }
      />
      <ContactsTable listId={list.id} listName={list.name} />
      {dialog === "edit" && <EditListDialog list={list} onClose={() => setDialog(null)} />}
      <NewContactDialog open={dialog === "add"} onClose={() => setDialog(null)} defaultListId={list.id} />
      <ConfirmDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title={`Delete “${list.name}”?`}
        description={remove.isError ? errorMessage(remove.error) : "The list is removed. Its contacts stay in FocusRealm. Lists used by a campaign can't be deleted."}
        confirmLabel="Delete list"
      />
    </>
  );
}
