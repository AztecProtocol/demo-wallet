import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";

/**
 * Per-function timing entry from simulation/proving stats
 */
interface FunctionTiming {
  functionName: string;
  time: number;
  oracles?: Record<string, { times: number[] }>;
}

/**
 * Timing breakdown from simulation or proving stats.
 * Wall-clock phases (simulation, sending, mining) are injected at the origin
 * so the display component can stay dumb.
 */
interface StatsTimings {
  sync: number;
  publicSimulation?: number;
  validation?: number;
  proving?: number; // circuit proof time
  perFunction: FunctionTiming[];
  unaccounted: number;
  total: number;
  // Wall-clock phases injected at origin for sendTx
  simulation?: number; // prepare-phase simulation time
  sending?: number;
  mining?: number;
}

/**
 * Stats structure from TxSimulationResult / TxProvingResult.
 */
export interface ExecutionStats {
  timings: StatsTimings;
  nodeRPCCalls?: {
    perMethod: Partial<Record<string, { times: number[] }>>;
    roundTrips: {
      roundTripDurations: number[];
      roundTripMethods: string[][];
    };
  };
}

/**
 * Phase timing data for a single phase
 */
export interface PhaseTiming {
  name: string;
  duration: number; // milliseconds
  color: string;
  breakdown?: Array<{ label: string; duration: number }>;
}

/**
 * Props for the PhaseTimeline component
 */
interface PhaseTimelineProps {
  phases: PhaseTiming[];
  /** Component size variant - affects detail level */
  size?: "compact" | "normal" | "detailed";
  /** If true, show labels inside segments */
  showLabels?: boolean;
  /** Custom height for the timeline bar */
  height?: number;
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
};

const formatDurationLong = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} milliseconds`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} seconds`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
};

/**
 * Extracts phase timings from stats.
 *
 * For sendTx, the stats object is enriched at the origin with wall-clock phases
 * (simulation, sending, mining) so this function stays dumb — it just reads what's there.
 */
export function extractPhasesFromStats(
  stats: ExecutionStats | undefined,
  isUtility = false,
): PhaseTiming[] {
  if (!stats?.timings) return [];

  const phases: PhaseTiming[] = [];
  const t = stats.timings;

  if (t.simulation && t.simulation > 0) {
    phases.push({ name: "Simulation", duration: t.simulation, color: "#ff9800" });
  }

  if (t.sync > 0) {
    phases.push({ name: "Sync", duration: t.sync, color: "#90caf9" });
  }

  if (t.perFunction?.length > 0) {
    const total = t.perFunction.reduce((s, fn) => s + fn.time, 0);
    phases.push({
      name: isUtility ? "Execution" : "Witgen",
      duration: total,
      color: "#ffb74d",
      breakdown: t.perFunction.map((fn) => ({
        label: fn.functionName.split(":").pop() || fn.functionName,
        duration: fn.time,
      })),
    });
  }

  if (!t.proving && t.publicSimulation && t.publicSimulation > 0) {
    phases.push({ name: "Public Sim", duration: t.publicSimulation, color: "#81c784" });
  }

  if (!t.proving && t.validation && t.validation > 0) {
    phases.push({ name: "Validation", duration: t.validation, color: "#ce93d8" });
  }

  if (t.proving && t.proving > 0) {
    phases.push({ name: "Proving", duration: t.proving, color: "#f48fb1" });
  }

  if (t.unaccounted > 0) {
    phases.push({ name: "Other", duration: t.unaccounted, color: "#bdbdbd" });
  }

  if (t.sending && t.sending > 0) {
    phases.push({ name: "Sending", duration: t.sending, color: "#2196f3" });
  }

  if (t.mining && t.mining > 0) {
    phases.push({ name: "Mining", duration: t.mining, color: "#4caf50" });
  }

  return phases;
}

/**
 * Phase timeline tooltip content
 */
