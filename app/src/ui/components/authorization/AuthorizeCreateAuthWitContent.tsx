import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import type { AuthorizationItem } from "../../../wallet/types/authorization";

interface AuthorizeCreateAuthWitContentProps {
  request: AuthorizationItem;
  showAppId?: boolean;
}

export function AuthorizeCreateAuthWitContent({
  request,
  showAppId = true,
}: AuthorizeCreateAuthWitContentProps) {
  const params = request.params as any;
  const displayData = params;

  return (
    <>
      {showAppId && (
        <>
          <Typography variant="body1" gutterBottom>
            App <strong>{request.appId}</strong> is requesting to create an
            authorization witness.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This allows the app to gather a signed authorization that can be
            used to perform actions on your behalf.
          </Typography>
        </>
      )}

      <Alert severity="warning" sx={{ mb: 2 }}>
        <Typography variant="body2" fontWeight="bold" gutterBottom>
          Security Warning
        </Typography>
        <Typography variant="body2">
          Creating an authorization witness gives the app permission to execute
          specific actions on your behalf. Only approve if you trust this app
          and understand what it will be authorized to do.
        </Typography>
      </Alert>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Box>
          <Typography variant="subtitle2" color="text.secondary">
            From Account
          </Typography>
          <Typography
            variant="body2"
            sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
          >
            {displayData.from}
          </Typography>
        </Box>

        {displayData.type === "hash" ? (
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Authorization Type
            </Typography>
            <Chip label="Message Hash" size="small" sx={{ mt: 0.5 }} />
            <Typography
              variant="caption"
              sx={{
                display: "block",
                mt: 1,
                fontFamily: "monospace",
                wordBreak: "break-all",
                color: "text.secondary",
              }}
            >
              Hash: {displayData.hash}
            </Typography>
          </Box>
        ) : (
          <>
            <Box>
              <Typography variant="subtitle2" color="text.secondary">
                Authorization Type
              </Typography>
              <Chip label="Call Intent" size="small" color="primary" sx={{ mt: 0.5 }} />
            </Box>

            {displayData.call && (
              <>
                <Box>
                  <Typography variant="subtitle2" color="text.secondary">
                    Caller (Who can use this authorization)
                  </Typography>
                  <Typography variant="body2" fontWeight="bold">
                    {displayData.call.callerAlias}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ fontFamily: "monospace", color: "text.secondary" }}
                  >
                    {displayData.call.caller}
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="subtitle2" color="text.secondary">
                    Contract
                  </Typography>
                  <Typography variant="body2" fontWeight="bold">
                    {displayData.call.contractName}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ fontFamily: "monospace", color: "text.secondary" }}
                  >
                    {displayData.call.contract}
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="subtitle2" color="text.secondary">
                    Function
                  </Typography>
                  <Typography variant="body2" fontWeight="bold">
                    {displayData.call.function}
                  </Typography>
                </Box>

                {displayData.call.args && displayData.call.args.length > 0 && (
                  <Box>
                    <Typography variant="subtitle2" color="text.secondary">
                      Arguments
                    </Typography>
                    <Box
                      sx={{
                        mt: 1,
                        p: 1,
                        bgcolor: "background.default",
                        borderRadius: 1,
                        maxHeight: 200,
                        overflow: "auto",
                      }}
                    >
                      {displayData.call.args.map((arg: string, index: number) => (
                        <Typography
                          key={index}
                          variant="caption"
                          sx={{
                            display: "block",
                            fontFamily: "monospace",
                            wordBreak: "break-all",
                          }}
                        >
                          {index}: {arg}
                        </Typography>
                      ))}
                    </Box>
                  </Box>
                )}
              </>
            )}
          </>
        )}
      </Box>

      <Alert severity="info" sx={{ mt: 2 }}>
        <Typography variant="body2">
          This authorization is <strong>NOT persistent</strong>. Each
          authorization witness requires separate approval.
        </Typography>
      </Alert>
    </>
  );
}
