import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Upload } from "lucide-react";
import { useTitle } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { PageHeader, Tabs } from "../../components/ui/Navigation";
import { Button, ButtonLink } from "../../components/ui/Button";
import { ContactsTable } from "../../components/contacts/ContactsTable";
import { NewContactDialog } from "../../components/contacts/ContactDialogs";
import { ListsPage } from "./ListsPage";

export function ContactsPage() {
  useTitle("Contacts");
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "lists" ? "lists" : "contacts";
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader
        title="Contacts"
        description="Manage the people and audiences used in your campaigns."
        actions={
          can("contacts.manage") && (
            <>
              {view === "lists" ? (
                <ButtonLink to="/contacts/import" variant="primary" icon={<Upload className="h-4 w-4" />}>Import</ButtonLink>
              ) : (
                <>
                  <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add contact</Button>
                  <ButtonLink to="/contacts/import" variant="primary" icon={<Upload className="h-4 w-4" />}>Import</ButtonLink>
                </>
              )}
            </>
          )
        }
      />
      <Tabs
        className="mb-5"
        active={view}
        onChange={(next) => setParams(next === "contacts" ? {} : { view: next }, { replace: true })}
        tabs={[
          { key: "contacts", label: "All contacts" },
          { key: "lists", label: "Lists" },
        ]}
      />
      {view === "lists" ? (
        <ListsPage embedded />
      ) : (
        <ContactsTable emptyAction={can("contacts.manage") && <ButtonLink to="/contacts/import" variant="primary">Import contacts</ButtonLink>} />
      )}
      <NewContactDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
