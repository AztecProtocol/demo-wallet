import { useEffect, useState, useMemo, type MutableRefObject } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import type {
  WalletInteraction,
  WalletInteractionType,
} from "../../../wallet/types/wallet-interaction";
import { PhaseTimeline, extractPhasesFromStats, type ExecutionStats } from "./PhaseTimeline";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PhaseDef {
  /** Key into phaseStartsRef: interaction.id + ":" + this value */
  statusKey: string;
  name: string;
  color: string;
  /** Status string that signals this phase has ended and the next has begun */
  nextStatusKey: string | null;
}

interface LivePhaseTiming {
  name: string;
  duration: number;
  color: string;
  isLive?: boolean;
}

// sendTx / createAccount phases.
// Simulation runs during prepare() before auth — interaction starts with status "SIMULATING".
// The end of simulation is marked by "REQUESTING AUTHORIZATION" (prepare completes).
// Auth wait time is intentionally excluded (not a phase).
const SEND_TX_PHASE_DEFS: PhaseDef[] = [
  { statusKey: "SIMULATING", name: "Simulation", color: "#ff9800", nextStatusKey: "PROVING" },
  { statusKey: "PROVING", name: "Proving", color: "#f48fb1", nextStatusKey: "SENDING" },
  { statusKey: "SENDING", name: "Sending", color: "#2196f3", nextStatusKey: "SENT" },
  { statusKey: "SENT", name: "Mining", color: "#4caf50", nextStatusKey: null },
];

// simulateTx / simulateUtility — the interaction is created at simulation start (timestamp),
// so we can show a live SIMULATING phase directly from interaction.timestamp.
const SIMULATE_TX_PHASE_DEFS: PhaseDef[] = [
  { statusKey: "SIMULATING", name: "Simulation", color: "#ff9800", nextStatusKey: null },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const shimmer = keyframes`
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
`;

const pulse = keyframes`
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
`;

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
};

const formatDurationLong = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} milliseconds`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} seconds`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
};

function getPhaseDefs(type: WalletInteractionType): PhaseDef[] {
  if (type === "sendTx" || type === "createAccount" || type === "deployAccount")
    return SEND_TX_PHASE_DEFS;
  return SIMULATE_TX_PHASE_DEFS;
}

