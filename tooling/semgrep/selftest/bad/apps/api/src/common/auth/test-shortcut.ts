// Fixture: production code that reaches for the test-only auth support.
import { roleGrants } from "../../../test/support/auth.js";
import type { TestAccess } from "../../../test/support/auth.js";
import * as support from "../../../test/support/auth.js";
import { startKeycloak } from "@bricx/keycloak-realm/testing";
export const lazy = () => import("../../../test/support/auth.js");
export const lazyKeycloak = () => import("@bricx/keycloak-realm/testing");
export { roleGrants, startKeycloak, support, type TestAccess };
