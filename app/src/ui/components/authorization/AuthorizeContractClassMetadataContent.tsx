import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import type { AuthorizationItem } from "../../../wallet/types/authorization";

interface AuthorizeContractClassMetadataContentProps {
  request: AuthorizationItem;
  showAppId?: boolean;
}

export function AuthorizeContractClassMetadataContent({
  request,
  showAppId = true,
}: AuthorizeContractClassMetadataContentProps) {
  const params = request.params as any;
  const displayData = params;

  return (
    <>
      {showAppId && (
        <>
          <Typography variant="body1" gutterBottom>
            App <strong>{request.appId}</strong> is requesting contract class
            metadata information.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This reveals whether you have a specific contract artifact
            registered in your wallet.
          </Typography>
        </>
      )}

      <Alert severity="warning" sx={{ mb: 2 }}>
        <Typography variant="body2" fontWeight="bold" gutterBottom>
          Privacy Notice
        </Typography>
        <Typography variant="body2">
          Revealing artifact registration status discloses information about
          which contracts you can interact with. Only grant this permission to
          apps you trust.
        </Typography>
      </Alert>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Box>
          <Typography variant="subtitle2" color="text.secondary">
            Contract Class ID
          </Typography>
          <Typography
            variant="body2"
            sx={{
              fontFamily: "monospace",
              wordBreak: "break-all",
            }}
          >
            {displayData.contractClassId}
          </Typography>
        </Box>

        {displayData.artifactName && (
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Artifact Name
            </Typography>
            <Typography variant="body2" fontWeight="bold">
              {displayData.artifactName}
            </Typography>
          </Box>
        )}

        <Box>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Information that will be revealed:
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              {displayData.isArtifactRegistered ? (
                <CheckCircleIcon fontSize="small" color="success" />
              ) : (
                <CancelIcon fontSize="small" color="error" />
              )}
              <Typography variant="body2">
                Artifact {displayData.isArtifactRegistered ? "is" : "is not"}{" "}
                registered in wallet
              </Typography>
            </Box>

            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              {displayData.isPubliclyRegistered ? (
                <CheckCircleIcon fontSize="small" color="success" />
              ) : (
                <CancelIcon fontSize="small" color="error" />
              )}
              <Typography variant="body2">
                Contract class{" "}
                {displayData.isPubliclyRegistered ? "is" : "is not"}{" "}
                publicly registered on-chain
              </Typography>
            </Box>
          </Box>
        </Box>

        {displayData.isArtifactRegistered && displayData.artifactName && (
          <Alert severity="success" icon={<CheckCircleIcon />}>
            <Typography variant="body2">
              You have the <strong>{displayData.artifactName}</strong> artifact
              registered, which allows you to interact with contracts of this
              class.
            </Typography>
          </Alert>
        )}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        This authorization can be made persistent for this specific contract
        class. You can revoke it later from the Authorized Apps settings.
      </Typography>
    </>
  );
}