// Maps an interaction status string to the PhaseDef.statusKey it corresponds to.
// Returns null when no live phase should be shown (auth wait is intentionally excluded).
function getCurrentPhaseKey(status: string, type: WalletInteractionType): string | null {
  if (type === "sendTx" || type === "createAccount" || type === "deployAccount") {
    if (status.includes("SIMULATING")) return "SIMULATING";
    if (status.includes("PROVING")) return "PROVING";
    if (status.includes("SENDING")) return "SENDING";
    if (
      status.includes("MINING") ||
      status.includes("SENT") ||
      status.includes("MINED") ||
      status.includes("DEPLOYED")
    )
      return "SENT";
    return null; // REQUESTING AUTHORIZATION — auth wait excluded from timeline
  }
  // simulateTx / simulateUtility: single SIMULATING phase, paused during auth wait
  if (status.includes("REQUESTING AUTHORIZATION")) return null;
  return "SIMULATING";
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface TxProgressTimelineProps {
  interaction: WalletInteraction<WalletInteractionType>;
  phaseStartsRef: MutableRefObject<Map<string, number>>;
  /** True once the parent has finished loading (even if result was empty) */
  timingsLoaded?: boolean;
  stats?: ExecutionStats;
}

// ── Inner bar (shared between live and a fallback) ────────────────────────────

function PhaseTimelineBar({ phases }: { phases: LivePhaseTiming[] }) {
  const completedPhases = useMemo(() => phases.filter((p) => !p.isLive), [phases]);
  const livePhase = useMemo(() => phases.find((p) => p.isLive), [phases]);

  const completedDuration = useMemo(
    () => completedPhases.reduce((sum, p) => sum + p.duration, 0),
    [completedPhases],
  );
  const liveDuration = livePhase?.duration ?? 0;
  const totalDuration = completedDuration + liveDuration;

  const miningDuration = useMemo(
    () =>
      completedPhases.filter((p) => p.name === "Mining").reduce((sum, p) => sum + p.duration, 0),
    [completedPhases],
  );

  if (phases.length === 0 || totalDuration === 0) return null;

  const preparingDuration = totalDuration - miningDuration;
  const hasMining = miningDuration > 0;
  const hasLive = !!livePhase;

  return (
    <Box sx={{ width: "100%" }}>
      {/* Summary chips */}
      <Box sx={{ display: "flex", gap: 0.5, mb: 0.5, flexWrap: "wrap", alignItems: "center" }}>
        {hasMining ? (
          <>
            <Chip
              label={`Preparing: ${formatDuration(preparingDuration)}`}
              size="small"
              sx={{
                height: 18,
                fontSize: "0.6rem",
                fontWeight: 600,
                bgcolor: "#1565c0",
                color: "white",
              }}
            />
            <Chip
              label={`Mining: ${formatDuration(miningDuration)}`}
              size="small"
              sx={{
                height: 18,
                fontSize: "0.6rem",
                fontWeight: 600,
                bgcolor: "#4caf50",
                color: "white",
              }}
            />
            <Chip
              label={`Total: ${formatDuration(totalDuration)}`}
              size="small"
              sx={{ height: 18, fontSize: "0.6rem", fontWeight: 600 }}
            />
          </>
        ) : (
          <Chip
            label={
              hasLive
                ? `Elapsed: ${formatDuration(totalDuration)}`
                : `Total: ${formatDuration(totalDuration)}`
            }
            size="small"
            sx={{ height: 18, fontSize: "0.6rem", fontWeight: 600 }}
          />
        )}
      </Box>

      {/* Timeline bar */}
      <Box
        sx={{
          display: "flex",
          width: "100%",
          height: 14,
          borderRadius: 0.5,
          overflow: "hidden",
          bgcolor: "action.hover",
        }}
      >
        {/* Completed segments */}
        {completedPhases.map((phase, index) => {
          const percentage = (phase.duration / totalDuration) * 100;
          return (
            <Tooltip
              key={phase.name}
              title={
                <Box sx={{ p: 0.5 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {phase.name}
                  </Typography>
                  <Typography variant="body2">
                    {formatDurationLong(phase.duration)} ({percentage.toFixed(1)}%)
                  </Typography>
                </Box>
              }
              arrow
              placement="top"
            >
              <Box
                sx={{
                  width: `${percentage}%`,
                  minWidth: percentage > 0 ? 2 : 0,
                  height: "100%",
                  bgcolor: phase.color,
                  borderRight:
                    index < completedPhases.length - 1 || hasLive
                      ? "1px solid rgba(255,255,255,0.3)"
                      : undefined,
                  transition: "filter 0.2s ease",
                  cursor: "pointer",
                  "&:hover": { filter: "brightness(1.2)" },
                }}
              />
            </Tooltip>
          );
        })}

        {/* Live (shimmer) segment — flex: 1 to fill remaining space */}
        {livePhase && (
          <Tooltip
            title={
              <Box sx={{ p: 0.5 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  {livePhase.name}
                </Typography>
                <Typography variant="body2">
                  {formatDurationLong(livePhase.duration)} (in progress)
                </Typography>
              </Box>
            }
            arrow
            placement="top"
          >
            <Box
              sx={{
                flex: 1,
                minWidth: 40,
                height: "100%",
                background: `linear-gradient(90deg, ${livePhase.color}88 0%, ${livePhase.color} 50%, ${livePhase.color}88 100%)`,
                backgroundSize: "400px 100%",
                animation: `${shimmer} 1.5s infinite linear`,
                cursor: "pointer",
              }}
            />
          </Tooltip>
        )}
      </Box>

      {/* Legend */}
      <Box sx={{ display: "flex", gap: 1, mt: 0.5, flexWrap: "wrap" }}>
        {phases.map((phase) => (
          <Box key={phase.name} sx={{ display: "flex", alignItems: "center", gap: 0.3 }}>
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                bgcolor: phase.color,
                ...(phase.isLive && { animation: `${pulse} 1.2s ease-in-out infinite` }),
              }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.6rem" }}>
              {phase.name}
              {phase.isLive ? " ●" : ""}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function TxProgressTimeline({
  interaction,
  phaseStartsRef,
  timingsLoaded,
  stats,
}: TxProgressTimelineProps) {
  // Ticks every 200ms while in-progress so the live phase elapsed updates
  const [phaseElapsed, setPhaseElapsed] = useState(0);

  const phaseDefs = getPhaseDefs(interaction.type);
  const currentPhaseKey = getCurrentPhaseKey(interaction.status, interaction.type);

  // The ref key for when the current phase started
  const currentPhaseStartKey = currentPhaseKey ? `${interaction.id}:${currentPhaseKey}` : null;

  useEffect(() => {
    if (interaction.complete || !currentPhaseStartKey) return;
    const tick = () => {
      const now = Date.now();
      const phaseStart =
        phaseStartsRef.current.get(currentPhaseStartKey) ??
        phaseStartsRef.current.get(`${interaction.id}:START`) ??
        now;
      setPhaseElapsed(Math.max(0, now - phaseStart));
    };
    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
  }, [interaction.complete, currentPhaseStartKey, interaction.id]);

  // ── Completed state: use full PhaseTimeline with accurate measurements ──────
  if (interaction.complete) {
    if (!timingsLoaded) return null;
    const isUtility = interaction.type === "simulateUtility";
    const phases = extractPhasesFromStats(stats, isUtility);
    if (phases.length === 0) return null;
    return (
      <Box sx={{ mt: 1 }}>
        <PhaseTimeline phases={phases} size="compact" />
      </Box>
    );
  }

  // ── In-progress state ────────────────────────────────────────────────────────

  // During auth wait (REQUESTING AUTHORIZATION), currentPhaseKey is null.
  // Show the locked simulation segment so the user can see how long simulation took.
  if (!currentPhaseKey) {
    const simStart =
      phaseStartsRef.current.get(`${interaction.id}:SIMULATING`) ??
      phaseStartsRef.current.get(`${interaction.id}:START`) ??
      Date.now();
    const simEnd = phaseStartsRef.current.get(`${interaction.id}:REQUESTING AUTHORIZATION`);
    if (!simEnd) return null;
    const simulationSegment: LivePhaseTiming = {
      name: "Simulation",
      duration: Math.max(0, simEnd - simStart),
      color: "#ff9800",
    };
    return (
      <Box sx={{ mt: 1 }}>
        <PhaseTimelineBar phases={[simulationSegment]} />
      </Box>
    );
  }

  const currentIdx = phaseDefs.findIndex((p) => p.statusKey === currentPhaseKey);
  if (currentIdx === -1) return null;

  // Build completed segments
  const completedSegments: LivePhaseTiming[] = [];
  for (let i = 0; i < currentIdx; i++) {
    const startKey = `${interaction.id}:${phaseDefs[i].statusKey}`;
    // Simulation ends when REQUESTING AUTHORIZATION fires (not when PROVING starts),
    // so use that as the boundary for the simulation→proving gap.
    const endStatusKey =
      phaseDefs[i].statusKey === "SIMULATING"
        ? "REQUESTING AUTHORIZATION"
        : phaseDefs[i + 1].statusKey;
    const endKey = `${interaction.id}:${endStatusKey}`;
    const start =
      phaseStartsRef.current.get(startKey) ??
      (phaseDefs[i].statusKey === "SIMULATING"
        ? phaseStartsRef.current.get(`${interaction.id}:START`)
        : undefined);
    const end = phaseStartsRef.current.get(endKey);
    if (start && end) {
      completedSegments.push({
        name: phaseDefs[i].name,
        color: phaseDefs[i].color,
        duration: Math.max(0, end - start),
      });
    }
  }

  const liveDef = phaseDefs[currentIdx];
  const displayPhases: LivePhaseTiming[] = [
    ...completedSegments,
    {
      name: liveDef.name,
      duration: phaseElapsed > 0 ? phaseElapsed : 100,
      color: liveDef.color,
      isLive: true,
    },
  ];

  return (
    <Box sx={{ mt: 1 }}>
      <PhaseTimelineBar phases={displayPhases} />
    </Box>
  );
}
