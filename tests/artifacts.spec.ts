import "./_setup";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveKernel } from "../src/kernel/authority";
import { DEFAULT_TENANT, seedWorkspace } from "../src/kernel/seed";
import { ArtifactCorruptError, ForbiddenError } from "../src/kernel/types";

function kernelWithTmpArtifacts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-artifacts-"));
  fs.chmodSync(dir, 0o700);
  process.env.HIVE_ARTIFACT_DIR = dir;
  const kernel = new HiveKernel();
  seedWorkspace(kernel, DEFAULT_TENANT);
  return { kernel, dir };
}

test("artifacts: sha256-addressed store dedupes identical bytes and lists them", () => {
  const { kernel } = kernelWithTmpArtifacts();
  const bytes = Buffer.from("clean sandbox repro output — all 14 steps pass\n");
  const a = kernel.storeArtifact(DEFAULT_TENANT, { actor: "verifier", mediaType: "text/plain", bytes });
  const b = kernel.storeArtifact(DEFAULT_TENANT, { actor: "verifier", mediaType: "text/plain", bytes });
  assert.equal(a.sha256, b.sha256);
  assert.equal(kernel.listArtifacts(DEFAULT_TENANT).length, 1);
  assert.equal(kernel.getArtifact(DEFAULT_TENANT, a.sha256)?.size, bytes.length);
});

test("artifacts: cross-tenant reads see nothing (no existence leak)", () => {
  const { kernel } = kernelWithTmpArtifacts();
  seedWorkspace(kernel, "globex");
  const a = kernel.storeArtifact(DEFAULT_TENANT, { actor: "verifier", mediaType: "text/plain", bytes: Buffer.from("acme evidence") });
  assert.equal(kernel.getArtifact("globex", a.sha256), null);
});

test("artifacts: readArtifactBytes detects disk tampering (integrity check)", () => {
  const { kernel, dir } = kernelWithTmpArtifacts();
  const a = kernel.storeArtifact(DEFAULT_TENANT, { actor: "verifier", mediaType: "text/plain", bytes: Buffer.from("evidence-v1") });
  const file = path.join(dir, a.sha256.slice(0, 2), a.sha256);
  fs.writeFileSync(file, "evidence-FORGED");
  assert.throws(() => kernel.readArtifactBytes(DEFAULT_TENANT, a.sha256), ArtifactCorruptError);
});

test("artifacts: secret-shaped bytes are refused by outbound DLP before hitting disk", () => {
  const { kernel } = kernelWithTmpArtifacts();
  assert.throws(
    () => kernel.storeArtifact(DEFAULT_TENANT, { actor: "verifier", mediaType: "text/plain", bytes: Buffer.from("key=sk_live_99887766") }),
    ForbiddenError,
  );
  assert.equal(kernel.listArtifacts(DEFAULT_TENANT).length, 0);
});
