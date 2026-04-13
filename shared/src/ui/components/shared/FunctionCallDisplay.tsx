import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Chip from "@mui/material/Chip";
import CallMadeIcon from "@mui/icons-material/CallMade";
import VpnKeyIcon from "@mui/icons-material/VpnKey";
import { useState, type ReactNode } from "react";

export interface FunctionCallDisplayProps {
  contractName: string;
  contractAddress: string;
  functionName: string;
  args: Array<{ name: string; value: string }>;
  returnValues: Array<{ name: string; value: string }>;
  callerName?: string;
  typeLabel: "Private" | "Utility" | "Public";
  typeChipColor?: "primary" | "success" | "warning" | "info";
  /** Color for accent elements (borders, icons, labels). Defaults to primary.main */
  accentColor?: string;
  depth?: number;
  isStaticCall?: boolean;
  needsAuth?: boolean;
  nestedContent?: ReactNode;
  accordionBgColor?: string;
  compact?: boolean;
}

export function FunctionCallDisplay({
  contractName,
  contractAddress,
  functionName,
  args,
  returnValues,
  callerName,
  typeLabel,
  typeChipColor = "primary",
  accentColor = "primary.main",
  depth = 0,
  isStaticCall = false,
  needsAuth = false,
  nestedContent,
  accordionBgColor = "rgba(0, 0, 0, 0.01)",
  compact = false,
}: FunctionCallDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const hasArgs = args.length > 0;
  const hasReturnValues = returnValues.length > 0;
  // In compact mode, reduce nesting indent to avoid consuming too much width
  const indent = compact ? Math.min(depth, 3) * 1 : Math.min(depth, 4) * 2;

  return (
    <Box
      sx={{
        ml: indent,
        mb: compact ? 0.5 : 1,
        borderLeft: depth > 0 ? "2px solid" : "none",
        borderColor: accentColor,
        pl: depth > 0 ? (compact ? 1 : 2) : 0,
        // minWidth:0 allows flex children to shrink below their content size (needed for text truncation)
        minWidth: 0,
      }}
    >
      <Accordion
        expanded={expanded}
        onChange={(_, isExpanded) => setExpanded(isExpanded)}
        sx={{
          bgcolor: accordionBgColor,
          boxShadow: compact ? 0 : 1,
          border: "1px solid",
          borderColor: "divider",
        }}
      >
        <AccordionSummary
          expandIcon={<ExpandMoreIcon fontSize={compact ? "small" : "medium"} />}
          sx={
            compact
              ? {
                  minHeight: "32px !important",
                  "& .MuiAccordionSummary-content": {
                    my: "4px !important",
                    width: "100%",
                    minWidth: 0,
                    overflow: "hidden",
                  },
                  px: 1,
                }
              : {
                  "& .MuiAccordionSummary-content": {
                    minWidth: 0,
                    overflow: "hidden",
                  },
                }
          }
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: compact ? 0.5 : 1,
              width: "100%",
              overflow: "hidden",
              flexWrap: expanded ? "wrap" : "nowrap",
            }}
          >
            <CallMadeIcon
              fontSize="small"
              sx={{ color: accentColor, flexShrink: 0, fontSize: compact ? "0.875rem" : undefined }}
            />
            <Typography
              variant="body2"
              sx={{
                fontFamily: "monospace",
                fontWeight: "medium",
                fontSize: compact ? "0.75rem" : undefined,
                flexShrink: 1,
                minWidth: 0,
                ...(expanded
                  ? { wordBreak: "break-all" }
                  : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
              }}
            >
              {contractName}.{functionName}({hasArgs ? "..." : ""})
            </Typography>
            {/* Chips and return value — grouped so they never shrink away */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: compact ? 0.5 : 1,
                flexShrink: 0,
                ml: expanded ? 0 : "auto",
              }}
            >
              <Chip
                label={typeLabel}
                size="small"
                color={typeChipColor}
                variant="outlined"
                sx={{
                  height: compact ? 16 : undefined,
                  fontSize: compact ? "0.6rem" : undefined,
                }}
              />
              {needsAuth && (
                <Chip
                  icon={<VpnKeyIcon />}
                  label={compact ? "Auth" : "Requires Authorization"}
                  size="small"
                  color="warning"
                  variant="filled"
                  sx={compact ? { height: 16, fontSize: "0.6rem" } : undefined}
                />
              )}
              {isStaticCall && !compact && <Chip label="static" size="small" variant="outlined" />}
              {hasReturnValues && !compact && !expanded && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    fontFamily: "monospace",
                    ...(expanded
                      ? { wordBreak: "break-all" }
                      : {
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 200,
                        }),
                  }}
                >
                  → {returnValues.map((rv) => rv.value).join(", ")}
                </Typography>
              )}
            </Box>
          </Box>
        </AccordionSummary>
        <AccordionDetails sx={compact ? { px: 1, py: 0.5 } : undefined}>
          <Box sx={{ width: "100%", minWidth: 0 }}>
            {/* Arguments (if available) - Show first as most important */}
            {hasArgs && (
              <Box sx={{ mb: compact ? 1 : 2 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    fontWeight: "bold",
                    color: accentColor,
                    fontSize: compact ? "0.7rem" : undefined,
                  }}
                  gutterBottom
                >
                  Arguments:
                </Typography>
                <Box
                  sx={{
                    p: compact ? 1 : 1.5,
                    bgcolor: "action.hover",
                    borderRadius: 1,
                    border: "1px solid",
                    borderColor: "divider",
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    gap: compact ? 0.5 : 1,
                    columnGap: compact ? 1 : 2,
                    alignItems: "start",
                    minWidth: 0,
                  }}
                >
                  {args.map((arg, i) => (
                    <>
                      <Typography
                        key={`${i}-name`}
                        sx={{
                          fontFamily: "monospace",
                          fontSize: compact ? "0.7rem" : "0.875rem",
                          fontWeight: "medium",
                          color: accentColor,
                          whiteSpace: "normal",
                          wordBreak: "break-word",
                        }}
                      >
                        {arg.name}:
                      </Typography>
                      <Typography
                        key={`${i}-value`}
                        sx={{
                          fontFamily: "monospace",
                          fontSize: compact ? "0.7rem" : "0.8125rem",
                          wordBreak: "break-all",
                        }}
                      >
                        {arg.value}
                      </Typography>
                    </>
                  ))}
                </Box>
              </Box>
            )}

            {/* Return Values */}
            {hasReturnValues && (
              <Box sx={{ mb: compact ? 1 : 2 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    fontWeight: "bold",
                    color: accentColor,
                    fontSize: compact ? "0.7rem" : undefined,
                  }}
                  gutterBottom
                >
                  Return Values:
                </Typography>
                <Box
                  sx={{
                    p: compact ? 1 : 1.5,
                    bgcolor: "action.hover",
                    borderRadius: 1,
                    border: "1px solid",
                    borderColor: "divider",
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    gap: compact ? 0.5 : 1,
                    columnGap: compact ? 1 : 2,
                    alignItems: "start",
                    minWidth: 0,
                  }}
                >
                  {returnValues.map((rv, i) => (
                    <>
                      <Typography
                        key={`${i}-name`}
                        sx={{
                          fontFamily: "monospace",
                          fontSize: compact ? "0.7rem" : "0.875rem",
                          fontWeight: "medium",
                          color: accentColor,
                          whiteSpace: "normal",
                          wordBreak: "break-word",
                        }}
                      >
                        {rv.name}:
                      </Typography>
                      <Typography
                        key={`${i}-value`}
                        sx={{
                          fontFamily: "monospace",
                          fontSize: compact ? "0.7rem" : "0.8125rem",
                          wordBreak: "break-all",
                        }}
                      >
                        {rv.value}
                      </Typography>
                    </>
                  ))}
                </Box>
              </Box>
            )}

            {/* Call Details */}
            <Box sx={{ mb: compact ? 1 : 2 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontSize: compact ? "0.65rem" : undefined }}
              >
                Contract:
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  fontFamily: "monospace",
                  wordBreak: "break-all",
                  fontSize: compact ? "0.7rem" : undefined,
                }}
              >
                {contractName}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  fontFamily: "monospace",
                  wordBreak: "break-all",
                  color: "text.secondary",
                  display: "block",
                  fontSize: compact ? "0.65rem" : undefined,
                }}
              >
                {contractAddress}
              </Typography>
            </Box>

            {callerName && (
              <Box sx={{ mb: compact ? 1 : 2 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontSize: compact ? "0.65rem" : undefined }}
                >
                  Caller:
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: "monospace",
                    wordBreak: "break-all",
                    fontSize: compact ? "0.7rem" : undefined,
                  }}
                >
                  {callerName}
                </Typography>
              </Box>
            )}
          </Box>
        </AccordionDetails>
      </Accordion>

      {/* Nested Content */}
      {nestedContent}
    </Box>
  );
}
