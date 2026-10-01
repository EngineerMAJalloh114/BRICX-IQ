// Conventional Commits (CLAUDE.md workflow step 5), checked by the commit-msg
// hook. A scope is optional; when given it must be one of these. Add a scope
// in the task that creates the area (for example an API module), not before.
const scopes = [
  // Repository areas
  "tooling",
  "lint",
  "format",
  "test",
  "turbo",
  "hooks",
  "deps",
  "ci",
  "claude",
  "adr",
  "docs",
  // Apps
  "api",
  "worker",
  "client",
  // Packages
  "ids",
  "money",
  "i18n",
  "validation",
  "permissions",
  "domain",
  "db",
  "sync-schema",
  "ui",
  "api-client",
  "adapters",
  "config",
  // Infrastructure
  "infra",
  "docker",
  "tofu",
  "keycloak",
];

module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", scopes],
  },
};
