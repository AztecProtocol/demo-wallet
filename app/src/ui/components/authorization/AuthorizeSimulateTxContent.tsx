import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Alert from "@mui/material/Alert";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { AuthorizationItem } from "../../../wallet/types/authorization";
import type { ReadableCallAuthorization } from "../../../wallet/decoding/call-authorization-formatter";
import type { DecodedExecutionTrace } from "../../../wallet/decoding/tx-callstack-decoder";
import { ExecutionTraceDisplay } from "../shared/ExecutionTraceDisplay";

interface AuthorizeSimulateTxContentProps {
  request: AuthorizationItem;
  showAppId?: boolean;
}

// Content component for displaying simulateTx authorization details
export function AuthorizeSimulateTxContent({
  request,
  showAppId = true,
}: AuthorizeSimulateTxContentProps) {
  const params = request.params as {
    payloadHash?: string;
    callAuthorizations?: ReadableCallAuthorization[];
    executionTrace?: DecodedExecutionTrace | any;
    isUtility?: boolean;
    stats?: any;
    from?: string;
    embeddedPaymentMethodFeePayer?: string;
  };
  const callAuthorizations = params.callAuthorizations || [];
  const executionTrace = params.executionTrace;
  const isUtility = params.isUtility || request.method === "simulateUtility";
  const stats = params.stats;
  const from = params.from;
  const embeddedPaymentMethodFeePayer = params.embeddedPaymentMethodFeePayer;

  const isFromZero = from && AztecAddress.fromString(from).equals(AztecAddress.ZERO);
  const hasEmbeddedFeePayer = !!embeddedPaymentMethodFeePayer;

  return (
    <>
      {showAppId && (
        <Typography variant="body1" gutterBottom>
          App <strong>{request.appId}</strong> wants to simulate a{" "}
          {isUtility ? "utility function" : "transaction"} and receive the
          execution details.
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
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Simulation Preview:
          </Typography>
          <ExecutionTraceDisplay
            trace={executionTrace}
            callAuthorizations={callAuthorizations}
            stats={stats}
          />
        </Box>
      )}
    </>
  );
}
