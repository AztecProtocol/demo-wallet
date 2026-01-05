import { useContext, useEffect, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Checkbox,
  FormControlLabel,
  TextField,
  List,
  ListItem,
  Alert,
} from "@mui/material";
import { WalletContext } from "../../renderer";

interface EditAddressBookAuthorizationDialogProps {
  open: boolean;
  appId: string;
  currentContacts: Array<{ alias: string; item: string }>;
  onClose: () => void;
  onSave: () => Promise<void>;
}

interface ContactWithSelection {
  address: string;
  originalAlias: string;
  displayAlias: string;
  selected: boolean;
}

export function EditAddressBookAuthorizationDialog({
  open,
  appId,
  currentContacts,
  onClose,
  onSave,
}: EditAddressBookAuthorizationDialogProps) {
  const { walletAPI } = useContext(WalletContext);
  const [allContacts, setAllContacts] = useState<ContactWithSelection[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      loadContacts();
    }
  }, [open, currentContacts]);

  const loadContacts = async () => {
    try {
      setError(null);
      const contacts = await walletAPI.getAddressBook();
      const currentAddresses = new Set(currentContacts.map((c) => c.item));

      const contactsWithSelection = contacts.map((contact) => {
        const isSelected = currentAddresses.has(contact.item.toString());
        const currentContact = currentContacts.find(
          (cc) => cc.item === contact.item.toString()
        );

        return {
          address: contact.item.toString(),
          originalAlias: contact.alias,
          displayAlias: isSelected
            ? currentContact?.alias || contact.alias
            : contact.alias,
          selected: isSelected,
        };
      });

      setAllContacts(contactsWithSelection);
    } catch (err) {
      console.error("Failed to load address book:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleContact = (address: string) => {
    setAllContacts((prev) =>
      prev.map((contact) =>
        contact.address === address ? { ...contact, selected: !contact.selected } : contact
      )
    );
  };

  const handleAliasChange = (address: string, newAlias: string) => {
    setAllContacts((prev) =>
      prev.map((contact) =>
        contact.address === address ? { ...contact, displayAlias: newAlias } : contact
      )
    );
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      const selectedContacts = allContacts
        .filter((contact) => contact.selected)
        .map((contact) => ({
          alias: contact.displayAlias,
          item: contact.address,
        }));

      await walletAPI.updateAddressBookAuthorization(appId, selectedContacts);
      await onSave();
      onClose();
    } catch (err) {
      console.error("Failed to update authorization:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const selectedCount = allContacts.filter((c) => c.selected).length;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit Address Book Authorization for {appId}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Select which contacts this app can access and customize the aliases
          shown to the app.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Selected Contacts: {selectedCount}
        </Typography>

        <List>
          {allContacts.map((contact) => (
            <ListItem
              key={contact.address}
              sx={{
                flexDirection: "column",
                alignItems: "stretch",
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                mb: 1,
                p: 2,
              }}
            >
              <FormControlLabel
                control={
                  <Checkbox
                    checked={contact.selected}
                    onChange={() => handleToggleContact(contact.address)}
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2">
                      {contact.originalAlias}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: "monospace" }}
                    >
                      {contact.address.slice(0, 10)}...
                      {contact.address.slice(-8)}
                    </Typography>
                  </Box>
                }
              />
              {contact.selected && (
                <TextField
                  fullWidth
                  size="small"
                  label="Alias shown to app"
                  value={contact.displayAlias}
                  onChange={(e) =>
                    handleAliasChange(contact.address, e.target.value)
                  }
                  sx={{
                    mt: 1,
                    ml: 4,
                    '& .MuiInputBase-input': {
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }
                  }}
                  helperText="The app will see this contact under this alias"
                />
              )}
            </ListItem>
          ))}
        </List>

        {allContacts.length === 0 && (
          <Alert severity="info">
            No contacts available. Add contacts to your address book first.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
