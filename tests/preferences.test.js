import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { DEFAULT_PREFERENCES, PreferencesPanel } from "../src/preferences.ts";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const originalGlobals = new Map();
let dom;

beforeEach(() => {
  dom = new JSDOM(html);
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  clearMocks();
  dom.window.close();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

async function fixture(initial = DEFAULT_PREFERENCES) {
  let saved = structuredClone(initial);
  const changes = [];
  mockIPC((command, args) => {
    if (command === "get_preferences") return structuredClone(saved);
    if (command === "save_preferences") {
      saved = structuredClone(args.preferences);
      return structuredClone(saved);
    }
    if (command === "reset_preferences") {
      saved = structuredClone(DEFAULT_PREFERENCES);
      return structuredClone(saved);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const panel = new PreferencesPanel({
    onChange: (preferences) => changes.push(preferences),
    onTestNotification: async () => "",
    onCustomSound: async () => "",
    onRemoveCustomSound: async () => {},
  });
  await panel.load();
  return { panel, changes, saved: () => saved };
}

test("chat sync defaults to automatic, and its manual adjustment saves and reloads", async () => {
  const f = await fixture();
  const automatic = document.querySelector("#sync-chat-to-video");
  const adjustment = document.querySelector("#chat-sync-offset");
  assert.equal(automatic.checked, true);
  assert.equal(adjustment.value, "0");
  assert.equal(adjustment.disabled, false);
  adjustment.value = "2.5";
  adjustment.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(f.changes.at(-1).syncChatToVideo, true);
  assert.equal(f.changes.at(-1).chatSyncOffset, 2.5);
  assert.equal(document.querySelector("#chat-sync-offset-value").value, "+2.5s");
  await f.panel.flushPendingSave();
  assert.equal(f.saved().chatSyncOffset, 2.5);
  assert.equal(f.saved().version, 8);
  adjustment.value = "0";
  await f.panel.load();
  assert.equal(adjustment.value, "2.5");
});

test("turning sync off preserves the saved adjustment and disables its control", async () => {
  const f = await fixture({ ...DEFAULT_PREFERENCES, chatSyncOffset: -1.5 });
  const automatic = document.querySelector("#sync-chat-to-video");
  const adjustment = document.querySelector("#chat-sync-offset");
  automatic.checked = false;
  automatic.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(adjustment.disabled, true);
  assert.equal(document.querySelector("#chat-sync-offset-value").value, "-1.5s");
  await f.panel.flushPendingSave();
  assert.equal(f.saved().syncChatToVideo, false);
  assert.equal(f.saved().chatSyncOffset, -1.5);
  await f.panel.load();
  assert.equal(automatic.checked, false);
  assert.equal(adjustment.value, "-1.5");
  automatic.checked = true;
  automatic.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(adjustment.disabled, false);
  assert.equal(f.changes.at(-1).chatSyncOffset, -1.5);
  await f.panel.flushPendingSave();
});

test("deleted messages default to gray, and removal saves and reloads from Chat settings", async () => {
  const f = await fixture();
  const behavior = document.querySelector("#deleted-message-behavior");
  assert.equal(DEFAULT_PREFERENCES.deletedMessageBehavior, "dim");
  assert.equal(behavior.closest("[data-settings-panel]").dataset.settingsPanel, "chat");
  assert.equal(behavior.value, "dim");
  assert.deepEqual([...behavior.options].map((option) => [option.value, option.textContent]), [
    ["dim", "Keep visible in gray"],
    ["remove", "Remove from chat"],
  ]);

  behavior.value = "remove";
  behavior.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(f.changes.at(-1).deletedMessageBehavior, "remove");
  await f.panel.flushPendingSave();
  assert.equal(f.saved().deletedMessageBehavior, "remove");
  assert.equal(f.saved().version, 8);

  behavior.value = "dim";
  await f.panel.load();
  assert.equal(behavior.value, "remove");
});

test("reset restores gray deleted messages and invalid selections use the default", async () => {
  const f = await fixture({ ...DEFAULT_PREFERENCES, deletedMessageBehavior: "remove" });
  const behavior = document.querySelector("#deleted-message-behavior");
  assert.equal(behavior.value, "remove");
  window.confirm = () => true;
  document.querySelector("#settings-reset").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(behavior.value, "dim");
  assert.equal(f.saved().deletedMessageBehavior, "dim");
  assert.equal(f.changes.at(-1).deletedMessageBehavior, "dim");

  behavior.value = "unsupported";
  behavior.dispatchEvent(new window.Event("input", { bubbles: true }));
  await f.panel.flushPendingSave();
  assert.equal(f.saved().deletedMessageBehavior, "dim");
});
