import type { DecodedExecutionTrace } from "../../../wallet/decoding/tx-callstack-decoder";
import type { ReadableCallAuthorization } from "../../../wallet/decoding/call-authorization-formatter";
import { FunctionCallDisplay } from "./FunctionCallDisplay";
import { PrivateCallDisplay } from "./PrivateCallDisplay";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import TimerIcon from "@mui/icons-material/Timer";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Paper from "@mui/material/Paper";

// Utility execution trace type
interface UtilityExecutionTrace {
  functionName: string;
  args: Array<{ name: string; value: string }>;
  contractAddress: string;
  contractName: string;
  result: string;
  isUtility: true;
}

interface SimulationStats {
  timings: {
    sync: number;
    publicSimulation?: number;
    validation?: number;
    perFunction: Array<{
      functionName: string;
      time: number;
      oracles?: Record<string, { times: number[] }>;
    }>;
    unaccounted: number;
    total: number;
  };
  nodeRPCCalls: Record<string, { times: number[] }>;
}

interface ExecutionTraceDisplayProps {
  trace: DecodedExecutionTrace | UtilityExecutionTrace;
  callAuthorizations?: ReadableCallAuthorization[];
  accordionBgColor?: string;
  stats?: SimulationStats;
}

interface SimulationStatsDisplayProps {
  stats: SimulationStats;
  trace: DecodedExecutionTrace | UtilityExecutionTrace;
}

