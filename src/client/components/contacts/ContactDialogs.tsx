// Create contact, add to list, and new list dialogs
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, errorMessage } from "../../lib/api";
import { useInvalidate, useLists } from "../../lib/queries";
import { plural } from "../../lib/format";
import { Button } from "../ui/Button";
import { SelectField, TextAreaField, TextField } from "../ui/Field";
import { Callout } from "../ui/Feedback";
import { Dialog } from "../ui/Overlay";
import { useToast } from "../ui/Toast";
import { ContactBatchInputSchema, type ContactDto, type ContactListDto } from "@shared/types";

export function NewListDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (list: ContactListDto) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isShared, setIsShared] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => api.post<ContactListDto>("/api/lists", { name, description: description || null, isShared }),
    onSuccess: async (res) => {
      await invalidate("lists");
      toast.success("List created", res.data.name);
      setName("");
      setDescription("");
      setIsShared(false);
      onCreated?.(res.data);
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!create.isPending}
      title="New list"
      description="Lists are the audiences you send campaigns to. A contact can be in many lists."
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={() => create.mutate()} disabled={!name.trim()} loading={create.isPending}>Create list</Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Goa boutique hotels" data-autofocus />
        <TextAreaField label="Description" optional value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <label className="flex items-start gap-2 text-[13px] text-ink-muted">
          <input type="checkbox" checked={isShared} onChange={(event) => setIsShared(event.target.checked)} className="mt-0.5 accent-brand" />
          <span>Share this list with the organization</span>
        </label>
        {create.isError && <Callout tone="danger">{errorMessage(create.error)}</Callout>}
      </div>
    </Dialog>
  );
}

export function AddToListDialog({ contactIds, onClose, onDone }: { contactIds: string[]; onClose: () => void; onDone: () => void }) {
  const lists = useLists();
  const [listId, setListId] = useState("");
  const [creating, setCreating] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();
  const add = useMutation({
    mutationFn: () => api.post<{ added: number; alreadyMembers: number }>(`/api/lists/${listId}/members`, { contactIds }),
    onSuccess: async (res) => {
      await invalidate("lists", "contacts");
      const name = lists.data?.data.find((l) => l.id === listId)?.name;
      toast.success(`Added to ${name}`, `${plural(res.data.added, "contact")} added${res.data.alreadyMembers ? `, ${res.data.alreadyMembers} already there` : ""}.`);
      onDone();
    },
  });
  if (creating) return <NewListDialog open onClose={() => setCreating(false)} onCreated={(l) => setListId(l.id)} />;
  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!add.isPending}
      title={`Add ${plural(contactIds.length, "contact")} to a list`}
      footer={
        <>
          <Button onClick={onClose} disabled={add.isPending}>Cancel</Button>
          <Button variant="primary" onClick={() => add.mutate()} disabled={!listId} loading={add.isPending}>Add to list</Button>
        </>
      }
    >
      <div className="space-y-3">
        <SelectField
          label="List"
          value={listId}
          onChange={(e) => setListId(e.target.value)}
          placeholder={lists.isPending ? "Loading…" : "Choose a list"}
          options={(lists.data?.data ?? []).map((l) => ({ value: l.id, label: `${l.name} (${plural(l.memberCount, "contact")})` }))}
        />
        <button className="link text-[13px]" onClick={() => setCreating(true)}>Create a new list</button>
        {add.isError && <Callout tone="danger">{errorMessage(add.error)}</Callout>}
      </div>
    </Dialog>
  );
}

export function NewContactDialog({ open, onClose, defaultListId }: { open: boolean; onClose: () => void; defaultListId?: string }) {
  const empty = { email: "", firstName: "", lastName: "", company: "", title: "", phone: "" };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const invalidate = useInvalidate();
  const toast = useToast();
  const create = useMutation({
    mutationFn: (body: unknown) => api.post<ContactDto[]>("/api/contacts/bulk", body),
    onSuccess: async (res) => {
      await invalidate("contacts", "lists");
      toast.success(`${plural(res.data.length, "contact")} saved`, res.data.map((contact) => contact.email).join(", "));
      setForm(empty);
      onClose();
    },
  });
  const submit = () => {
    const emails = form.email.split(/[,\n;]+/).map((email) => email.trim()).filter(Boolean);
    const parsed = ContactBatchInputSchema.safeParse({
      emails,
      firstName: form.firstName,
      lastName: form.lastName,
      company: form.company,
      title: form.title,
      phone: form.phone,
      listIds: defaultListId ? [defaultListId] : [],
    });
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setErrors({
        ...Object.fromEntries(Object.entries(fieldErrors).map(([k, v]) => [k === "emails" ? "email" : k, v?.[0]])),
        ...(emails.length === 0 ? { email: "Enter at least one email address." } : {}),
      });
      return;
    }
    setErrors({});
    create.mutate({ ...parsed.data, listIds: defaultListId ? [defaultListId] : [] });
  };
  const field = (key: keyof typeof empty, label: string, extra?: { optional?: boolean; type?: string }) => (
    <TextField label={label} type={extra?.type} optional={extra?.optional} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} error={errors[key]} />
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!create.isPending}
      title="Add a contact"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>Add contact</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField
            label="Email addresses"
            hint="Enter one or more addresses, separated by commas, semicolons, or new lines. Each address becomes a separate contact."
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            error={errors.email}
            placeholder="alex@example.com, alex.work@example.com"
            autoComplete="email"
          />
        </div>
        {field("firstName", "First name", { optional: true })}
        {field("lastName", "Last name", { optional: true })}
        {field("company", "Company", { optional: true })}
        {field("title", "Job title", { optional: true })}
        {field("phone", "Phone", { optional: true })}
        {create.isError && <Callout tone="danger" className="sm:col-span-2">{errorMessage(create.error)}</Callout>}
      </div>
    </Dialog>
  );
}
