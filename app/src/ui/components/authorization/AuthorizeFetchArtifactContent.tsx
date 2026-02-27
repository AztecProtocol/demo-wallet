import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import type { AuthorizationItem } from "../../../wallet/types/authorization";

interface AuthorizeFetchArtifactContentProps {
  request: AuthorizationItem;
  showAppId?: boolean;
}

/**
 * Content component for the "fetchArtifact" authorization dialog.
 * Shown when the wallet needs to fetch a contract artifact from AztecScan
 * because it's not available locally in PXE.
 */
export function AuthorizeFetchArtifactContent({
  request,
  showAppId = true,
}: AuthorizeFetchArtifactContentProps) {
  const contractClassId = request.params.contractClassId || "Unknown";
  const version = request.params.version ?? 1;
  const source = request.params.source || "AztecScan";
  const reason = request.params.reason || "Contract artifact not found locally";

  return (
    <>
      {showAppId && (
        <Typography variant="body1" gutterBottom>
          The wallet needs to fetch a contract artifact from an external source.
        </Typography>
      )}
      <Box
        sx={{
          mt: 2,
          p: 2,
          bgcolor: "background.default",
          borderRadius: 1,
        }}
      >
        <Typography variant="caption" color="text.secondary">
          Reason:
        </Typography>
        <Typography
          variant="body2"
          sx={{
            fontWeight: "medium",
            mt: 0.5,
            mb: 2,
          }}
        >
          {reason}
        </Typography>

        <Typography variant="caption" color="text.secondary">
          Contract Class ID:
        </Typography>
        <Typography
          variant="body2"
          sx={{
            wordBreak: "break-all",
            fontFamily: "monospace",
            mt: 0.5,
            mb: 2,
          }}
        >
          {contractClassId}
        </Typography>

        <Typography variant="caption" color="text.secondary">
          Version:
        </Typography>
        <Typography
          variant="body2"
          sx={{
            mt: 0.5,
            mb: 2,
          }}
        >
          {version}
        </Typography>

        <Box
          sx={{
            mt: 2,
            pt: 2,
            borderTop: "1px solid",
            borderColor: "divider",
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <CloudDownloadIcon
            sx={{ fontSize: 18, color: "info.main" }}
          />
          <Typography variant="caption" color="info.main">
            Source: {source}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {" "}
          </Typography>
          <Link
            href={`https://aztecscan.xyz`}
            target="_blank"
            rel="noopener noreferrer"
            variant="caption"
            sx={{ textDecoration: "none" }}
          >
            View on AztecScan
          </Link>
        </Box>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        The artifact contains the contract's ABI (function signatures, parameter
        types) and is needed to decode transactions and interact with this
        contract. If approved, the artifact will be fetched from {source} and
        registered in your wallet for future use.
      </Typography>
    </>
  );
}
