import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const globalUrl = "https://api.ivr.fi/v2/twitch/badges/global";
const channelUrl = (roomId) => `https://api.ivr.fi/v2/twitch/badges/channel?id=${roomId}`;
const originalFetch = globalThis.fetch;
let moduleId = 0;

afterEach(() => { globalThis.fetch = originalFetch; });

async function catalogFixture(responses) {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    assert.ok(responses.has(url), `Unexpected request: ${url}`);
    const result = responses.get(url);
    return typeof result === "function" ? result() : result;
  };
  const { BadgeCatalog } = await import(`../src/badges.ts?badge-test=${++moduleId}`);
  return { catalog: new BadgeCatalog(), requests };
}

function response(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function badge(setId, title = setId, image = `https://cdn.example/${setId}`) {
  return { set_id: setId, versions: [{ id: "1", title, image_url_1x: image }] };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
}

test("ready channel badges appear while the global request is still pending", async () => {
  const pending = deferred();
  const responses = new Map([
    [globalUrl, () => pending.promise],
    [channelUrl("42"), response([badge("subscriber")])],
  ]);
  const { catalog } = await catalogFixture(responses);
  let updates = 0;
  const load = catalog.load("42", () => { updates++; });
  await settle();
  assert.equal(catalog.find("subscriber/1").title, "subscriber");
  assert.equal(updates, 1);
  pending.resolve(response([badge("moderator")]));
  await load;
  assert.equal(catalog.find("moderator/1").title, "moderator");
  assert.equal(updates, 2);
});

test("global badges appear while the channel response body is still pending", async () => {
  const pending = deferred();
  const responses = new Map([
    [globalUrl, response([badge("moderator")])],
    [channelUrl("42"), { ok: true, status: 200, json: () => pending.promise }],
  ]);
  const { catalog } = await catalogFixture(responses);
  const load = catalog.load("42");
  await settle();
  assert.equal(catalog.find("moderator/1").title, "moderator");
  assert.equal(catalog.find("subscriber/1"), undefined);
  pending.resolve([badge("subscriber")]);
  await load;
  assert.equal(catalog.find("subscriber/1").title, "subscriber");
});

test("transient global failures and malformed payloads are retried instead of cached empty", async () => {
  for (const failure of [response(null, 503), response({ error: "malformed" })]) {
    const responses = new Map([
      [globalUrl, failure],
      [channelUrl("42"), response([badge("subscriber")])],
    ]);
    const { catalog, requests } = await catalogFixture(responses);
    await catalog.load("42");
    assert.equal(catalog.find("moderator/1"), undefined);
    assert.equal(catalog.loadIncomplete, true);
    responses.set(globalUrl, response([badge("moderator")]));
    await catalog.load("42");
    assert.equal(catalog.find("moderator/1").title, "moderator");
    assert.equal(catalog.loadIncomplete, false);
    assert.equal(requests.filter((url) => url === globalUrl).length, 2);
    await catalog.load("42");
    assert.equal(requests.filter((url) => url === globalUrl).length, 2, "successful globals stay cached");
  }
});

test("same-room failures keep known badges while a channel switch drops old channel badges", async () => {
  const responses = new Map([
    [globalUrl, response([badge("moderator")])],
    [channelUrl("42"), response([badge("subscriber", "Old room")])],
    [channelUrl("43"), response(null, 503)],
  ]);
  const { catalog } = await catalogFixture(responses);
  await catalog.load("42");
  responses.set(channelUrl("42"), response(null, 503));
  await catalog.load("42");
  assert.equal(catalog.find("subscriber/1").title, "Old room");
  assert.equal(catalog.loadIncomplete, true);
  await catalog.load("43");
  assert.equal(catalog.find("subscriber/1"), undefined);
  assert.equal(catalog.find("moderator/1").title, "moderator");
});

test("late responses from the previous room cannot replace current badges or notify its UI", async () => {
  const oldChannel = deferred();
  const global = deferred();
  const responses = new Map([
    [globalUrl, () => global.promise],
    [channelUrl("42"), () => oldChannel.promise],
    [channelUrl("43"), response([badge("subscriber", "New room")])],
  ]);
  const { catalog } = await catalogFixture(responses);
  let staleUpdates = 0;
  let currentUpdates = 0;
  const oldLoad = catalog.load("42", () => { staleUpdates++; });
  const currentLoad = catalog.load("43", () => { currentUpdates++; });
  global.resolve(response([badge("moderator")]));
  await currentLoad;
  assert.equal(catalog.find("subscriber/1").title, "New room");
  oldChannel.resolve(response([badge("subscriber", "Old room")]));
  await oldLoad;
  assert.equal(catalog.find("subscriber/1").title, "New room");
  assert.equal(staleUpdates, 0);
  assert.equal(currentUpdates, 2);
});

test("a missing channel has no badges and valid channel badges override global versions", async () => {
  const responses = new Map([
    [globalUrl, response([badge("subscriber", "Global")])],
    [channelUrl("42"), response([badge("subscriber", "Channel")])],
    [channelUrl("43"), response(null, 404)],
  ]);
  const { catalog } = await catalogFixture(responses);
  await catalog.load("42");
  assert.equal(catalog.find("subscriber/1").title, "Channel");
  await catalog.load("43");
  assert.equal(catalog.find("subscriber/1").title, "Global");
  assert.equal(catalog.loadIncomplete, false);
});

test("clearing badges invalidates in-flight responses and resets failure state", async () => {
  const pending = deferred();
  const responses = new Map([
    [globalUrl, response(null, 503)],
    [channelUrl("42"), () => pending.promise],
  ]);
  const { catalog } = await catalogFixture(responses);
  let updates = 0;
  const load = catalog.load("42", () => { updates++; });
  await settle();
  assert.equal(catalog.loadIncomplete, true);
  catalog.clear();
  assert.equal(catalog.loadIncomplete, false);
  pending.resolve(response([badge("subscriber")]));
  await load;
  assert.equal(catalog.find("subscriber/1"), undefined);
  assert.equal(updates, 0);
  assert.equal(catalog.loadIncomplete, false);
});

test("malformed badge entries cannot break loading, and metadata keeps image and title fallbacks", async () => {
  const responses = new Map([
    [globalUrl, response([null, {}, { set_id: "bad", versions: [null, {}] }, {
      set_id: "founder-badge", versions: [{ id: "1", image_url_1x: "https://cdn.example/small" }],
    }])],
    [channelUrl("42"), response([{
      set_id: "subscriber", versions: [{ id: "1", image_url_1x: "https://cdn.example/small",
        image_url_2x: "https://cdn.example/large", title: "Subscriber", description: "A description" }],
    }])],
  ]);
  const { catalog } = await catalogFixture(responses);
  await catalog.load("42");
  assert.deepEqual(catalog.find("founder-badge/1"), {
    imageUrl: "https://cdn.example/small", title: "Founder Badge", description: "",
  });
  assert.deepEqual(catalog.find("subscriber/1"), {
    imageUrl: "https://cdn.example/large", title: "Subscriber", description: "A description",
  });
  assert.equal(catalog.find("bad/undefined"), undefined);
});
