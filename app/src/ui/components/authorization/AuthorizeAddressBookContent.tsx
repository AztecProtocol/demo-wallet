import { useContext, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Checkbox from "@mui/material/Checkbox";
import TextField from "@mui/material/TextField";
import FormControlLabel from "@mui/material/FormControlLabel";
import { WalletContext } from "../../renderer";
import type { Aliased } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AuthorizationItem } from "../../../wallet/types/authorization";

type SelectedContact = {
  address: string;
  alias: string;
  originalAlias: string;
  selected: boolean;
};

interface AuthorizeAddressBookContentProps {
  request: AuthorizationItem;
  onContactsChange?: (contacts: any[]) => void;
  showAppId?: boolean;
}

export function AuthorizeAddressBookContent({
  request,
  onContactsChange,
  showAppId = true,
}: AuthorizeAddressBookContentProps) {
  const [contacts, setContacts] = useState<SelectedContact[]>([]);
  const { walletAPI } = useContext(WalletContext);

  useEffect(() => {
    const loadContacts = async () => {
      const allContacts: Aliased<AztecAddress>[] = await walletAPI.getAddressBook();
      setContacts(
        allContacts.map((contact) => ({
          address: contact.item.toString(),
          alias: contact.alias,
          originalAlias: contact.alias,
          selected: false,
        }))
      );
    };
    loadContacts();
  }, []);

  // Notify parent when contacts change
  useEffect(() => {
    if (onContactsChange) {
      const selectedContacts = contacts
        .filter((contact) => contact.selected)
        .map((contact) => ({
          item: contact.address,
          alias: contact.alias,
        }));
      onContactsChange(selectedContacts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts]); // Only depend on contacts, not onContactsChange to avoid infinite loop

  const handleToggleContact = (index: number) => {
    setContacts((prev) =>
      prev.map((contact, i) =>
        i === index ? { ...contact, selected: !contact.selected } : contact
      )
    );
  };

  const handleAliasChange = (index: number, newAlias: string) => {
    setContacts((prev) =>
      prev.map((contact, i) => (i === index ? { ...contact, alias: newAlias } : contact))
    );
  };

  return (
    <>
      {showAppId && (
        <>
          <Typography variant="body1" gutterBottom>
            App <strong>{request.appId}</strong> is requesting access to your
            address book.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Select which contacts to share. You can also customize the aliases
            that will be visible to the app.
          </Typography>
        </>
      )}

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {contacts.map((contact, index) => (
          <Box
            key={contact.address}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              p: 2,
              border: 1,
              borderColor: contact.selected ? "primary.main" : "divider",
              borderRadius: 1,
              bgcolor: contact.selected
                ? "action.hover"
                : "background.paper",
            }}
          >
            <FormControlLabel
              control={
                <Checkbox
                  checked={contact.selected}
                  onChange={() => handleToggleContact(index)}
                />
              }
              label=""
              sx={{ m: 0 }}
            />
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {contact.address}
              </Typography>
              {contact.selected ? (
                <TextField
                  size="small"
                  value={contact.alias}
                  onChange={(e) => handleAliasChange(index, e.target.value)}
                  label="Alias (visible to app)"
                  fullWidth
                  sx={{ mt: 1 }}
                />
              ) : (
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  {contact.originalAlias}
                </Typography>
              )}
            </Box>
          </Box>
        ))}
      </Box>

      {contacts.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          No contacts available. Please add contacts to your address book first.
        </Typography>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        This authorization will be remembered. You can revoke it later from the
        Authorized Apps settings.
      </Typography>
    </>
  );
}
