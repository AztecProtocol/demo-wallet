import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import type { AuthorizationItem } from "../../../wallet/types/authorization";

interface AuthorizeContractMetadataContentProps {
  request: AuthorizationItem;
  showAppId?: boolean;
}

export function AuthorizeContractMetadataContent({
  request,
  showAppId = true,
}: AuthorizeContractMetadataContentProps) {
  const params = request.params as any;
  const displayData = params;

  return (
    <>
      {showAppId && (
        <>
          <Typography variant="body1" gutterBottom>
            App <strong>{request.appId}</strong> is requesting contract metadata
            information.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This reveals whether you have a specific contract registered in your
            wallet.
          </Typography>
        </>
      )}

      <Alert severity="warning" sx={{ mb: 2 }}>
        <Typography variant="body2" fontWeight="bold" gutterBottom>
          Privacy Notice
        </Typography>
        <Typography variant="body2">
          Revealing contract registration status discloses information about
          your interactions and interests. Only grant this permission to apps
          you trust.
        </Typography>
      </Alert>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Box>
          <Typography variant="subtitle2" color="text.secondary">
            Contract
          </Typography>
          <Typography variant="body2" fontWeight="bold">
            {displayData.contractName || "Unknown Contract"}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              display: "block",
              fontFamily: "monospace",
              color: "text.secondary",
              wordBreak: "break-all",
            }}
          >
            {displayData.address}
          </Typography>
        </Box>

        <Box>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Information that will be revealed:
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              {displayData.isRegistered ? (
                <CheckCircleIcon fontSize="small" color="success" />
              ) : (
                <CancelIcon fontSize="small" color="error" />
              )}
              <Typography variant="body2">
                Contract {displayData.isRegistered ? "is" : "is not"} registered
                in wallet
              </Typography>
            </Box>

            {displayData.isRegistered && (
              <>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {displayData.isInitialized ? (
                    <CheckCircleIcon fontSize="small" color="success" />
                  ) : (
                    <CancelIcon fontSize="small" color="error" />
                  )}
                  <Typography variant="body2">
                    Contract {displayData.isInitialized ? "is" : "is not"}{" "}
                    initialized
                  </Typography>
                </Box>

                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {displayData.isPublished ? (
                    <CheckCircleIcon fontSize="small" color="success" />
                  ) : (
                    <CancelIcon fontSize="small" color="error" />
                  )}
                  <Typography variant="body2">
                    Instance {displayData.isPublished ? "is" : "is not"}{" "}
                    published on-chain
                  </Typography>
                </Box>
              </>
            )}
          </Box>
        </Box>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        This authorization can be made persistent for this specific contract.
        You can revoke it later from the Authorized Apps settings.
      </Typography>
    </>
  );
}
