import type { Aliased } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { contextBridge, ipcRenderer } from "electron";
import type { TxHash, TxReceipt } from "@aztec/stdlib/tx";
import type {
  WalletInteraction,
  WalletInteractionType,
} from "@demo-wallet/shared/core";

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
  getInteractions(
    stringifiedArgs: string
  ): Promise<WalletInteraction<WalletInteractionType>[]> {
    return ipcRenderer.invoke("getInteractions", stringifiedArgs);
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
  onWalletUpdate(callback) {
    const listener = (_event: any, eventData: any) => callback(eventData);
    ipcRenderer.on("wallet-update", listener);
    return () => ipcRenderer.off("wallet-update", listener);
  },
  onAuthorizationRequest(callback) {
    const listener = (_event: any, eventData: any) => callback(eventData);
    ipcRenderer.on("authorization-request", listener);
    return () => ipcRenderer.off("authorization-request", listener);
  },
  resolveAuthorization(stringifiedArgs: string) {
    return ipcRenderer.invoke("resolveAuthorization", stringifiedArgs);
  },
  // Proof debug export
  saveProofDebugData(
    base64Data: string
  ): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> {
    return ipcRenderer.invoke("saveProofDebugData", base64Data);
  },
  onProofDebugExportRequest(callback) {
    return ipcRenderer.on("proof-debug-export-request", (_event, eventData) =>
      callback(eventData)
    );
  },
});
