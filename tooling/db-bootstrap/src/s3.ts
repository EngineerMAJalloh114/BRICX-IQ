// The dev stack's S3 store (SeaweedFS) and its s3-init one-shot, started the
// way compose.yml starts them, for s3-bucket.int.test.ts (P2-01b, ADR 0036).
// Image, command, environment, entrypoint, bind mount and healthcheck come
// from `docker compose config` on the real compose.yml with .env.example
// (no second copy of any of them).
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { repoRoot, waitFor } from "./stack.js";

interface ComposeService {
  image: string;
  command: string[] | null;
  entrypoint: string[] | null;
  environment: Record<string, string>;
  healthcheck?: { test: string[] };
  volumes?: { type: string; source: string; target: string }[];
}

const config = JSON.parse(
  execFileSync(
    "docker",
    [
      "compose",
      "--file",
      path.join(repoRoot, "infrastructure/docker/compose.yml"),
      "--env-file",
      path.join(repoRoot, ".env.example"),
      "--profile",
      "init",
      "config",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  ),
) as { services: Record<string, ComposeService> };

function service(name: string): ComposeService {
  const found = config.services[name];
  if (found === undefined) throw new Error(`compose.yml has no ${name}`);
  return found;
}

export const s3Service = service("s3");
export const initService = service("s3-init");
export const bucket = s3Service.environment.BRICX_S3_BUCKET ?? "";

/** The s3 healthcheck command, as Docker runs it (CMD-SHELL, `$$` → `$`). */
const healthcheckTest = s3Service.healthcheck?.test ?? [];
if (healthcheckTest[0] !== "CMD-SHELL" || healthcheckTest[1] === undefined) {
  throw new Error("compose.yml: the s3 healthcheck is not CMD-SHELL");
}
const healthcheckCommand = healthcheckTest[1].replaceAll("$$", "$");

/**
 * The s3 service on the network as `s3`, as in compose. It returns as soon
 * as `weed mini` starts, before the filer is ready, so a test can pause it.
 */
export async function startS3(
  network: StartedNetwork,
): Promise<StartedTestContainer> {
  return new GenericContainer(s3Service.image)
    .withNetwork(network)
    .withNetworkAliases("s3")
    .withCommand(s3Service.command ?? [])
    .withEnvironment(s3Service.environment)
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forLogMessage("Starting SeaweedFS Mini"))
    .start();
}

/** Runs the real s3 healthcheck inside the container, as Docker does. */
export async function s3Health(s3: StartedTestContainer) {
  return s3.exec(["sh", "-c", healthcheckCommand]);
}

export async function pause(container: StartedTestContainer) {
  const client = await getContainerRuntimeClient();
  await client.container.dockerode.getContainer(container.getId()).pause();
}

export async function unpause(container: StartedTestContainer) {
  const client = await getContainerRuntimeClient();
  await client.container.dockerode.getContainer(container.getId()).unpause();
}

export interface InitRun {
  exitCode: number;
  output: string;
  seconds: number;
}

/** What the s3-init container has printed so far (stdout and stderr). */
async function logsOf(container: StartedTestContainer): Promise<string> {
  const client = await getContainerRuntimeClient();
  const raw = await client.container.dockerode
    .getContainer(container.getId())
    .logs({ stdout: true, stderr: true, follow: false });
  // Docker multiplexes non-TTY logs: an 8-byte header before each frame.
  const chunks: string[] = [];
  for (let at = 0; at + 8 <= raw.length;) {
    const size = raw.readUInt32BE(at + 4);
    chunks.push(raw.subarray(at + 8, at + 8 + size).toString("utf8"));
    at += 8 + size;
  }
  return chunks.join("");
}

/**
 * Starts the real s3-init one-shot (compose.yml's image, entrypoint,
 * environment and bind-mounted script) and returns once it has printed its
 * first line. `finish` waits for it to exit.
 */
export async function startInit(
  network: StartedNetwork,
  extraEnvironment: Record<string, string> = {},
) {
  const started = performance.now();
  const mounts = (initService.volumes ?? []).map((v) => {
    if (v.type !== "bind") throw new Error("s3-init: only bind mounts");
    return { source: v.source, target: v.target, mode: "ro" as const };
  });
  const container = await new GenericContainer(initService.image)
    .withNetwork(network)
    .withEntrypoint(initService.entrypoint ?? [])
    .withEnvironment({ ...initService.environment, ...extraEnvironment })
    .withBindMounts(mounts)
    .withWaitStrategy(Wait.forLogMessage("s3-init"))
    .withStartupTimeout(120_000)
    .start();
  const client = await getContainerRuntimeClient();
  const inspect = () =>
    client.container.dockerode.getContainer(container.getId()).inspect();
  return {
    container,
    output: () => logsOf(container),
    async finish(timeoutMs = 300_000): Promise<InitRun> {
      const state = await waitFor(
        "s3-init to exit",
        async () => {
          const info = await inspect();
          return info.State.Running ? undefined : info.State;
        },
        timeoutMs,
      );
      const output = await logsOf(container);
      await container.stop();
      return {
        exitCode: state.ExitCode,
        output,
        seconds: (performance.now() - started) / 1000,
      };
    },
  };
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/**
 * One S3 request signed with AWS Signature Version 4 (path-style URL,
 * region us-east-1), hand-rolled so the test needs no S3 client dependency.
 */
export async function s3Request(
  method: "PUT" | "GET",
  url: URL,
  credentials: { accessKeyId: string; secretAccessKey: string },
  body = "",
): Promise<Response> {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    url.pathname,
    "",
    `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of ["us-east-1", "s3", "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key)
    .update(stringToSign)
    .digest("hex");
  return fetch(url, {
    method,
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    ...(method === "PUT" ? { body } : {}),
  });
}
