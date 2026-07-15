import type { Aliased } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { contextBridge, ipcRenderer } from "electron";
import type { TxHash, TxReceipt } from "@aztec/stdlib/tx";
import type { WalletInteraction, WalletInteractionType } from "@demo-wallet/shared/core";

contextBridge.exposeInMainWorld("walletAPI", {
  getTxReceipt(stringifiedArgs: string): Promise<TxReceipt> {
    return ipcRenderer.invoke("getTxReceipt", stringifiedArgs);
  },
  registerSender(stringifiedArgs: string): Promise<AztecAddress> {
    return ipcRenderer.invoke("registerSender", stringifiedArgs);
  },
  getAddressBook(stringifiedArgs: string): Promise<Aliased<AztecAddress>[]> {
    return ipcRenderer.invoke("getAddressBook", stringifiedArgs);
  },
  getAccounts(stringifiedArgs: string): Promise<Aliased<AztecAddress>[]> {
    return ipcRenderer.invoke("getAccounts", stringifiedArgs);
  },
  createAccount(stringifiedArgs: string): Promise<TxHash> {
    return ipcRenderer.invoke("createAccount", stringifiedArgs);
  },
  deployAccount(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("deployAccount", stringifiedArgs);
  },
  getInteractions(stringifiedArgs: string): Promise<WalletInteraction<WalletInteractionType>[]> {
    return ipcRenderer.invoke("getInteractions", stringifiedArgs);
  },
  deleteInteraction(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("deleteInteraction", stringifiedArgs);
  },
  clearInteractions(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("clearInteractions", stringifiedArgs);
  },
  getExecutionTrace(stringifiedArgs: string): Promise<any> {
    return ipcRenderer.invoke("getExecutionTrace", stringifiedArgs);
  },
  // App authorization management
  listAuthorizedApps(stringifiedArgs: string): Promise<string[]> {
    return ipcRenderer.invoke("listAuthorizedApps", stringifiedArgs);
  },
  getAppCapabilities(stringifiedArgs: string): Promise<any> {
    return ipcRenderer.invoke("getAppCapabilities", stringifiedArgs);
  },
  resolveContractNames(stringifiedArgs: string): Promise<Record<string, string>> {
    return ipcRenderer.invoke("resolveContractNames", stringifiedArgs);
  },
  capabilityToStorageKeys(stringifiedArgs: string): Promise<string[]> {
    return ipcRenderer.invoke("capabilityToStorageKeys", stringifiedArgs);
  },
  storeCapabilityGrants(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("storeCapabilityGrants", stringifiedArgs);
  },
  revokeCapability(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("revokeCapability", stringifiedArgs);
  },
  updateAccountAuthorization(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("updateAccountAuthorization", stringifiedArgs);
  },
  updateAddressBookAuthorization(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("updateAddressBookAuthorization", stringifiedArgs);
  },
  revokeAuthorization(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("revokeAuthorization", stringifiedArgs);
  },
  revokeAppAuthorizations(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("revokeAppAuthorizations", stringifiedArgs);
  },
  onWalletUpdate(callback: (eventData: unknown) => void) {
    const listener = (_event: unknown, eventData: unknown) => callback(eventData);
    ipcRenderer.on("wallet-update", listener);
    return () => ipcRenderer.off("wallet-update", listener);
  },
  onAuthorizationRequest(callback: (eventData: unknown) => void) {
    const listener = (_event: unknown, eventData: unknown) => callback(eventData);
    ipcRenderer.on("authorization-request", listener);
    return () => ipcRenderer.off("authorization-request", listener);
  },
  resolveAuthorization(stringifiedArgs: string) {
    return ipcRenderer.invoke("resolveAuthorization", stringifiedArgs);
  },
  // Interactive handshakes
  respondToInteractiveHandshake(stringifiedArgs: string): Promise<string> {
    return ipcRenderer.invoke("respondToInteractiveHandshake", stringifiedArgs);
  },
  resolveHandshakeRelay(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("resolveHandshakeRelay", stringifiedArgs);
  },
  setSenderPrivateChannel(stringifiedArgs: string): Promise<void> {
    return ipcRenderer.invoke("setSenderPrivateChannel", stringifiedArgs);
  },
  getSenderPrivateChannels(stringifiedArgs: string): Promise<Record<string, boolean>> {
    return ipcRenderer.invoke("getSenderPrivateChannels", stringifiedArgs);
  },
  onHandshakeRelayRequest(callback: (eventData: unknown) => void) {
    const listener = (_event: unknown, eventData: unknown) => callback(eventData);
    ipcRenderer.on("handshake-relay-request", listener);
    return () => ipcRenderer.off("handshake-relay-request", listener);
  },
  // Proof debug export
  saveProofDebugData(
    base64Data: string,
  ): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> {
    return ipcRenderer.invoke("saveProofDebugData", base64Data);
  },
  onProofDebugExportRequest(callback: (eventData: unknown) => void) {
    return ipcRenderer.on("proof-debug-export-request", (_event, eventData) => callback(eventData));
  },
});
