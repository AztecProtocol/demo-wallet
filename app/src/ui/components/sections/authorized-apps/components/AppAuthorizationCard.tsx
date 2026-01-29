import { useContext, useEffect, useState, useMemo, useRef } from "react";
import {
  Card,
  CardContent,
  Typography,
  Box,
  IconButton,
  Tooltip,
  Alert,
} from "@mui/material";
import {
  Apps as AppsIcon,
  Block as RevokeIcon,
} from "@mui/icons-material";
import { WalletContext } from "../../../../renderer";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { GrantedCapability, AppCapabilities, CAPABILITY_VERSION } from "@aztec/aztec.js/wallet";
import type { AuthorizationItem } from "../../../../../wallet/types/authorization";
import { AuthorizeCapabilitiesContent } from "../../../authorization/AuthorizeCapabilitiesContent";

interface AppAuthorizationCardProps {
  appId: string;
  onRevoke: (appId: string) => Promise<void>;
  onUpdate: () => Promise<void>;
}

export function AppAuthorizationCard({
  appId,
  onRevoke,
  onUpdate,
}: AppAuthorizationCardProps) {
  const { walletAPI } = useContext(WalletContext);
  const [capabilities, setCapabilities] = useState<GrantedCapability[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadCapabilities();
  }, [appId]);

  useEffect(() => {
    // Cleanup: clear any pending save on unmount
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const loadCapabilities = async () => {
    try {
      setLoading(true);
      const caps = await walletAPI.getAppCapabilities(appId);
      setCapabilities(caps);
      console.log("[AppAuthorizationCard] Loaded capabilities:", caps);
    } catch (err) {
      console.error("Failed to load app capabilities:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (
      !confirm(
        `Are you sure you want to revoke all authorizations for ${appId}? The app will need to request authorization again.`
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

  const handleCapabilitiesChange = (data: {
    granted: GrantedCapability[];
    mode: "strict" | "permissive";
    duration: number;
  }) => {
    console.log("[AppAuthorizationCard] handleCapabilitiesChange called with:", {
      appId,
      grantedCount: data.granted.length,
      granted: data.granted,
      mode: data.mode,
      duration: data.duration,
    });

    // Clear any pending save
    if (saveTimeoutRef.current) {
      console.log("[AppAuthorizationCard] Clearing previous timeout");
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce: save after 500ms of no changes
    console.log("[AppAuthorizationCard] Setting up debounced save (500ms)");
    saveTimeoutRef.current = setTimeout(async () => {
      console.log("[AppAuthorizationCard] Debounced save firing now");
      try {
        setSaving(true);

        // Create manifest for the granted capabilities
        const manifest: AppCapabilities = {
          version: "1.0" as typeof CAPABILITY_VERSION,
          metadata: {
            name: appId,
            version: "1.0.0",
          },
          capabilities: data.granted,
        };

        console.log("[AppAuthorizationCard] Calling storeCapabilityGrants with:", {
          appId,
          grantedCount: data.granted.length,
          granted: data.granted,
        });

        await walletAPI.storeCapabilityGrants(appId, manifest, data.granted);
        console.log("[AppAuthorizationCard] storeCapabilityGrants completed successfully");
      } catch (err) {
        console.error("[AppAuthorizationCard] Failed to save capabilities:", err);
        alert(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSaving(false);
      }
    }, 500);
  };


  // Create a fake AuthorizationItem to pass to AuthorizeCapabilitiesContent
  // Only create when we have capabilities loaded
  const fakeRequest = useMemo<AuthorizationItem | null>(() => {
    if (loading || capabilities.length === 0) {
      return null;
    }

    const manifest: AppCapabilities = {
      version: "1.0" as typeof CAPABILITY_VERSION,
      metadata: {
        name: appId,
        version: "1.0.0",
      },
      capabilities: capabilities,
    };

    return {
      id: "view-granted",
      appId,
      method: "requestCapabilities",
      params: {
        manifest,
        newCapabilityIndices: [],
        contractNames: {},
        existingGrants: {},
      },
      timestamp: Date.now(),
    };
  }, [loading, capabilities, appId]);

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
        ) : capabilities.length === 0 ? (
          <Alert severity="warning">
            No authorizations found for this app
          </Alert>
        ) : fakeRequest ? (
          <AuthorizeCapabilitiesContent
            request={fakeRequest}
            onCapabilitiesChange={handleCapabilitiesChange}
            showAppId={false}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
