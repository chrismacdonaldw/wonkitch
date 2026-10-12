import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { ChatAutoscroll, PlayerControlsVisibility } from "../src/interactions.ts";

const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });

function fixture() {
  const dom = new JSDOM('<section id="stage"><div id="controls"><input id="volume" type="range" /></div></section><div id="chat" tabindex="0"></div><button id="jump"></button><button id="other"></button>');
  const { window } = dom;
  const document = window.document;
  const stage = document.querySelector("#stage");
  const controls = document.querySelector("#controls");
  const volume = document.querySelector("#volume");
  const log = document.querySelector("#chat");
  const jump = document.querySelector("#jump");
  stage.getBoundingClientRect = () => ({ left: 0, right: 800, top: 0, bottom: 600 });
  log.getBoundingClientRect = () => ({ left: 800, right: 1000, top: 0, bottom: 600 });
  let height = 1000;
  let top = 800;
  Object.defineProperties(log, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 200 },
    clientWidth: { get: () => 196 },
    scrollTop: { get: () => top, set: (value) => { top = Math.max(0, Math.min(height - 200, value)); } },
  });
  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const tick = () => {
    const ready = [...frames.values()];
    frames.clear();
    for (const callback of ready) callback(0);
  };
  let pauseOnHover = false;
  let dismissed = 0;
  let chat;
  chat = new ChatAutoscroll(log, jump, {
    pauseOnHover: () => pauseOnHover,
    dismissPreview: () => { dismissed++; chat.setPreview(false); },
  });
  const player = new PlayerControlsVisibility(stage, controls);
  cleanup.push(() => { chat.dispose(); player.dispose(); dom.window.close(); });
  const pointer = (target, type, x = 100, y = 100, id = 1, extra = {}) => {
    const event = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...extra });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: extra.pointerType ?? "mouse" } });
    target.dispatchEvent(event);
  };
  const scroll = (value) => { log.scrollTop = value; log.dispatchEvent(new window.Event("scroll")); };
  const wheel = (deltaY) => log.dispatchEvent(new window.WheelEvent("wheel", { deltaY, bubbles: true }));
  const append = (amount = 200) => { height += amount; chat.flush(); };
  return { window, document, stage, controls, volume, log, jump, chat, player, tick, pointer, scroll, wheel, append,
    hoverPause: (value) => { pauseOnHover = value; }, dismissed: () => dismissed, frames };
}

test("volume mouse focus does not pin the entire controls bar after a drag ends outside the player", () => {
  const f = fixture();
  f.pointer(f.volume, "pointerdown", 200, 550);
  f.volume.focus();
  assert.equal(f.stage.classList.contains("controls-visible"), true);
  f.pointer(f.stage, "pointerleave", 900, 550);
  assert.equal(f.stage.classList.contains("controls-visible"), true, "keep controls usable during the volume drag");
  f.pointer(f.window, "pointerup", 900, 550);
  assert.equal(f.document.activeElement, f.volume);
  assert.equal(f.stage.classList.contains("controls-visible"), false);
});

test("a missing mouse-up is recovered by lost capture or window blur", () => {
  for (const interruption of ["lostpointercapture", "blur"]) {
    const f = fixture();
    f.pointer(f.volume, "pointerdown", 200, 550);
    f.volume.focus();
    if (interruption === "blur") f.window.dispatchEvent(new f.window.Event("blur"));
    else f.pointer(f.volume, interruption);
    assert.equal(f.stage.classList.contains("controls-visible"), false, interruption);
  }
});

test("fresh pointer movement without buttons recovers a release missed in native UI", () => {
  const f = fixture();
  f.pointer(f.volume, "pointerdown", 200, 550, 1, { buttons: 1 });
  f.pointer(f.stage, "pointermove", 500, 400, 1, { buttons: 1 });
  f.pointer(f.window, "pointermove", 950, 400);
  assert.equal(f.stage.classList.contains("controls-visible"), false);
});

test("an overlay in front of the player or chat does not count as hovering underneath it", () => {
  const f = fixture();
  const overlay = f.document.querySelector("#other");
  f.pointer(f.stage, "pointerenter");
  f.pointer(overlay, "pointermove", 200, 400);
  assert.equal(f.stage.classList.contains("controls-visible"), false);
  f.hoverPause(true);
  f.pointer(f.log, "pointerenter", 950);
  f.append(500);
  f.pointer(overlay, "pointermove", 950);
  f.tick();
  assert.equal(f.log.scrollTop, 1300);
});

test("native move/resize cleanup removes stale hover and focus until fresh pointer input", () => {
  const f = fixture();
  f.pointer(f.stage, "pointerenter");
  f.volume.focus();
  f.player.interrupt();
  assert.equal(f.stage.classList.contains("controls-visible"), false);
  f.pointer(f.stage, "pointermove");
  assert.equal(f.stage.classList.contains("controls-visible"), true);
  f.pointer(f.window, "pointermove", 950);
  assert.equal(f.stage.classList.contains("controls-visible"), false);
});

test("keyboard navigation keeps player controls visible while they have keyboard focus", async () => {
  const f = fixture();
  f.document.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  f.volume.focus();
  assert.equal(f.stage.classList.contains("controls-visible"), true);
  f.pointer(f.window, "pointermove", 950);
  assert.equal(f.stage.classList.contains("controls-visible"), true);
  f.document.querySelector("#other").focus();
  await Promise.resolve();
  assert.equal(f.stage.classList.contains("controls-visible"), false);
});

