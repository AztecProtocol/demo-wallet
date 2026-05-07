// Public API only — test seams (`__*ForTests`) and factory-type aliases stay
// internal. Tests import them directly from "./session" via a relative path.
export {
  getOrCreateSession,
  getRunningSessionIds,
  getSharedResources,
  setStoreFactory,
} from "./session";
export type { SessionData, SharedResources, StoreFactory } from "./session";
