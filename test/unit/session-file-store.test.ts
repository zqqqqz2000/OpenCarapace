import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { FileSessionStore, SessionManager } from "../../src/core/session.js";

describe("FileSessionStore", () => {
  test("merges writes from multiple store instances sharing one file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-session-file-race-"));
    const filePath = path.join(dir, "sessions.json");

    const sessionsA = new SessionManager(new FileSessionStore({ filePath }));
    const sessionsB = new SessionManager(new FileSessionStore({ filePath }));

    sessionsA.appendMessage("s-old", "codex", {
      role: "user",
      content: "old",
      createdAt: Date.now(),
    });
    sessionsB.appendMessage("s-new", "codex", {
      role: "user",
      content: "new",
      createdAt: Date.now(),
    });

    const reloaded = new SessionManager(new FileSessionStore({ filePath }));
    const ids = reloaded.list().map((item) => item.id).sort();
    expect(ids).toEqual(["s-new", "s-old"]);
  });

  test("persists messages and metadata across store instances", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-session-file-"));
    const filePath = path.join(dir, "sessions.json");

    const storeA = new FileSessionStore({ filePath });
    const sessionsA = new SessionManager(storeA);
    sessionsA.appendMessage("s1", "codex", {
      role: "user",
      content: "first",
      createdAt: Date.now(),
    });
    sessionsA.appendMessage("s1", "codex", {
      role: "assistant",
      content: "reply",
      createdAt: Date.now(),
    });
    sessionsA.setMetadata("s1", "codex", {
      codex_thread_id: "thread-1",
      model: "gpt-5",
    });

    expect(fs.existsSync(filePath)).toBeTrue();

    const storeB = new FileSessionStore({ filePath });
    const sessionsB = new SessionManager(storeB);
    const snapshot = sessionsB.snapshot("s1");

    expect(snapshot?.messages.length).toBe(2);
    expect(snapshot?.messages[0]?.role).toBe("user");
    expect(snapshot?.messages[1]?.role).toBe("assistant");
    const metadata = sessionsB.getMetadata("s1");
    expect(metadata.codex_thread_id).toBe("thread-1");
    expect(metadata.model).toBe("gpt-5");
  });

  test("deletes session and flushes to disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-session-file-delete-"));
    const filePath = path.join(dir, "sessions.json");
    const store = new FileSessionStore({ filePath });
    const sessions = new SessionManager(store);

    sessions.appendMessage("s-delete", "codex", {
      role: "user",
      content: "hello",
      createdAt: Date.now(),
    });
    expect(sessions.snapshot("s-delete")).toBeDefined();

    sessions.delete("s-delete");
    expect(sessions.snapshot("s-delete")).toBeUndefined();

    const reloaded = new SessionManager(new FileSessionStore({ filePath }));
    expect(reloaded.snapshot("s-delete")).toBeUndefined();
  });

  test("persists scoped preferences and keeps internal scope records out of session list", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-carapace-session-file-scoped-"));
    const filePath = path.join(dir, "sessions.json");
    const sessionsA = new SessionManager(new FileSessionStore({ filePath }));

    sessionsA.setGlobalMetadata({
      model: "gpt-5.1",
      thinking_depth: "high",
    });
    sessionsA.setWorkspaceMetadata("agent.alpha.telegram.chat.main", {
      sandbox_mode: "workspace-write",
    });

    const sessionsB = new SessionManager(new FileSessionStore({ filePath }));
    const metadata = sessionsB.getMetadata("agent.alpha.telegram.chat.thread");
    expect(metadata.model).toBe("gpt-5.1");
    expect(metadata.thinking_depth).toBe("high");
    expect(metadata.sandbox_mode).toBe("workspace-write");
    expect(sessionsB.list()).toEqual([]);
  });
});
