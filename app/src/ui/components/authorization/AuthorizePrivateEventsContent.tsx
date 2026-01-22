import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import type { AuthorizationItem } from "../../../wallet/types/authorization";

interface AuthorizePrivateEventsContentProps {
  request: AuthorizationItem;
  showAppId?: boolean;
}

export function AuthorizePrivateEventsContent({
  request,
  showAppId = true,
}: AuthorizePrivateEventsContentProps) {
  const params = request.params as any;
  const displayData = params;

  return (
    <>
      {showAppId && (
        <>
          <Typography variant="body1" gutterBottom>
            App <strong>{request.appId}</strong> is requesting access to your
            private events.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This allows the app to query private events that you have received.
          </Typography>
        </>
      )}

      <Alert severity="info" sx={{ mb: 2 }}>
        <Typography variant="body2" fontWeight="bold" gutterBottom>
          Privacy Notice
        </Typography>
        <Typography variant="body2">
          Private events can contain sensitive information about your
          interactions with contracts. Only grant this permission to apps you
          trust.
        </Typography>
      </Alert>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Box>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Event Details
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
            <Chip label={`${displayData.eventCount || 0} events found`} size="small" />
            {displayData.contract && (
              <Chip
                label={displayData.contract}
                size="small"
                variant="outlined"
              />
            )}
          </Box>
        </Box>

        {displayData.contractName && (
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Contract
            </Typography>
            <Typography variant="body2" fontWeight="bold">
              {displayData.contractName}
            </Typography>
            {displayData.contract && (
              <Typography
                variant="caption"
                sx={{ fontFamily: "monospace", color: "text.secondary" }}
              >
                {displayData.contract}
              </Typography>
            )}
          </Box>
        )}

        {displayData.eventName && (
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Event Type
            </Typography>
            <Typography variant="body2" fontWeight="bold">
              {displayData.eventName}
            </Typography>
          </Box>
        )}

        {displayData.fromBlock !== undefined && (
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Block Range
            </Typography>
            <Typography variant="body2">
              From block: {displayData.fromBlock || "genesis"}
              {displayData.toBlock !== undefined &&
                ` to ${displayData.toBlock}`}
            </Typography>
          </Box>
        )}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        This authorization can be made persistent for this specific event type.
        You can revoke it later from the Authorized Apps settings.
      </Typography>
    </>
  );
}
