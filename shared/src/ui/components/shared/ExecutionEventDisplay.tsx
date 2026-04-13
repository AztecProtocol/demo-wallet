import type { ExecutionEvent } from "../../../wallet/decoding/tx-callstack-decoder";
import type { ReadableCallAuthorization } from "../../../wallet/decoding/call-authorization-formatter";
import { PrivateCallDisplay } from "./PrivateCallDisplay";
import { PublicCallDisplay } from "./PublicCallDisplay";

export interface ExecutionEventDisplayProps {
  event: ExecutionEvent;
  authorizations?: ReadableCallAuthorization[];
  accordionBgColor?: string;
  compact?: boolean;
}

export function ExecutionEventDisplay({
  event,
  authorizations,
  accordionBgColor,
  compact = false,
}: ExecutionEventDisplayProps) {
  if (event.type === "private-call") {
    return (
      <PrivateCallDisplay
        call={event}
        authorizations={authorizations}
        accordionBgColor={accordionBgColor}
        compact={compact}
      />
    );
  } else {
    return <PublicCallDisplay call={event} accordionBgColor={accordionBgColor} compact={compact} />;
  }
}
