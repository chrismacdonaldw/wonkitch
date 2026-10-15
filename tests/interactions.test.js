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
  let viewportHeight = 200;
  Object.defineProperties(log, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => viewportHeight },
    clientWidth: { get: () => 196 },
    scrollTop: { get: () => top, set: (value) => { top = Math.max(0, Math.min(height - viewportHeight, value)); } },
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
  const timers = new Map();
  let timerId = 0;
  window.setTimeout = (callback) => { timers.set(++timerId, callback); return timerId; };
  window.clearTimeout = (id) => timers.delete(id);
  const expireTimers = () => {
    const ready = [...timers.values()];
    timers.clear();
    for (const callback of ready) callback();
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
  const resize = (value) => { viewportHeight = value; scroll(top); chat.flush(); };
  const trim = (amount) => { height = Math.max(viewportHeight, height - amount); scroll(top); chat.flush(); };
  return { window, document, stage, controls, volume, log, jump, chat, player, tick, pointer, scroll, wheel, append,
    resize, trim, expireTimers, timers,
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

for (const amount of [1, 10, 30]) {
  test(`the first ${amount}-pixel upward wheel scroll holds its position while chat is busy`, () => {
    const f = fixture();
    f.wheel(-amount);
    assert.equal(f.chat.isFollowing, false, "pause before the browser applies the wheel movement");
    assert.equal(f.jump.classList.contains("visible"), true, "offer resume even inside the old 90px margin");
    f.scroll(800 - amount);
    f.tick();
    assert.equal(f.log.scrollTop, 800 - amount, "the input frame must not undo a small scroll");
    for (let i = 0; i < 20; i++) f.append(1);
    f.chat.interrupt();
    f.tick();
    assert.equal(f.log.scrollTop, 800 - amount);
    assert.equal(f.chat.isFollowing, false);
    assert.equal(f.jump.classList.contains("visible"), true);
  });
}

test("upward intent survives native scroll events arriving before or after the input frame", () => {
  for (const delayed of [false, true]) {
    const f = fixture();
    f.wheel(-1);
    f.scroll(800); // A queued scroll event from the previous automatic follow.
    if (delayed) f.tick();
    f.append(1);
    f.scroll(799);
    f.tick();
    f.append(1);
    assert.equal(f.log.scrollTop, 799, `delayed native scroll: ${delayed}`);
    assert.equal(f.chat.isFollowing, false);
  }
});

test("forward scrolling resumes only at the actual bottom, including delayed smooth scrolling", () => {
  const f = fixture();
  f.wheel(-30);
  f.scroll(770);
  f.tick();
  f.wheel(10);
  f.scroll(780);
  f.tick();
  assert.equal(f.chat.isFollowing, false);
  assert.equal(f.jump.classList.contains("visible"), true);
  f.wheel(20);
  f.tick(); // Native scrolling can continue after our animation-frame sample.
  f.scroll(790);
  f.scroll(799);
  assert.equal(f.chat.isFollowing, false, "one pixel above the bottom is still intentional scrollback");
  f.scroll(800);
  assert.equal(f.chat.isFollowing, true);
  assert.equal(f.jump.classList.contains("visible"), false);
  f.append(20);
  assert.equal(f.log.scrollTop, 820);
});

test("reaching the live edge resumes even when new rows arrive before its native scroll event", () => {
  const f = fixture();
  f.wheel(-10);
  f.scroll(790);
  f.tick();
  f.wheel(10);
  f.log.scrollTop = 800; // Native movement happened, but its event is still queued.
  f.append(1);
  f.tick();
  assert.equal(f.chat.isFollowing, true);
  assert.equal(f.log.scrollTop, 801);
  f.scroll(801);
  f.append(1);
  assert.equal(f.log.scrollTop, 802);
});

test("a one-pixel scrollbar drag pauses immediately and dragging back to bottom resumes", () => {
  const f = fixture();
  f.pointer(f.log, "pointerdown", 999, 100);
  f.scroll(799);
  f.tick();
  f.pointer(f.window, "pointerup", 999, 101);
  f.tick();
  f.append(1);
  assert.equal(f.log.scrollTop, 799);
  assert.equal(f.chat.isFollowing, false);
  f.pointer(f.log, "pointerdown", 999, 100);
  f.scroll(800);
  assert.equal(f.chat.isFollowing, false);
  f.scroll(801);
  assert.equal(f.chat.isFollowing, true);
  f.pointer(f.window, "pointerup", 999, 102);
  f.tick();
  f.append(1);
  assert.equal(f.log.scrollTop, 802);
});

test("scrollbar movement preserves upward intent before the first native scroll event", () => {
  const f = fixture();
  f.pointer(f.log, "pointerdown", 999, 100);
  f.pointer(f.window, "pointermove", 999, 99, 1, { buttons: 1 });
  f.pointer(f.window, "pointerup", 999, 99);
  f.tick();
  f.append(1);
  f.scroll(799);
  f.append(1);
  assert.equal(f.chat.isFollowing, false);
  assert.equal(f.log.scrollTop, 799);
});

test("small touch scrolls preserve intent through pointer release and delayed compositor scrolling", () => {
  const f = fixture();
  const touch = { pointerType: "touch" };
  f.pointer(f.log, "pointerdown", 950, 100, 4, touch);
  f.pointer(f.log, "pointermove", 950, 101, 4, touch);
  assert.equal(f.chat.isFollowing, false);
  f.tick();
  f.pointer(f.window, "pointerup", 950, 101, 4, touch);
  f.tick();
  f.append(1);
  f.scroll(799);
  f.append(1);
  assert.equal(f.log.scrollTop, 799);
  assert.equal(f.jump.classList.contains("visible"), true);
  f.pointer(f.log, "pointerdown", 950, 100, 5, touch);
  f.pointer(f.log, "pointermove", 950, 90, 5, touch);
  f.scroll(802);
  f.pointer(f.window, "pointerup", 950, 90, 5, touch);
  f.tick();
  f.append(1);
  assert.equal(f.log.scrollTop, 803);
  assert.equal(f.chat.isFollowing, true);
});

test("native touch panning can continue to the bottom after Chromium cancels the pointer", () => {
  const f = fixture();
  const touch = { pointerType: "touch" };
  f.wheel(-100);
  f.scroll(700);
  f.tick();
  f.pointer(f.log, "pointerdown", 950, 100, 4, touch);
  f.pointer(f.log, "pointermove", 950, 90, 4, touch);
  f.pointer(f.log, "pointercancel", 950, 90, 4, touch);
  f.tick();
  f.scroll(800);
  f.append(1);
  assert.equal(f.chat.isFollowing, true);
  assert.equal(f.log.scrollTop, 801);
});

test("native touch cancellation preserves upward scrollback while the compositor takes over", () => {
  const f = fixture();
  const touch = { pointerType: "touch" };
  f.pointer(f.log, "pointerdown", 950, 100, 4, touch);
  f.pointer(f.log, "pointermove", 950, 101, 4, touch);
  f.pointer(f.log, "pointercancel", 950, 101, 4, touch);
  f.tick();
  f.append(1);
  f.scroll(799);
  f.append(1);
  assert.equal(f.chat.isFollowing, false);
  assert.equal(f.log.scrollTop, 799);
});

test("a single ArrowUp pauses chat without waiting to leave the bottom margin", () => {
  const f = fixture();
  f.log.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  f.tick();
  f.scroll(799);
  f.append(1);
  assert.equal(f.log.scrollTop, 799);
  assert.equal(f.jump.classList.contains("visible"), true);
});

test("scroll keys used by controls inside chat do not pause automatic following", () => {
  const f = fixture();
  const control = f.document.createElement("button");
  f.log.append(control);
  control.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  f.append(1);
  assert.equal(f.log.scrollTop, 801);
  assert.equal(f.chat.isFollowing, true);
});

test("browser anchoring and resizing cannot turn automatic following into scrollback", () => {
  const f = fixture();
  f.scroll(799);
  f.resize(199);
  assert.equal(f.chat.isFollowing, true);
  assert.equal(f.log.scrollTop, 801);
  f.append(1);
  assert.equal(f.log.scrollTop, 802);
});

test("resizing or trimming history to the bottom does not discard intentional scrollback", () => {
  const f = fixture();
  f.wheel(-10);
  f.scroll(790);
  f.tick();
  f.log.dispatchEvent(new f.window.Event("scrollend"));
  f.resize(210); // The larger viewport reaches the bottom without a user scroll.
  assert.equal(f.chat.isFollowing, false);
  assert.equal(f.jump.classList.contains("visible"), true);
  f.append(1);
  assert.equal(f.log.scrollTop, 790);
  f.trim(800);
  assert.equal(f.log.scrollTop, 0);
  assert.equal(f.chat.isFollowing, false);
  f.chat.reset();
  f.append(1);
  assert.equal(f.log.scrollTop, 1);
  assert.equal(f.chat.isFollowing, true);
});

test("expired forward gestures cannot mistake later browser anchoring for user scrolling", () => {
  const f = fixture();
  f.wheel(-100);
  f.scroll(700);
  f.tick();
  f.wheel(20);
  f.scroll(720);
  f.tick();
  f.expireTimers(); // Fallback for WebViews without the native scrollend event.
  f.scroll(800);
  assert.equal(f.chat.isFollowing, false);
  assert.equal(f.jump.classList.contains("visible"), true);
});

test("jumping to live clears pending gestures and an upward input on an empty log stays live", () => {
  const f = fixture();
  f.wheel(-1);
  f.chat.jumpToLive();
  f.tick();
  f.append(1);
  assert.equal(f.log.scrollTop, 801);
  f.trim(1000);
  f.chat.reset();
  f.wheel(-1);
  f.tick();
  f.append(1);
  assert.equal(f.log.scrollTop, 1);
  assert.equal(f.chat.isFollowing, true);
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
  assert.equal(f.timers.size, 0);
});
