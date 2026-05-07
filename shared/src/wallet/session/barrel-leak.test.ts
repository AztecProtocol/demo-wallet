import { describe, it, expect } from "vitest";

// Pulls in the barrel only, the same way `@demo-wallet/shared/core` re-exports it.
import * as barrel from "./index";

describe("session barrel", () => {
  it("does not leak test seams", () => {
    expect("__resetSessionsForTests" in barrel).toBe(false);
    expect("__setSharedResourcesFactoryForTests" in barrel).toBe(false);
    expect("__setNodeClientFactoryForTests" in barrel).toBe(false);
  });

  it("re-exports the public surface", () => {
    expect("getOrCreateSession" in barrel).toBe(true);
    expect("getRunningSessionIds" in barrel).toBe(true);
    expect("getSharedResources" in barrel).toBe(true);
  });
});
