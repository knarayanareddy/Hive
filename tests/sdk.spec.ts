import "./_setup";
import test from "node:test";
import assert from "node:assert/strict";
import { HiveClient, HiveHttpError } from "../src/sdk/index";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

test("sdk.events: parses ready + event frames from a stubbed fetch stream", async () => {
  const body =
    ': hive event stream\n\n' +
    'event: ready\ndata: {"tenant":"acme","principalId":"ben","incarnation":"inc","streams":1,"replayed":1}\n\n' +
    'id: 7\nevent: event\ndata: {"seq":7,"id":"e","prev":"p","kind":"task.created","actor":"ben","channel":"dev","taskId":"801","payload":{},"trust":"member","attest":[],"sig":"s","createdAt":1}\n\n';
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /\/api\/events\?/);
    assert.match((init?.headers as Record<string, string>).Authorization, /^Bearer hst_test/);
    return new Response(sseStream([body.slice(0, 60), body.slice(60)]), { status: 200 });
  }) as typeof fetch;
  const hive = new HiveClient({ baseUrl: "http://gw.test", token: "hst_test", fetchImpl });
  const frames = [];
  for await (const f of hive.events({ tenant: "acme", channel: "dev" })) frames.push(f);
  assert.deepEqual(frames.map((f) => f.type), ["ready", "event"]);
  const ev = frames[1] as Extract<(typeof frames)[1], { type: "event" }>;
  assert.equal(ev.event.seq, 7);
  assert.equal(ev.event.kind, "task.created");
});

test("sdk.events: HTTP failure surfaces as HiveHttpError, not a silent hang", async () => {
  const fetchImpl = (async () => new Response('{"error":"session required"}', { status: 401 })) as typeof fetch;
  const hive = new HiveClient({ baseUrl: "http://gw.test", token: "hst_stale", fetchImpl });
  await assert.rejects(async () => {
    for await (const _ of hive.events({ tenant: "acme" })) void _;
  }, (e: unknown) => e instanceof HiveHttpError && e.status === 401);
});

test("sdk.getState: sends bearer and decodes JSON", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "http://gw.test/api/state?tenant=globex");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer hst_x");
    return new Response('{"tenantId":"globex","tasks":[]}', { status: 200 });
  }) as typeof fetch;
  const hive = new HiveClient({ baseUrl: "http://gw.test", token: "hst_x", fetchImpl });
  const state = await hive.getState("globex");
  assert.equal(state.tenantId, "globex");
});
