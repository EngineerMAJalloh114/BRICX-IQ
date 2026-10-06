// P2-01b (ADR 0036): the dev S3 bucket is created deterministically.
// SeaweedFS 4.48 `weed mini` gives its filer about 6 s, tries the bucket
// once and never retries, so on a slow cold start the bucket was never
// created. s3-init now creates it with bounded retries. The fault case
// pauses the s3 container so the filer is unreachable while s3-init runs:
// without the retry, that case fails. Bounded polling only, no fixed sleeps.
import {
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { afterEach, describe, expect, test } from "vitest";
import {
  bucket,
  pause,
  s3Health,
  s3Request,
  s3Service,
  startInit,
  startS3,
  unpause,
} from "../src/s3.js";
import { waitFor } from "../src/stack.js";

const credentials = {
  accessKeyId: s3Service.environment.AWS_ACCESS_KEY_ID ?? "",
  secretAccessKey: s3Service.environment.AWS_SECRET_ACCESS_KEY ?? "",
};

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup.length = 0;
});

async function network(): Promise<StartedNetwork> {
  const started = await new Network().start();
  cleanup.push(() => started.stop());
  return started;
}

async function s3On(net: StartedNetwork): Promise<StartedTestContainer> {
  const s3 = await startS3(net);
  cleanup.push(() => s3.stop());
  return s3;
}

/** Whether a bucket directory exists in the filer (200 vs 404). */
async function bucketExists(s3: StartedTestContainer, name = bucket) {
  const filerUp = await waitFor("the filer", async () => {
    const r = await s3.exec([
      "wget",
      "-q",
      "--spider",
      "http://127.0.0.1:8888/",
    ]);
    return r.exitCode === 0 ? true : undefined;
  });
  expect(filerUp).toBe(true);
  const r = await s3.exec([
    "wget",
    "-q",
    "--spider",
    `http://127.0.0.1:8888/buckets/${name}/`,
  ]);
  return r.exitCode === 0;
}

describe("S3 dev bucket (P2-01b)", () => {
  test("compose wiring: s3 no longer creates the bucket itself; s3-init does", () => {
    expect(bucket).toBe("bricx-dev");
    expect(s3Service.environment).not.toHaveProperty("S3_BUCKET");
  });

  test("fault: the filer is unreachable when s3-init starts; it retries, creates the bucket, and S3 works", async () => {
    const net = await network();
    const s3 = await s3On(net);
    await pause(s3);
    let paused = true;
    cleanup.push(async () => {
      if (paused) await unpause(s3);
    });

    const init = await startInit(net);
    // The fault must actually hit: a failed attempt while the filer cannot
    // answer.
    await waitFor(
      "a failed s3-init attempt",
      async () =>
        /attempt 1\/\d+: bucket bricx-dev does not exist yet/.test(
          await init.output(),
        )
          ? true
          : undefined,
      120_000,
    );
    await unpause(s3);
    paused = false;

    const run = await init.finish();
    expect(run.output).toMatch(
      /s3-init: bucket bricx-dev created \(attempt \d+\)/,
    );
    expect(run.exitCode).toBe(0);

    // The unchanged healthcheck proves the bucket exists.
    const health = await waitFor("s3 healthy", async () => {
      const r = await s3Health(s3);
      return r.exitCode === 0 ? r : undefined;
    });
    expect(health.exitCode).toBe(0);

    // Credentials still work without S3_BUCKET: an authenticated PUT, then
    // GET, through the S3 API; a wrong secret is refused.
    const base = `http://${s3.getHost()}:${String(s3.getMappedPort(8333))}`;
    const object = new URL(`/${bucket}/p2-01b-probe.txt`, base);
    const body = "p2-01b credentials probe";
    const put = await waitFor("authenticated PUT", async () => {
      const r = await s3Request("PUT", object, credentials, body);
      return r.ok ? r : undefined;
    });
    expect(put.status).toBe(200);
    const get = await s3Request("GET", object, credentials);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(body);
    const forged = await s3Request("GET", object, {
      ...credentials,
      secretAccessKey: "not-the-secret",
    });
    expect(forged.status).toBe(403);
  });

  test("the s3 healthcheck fails while the bucket is missing; s3-init is idempotent", async () => {
    const net = await network();
    const s3 = await s3On(net);
    // weed mini has no S3_BUCKET, so nothing else creates the bucket.
    expect(await bucketExists(s3)).toBe(false);
    expect((await s3Health(s3)).exitCode).not.toBe(0);

    const first = await (await startInit(net)).finish();
    expect(first.exitCode).toBe(0);
    expect(await bucketExists(s3)).toBe(true);
    expect((await s3Health(s3)).exitCode).toBe(0);

    // A second run (every `pnpm dev:up` on an existing volume) succeeds on
    // the existence check, before creating anything.
    const second = await (await startInit(net)).finish();
    expect(second.exitCode).toBe(0);
    expect(second.output).toContain(
      "s3-init: bucket bricx-dev exists (attempt 1)",
    );
    expect(await bucketExists(s3)).toBe(true);
  });

  test("fails loudly, within its bounds, when the filer never answers", async () => {
    const net = await network(); // no s3 on this network
    const run = await (
      await startInit(net, {
        S3_INIT_ATTEMPTS: "2",
        S3_INIT_DELAY_SECONDS: "1",
      })
    ).finish();
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain(
      "s3-init FAILED: bucket bricx-dev does not exist after 2 attempts",
    );
    // 2 attempts, each bounded (10 s shell timeout, 3 s per check).
    expect(run.seconds).toBeLessThan(45);
  });

  test("rejects an invalid bucket name before weed shell runs (no command injection)", async () => {
    const net = await network();
    const s3 = await s3On(net);
    const injected = "injected-by-newline";
    const invalid = [
      "Bricx_Dev", // uppercase and underscore
      "ab", // too short
      "a".repeat(64), // too long
      "-bricx-dev", // must start with a letter or digit
      "bricx-dev.", // must end with a letter or digit
      // A newline would start a second weed shell command.
      `bricx-dev\ns3.bucket.create -name ${injected}`,
    ];
    for (const name of invalid) {
      const run = await (
        await startInit(net, {
          BRICX_S3_BUCKET: name,
          S3_INIT_ATTEMPTS: "2",
          S3_INIT_DELAY_SECONDS: "1",
        })
      ).finish();
      expect(run.exitCode, JSON.stringify(name)).toBe(1);
      expect(run.output, JSON.stringify(name)).toContain(
        "s3-init FAILED: BRICX_S3_BUCKET is not a valid S3 bucket name",
      );
      expect(run.output, JSON.stringify(name)).not.toContain("weed shell");
    }
    expect(await bucketExists(s3, injected)).toBe(false);
  });
});
