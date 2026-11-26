import "./_setup";
import test from "node:test";
import assert from "node:assert/strict";
import {
  SseHub,
  PresenceRegistry,
  formatSseFrame,
  parseSseBuffer,
  STREAM_LIMIT_PER_PRINCIPAL,
  PRESENCE_GRACE_MS,
  type StreamRecord,
} from "../src/server/streams";

function fakeStream(id: string, principalId: string, kind: "human" | "agent", tenant = "acme") {
  const frames: string[] = [];
  const rec: StreamRecord = {
    id,
    tenantId: tenant,
    principalId,
    principalKind: kind,
    channel: null,
    taskId: null,
    connectedAt: 1,
    lastSeenAt: 1,
    lastSeq: 0,
    closed: false,
    close: (frame?: string) => {
      if (frame) frames.push(frame);
      rec.closed = true;
    },
    send: (frame: string) => {
      frames.push(frame);
      return true;
    },
  };
  return { rec, frames };
}

test("formatSseFrame parses back with parseSseBuffer", () => {
  const text = formatSseFrame(42, "event", { kind: "task.created", seq: 42 }) + formatSseFrame(null, "presence", { watchers: [] });
  const { frames, rest } = parseSseBuffer(text);
  assert.equal(rest, "");
  assert.equal(frames.length, 2);
  assert.deepEqual(JSON.parse(frames[0].data), { kind: "task.created", seq: 42 });
  assert.equal(frames[0].id, "42");
  assert.equal(frames[1].event, "presence");
});

test("parseSseBuffer keeps partial frames in rest and skips comments", () => {
  const full = formatSseFrame(1, "event", { a: 1 });
  const { frames, rest } = parseSseBuffer(": ping\n\n" + full.slice(0, full.length - 3));
  assert.equal(frames.length, 0);
  assert.ok(rest.startsWith("id: 1"));
  const done = parseSseBuffer(rest + full.slice(full.length - 3));
  assert.equal(done.frames.length, 1);
});

test("SseHub caps humans at 20 streams and agents at 1 (watch_replaced on reconnect)", () => {
  const hub = new SseHub();
  for (let i = 0; i < STREAM_LIMIT_PER_PRINCIPAL; i += 1) {
    const { rec } = fakeStream(`s${i}`, "ben", "human");
    assert.equal(hub.attach(rec, 1000).error, undefined);
  }
  const { rec: overflow } = fakeStream("s20", "ben", "human");
  assert.match(hub.attach(overflow, 1000).error ?? "", /stream limit/);

  const hub2 = new SseHub();
  const first = fakeStream("agent-1", "fixer", "agent");
  const second = fakeStream("agent-2", "fixer", "agent");
  hub2.attach(first.rec, 1000);
  const { replaced, error } = hub2.attach(second.rec, 2000);
  assert.equal(error, undefined);
  assert.equal(replaced.length, 1);
  assert.equal(first.rec.closed, true);
  assert.match(first.frames.join(""), /watch_replaced/);
  assert.equal(hub2.count("acme", "fixer"), 1);
});

test("PresenceRegistry grace: disconnect → 60s window → sweep evicts; heartbeat inside grace revives", () => {
  const reg = new PresenceRegistry();
  reg.touch({ tenantId: "acme", principalId: "ben", principalKind: "human", channel: "dev", taskId: null, now: 1000 });
  assert.equal(reg.snapshot("acme", 2000).length, 1);
  reg.drop("acme", "ben", 3000);
  assert.equal(reg.snapshot("acme", 3000 + PRESENCE_GRACE_MS - 1).length, 1, "still inside grace");
  // Heartbeat inside grace revives the entry.
  reg.touch({ tenantId: "acme", principalId: "ben", principalKind: "human", channel: "dev", taskId: null, now: 3000 + PRESENCE_GRACE_MS - 1 });
  assert.equal(reg.snapshot("acme", 3000 + PRESENCE_GRACE_MS + 100).length, 1, "revived by heartbeat");
  reg.drop("acme", "ben", 10000);
  assert.equal(reg.snapshot("acme", 10000 + PRESENCE_GRACE_MS + 1).length, 0, "grace expired → evicted");
});
