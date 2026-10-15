// P4-01: the real probes against local stand-ins (no containers): each
// check passes when its peer answers correctly, fails within the bound
// when it does not, and never carries a secret. Real images:
// test/health.int.test.ts.
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { loadApiConfig } from "@bricx/config/api";
import { afterEach, describe, expect, test } from "vitest";
import { createProbes, type Probes } from "../src/common/health/probes.js";
import { apiEnv, exampleValue } from "./env.js";

const servers: (Server | HttpServer)[] = [];
const sockets: Socket[] = [];
let probes: Probes | undefined;
afterEach(async () => {
  await Promise.all(Object.values(probes ?? {}).map((p) => p.close()));
  probes = undefined;
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function listen(server: Server | HttpServer): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return address.port;
}

/** A TCP server answering every chunk with `reply` (null: never answers). */
function tcp(reply: string | null): Promise<number> {
  return listen(
    createServer((socket) => {
      sockets.push(socket);
      socket.on("data", () => {
        if (reply !== null) socket.write(reply);
      });
    }),
  );
}

/** An HTTP server answering HEAD /<bucket> with `status`. */
function http(status: number): Promise<number> {
  return listen(
    createHttpServer((req, res) => {
      res.statusCode =
        req.url?.startsWith(`/${exampleValue("S3_BUCKET")}`) === true
          ? status
          : 404;
      res.end();
    }),
  );
}

function config(ports: { db: number; valkey: number; s3: number }) {
  return loadApiConfig(
    apiEnv({
      DATABASE_URL: `postgres://bricx_app:${exampleValue("BRICX_APP_PASSWORD")}@127.0.0.1:${String(ports.db)}/bricx_dev`,
      VALKEY_URL: `redis://default:${exampleValue("VALKEY_PASSWORD")}@127.0.0.1:${String(ports.valkey)}`,
      S3_ENDPOINT: `http://127.0.0.1:${String(ports.s3)}`,
    }),
  );
}

const secrets = () => [
  exampleValue("BRICX_APP_PASSWORD"),
  exampleValue("VALKEY_PASSWORD"),
  exampleValue("S3_SECRET_ACCESS_KEY"),
];

async function failure(check: () => Promise<void>) {
  const started = performance.now();
  const error: unknown = await check().then(
    () => new Error("expected the check to fail"),
    (e: unknown) => e,
  );
  expect(performance.now() - started).toBeLessThan(15_000);
  if (!(error instanceof Error)) throw new Error("expected an Error");
  const text = `${error.message} ${String(error.stack)}`;
  for (const secret of secrets()) expect(text).not.toContain(secret);
  expect(error.cause).toBeUndefined();
  return error;
}

describe("readiness probes", () => {
  // The passing valkey case needs a real server (ioredis 6 opens with
  // HELLO 3 + AUTH + CLIENT SETINFO): test/health.int.test.ts covers it.

  test("valkey: a peer that never answers fails within the bound", async () => {
    probes = createProbes(config({ db: 1, valkey: await tcp(null), s3: 1 }));
    await failure(() => probes?.valkey.check() ?? Promise.resolve());
  });

  test("valkey: a wrong answer fails", async () => {
    probes = createProbes(
      config({ db: 1, valkey: await tcp("+OK\r\n+NOPE\r\n"), s3: 1 }),
    );
    await failure(() => probes?.valkey.check() ?? Promise.resolve());
  });

  test("s3: HEAD bucket 200 passes", async () => {
    probes = createProbes(config({ db: 1, valkey: 1, s3: await http(200) }));
    await expect(probes.s3.check()).resolves.toBeUndefined();
  });

  test("s3: 403 fails", async () => {
    probes = createProbes(config({ db: 1, valkey: 1, s3: await http(403) }));
    await failure(() => probes?.s3.check() ?? Promise.resolve());
  });

  test("s3: a peer that never answers fails within the bound", async () => {
    probes = createProbes(config({ db: 1, valkey: 1, s3: await tcp(null) }));
    await failure(() => probes?.s3.check() ?? Promise.resolve());
  });

  test("db: a peer that never answers fails within the bound", async () => {
    probes = createProbes(config({ db: await tcp(null), valkey: 1, s3: 1 }));
    await failure(() => probes?.db.check() ?? Promise.resolve());
  });

  test("close() releases every probe and can be called again", async () => {
    probes = createProbes(config({ db: 1, valkey: 1, s3: 1 }));
    for (const probe of Object.values(probes)) {
      await probe.close();
      await probe.close();
    }
  });
});