function SimulationStatsDisplay({ stats, trace }: SimulationStatsDisplayProps) {
  const formatTime = (ms: number) => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // Build timing map - store by function name for matching
  const timingByFunction = new Map<
    string,
    { contractClass: string; time: number }
  >();
  if (stats?.timings.perFunction) {
    stats.timings.perFunction.forEach((fn) => {
      // Stats format is like "EcdsaRAccount:entrypoint" or "ContractName:functionName"
      const parts = fn.functionName.split(":");
      if (parts.length === 2) {
        const [contractClass, functionName] = parts;
        timingByFunction.set(functionName, { contractClass, time: fn.time });
      }
    });
  }

  // Render a call with timing in hierarchy
  const renderCallWithTiming = (call: any, depth: number = 0) => {
    const functionKey = `${call.contract.name}:${call.function}`;

    // Match by function name only, since contract names in trace might be aliases
    const timingData = timingByFunction.get(call.function);
    const timing = timingData?.time;

    const nestedCalls = call.nestedEvents
      ? call.nestedEvents.filter((evt: any) => evt.type === "private-call")
      : [];

    return (
      <Box
        key={`${functionKey}-${depth}`}
        sx={{
          position: 'relative',
          ml: depth > 0 ? 2 : 0,
          '&::before': depth > 0 ? {
            content: '""',
            position: 'absolute',
            left: -8,
            top: 0,
            bottom: '50%',
            width: 6,
            borderLeft: '1px solid #d0d0d0',
            borderBottom: '1px solid #d0d0d0',
          } : {},
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
          <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
            {call.contract.name}.{call.function}
          </Typography>
          {timing !== undefined && (
            <Chip
              label={formatTime(timing)}
              size="small"
              sx={{ height: 18, fontSize: "0.65rem" }}
            />
          )}
        </Box>
        {nestedCalls.length > 0 && (
          <Box
            sx={{
              position: 'relative',
              '&::before': {
                content: '""',
                position: 'absolute',
                left: -8,
                top: 0,
                height: '100%',
                borderLeft: '1px solid #d0d0d0',
              }
            }}
          >
            {nestedCalls.map((nestedCall: any) =>
              renderCallWithTiming(nestedCall, depth + 1)
            )}
          </Box>
        )}
      </Box>
    );
  };

  return (
    <Accordion
      defaultExpanded={false}
      sx={{ mb: 2, boxShadow: "none", "&:before": { display: "none" } }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon />}
        sx={{
          minHeight: "auto",
          "& .MuiAccordionSummary-content": { my: 1 },
          bgcolor: "background.default",
          borderRadius: 1,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <TimerIcon fontSize="small" color="action" />
          <Typography variant="caption" color="text.secondary">
            Simulation Time: {formatTime(stats.timings.total)}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 1, pb: 2 }}>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 2 }}>
          <Chip
            label={`Sync: ${formatTime(stats.timings.sync)}`}
            size="small"
            variant="outlined"
          />
          {stats.timings.publicSimulation !== undefined && (
            <Chip
              label={`Public: ${formatTime(stats.timings.publicSimulation)}`}
              size="small"
              variant="outlined"
            />
          )}
          {stats.timings.validation !== undefined && (
            <Chip
              label={`Validation: ${formatTime(stats.timings.validation)}`}
              size="small"
              variant="outlined"
            />
          )}
          {stats.timings.unaccounted > 0 && (
            <Chip
              label={`Unaccounted: ${formatTime(stats.timings.unaccounted)}`}
              size="small"
              variant="outlined"
            />
          )}
        </Box>
        {!("isUtility" in trace) && (
          <Box sx={{ mb: 2 }}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 1 }}
            >
              Function Call Hierarchy:
            </Typography>
            {renderCallWithTiming(
              (trace as DecodedExecutionTrace).privateExecution
            )}
          </Box>
        )}
        {stats.nodeRPCCalls && Object.keys(stats.nodeRPCCalls).length > 0 && (
          <Box>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 1 }}
            >
              Node RPC Calls (some batched, times might overlap):
            </Typography>
            <TableContainer
              component={Paper}
              variant="outlined"
              sx={{ maxHeight: 300 }}
            >
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Method</TableCell>
                    <TableCell align="right">Count</TableCell>
                    <TableCell align="right">Total Time</TableCell>
                    <TableCell align="right">Avg Time</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {Object.entries(stats.nodeRPCCalls)
                    .sort(([, a], [, b]) => {
                      const totalA = a.times.reduce((sum, t) => sum + t, 0);
                      const totalB = b.times.reduce((sum, t) => sum + t, 0);
                      return totalB - totalA;
                    })
                    .map(([method, data]) => {
                      const total = data.times.reduce((sum, t) => sum + t, 0);
                      const avg = total / data.times.length;
                      return (
                        <TableRow key={method}>
                          <TableCell
                            sx={{
                              fontFamily: "monospace",
                              fontSize: "0.75rem",
                            }}
                          >
                            {method}
                          </TableCell>
                          <TableCell align="right">
                            {data.times.length}
                          </TableCell>
                          <TableCell align="right">
                            {formatTime(total)}
                          </TableCell>
                          <TableCell align="right">{formatTime(avg)}</TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

export function ExecutionTraceDisplay({
  trace,
  callAuthorizations,
  accordionBgColor,
  stats,
}: ExecutionTraceDisplayProps) {
  // Check if this is a utility trace
  if ("isUtility" in trace && trace.isUtility) {
    const utilityTrace = trace as UtilityExecutionTrace;

    // Convert result to return values format (result is already formatted as a string)
    const returnValues =
      utilityTrace.result !== undefined && utilityTrace.result !== ""
        ? [{ name: "result", value: utilityTrace.result }]
        : [];

    return (
      <>
        <FunctionCallDisplay
          contractName={utilityTrace.contractName}
          contractAddress={utilityTrace.contractAddress}
          functionName={utilityTrace.functionName}
          args={utilityTrace.args}
          returnValues={returnValues}
          typeLabel="Utility"
          accordionBgColor={accordionBgColor}
        />
        {stats && <SimulationStatsDisplay stats={stats} trace={trace} />}
      </>
    );
  }

  // Full transaction trace
  const decodedTrace = trace as DecodedExecutionTrace;
  return (
    <>
      <PrivateCallDisplay
        call={decodedTrace.privateExecution}
        authorizations={callAuthorizations}
        accordionBgColor={accordionBgColor}
      />
      {stats && <SimulationStatsDisplay stats={stats} trace={trace} />}
    </>
  );
}
