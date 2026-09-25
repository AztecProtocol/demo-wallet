import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { AuthorizationItem } from "../../../wallet/types/authorization";
import type { ReadableCallAuthorization } from "../../../wallet/decoding/call-authorization-formatter";
import type { DecodedExecutionTrace } from "../../../wallet/decoding/tx-callstack-decoder";
import { ExecutionTraceDisplay } from "../shared/ExecutionTraceDisplay";

interface AuthorizeSendTxContentProps {
  request: AuthorizationItem;
  showAppId?: boolean;
  compact?: boolean;
}

// Reusable content component for displaying sendTx authorization details
export function AuthorizeSendTxContent({
  request,
  showAppId = true,
  compact,
}: AuthorizeSendTxContentProps) {
  const params = request.params as {
    callAuthorizations?: ReadableCallAuthorization[];
    executionTrace?: DecodedExecutionTrace;
    stats?: any;
    from?: string;
    embeddedPaymentMethodFeePayer?: string;
  };
  const callAuthorizations = params.callAuthorizations || [];
  const executionTrace = params.executionTrace;
  const stats = params.stats;
  const from = params.from;
  const embeddedPaymentMethodFeePayer = params.embeddedPaymentMethodFeePayer;

  const isNoFrom =
    from === "NO_FROM" ||
    (from && from.startsWith("0x") && AztecAddress.fromStringUnsafe(from).equals(AztecAddress.ZERO));
  const hasEmbeddedFeePayer = !!embeddedPaymentMethodFeePayer;

  return (
    <>
      {showAppId && (
        <Typography variant={compact ? "body2" : "body1"} gutterBottom>
          App <strong>{request.appId}</strong> wants to execute a transaction that requires your
          authorization.
        </Typography>
      )}

      {(isNoFrom || hasEmbeddedFeePayer) &&
        (compact ? (
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mb: 1 }}>
            {isNoFrom && (
              <Chip
                label="External entrypoint"
                size="small"
                color="info"
                variant="outlined"
                sx={{ height: 18, fontSize: "0.6rem" }}
              />
            )}
            {hasEmbeddedFeePayer && (
              <Chip
                label="App pays fee"
                size="small"
                color="success"
                variant="outlined"
                sx={{ height: 18, fontSize: "0.6rem" }}
              />
            )}
          </Box>
        ) : (
          <>
            {isNoFrom && (
              <Alert severity="info" sx={{ mb: 2 }}>
                This transaction uses an external entrypoint and does not execute from any of your
                accounts.
              </Alert>
            )}
            {hasEmbeddedFeePayer && (
              <Alert severity="success" sx={{ mb: 2 }}>
                The app is providing the fee payment method for this transaction.
              </Alert>
            )}
          </>
        ))}

      {executionTrace && (
        <ExecutionTraceDisplay
          trace={executionTrace}
          callAuthorizations={callAuthorizations}
          stats={stats}
          compact={compact}
        />
      )}

      {!compact && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          By approving, you authorize the app to execute these function calls on your behalf.
        </Typography>
      )}
    </>
  );
}
