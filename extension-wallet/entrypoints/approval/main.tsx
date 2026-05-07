import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, createTheme, CssBaseline } from "@mui/material";
import { Fr } from "@aztec/aztec.js/fields";
import { AuthorizationDialog, WalletContext } from "@demo-wallet/shared/ui";
import type {
  AuthorizationRequest,
  AuthorizationItemResponse,
} from "@demo-wallet/shared/core";
import { PortClient } from "../../src/ipc/port-client";
import { makePortWalletApi } from "../../src/ui/port-wallet-api";

function Approval() {
  const [client] = useState(() => {
    const c = new PortClient();
    c.connect();
    return c;
  });
  const [request, setRequest] = useState<AuthorizationRequest | null>(null);
  const [walletAPI, setWalletAPI] = useState<ReturnType<typeof makePortWalletApi> | null>(
    null,
  );
  const resolved = useRef(false);
  const requestId = new URLSearchParams(window.location.search).get("requestId");

  // Resolve current chain → build a port-backed wallet API for the dialog.
  useEffect(() => {
    void (async () => {
      const net = await client.call<{ chainId: string; version: string }>(
        "network.get",
        [],
      );
      setWalletAPI(
        makePortWalletApi(client, Fr.fromString(net.chainId), Fr.fromString(net.version)),
      );
    })();
  }, [client]);

  // Fetch pending requests, find the one matching our requestId.
  useEffect(() => {
    if (!requestId) return;
    void (async () => {
      const pending = await client.call<AuthorizationRequest[]>(
        "authorization.getPending",
        [],
      );
      const found = pending.find((r) => r.id === requestId);
      if (found) setRequest(found);
    })();
  }, [client, requestId]);

  // Window-close = denial (only if the user hasn't already resolved).
  useEffect(() => {
    function onUnload() {
      if (resolved.current || !request) return;
      const itemResponses: Record<string, AuthorizationItemResponse> = {};
      for (const item of request.items) {
        itemResponses[item.id] = {
          id: item.id,
          approved: false,
          appId: item.appId,
        };
      }
      // Best-effort: postMessage on a port runs synchronously; the offscreen
      // may or may not see it before the SW unloads us.
      void client.call("authorization.resolve", [
        { id: request.id, approved: false, appId: request.appId, itemResponses },
      ]);
    }
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [client, request]);

  if (!request || !walletAPI) return null;

  const handleApprove = async (
    itemResponses: Record<string, AuthorizationItemResponse>,
  ) => {
    resolved.current = true;
    await client.call("authorization.resolve", [
      { id: request.id, approved: true, appId: request.appId, itemResponses },
    ]);
    window.close();
  };

  const handleDeny = async () => {
    resolved.current = true;
    const itemResponses: Record<string, AuthorizationItemResponse> = {};
    for (const item of request.items) {
      itemResponses[item.id] = {
        id: item.id,
        approved: false,
        appId: item.appId,
      };
    }
    await client.call("authorization.resolve", [
      { id: request.id, approved: false, appId: request.appId, itemResponses },
    ]);
    window.close();
  };

  return (
    <WalletContext.Provider value={{ walletAPI }}>
      <AuthorizationDialog
        request={request}
        queueLength={1}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
    </WalletContext.Provider>
  );
}

const theme = createTheme({ palette: { mode: "dark" } });

createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <Approval />
  </ThemeProvider>,
);
