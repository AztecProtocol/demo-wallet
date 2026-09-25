/**
 * EmojiVerification — shown in the wallet iframe during key exchange.
 *
 * Mirrors the gregoswap EmojiVerification component but lives on the
 * wallet side. The user should compare these emojis with what they see
 * in the dApp before the dApp proceeds.
 */

import { Box, Typography } from "@mui/material";
import SecurityIcon from "@mui/icons-material/Security";
import { hashToEmoji } from "@aztec-labs/wallet-sdk/crypto";

interface EmojiGridProps {
  emojis: string;
}

function EmojiGrid({ emojis }: EmojiGridProps) {
  const emojiArray = [...emojis];
  const rows = [emojiArray.slice(0, 3), emojiArray.slice(3, 6), emojiArray.slice(6, 9)];

  return (
    <Box sx={{ display: "inline-flex", flexDirection: "column", gap: "2px" }}>
      {rows.map((row, i) => (
        <Box key={i} sx={{ display: "flex", gap: "2px" }}>
          {row.map((emoji, j) => (
            <Box
              key={j}
              sx={{
                fontSize: "1.8rem",
                width: "1.2em",
                height: "1.2em",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {emoji}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

interface EmojiVerificationProps {
  verificationHash: string;
}

export function EmojiVerification({ verificationHash }: EmojiVerificationProps) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        gap: 2,
        p: 3,
      }}
    >
      {/* Emoji grid */}
      <Box
        sx={{
          p: 2,
          border: "1px solid",
          borderColor: "primary.main",
          borderRadius: 1,
          backgroundColor: "rgba(212, 255, 40, 0.05)",
          width: "100%",
        }}
      >
        <Typography variant="body2" fontWeight={600} textAlign="center" sx={{ mb: 2 }}>
          Aztec Demo Web Wallet
        </Typography>
        <Box
          sx={{
            p: 2,
            backgroundColor: "rgba(0, 0, 0, 0.2)",
            borderRadius: 1,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <EmojiGrid emojis={hashToEmoji(verificationHash)} />
        </Box>
      </Box>

      {/* Security info */}
      <Box
        sx={{
          p: 1.5,
          backgroundColor: "rgba(33, 150, 243, 0.08)",
          borderRadius: 1,
          border: "1px solid",
          borderColor: "rgba(33, 150, 243, 0.3)",
          width: "100%",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
          <SecurityIcon sx={{ fontSize: 18, color: "info.main" }} />
          <Typography variant="body2" fontWeight={600} color="info.main">
            Security Verification
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary">
          Confirm these emojis match what your dApp is showing before proceeding.
        </Typography>
      </Box>
    </Box>
  );
}
