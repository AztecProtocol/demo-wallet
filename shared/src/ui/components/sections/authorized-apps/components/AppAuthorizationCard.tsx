import { useContext, useEffect, useState, useRef, useCallback } from "react";
import { Card, CardContent, Typography, Box, IconButton, Tooltip, Alert } from "@mui/material";
import { Apps as AppsIcon, Block as RevokeIcon } from "@mui/icons-material";
import { WalletContext } from "../../../../renderer";
import type {
  GrantedCapability,
  AppCapabilities,
  CAPABILITY_VERSION,
  Capability,
} from "@aztec/aztec.js/wallet";
import type {
  AuthorizationItem,
  RequestCapabilitiesParams,
} from "../../../../../wallet/types/authorization";
import { AuthorizeCapabilitiesContent } from "../../../authorization/AuthorizeCapabilitiesContent";

interface AppAuthorizationCardProps {
  appId: string;
  onRevoke: (appId: string) => Promise<void>;
}

/**
 * Extract all contract addresses from a list of capabilities.
 */
function extractContractAddresses(caps: GrantedCapability[]): string[] {
  const addresses = new Set<string>();
  for (const cap of caps) {
    if (cap.type === "contracts" && cap.contracts !== "*") {
      for (const addr of cap.contracts) addresses.add(addr.toString());
    }
    if (cap.type === "simulation") {
      for (const scope of [cap.transactions, cap.utilities]) {
        if (scope && scope.scope !== "*") {
          for (const p of scope.scope) {
            if (p.contract !== "*") addresses.add(p.contract.toString());
          }
        }
      }
    }
    if (cap.type === "transaction" && cap.scope !== "*") {
      for (const p of cap.scope) {
        if (p.contract !== "*") addresses.add(p.contract.toString());
      }
    }
    if (cap.type === "data" && cap.privateEvents?.contracts !== "*") {
      for (const addr of cap.privateEvents?.contracts ?? []) {
        addresses.add(addr.toString());
      }
    }
  }
  return [...addresses];
}

export function AppAuthorizationCard({ appId, onRevoke }: AppAuthorizationCardProps) {
  const { walletAPI } = useContext(WalletContext);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fakeRequest, setFakeRequest] =
    useState<AuthorizationItem<RequestCapabilitiesParams> | null>(null);
  // Track granted capabilities for diffing in handleCapabilitiesChange, but don't
  // use as a useEffect dependency to avoid re-render loops.
  const grantedRef = useRef<GrantedCapability[]>([]);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadCapabilities();
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [appId]);

  const loadCapabilities = async () => {
    try {
      setLoading(true);
      const result = await walletAPI.getAppCapabilities(appId);
      grantedRef.current = result.granted;

      // Resolve contract names from all requested capabilities
      const addresses = extractContractAddresses(result.requested);
      const resolvedNames =
        addresses.length > 0 ? await walletAPI.resolveContractNames(addresses) : {};

      // Build existingGrants from currently-granted capabilities
      const existingGrants: Record<string, boolean> = {};
      for (const capability of result.granted) {
        const keys = await walletAPI.capabilityToStorageKeys(capability);
        for (const key of keys) {
          existingGrants[key] = true;
        }
      }

      // Build the fake request once with all data
      if (result.requested.length > 0) {
        // Merge granted account data into the requested capabilities so the
        // UI initialises checkboxes from the *currently granted* accounts
        // rather than from the (cumulative) requested list.
        const grantedAccountsCap = result.granted.find((c) => c.type === "accounts") as
          | (GrantedCapability & { accounts?: unknown[] })
          | undefined;

        const mergedCapabilities = result.requested.map((cap) => {
          if (cap.type === "accounts" && grantedAccountsCap) {
            return { ...cap, accounts: grantedAccountsCap.accounts ?? [] };
          }
          return cap;
        });

        const manifest: AppCapabilities = {
          version: "1.0" as typeof CAPABILITY_VERSION,
          metadata: { name: appId, version: "1.0.0" },
          capabilities: mergedCapabilities as unknown as Capability[],
        };

        setFakeRequest({
          id: "view-granted",
          appId,
          method: "requestCapabilities",
          params: {
            manifest,
            newCapabilityIndices: [],
            contractNames: resolvedNames,
            existingGrants,
            isAppFirstTime: false,
          },
          timestamp: Date.now(),
        });
      } else {
        setFakeRequest(null);
      }
    } catch (err) {
      console.error("Failed to load app capabilities:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (
      !confirm(
        `Are you sure you want to revoke all authorizations for ${appId}? The app will need to request authorization again.`,
      )
    ) {
      return;
    }

    try {
      setRevoking(true);
      await onRevoke(appId);
    } catch (err) {
      console.error("Failed to revoke:", err);
    } finally {
      setRevoking(false);
    }
  };

  const handleCapabilitiesChange = useCallback(
    (data: { granted: GrantedCapability[]; mode: "strict" | "permissive"; duration: number }) => {
      // Clear any pending save
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      // Debounce: save after 500ms of no changes
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          setSaving(true);

          // Build old and new key sets for diffing
          const oldGrantedKeys = new Set<string>();
          for (const cap of grantedRef.current) {
            const keys = await walletAPI.capabilityToStorageKeys(cap);
            for (const key of keys) oldGrantedKeys.add(key);
          }

          const newGrantedKeys = new Set<string>();
          for (const cap of data.granted) {
            const keys = await walletAPI.capabilityToStorageKeys(cap);
            for (const key of keys) newGrantedKeys.add(key);
          }

          // Delete individual keys that were removed (not entire capabilities)
          for (const key of oldGrantedKeys) {
            if (!newGrantedKeys.has(key)) {
              await walletAPI.revokeAuthorization(`${appId}:${key}`);
            }
          }

          // Store all newly granted capabilities (additive upsert).
          // This also overwrites capability data blobs (e.g. account lists).
          if (data.granted.length > 0) {
            await walletAPI.storeCapabilityGrants(appId, data.granted);
          }

          // Update ref (not state — no re-render needed)
          grantedRef.current = data.granted;
        } catch (err) {
          console.error("[AppAuthorizationCard] Failed to save capabilities:", err);
          alert(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setSaving(false);
        }
      }, 500);
    },
    [appId, walletAPI],
  );

  return (
    <Card sx={{ width: "100%", position: "relative" }}>
      <CardContent>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            mb: 2,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <AppsIcon color="primary" />
            <Typography variant="h6">{appId}</Typography>
          </Box>
          <Box sx={{ display: "flex", gap: 1 }}>
            <Tooltip title="Revoke All Authorizations">
              <IconButton
                size="small"
                color="error"
                onClick={handleRevoke}
                disabled={loading || revoking || saving}
              >
                <RevokeIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        {loading ? (
          <Typography variant="body2" color="text.secondary">
            Loading...
          </Typography>
        ) : fakeRequest ? (
          <AuthorizeCapabilitiesContent
            request={fakeRequest}
            onCapabilitiesChange={handleCapabilitiesChange}
            showAppId={false}
          />
        ) : (
          <Alert severity="info">No capabilities have been requested by this app yet</Alert>
        )}
      </CardContent>
    </Card>
  );
}
