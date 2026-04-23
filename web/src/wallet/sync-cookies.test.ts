import { describe, it, expect, beforeEach } from "vitest";

/**
 * Minimal `document.cookie` shim that behaves like the real one for the
 * subset we use: each assignment sets or expires a single cookie, and the
 * getter returns `"name1=val1; name2=val2"` for all live cookies.
 */
function installCookieShim() {
  const jar = new Map<string, string>();
  const doc = {
    get cookie() {
      return Array.from(jar.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    },
    set cookie(raw: string) {
      const [head, ...rest] = raw.split(";").map((s) => s.trim());
      const eq = head.indexOf("=");
      if (eq === -1) return;
      const name = head.slice(0, eq);
      const value = head.slice(eq + 1);
      const expired = rest.some((a) => /^max-age=0$/i.test(a));
      if (expired) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    },
  };
  // @ts-expect-error — global document shim for tests
  globalThis.document = doc;
  return {
    jar,
    cookieString: () => doc.cookie,
  };
}

// Import AFTER the shim is installed so the module sees the patched globals.
async function loadModule() {
  return await import("./sync-cookies.ts");
}

describe("sync-cookies: chunked capability cookies", () => {
  let shim: ReturnType<typeof installCookieShim>;

  beforeEach(() => {
    shim = installCookieShim();
  });

  it("round-trips a small payload through write/read", async () => {
    const { writeCapabilitiesCookies, readCapabilitiesCookies } = await loadModule();
    const input = [
      {
        appId: "https://example.com",
        entries: { getAccounts: { persistent: true, grantedAt: 1 } },
      },
    ];

    await writeCapabilitiesCookies(input, "correct horse battery staple");
    const out = await readCapabilitiesCookies("correct horse battery staple");

    expect(out).toEqual(input);
  });

  it("emits chunked cookies for a large payload and round-trips them", async () => {
    const { writeCapabilitiesCookies, readCapabilitiesCookies } = await loadModule();

    // Build a capability blob that produces > 4000 chars of base64
    // post-compression. Random data is worst-case for gzip (incompressible),
    // which forces multiple chunks even after compression.
    const bigRandomHex = Array.from({ length: 20 })
      .map(() => {
        const bytes = new Uint8Array(1024);
        crypto.getRandomValues(bytes);
        return Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      })
      .join("");

    const input = [
      {
        appId: "https://example.com",
        entries: { bulk: bigRandomHex },
      },
    ];

    await writeCapabilitiesCookies(input, "pw");

    // At least two numbered chunk cookies should exist
    expect(shim.jar.has("aztec-wallet-caps-0")).toBe(true);
    expect(shim.jar.has("aztec-wallet-caps-1")).toBe(true);

    const out = await readCapabilitiesCookies("pw");
    expect(out).toEqual(input);
  });

  it("shrinks the cookie set when a subsequent write is smaller", async () => {
    const { writeCapabilitiesCookies, readCapabilitiesCookies } = await loadModule();

    // First write: large, produces multiple chunks.
    const bigRandom = Array.from({ length: 20 })
      .map(() => {
        const bytes = new Uint8Array(1024);
        crypto.getRandomValues(bytes);
        return Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      })
      .join("");
    await writeCapabilitiesCookies(
      [{ appId: "https://a.com", entries: { bulk: bigRandom } }],
      "pw",
    );
    const chunksAfterBig = [...shim.jar.keys()].filter((k) =>
      k.startsWith("aztec-wallet-caps-"),
    ).length;
    expect(chunksAfterBig).toBeGreaterThan(1);

    // Second write: tiny. Leftover chunk cookies must be expired.
    await writeCapabilitiesCookies(
      [{ appId: "https://a.com", entries: { x: 1 } }],
      "pw",
    );
    const chunksAfterSmall = [...shim.jar.keys()].filter((k) =>
      k.startsWith("aztec-wallet-caps-"),
    ).length;
    expect(chunksAfterSmall).toBe(1);

    const out = await readCapabilitiesCookies("pw");
    expect(out).toEqual([{ appId: "https://a.com", entries: { x: 1 } }]);
  });

  it("compresses repetitive JSON below the raw JSON size (sanity check)", async () => {
    const { writeCapabilitiesCookies } = await loadModule();

    // Highly repetitive capability-shaped data — the real-world case.
    const addrs = Array.from({ length: 100 }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`);
    const input = [
      {
        appId: "https://repeat.example.com",
        entries: Object.fromEntries(
          addrs.map((a) => [
            `registerContract:${a}`,
            { persistent: true, grantedAt: 1745420000000 },
          ]),
        ),
      },
    ];
    const rawJsonBytes = new TextEncoder().encode(JSON.stringify(input)).length;

    await writeCapabilitiesCookies(input, "pw");
    const totalCookieBytes = [...shim.jar.entries()]
      .filter(([k]) => k.startsWith("aztec-wallet-caps-"))
      .reduce((sum, [k, v]) => sum + k.length + 1 + v.length, 0);

    // Post-compress + base64 should comfortably beat the raw JSON size,
    // even including AES-GCM overhead and base64 expansion.
    expect(totalCookieBytes).toBeLessThan(rawJsonBytes);
  });

  it("wrong passphrase causes read to throw (not silently return empty)", async () => {
    const { writeCapabilitiesCookies, readCapabilitiesCookies } = await loadModule();
    await writeCapabilitiesCookies(
      [{ appId: "https://a.com", entries: { x: 1 } }],
      "right",
    );
    await expect(readCapabilitiesCookies("wrong")).rejects.toBeDefined();
  });

  it("read returns empty array when no cookies are set", async () => {
    const { readCapabilitiesCookies } = await loadModule();
    expect(await readCapabilitiesCookies("pw")).toEqual([]);
  });

  it("hasCapabilitiesCookies reflects cookie presence", async () => {
    const { hasCapabilitiesCookies, writeCapabilitiesCookies, clearCapabilitiesCookies } =
      await loadModule();
    expect(hasCapabilitiesCookies()).toBe(false);

    await writeCapabilitiesCookies(
      [{ appId: "https://a.com", entries: { x: 1 } }],
      "pw",
    );
    expect(hasCapabilitiesCookies()).toBe(true);

    clearCapabilitiesCookies();
    expect(hasCapabilitiesCookies()).toBe(false);
  });
});

describe("sync-cookies: chunked contacts cookies", () => {
  beforeEach(() => {
    installCookieShim();
  });

  it("round-trips contacts through write/read", async () => {
    const { writeContactsCookies, readContactsCookies } = await loadModule();

    const contacts = [
      { address: new Uint8Array(32).fill(1), alias: "Alice" },
      { address: new Uint8Array(32).fill(2), alias: "Bob" },
    ];

    await writeContactsCookies(contacts, "pw");
    const out = await readContactsCookies("pw");

    expect(out).toHaveLength(2);
    expect(out[0].alias).toBe("Alice");
    expect(Array.from(out[0].address)).toEqual(Array.from(contacts[0].address));
    expect(out[1].alias).toBe("Bob");
  });
});
