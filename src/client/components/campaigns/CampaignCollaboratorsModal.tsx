// Modal to view and manage campaign collaborators (Owner, Editor, Viewer)
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, UserPlus, Users } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { useCollaborators, useTeam, type CampaignDetail } from "../../lib/queries";
import { useAuth } from "../../lib/auth";
import { initials } from "../../lib/format";
import { Dialog, ConfirmDialog } from "../ui/Overlay";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { SelectField } from "../ui/Field";
import { useToast } from "../ui/Toast";
import type { CampaignAccessRole, CampaignCollaboratorDto } from "@shared/auth";

interface CampaignCollaboratorsModalProps {
  campaign: CampaignDetail;
  open: boolean;
  onClose: () => void;
}

export function CampaignCollaboratorsModal({
  campaign,
  open,
  onClose,
}: CampaignCollaboratorsModalProps) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const collaboratorsQuery = useCollaborators(campaign.id);
  const teamQuery = useTeam(open);

  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState<CampaignAccessRole>("EDITOR");
  const [removingUser, setRemovingUser] = useState<CampaignCollaboratorDto | null>(null);

  const collaborators = collaboratorsQuery.data?.data ?? campaign.collaborators ?? [];
  const team = teamQuery.data?.data ?? [];

  // Current user's rights on this campaign
  const isCreatorOrAdmin =
    user?.role === "FOUNDER" ||
    user?.role === "FOUNDER_OFFICE" ||
    campaign.createdById === user?.id ||
    campaign.createdBy?.id === user?.id ||
    collaborators.some((c) => c.userId === user?.id && c.role === "OWNER");

  // Filter team members who are not already collaborators or creator
  const availableUsers = team.filter(
    (m) =>
      m.id !== campaign.createdById &&
      m.id !== campaign.createdBy?.id &&
      !collaborators.some((c) => c.userId === m.id)
  );

  const addCollaboratorMutation = useMutation({
    mutationFn: (body: { userId: string; role: CampaignAccessRole }) =>
      api.post(`/api/campaigns/${campaign.id}/collaborators`, body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["campaigns", campaign.id] });
      await collaboratorsQuery.refetch();
      setSelectedUserId("");
      toast.success("Collaborator added", "Your teammate now has access to this campaign.");
    },
    onError: (err) => toast.error("Could not add collaborator", errorMessage(err)),
  });

  const removeCollaboratorMutation = useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/api/campaigns/${campaign.id}/collaborators/${userId}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["campaigns", campaign.id] });
      await collaboratorsQuery.refetch();
      setRemovingUser(null);
      toast.success("Collaborator removed");
    },
    onError: (err) => toast.error("Could not remove collaborator", errorMessage(err)),
  });

  const handleAdd = () => {
    if (!selectedUserId) return;
    addCollaboratorMutation.mutate({ userId: selectedUserId, role: selectedRole });
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="Campaign Team & Collaborators"
        description="Manage who can view, edit, or coordinate this campaign."
        footer={
          <Button onClick={onClose} variant="secondary">
            Done
          </Button>
        }
      >
        <div className="space-y-6 text-[13px]">
          {/* Owner section */}
          <div className="rounded-xl border border-line bg-surface-muted/40 p-3.5">
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-subtle mb-2">
              Campaign Owner
            </p>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-slate-900 text-xs font-bold text-white shadow-xs">
                  {initials(campaign.createdBy?.name || "FocusRealm")}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">
                    {campaign.createdBy?.name || "FocusRealm Organizer"}
                  </p>
                  <p className="text-2xs text-ink-subtle">Primary Creator & Lead</p>
                </div>
              </div>
              <Badge tone="brand">Owner</Badge>
            </div>
          </div>

          {/* Add collaborator form (only if admin/creator) */}
          {isCreatorOrAdmin && (
            <div className="rounded-xl border border-line/80 bg-surface p-4 space-y-3.5 shadow-xs">
              <div className="flex items-center gap-2 text-ink font-semibold text-xs">
                <UserPlus className="h-4 w-4 text-brand" />
                <span>Invite Teammate to Campaign</span>
              </div>
              {availableUsers.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-12 items-end">
                  <div className="sm:col-span-7">
                    <SelectField
                      label="Select Teammate"
                      value={selectedUserId}
                      onChange={(e) => setSelectedUserId(e.target.value)}
                      options={[
                        { value: "", label: "Choose team member..." },
                        ...availableUsers.map((m) => ({
                          value: m.id,
                          label: `${m.name} (${m.email})`,
                        })),
                      ]}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <SelectField
                      label="Permission"
                      value={selectedRole}
                      onChange={(e) => setSelectedRole(e.target.value as CampaignAccessRole)}
                      options={[
                        { value: "EDITOR", label: "Editor (Can edit)" },
                        { value: "VIEWER", label: "Viewer (Read-only)" },
                      ]}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Button
                      variant="primary"
                      className="w-full justify-center"
                      disabled={!selectedUserId}
                      loading={addCollaboratorMutation.isPending}
                      onClick={handleAdd}
                    >
                      Add
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-ink-subtle">
                  All active team members already have access or are collaborating on this campaign.
                </p>
              )}
            </div>
          )}

          {/* Collaborator List */}
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-subtle mb-2.5">
              Collaborators ({collaborators.length})
            </p>
            {collaboratorsQuery.isPending ? (
              <p className="text-xs text-ink-subtle py-3 text-center">Loading collaborators...</p>
            ) : collaborators.length > 0 ? (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface overflow-hidden">
                {collaborators.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 p-3.5 hover:bg-surface-muted/30 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs font-medium text-ink-muted">
                        {initials(c.userName)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink text-xs">{c.userName}</p>
                        <p className="truncate text-2xs text-ink-subtle">{c.userEmail}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <Badge tone={c.role === "OWNER" ? "brand" : c.role === "EDITOR" ? "success" : "neutral"}>
                        {c.role === "OWNER" ? "Owner" : c.role === "EDITOR" ? "Editor" : "Viewer"}
                      </Badge>
                      {isCreatorOrAdmin && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-ink-muted hover:text-danger"
                          title="Remove collaborator"
                          onClick={() => setRemovingUser(c)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-ink-subtle">
                <Users className="h-5 w-5 mx-auto mb-1 text-ink-faint" />
                No additional collaborators yet. Invite teammates to share and coordinate this campaign.
              </div>
            )}
          </div>
        </div>
      </Dialog>

      {/* Remove confirmation dialog */}
      {removingUser && (
        <ConfirmDialog
          open
          onClose={() => setRemovingUser(null)}
          onConfirm={() => removeCollaboratorMutation.mutate(removingUser.userId)}
          loading={removeCollaboratorMutation.isPending}
          tone="danger"
          title={`Remove ${removingUser.userName}?`}
          description="They will no longer have access to view or edit this campaign unless re-invited."
          confirmLabel="Remove Collaborator"
        />
      )}
    </>
  );
}
