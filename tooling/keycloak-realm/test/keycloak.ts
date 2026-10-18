// Starts Keycloak the way compose.yml does, for realm-import.int.test.ts
// (P5-01, ADR 0060): the image is built from compose.yml's build context
// (infrastructure/docker/keycloak/Dockerfile, the same file), and the
// command, environment and realm bind mount come from `docker compose
// config` on the real compose.yml with .env.example (no second copy). The
// bootstrap admin is a throwaway identity generated per run.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import type { Json } from "../src/normalise.js";
import { imageDir, repoRoot } from "../src/realm.js";

interface ComposeService {
  build?: { context: string; dockerfile: string };
  command: string[] | null;
  environment: Record<string, string>;
  volumes?: {
    type: string;
    source: string;
    target: string;
    read_only?: boolean;
  }[];
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
      "config",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  ),
) as { services: Record<string, ComposeService | undefined> };

const service = config.services.keycloak;
if (service === undefined) throw new Error("compose.yml has no keycloak");
export const keycloakService: ComposeService = service;

/** The realm file bind mount compose.yml declares (read-only). */
const realmMount = (service.volumes ?? []).find((v) => v.type === "bind");
if (realmMount === undefined) {
  throw new Error("compose.yml: keycloak has no realm bind mount");
}
export const composeRealmMount = realmMount;

const IMAGE = "bricx-keycloak-test:p5-01";
let built: Promise<GenericContainer> | undefined;

/** Builds the image once per run; Docker's layer cache makes reruns fast. */
function image(): Promise<GenericContainer> {
  if (service?.build?.context !== imageDir) {
    throw new Error(
      `compose.yml builds keycloak from ${String(service?.build?.context)}, not ${imageDir}`,
    );
  }
  built ??= GenericContainer.fromDockerfile(
    imageDir,
    service.build.dockerfile,
  ).build(IMAGE, { deleteOnExit: false });
  return built;
}

export interface Keycloak {
  readonly container: StartedTestContainer;
  /** http://host:port of the public listener. */
  readonly base: string;
  /** A JSON call to the admin REST API of the bricx realm (or `path` as given). */
  admin(method: string, adminPath: string, body?: Json): Promise<Json>;
  /** A raw call with no redirects followed. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Keycloak with the realm imported, as compose.yml starts it. `extraHosts`
 * adds /etc/hosts entries (the login suite's host.docker.internal for its
 * SMTP sink); compose sets none.
 */
export async function startKeycloak(
  realmSource = realmMount?.source ?? "",
  extraHosts: { host: string; ipAddress: string }[] = [],
): Promise<Keycloak> {
  const adminUser = "bootstrap-test";
  const adminPassword = randomBytes(16).toString("hex");
  const environment = {
    ...service?.environment,
    KC_BOOTSTRAP_ADMIN_USERNAME: adminUser,
    KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
  };
  const container = await (
    await image()
  )
    .withCommand(service?.command ?? [])
    .withEnvironment(environment)
    .withBindMounts([
      { source: realmSource, target: realmMount?.target ?? "", mode: "ro" },
    ])
    .withExtraHosts(extraHosts)
    .withExposedPorts(8080, 9000)
    .withWaitStrategy(
      Wait.forHttp("/health/ready", 9000)
        .forStatusCode(200)
        .withStartupTimeout(300_000),
    )
    .start();
  const base = `http://${container.getHost()}:${String(container.getMappedPort(8080))}`;
  const raw = (url: string, init?: RequestInit) =>
    fetch(url, { redirect: "manual", ...init });

  let token: { value: string; until: number } | undefined;
  async function adminToken(): Promise<string> {
    if (token !== undefined && token.until > performance.now()) {
      return token.value;
    }
    const response = await raw(
      `${base}/realms/master/protocol/openid-connect/token`,
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "admin-cli",
          username: adminUser,
          password: adminPassword,
        }),
      },
    );
    const body = (await response.json()) as { access_token: string };
    // Master-realm admin tokens live 60 s; refresh well before.
    token = { value: body.access_token, until: performance.now() + 30_000 };
    return token.value;
  }

  return {
    container,
    base,
    fetch: raw,
    async admin(method, adminPath, body) {
      const url = adminPath.startsWith("/admin/")
        ? `${base}${adminPath}`
        : `${base}/admin/realms/bricx${adminPath}`;
      const init: RequestInit = {
        method,
        headers: {
          authorization: `Bearer ${await adminToken()}`,
          "content-type": "application/json",
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await raw(url, init);
      if (!response.ok) {
        throw new Error(
          `${method} ${adminPath}: HTTP ${String(response.status)}`,
        );
      }
      const text = await response.text();
      return text === "" ? null : (JSON.parse(text) as Json);
    },
  };
}

/** The realm as Keycloak holds it: the admin API's partial export. */
export async function exportRealm(keycloak: Keycloak): Promise<Json> {
  return keycloak.admin(
    "POST",
    "/partial-export?exportClients=true&exportGroupsAndRoles=true",
  );
}