test("keyboard volume adjustment remains available after a pointer click", () => {
  const f = fixture();
  f.pointer(f.volume, "pointerdown", 200, 550);
  f.volume.focus();
  f.pointer(f.window, "pointerup", 950, 550);
  assert.equal(f.stage.classList.contains("controls-visible"), false);
  f.volume.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(f.stage.classList.contains("controls-visible"), true);
});

test("chat resumes after interrupted emote inspection even if browser scroll anchoring fires first", () => {
  const f = fixture();
  f.chat.setPreview(true);
  f.append();
  f.append();
  assert.equal(f.log.scrollTop, 800);
  assert.equal(f.jump.classList.contains("visible"), true);
  f.chat.setPreview(false);
  f.scroll(800); // Anchoring/trim scroll event used to cancel the pending resume.
  f.chat.interrupt();
  f.tick();
  assert.equal(f.log.scrollTop, 1200);
  assert.equal(f.jump.classList.contains("visible"), false);
  f.append();
  assert.equal(f.log.scrollTop, 1400);
});

test("pause-on-hover resumes on pointer leave or native interruption after many new messages", () => {
  for (const interruption of ["leave", "native", "blur", "cancel"]) {
    const f = fixture();
    f.hoverPause(true);
    f.pointer(f.log, "pointerenter", 950);
    f.append(500);
    assert.equal(f.log.scrollTop, 800);
    if (interruption === "leave") f.pointer(f.log, "pointerleave", 100);
    else if (interruption === "native") f.chat.interrupt();
    else if (interruption === "blur") f.window.dispatchEvent(new f.window.Event("blur"));
    else f.pointer(f.log, "pointercancel", 950);
    f.tick();
    assert.equal(f.log.scrollTop, 1300, interruption);
  }
});

test("clicking volume resumes a stale chat hover without needing a pointerleave", () => {
  const f = fixture();
  f.hoverPause(true);
  f.pointer(f.log, "pointerenter", 950);
  f.append(500);
  f.pointer(f.volume, "pointerdown", 200, 550);
  f.tick();
  assert.equal(f.log.scrollTop, 1300);
});

test("moving between emote previews in one frame does not jump chat under the pointer", () => {
  const f = fixture();
  f.chat.setPreview(true);
  f.append(500);
  f.chat.setPreview(false);
  f.chat.setPreview(true);
  f.tick();
  assert.equal(f.log.scrollTop, 800);
  f.chat.setPreview(false);
  f.tick();
  assert.equal(f.log.scrollTop, 1300);
});

test("deliberate wheel scrolling preserves reading position across previews, blur, and resize cleanup", () => {
  const f = fixture();
  f.chat.setPreview(true);
  f.wheel(-400);
  f.scroll(400);
  f.tick();
  assert.equal(f.dismissed(), 1);
  f.append(500);
  f.chat.interrupt();
  f.tick();
  f.window.dispatchEvent(new f.window.Event("blur"));
  f.tick();
  assert.equal(f.log.scrollTop, 400);
  assert.equal(f.jump.classList.contains("visible"), true);
  f.chat.jumpToLive();
  f.append();
  assert.equal(f.log.scrollTop, 1500);
});

test("scrollbar dragging and lost capture retain intentional scrollback", () => {
  const f = fixture();
  f.pointer(f.log, "pointerdown", 999, 100);
  f.scroll(300);
  f.pointer(f.log, "lostpointercapture", 999, 100);
  f.tick();
  f.append();
  f.chat.interrupt();
  f.tick();
  assert.equal(f.log.scrollTop, 300);
});

test("keyboard scrolling preserves reading position and End resumes following", () => {
  const f = fixture();
  f.log.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
  f.scroll(400);
  f.tick();
  f.append(500);
  f.chat.interrupt();
  f.tick();
  assert.equal(f.log.scrollTop, 400);
  f.log.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  f.scroll(1300);
  f.tick();
  f.append();
  assert.equal(f.log.scrollTop, 1500);
});

test("scrolling down while already live cannot lose following when messages arrive before its animation frame", () => {
  const f = fixture();
  f.wheel(100);
  f.append(500);
  f.tick();
  assert.equal(f.log.scrollTop, 1300);
  assert.equal(f.jump.classList.contains("visible"), false);
});

test("reset discards the previous channel's scrollback state and pending resume frames", () => {
  const f = fixture();
  f.wheel(-400);
  f.scroll(400);
  f.chat.setPreview(false);
  f.chat.reset();
  f.append();
  f.tick();
  assert.equal(f.log.scrollTop, 1000);
  assert.equal(f.jump.classList.contains("visible"), false);
});

test("hidden windows and disposal clear player state and cancel queued chat callbacks", () => {
  const f = fixture();
  f.pointer(f.stage, "pointerenter");
  f.chat.setPreview(true);
  f.append();
  Object.defineProperty(f.document, "hidden", { value: true });
  f.document.dispatchEvent(new f.window.Event("visibilitychange"));
  assert.equal(f.stage.classList.contains("controls-visible"), false);
  f.tick();
  assert.equal(f.log.scrollTop, 1000);
  f.chat.setPreview(false);
  f.chat.dispose();
  assert.equal(f.frames.size, 0);
});
