// Naxie file-access policy (naxie-fs.ts): read-anywhere-minus-secrets,
// writes jailed to her folder, staged sends bound to one chat + expiring.
import { describe, expect, it, beforeEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertNaxieReadable,
  assertNaxieWritable,
  stageSend,
  claimSendToken,
  cancelSendToken,
  inboxPath,
  editedCopyPath,
  parseLocalCallback,
  localSendCallback,
  naxieHome,
} from "../src/lib/naxie-fs.js";

const tmpFile = join(tmpdir(), `naxie-fs-test-${process.pid}.txt`);
beforeEach(() => {
  writeFileSync(tmpFile, "hello");
});

describe("read gate", () => {
  it("allows ordinary files", () => {
    expect(assertNaxieReadable(tmpFile)).toContain("naxie-fs-test");
  });

  it("refuses secrets (env, keys, wallets, profiles)", () => {
    for (const p of [
      "C:\\Users\\op\\.env",
      "D:\\docs\\credentials.json",
      "D:\\docs\\backup.pem",
      "D:\\docs\\id_rsa",
      "C:\\Users\\op\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies",
      "D:\\vault\\wallet.dat",
      "D:\\notes\\entry.token",
    ]) {
      expect(() => assertNaxieReadable(p), p).toThrow(/Refused/);
    }
  });
});

describe("write gate", () => {
  it("allows her folder, refuses everywhere else", () => {
    const home = naxieHome();
    expect(assertNaxieWritable(join(home, "edits", "a.txt"))).toContain("a.txt");
    expect(() => assertNaxieWritable("C:\\Windows\\Temp\\x.txt")).toThrow(/her folder/);
    expect(() => assertNaxieWritable(join(home, "..", "escape.txt"))).toThrow(/her folder/);
  });
});

describe("staged sends", () => {
  it("stages, claims once, then expires", () => {
    const { token, staged } = stageSend(tmpFile, "chat-1");
    expect(token).toMatch(/^[0-9a-f]{16}$/);
    expect(localSendCallback(token).length).toBeLessThanOrEqual(64);
    expect(staged.name).toContain("naxie-fs-test");
    // Wrong chat refused, token intact.
    expect(() => claimSendToken(token, "chat-2")).toThrow(/different chat/);
    const claimed = claimSendToken(token, "chat-1");
    expect(claimed.path).toBe(staged.path);
    // Single-use.
    expect(() => claimSendToken(token, "chat-1")).toThrow(/expired or was already used/);
  });

  it("cancel removes without claiming", () => {
    const { token } = stageSend(tmpFile, "chat-1");
    expect(cancelSendToken(token, "chat-1")).toBe(true);
    expect(() => claimSendToken(token, "chat-1")).toThrow(/expired/);
    expect(cancelSendToken("0123456789abcdef", "chat-1")).toBe(false);
  });

  it("refuses missing files at stage time", () => {
    expect(() => stageSend(join(tmpdir(), "definitely-not-here-xyz.txt"), "chat-1")).toThrow();
  });
});

describe("paths", () => {
  it("inbox sanitizes names under her folder", () => {
    const p = inboxPath('a<b>:"c?.txt');
    expect(p.startsWith(naxieHome())).toBe(true);
    const base = p.split(/[\\/]/).pop() ?? "";
    expect(base).not.toMatch(/[<>:"|?*]/);
  });

  it("edited copies land in her folder, never over originals", () => {
    const p = editedCopyPath(tmpFile);
    expect(p.startsWith(naxieHome())).toBe(true);
    expect(p).not.toBe(tmpFile);
  });
});

describe("callback parse", () => {
  it("parses send/cancel with hex tokens", () => {
    const t = "0123456789abcdef";
    expect(parseLocalCallback(`local:send:${t}`)).toEqual({ action: "send", token: t });
    expect(parseLocalCallback(`local:cancel:${t}`)).toEqual({ action: "cancel", token: t });
    expect(parseLocalCallback("approval:approve:x")).toBeNull();
    expect(parseLocalCallback("local:send:short")).toBeNull();
  });
});

rmSync(tmpFile, { force: true });
