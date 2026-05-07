import { useEffect, useState } from "react";
import { Box, Button, TextField, Typography, Stack } from "@mui/material";
import { hashToEmoji } from "@aztec/wallet-sdk/crypto";
import { PortClient } from "../../src/ipc/port-client";

export function Popup() {
  const [client] = useState(() => {
    const c = new PortClient();
    c.connect();
    // Dev helper: expose so we can test broadcast wiring from the popup's
    // own console (right-click popup → Inspect, then run popupClient.call(...)).
    (globalThis as { popupClient?: unknown }).popupClient = c;
    return c;
  });
  // Three states: uninitialized (no vault yet), locked (have vault, need pw),
  // unlocked. `null` while we're still asking the offscreen which we're in.
  const [vaultState, setVaultState] = useState<
    "uninitialized" | "locked" | "unlocked" | null
  >(null);
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Pending discovery requests the dApp sent. The SW opens the popup when one
  // arrives; the popup queries the list and renders approve/reject UI.
  type Pending = {
    requestId: string;
    origin: string;
    appId: string;
    chainId: string;
    version: string;
  };
  const [pendingDiscoveries, setPendingDiscoveries] = useState<Pending[]>([]);

  // Active (key-exchange-completed) sessions. Each has a `verificationHash`
  // the user compares with the dApp's emoji display — security check that
  // both sides ended up with the same shared secret.
  type ActiveSession = {
    sessionId: string;
    origin: string;
    appId: string;
    verificationHash: string;
    chainId: string;
    version: string;
  };
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);

  // Sessions the user has already eyeballed against the dApp's emojis. Stored
  // in chrome.storage.session so it survives popup-close/reopen but resets on
  // browser restart (security default: re-verify after restart).
  const [verifiedSessionIds, setVerifiedSessionIds] = useState<Set<string>>(new Set());

  const VERIFIED_KEY = "verifiedSessionIds";

  const loadVerified = async () => {
    const result = await chrome.storage.session.get(VERIFIED_KEY);
    setVerifiedSessionIds(new Set((result[VERIFIED_KEY] as string[] | undefined) ?? []));
  };

  const markAllVerified = async () => {
    const ids = activeSessions.map((s) => s.sessionId);
    const merged = new Set([...Array.from(verifiedSessionIds), ...ids]);
    await chrome.storage.session.set({ [VERIFIED_KEY]: Array.from(merged) });
    setVerifiedSessionIds(merged);
  };

  const refreshPending = async () => {
    const reply = (await chrome.runtime.sendMessage({
      type: "get-pending-discoveries",
    })) as { ok: boolean; discoveries: Pending[] } | undefined;
    if (reply?.ok) setPendingDiscoveries(reply.discoveries);
  };

  const refreshSessions = async () => {
    const reply = (await chrome.runtime.sendMessage({
      type: "get-active-sessions",
    })) as { ok: boolean; sessions: ActiveSession[] } | undefined;
    if (reply?.ok) setActiveSessions(reply.sessions);
  };

  const approveDiscovery = async (requestId: string, remember: boolean) => {
    await chrome.runtime.sendMessage({ type: "approve-discovery", requestId, remember });
    void refreshPending();
  };

  const rejectDiscovery = async (requestId: string) => {
    await chrome.runtime.sendMessage({ type: "reject-discovery", requestId });
    void refreshPending();
  };

  useEffect(() => {
    void (async () => {
      const initialized = await client.call<boolean>("vault.isInitialized", []);
      if (!initialized) {
        setVaultState("uninitialized");
      } else {
        const unlocked = await client.call<boolean>("vault.isUnlocked", []);
        setVaultState(unlocked ? "unlocked" : "locked");
      }
      void refreshPending();
      void refreshSessions();
      void loadVerified();
    })();
    const off1 = client.onBroadcast("vault-locked", () => setVaultState("locked"));
    const off2 = client.onBroadcast("vault-unlocked", () => setVaultState("unlocked"));
    return () => {
      off1();
      off2();
    };
  }, [client]);

  async function handleUnlock() {
    setError(null);
    const ok = await client.call<boolean>("vault.unlock", [pw]);
    if (!ok) setError("Incorrect password");
    setPw("");
  }

  if (vaultState === null) return null;

  // Filter out sessions the user has already verified — they've seen the
  // emojis and confirmed they matched. Remaining sessions are the new ones
  // (since browser start) that still need verification.
  const unverifiedSessions = activeSessions.filter(
    (s) => !verifiedSessionIds.has(s.sessionId),
  );

  // Active session verification takes precedence over the normal vault UI:
  // when the SW opened us because a session was just established
  // (`onSessionEstablished` → `chrome.action.openPopup()`), the user is here
  // to compare emojis with the dApp's display. That's a security-critical
  // moment, so it should be the first thing they see.
  if (unverifiedSessions.length > 0 && pendingDiscoveries.length === 0) {
    // TODO: design the active-session verification UI here.
    //
    // For each session, you have:
    //   - origin (the dApp's URL — anchor of trust)
    //   - appId (dApp's self-declared name)
    //   - verificationHash (string; pass to hashToEmoji to get an emoji string)
    //   - chainId / version
    //
    // The user's job: check that the emoji string we render here MATCHES the
    // emoji string the dApp shows on their end. Identical = handshake produced
    // matching shared secrets on both sides = no MITM. Different = something
    // is very wrong; the user should not trust this connection.
    //
    // Design considerations:
    //   - Make emojis BIG and easy to read at a glance
    //   - Show origin clearly (phishing protection)
    //   - Maybe label the emojis "Verify this matches the dApp"
    //   - Optional: add a "Disconnect" button per session for quick revoke
    //   - Optional: add a "Got it" / "Dismiss" to hide and return to vault UI
    //
    // The emojis come from: hashToEmoji(session.verificationHash)
    // (already imported at the top of this file).
    //
    // 15–25 lines of JSX is plenty for a v1.
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Verify connection
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Compare these emojis with what the dApp displays.
        </Typography>
        <Stack spacing={2} sx={{ mt: 2 }}>
          {unverifiedSessions.map((s) => (
            <Box key={s.sessionId} sx={{ border: "1px solid #444", p: 1.5, borderRadius: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {s.origin}
              </Typography>
              <Typography sx={{ fontSize: "1.5rem", letterSpacing: "0.2rem", mt: 1 }}>
                {hashToEmoji(s.verificationHash)}
              </Typography>
            </Box>
          ))}
        </Stack>
        <Button
          variant="contained"
          fullWidth
          sx={{ mt: 2 }}
          onClick={() => void markAllVerified()}
        >
          Emojis match — continue
        </Button>
      </Box>
    );
  }

  // Pending discovery takes priority over the regular vault UI. If the SW
  // opened us because a dApp asked, that's what the user wants to see first.
  // Approval doesn't expose any wallet data, so showing it even when locked
  // is fine (user still has to unlock to actually transact later).
  if (pendingDiscoveries.length > 0) {
    // TODO: design the discovery approval UI here.
    //
    // For each `pendingDiscoveries` entry you'll want to show:
    //   - origin (dApp's URL — most important security signal for the user)
    //   - appId (dApp's self-declared identifier)
    //   - chainId / version (which network the dApp expects)
    //   - Approve and Reject buttons
    //   - (optional) "Remember this dApp" checkbox; pass to approveDiscovery
    //
    // Action handlers are already defined above:
    //   approveDiscovery(requestId, remember)  -> sends approval, refreshes list
    //   rejectDiscovery(requestId)             -> rejects, refreshes list
    //
    // Trade-offs to think about:
    //   - One discovery at a time vs. queue all visible (rare but possible)
    //   - How prominent to make the origin text — phishing protection
    //   - Whether "remember" should be on by default (more friction-free)
    //     or off by default (more secure)
    //
    // 10–20 lines of JSX is plenty for a v1.
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Pending dApp connection
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Replace this with your design. {pendingDiscoveries.length} pending.
        </Typography>
        <Stack spacing={1} sx={{ mt: 2 }}>
          {pendingDiscoveries.map((d) => (
            <Box key={d.requestId} sx={{ border: "1px solid #444", p: 1, borderRadius: 1 }}>
              <Typography variant="body2">{d.origin}</Typography>
              <Typography variant="caption" color="text.secondary">
                appId={d.appId}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <Button size="small" variant="contained" onClick={() => approveDiscovery(d.requestId, false)}>
                  Approve
                </Button>
                <Button size="small" variant="text" onClick={() => rejectDiscovery(d.requestId)}>
                  Reject
                </Button>
              </Stack>
            </Box>
          ))}
        </Stack>
      </Box>
    );
  }

  if (vaultState === "uninitialized") {
    // TODO: implement the "no wallet yet" UI here.
    //
    // Constraints:
    //   - Popup is small (~380px wide). One headline + one button is plenty.
    //   - The button should open the onboarding tab:
    //         chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") })
    //   - On first-install Chrome already auto-opens onboarding, so this state
    //     is most likely reached when storage was wiped manually (test path)
    //     or onboarding was closed without finishing.
    //
    // Trade-offs to think about:
    //   - Hard nudge ("you must onboard first") vs. soft nudge ("set up here")
    //   - Whether to dismiss the popup on click (better flow, fewer surfaces)
    //     or keep it open (lets user see status as onboarding completes)
    //
    // 5–10 lines of JSX is plenty.
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Wallet not set up
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Replace this with your design.
        </Typography>
      </Box>
    );
  }

  if (vaultState === "locked") {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Wallet locked
        </Typography>
        <TextField
          type="password"
          label="Password"
          fullWidth
          margin="normal"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleUnlock();
          }}
        />
        {error && (
          <Typography color="error" variant="body2">
            {error}
          </Typography>
        )}
        <Button
          variant="contained"
          onClick={handleUnlock}
          fullWidth
          sx={{ mt: 2 }}
        >
          Unlock
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Aztec Wallet</Typography>
        <Typography variant="body2" color="text.secondary">
          Wallet unlocked. Use the expanded view for full features.
        </Typography>
        <Button
          variant="outlined"
          onClick={() => {
            chrome.tabs.create({
              url: chrome.runtime.getURL("expanded.html"),
            });
          }}
        >
          Open expanded view
        </Button>
        <Button variant="text" onClick={() => client.call("vault.lock", [])}>
          Lock
        </Button>
      </Stack>
    </Box>
  );
}
