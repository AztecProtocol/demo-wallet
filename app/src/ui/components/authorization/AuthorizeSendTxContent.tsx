import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Alert from "@mui/material/Alert";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { AuthorizationItem } from "../../../wallet/types/authorization";
import type { ReadableCallAuthorization } from "../../../wallet/decoding/call-authorization-formatter";
import type { DecodedExecutionTrace } from "../../../wallet/decoding/tx-callstack-decoder";
import { ExecutionTraceDisplay } from "../shared/ExecutionTraceDisplay";

interface AuthorizeSendTxContentProps {
  request: AuthorizationItem;
  showAppId?: boolean;
}

// Reusable content component for displaying sendTx authorization details
export function AuthorizeSendTxContent({
  request,
  showAppId = true,
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

  const isFromZero = from && AztecAddress.fromString(from).equals(AztecAddress.ZERO);
  const hasEmbeddedFeePayer = !!embeddedPaymentMethodFeePayer;

  return (
    <>
      {showAppId && (
        <Typography variant="body1" gutterBottom>
          App <strong>{request.appId}</strong> wants to execute a transaction
          that requires your authorization.
        </Typography>
      )}

      {isFromZero && (
        <Alert severity="info" sx={{ mb: 2 }}>
          This request uses the MulticallEntrypoint and does not execute from any of your accounts.
        </Alert>
      )}

      {hasEmbeddedFeePayer && (
        <Alert severity="success" sx={{ mb: 2 }}>
          The app is providing the fee payment method for this transaction.
        </Alert>
      )}

      {executionTrace && (
        <ExecutionTraceDisplay
          trace={executionTrace}
          callAuthorizations={callAuthorizations}
          stats={stats}
        />
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        By approving, you authorize the app to execute these function calls on
        your behalf.
      </Typography>
    </>
  );
}
