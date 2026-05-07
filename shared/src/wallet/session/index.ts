// Public API only — test seams (`__*ForTests`) and factory-type aliases stay
// internal. Tests import them directly from "./session" via a relative path.
export {
  getOrCreateSession,
  getRunningSessionIds,
  getSharedResources,
} from "./session";
export type { SessionData, SharedResources } from "./session";