function PhaseTooltipContent({ phase, percentage }: { phase: PhaseTiming; percentage: number }) {
  return (
    <Box sx={{ p: 0.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        {phase.name}
      </Typography>
      <Typography variant="body2">
        {formatDurationLong(phase.duration)} ({percentage.toFixed(1)}%)
      </Typography>
      {phase.breakdown && phase.breakdown.length > 0 && (
        <Box sx={{ mt: 1, pl: 1, borderLeft: "2px solid", borderColor: "divider" }}>
          {phase.breakdown.map((item, idx) => (
            <Typography key={idx} variant="caption" sx={{ display: "block" }}>
              {item.label}: {formatDuration(item.duration)}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * Reusable phase timeline component that displays execution phases as a visual timeline bar.
 *
 * Features:
 * - Proportional width segments for each phase
 * - Hover tooltips with detailed breakdown
 * - Responsive size variants (compact, normal, detailed)
 * - Total time display
 * - Customizable colors per phase
 */
export function PhaseTimeline({
  phases,
  size = "normal",
  showLabels = true,
  height,
}: PhaseTimelineProps) {
  const [hoveredPhase, setHoveredPhase] = useState<string | null>(null);

  const { totalDuration, preparingDuration, miningDuration } = useMemo(() => {
    let total = 0;
    let mining = 0;
    for (const phase of phases) {
      total += phase.duration;
      if (phase.name === "Mining") {
        mining += phase.duration;
      }
    }
    return {
      totalDuration: total,
      miningDuration: mining,
      preparingDuration: total - mining,
    };
  }, [phases]);

  if (phases.length === 0 || totalDuration === 0) {
    return null;
  }

  const isCompact = size === "compact";
  const barHeight = height ?? (isCompact ? 14 : size === "normal" ? 16 : 24);
  const showSegmentLabels = showLabels && !isCompact;
  const minSegmentWidthForLabel = size === "detailed" ? 40 : 60;
  const hasMining = miningDuration > 0;
  const chipHeight = isCompact ? 18 : 20;
  const chipFontSize = isCompact ? "0.6rem" : "0.65rem";

  return (
    <Box sx={{ width: "100%" }}>
      {/* Summary chips — shown in all sizes */}
      <Box
        sx={{
          display: "flex",
          gap: 0.5,
          mb: 0.5,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {hasMining ? (
          <>
            <Chip
              label={`Preparing: ${formatDuration(preparingDuration)}`}
              size="small"
              sx={{
                height: chipHeight,
                fontSize: chipFontSize,
                fontWeight: 600,
                bgcolor: "#1565c0",
                color: "white",
              }}
            />
            <Chip
              label={`Mining: ${formatDuration(miningDuration)}`}
              size="small"
              sx={{
                height: chipHeight,
                fontSize: chipFontSize,
                fontWeight: 600,
                bgcolor: "#4caf50",
                color: "white",
              }}
            />
            <Chip
              label={`Total: ${formatDuration(totalDuration)}`}
              size="small"
              sx={{
                height: chipHeight,
                fontSize: chipFontSize,
                fontWeight: 600,
              }}
            />
          </>
        ) : (
          <Chip
            label={`Total: ${formatDuration(totalDuration)}`}
            size="small"
            sx={{ height: chipHeight, fontSize: chipFontSize, fontWeight: 600 }}
          />
        )}
        {size === "detailed" && (
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", ml: "auto" }}>
            {phases.map((phase) => (
              <Box key={phase.name} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    bgcolor: phase.color,
                  }}
                />
                <Typography variant="caption" color="text.secondary">
                  {phase.name}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </Box>

      {/* Timeline bar */}
      <Box
        sx={{
          display: "flex",
          width: "100%",
          height: barHeight,
          borderRadius: 0.5,
          overflow: "hidden",
          bgcolor: "action.hover",
        }}
      >
        {phases.map((phase, index) => {
          const percentage = (phase.duration / totalDuration) * 100;
          const segmentWidth = `${percentage}%`;
          const showLabel = showSegmentLabels && percentage > (100 * minSegmentWidthForLabel) / 300;

          return (
            <Tooltip
              key={phase.name}
              title={<PhaseTooltipContent phase={phase} percentage={percentage} />}
              arrow
              placement="top"
            >
              <Box
                onMouseEnter={() => setHoveredPhase(phase.name)}
                onMouseLeave={() => setHoveredPhase(null)}
                sx={{
                  width: segmentWidth,
                  minWidth: percentage > 0 ? 2 : 0,
                  height: "100%",
                  bgcolor: phase.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.2s ease",
                  cursor: "pointer",
                  borderRight:
                    index < phases.length - 1 ? "1px solid rgba(255,255,255,0.3)" : undefined,
                  transform: hoveredPhase === phase.name ? "scaleY(1.1)" : "scaleY(1)",
                  zIndex: hoveredPhase === phase.name ? 1 : 0,
                  "&:hover": {
                    filter: "brightness(1.1)",
                  },
                }}
              >
                {showLabel && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "rgba(0,0,0,0.7)",
                      fontWeight: 600,
                      fontSize: size === "detailed" ? "0.65rem" : "0.6rem",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      px: 0.5,
                    }}
                  >
                    {phase.name}
                  </Typography>
                )}
              </Box>
            </Tooltip>
          );
        })}
      </Box>

      {/* Legend — always shown */}
      <Box
        sx={{
          display: "flex",
          gap: isCompact ? 0.75 : 1,
          mt: 0.5,
          flexWrap: "wrap",
        }}
      >
        {phases.map((phase) => (
          <Box key={phase.name} sx={{ display: "flex", alignItems: "center", gap: 0.3 }}>
            <Box
              sx={{
                width: isCompact ? 6 : 8,
                height: isCompact ? 6 : 8,
                borderRadius: "50%",
                bgcolor: phase.color,
              }}
            />
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontSize: isCompact ? "0.6rem" : "0.65rem" }}
            >
              {phase.name}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/**
 * Convenience component that extracts phases from stats automatically
 */
export function SimulationPhaseTimeline({
  stats,
  size = "normal",
}: {
  stats: ExecutionStats | undefined;
  size?: "compact" | "normal" | "detailed";
}) {
  const phases = useMemo(() => extractPhasesFromStats(stats), [stats]);
  return <PhaseTimeline phases={phases} size={size} />;
}
