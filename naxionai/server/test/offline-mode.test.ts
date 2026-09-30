// Offline mode — host classification, the global fetch/socket guard, and
// LLM routing staying local. Uses the in-memory test hooks only (no writes
// to .neuroworks/offline-mode.json).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import net from "node:net";
import {
  isLocalHost,
  isLocalUrl,
  assertOnline,
  installOfflineNetworkGuard,
  OfflineError,
  _setOfflineForTests,
  _uninstallOfflineNetworkGuardForTests,
} from "../src/lib/offline-mode.js";

describe("isLocalHost", () => {
  const local = ["localhost", "127.0.0.1", "127.8.9.1", "::1", "[::1]", "10.0.0.5", "172.16.0.1", "172.31.255.255",
    "192.168.1.20", "169.254.3.4", "fd12:3456::1", "fe80::1", "nas.local", "0.0.0.0", "::ffff:192.168.0.2", ""];
  const remote = ["example.com", "api.openai.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "2001:4860::8888", "11.0.0.1"];
  for (const h of local) it(`treats "${h}" as local`, () => expect(isLocalHost(h)).toBe(true));
  for (const h of remote) it(`treats "${h}" as internet`, () => expect(isLocalHost(h)).toBe(false));

  it("classifies URLs", () => {
    expect(isLocalUrl("http://127.0.0.1:11434/api/tags")).toBe(true);
    expect(isLocalUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });
});

describe("assertOnline", () => {
  afterEach(() => _setOfflineForTests(false));
  it("is a no-op while online", () => {
    _setOfflineForTests(false);
    expect(() => assertOnline("https://example.com")).not.toThrow();
  });
  it("throws OfflineError for public targets while offline, allows LAN", () => {
    _setOfflineForTests(true);
    expect(() => assertOnline("https://example.com/x")).toThrow(OfflineError);
    expect(() => assertOnline("http://192.168.1.2:8080")).not.toThrow();
  });
});

describe("network guard", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => { res.end("ok"); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as net.AddressInfo).port;
    installOfflineNetworkGuard();
  });
  afterAll(async () => {
    _uninstallOfflineNetworkGuardForTests();
    _setOfflineForTests(false);
    await new Promise<void>(r => server.close(() => r()));
  });
  afterEach(() => _setOfflineForTests(false));

  it("lets local fetches through while offline", async () => {
    _setOfflineForTests(true);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe("ok");
  });

  it("blocks public fetches while offline without touching the network", async () => {
    _setOfflineForTests(true);
    await expect(fetch("https://example.com/")).rejects.toBeInstanceOf(OfflineError);
    await expect(fetch(new URL("https://api.openai.com/v1/models"))).rejects.toThrow(/offline mode/);
  });

  it("blocks raw sockets to public hosts while offline", async () => {
    _setOfflineForTests(true);
    const err = await new Promise<Error>((resolve) => {
      const s = net.connect({ host: "8.8.8.8", port: 53 });
      s.on("error", resolve);
      s.on("connect", () => { s.destroy(); resolve(new Error("connected")); });
    });
    expect(err).toBeInstanceOf(OfflineError);
  });

  it("allows raw sockets to local hosts while offline", async () => {
    _setOfflineForTests(true);
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(); });
      s.on("error", reject);
    });
  });
});

describe("LLM routing while offline", () => {
  afterEach(() => _setOfflineForTests(false));
  it("always picks local ollama, even for complex synthesis", async () => {
    const { _chooseBackendAndModelForTests } = await import("../src/lib/llm.js");
    _setOfflineForTests(true);
    const r = await _chooseBackendAndModelForTests({ profile: "synthesis", complexity: "high" }, "x".repeat(40_000), undefined);
    expect(r.backend).toBe("ollama");
    expect(r.reason).toMatch(/offline/);
    const explicitRemote = await _chooseBackendAndModelForTests({ model: "openai/gpt-4o" }, "hi", undefined);
    expect(explicitRemote.backend).toBe("ollama");
    expect(explicitRemote.model).not.toBe("openai/gpt-4o");
  });
});
