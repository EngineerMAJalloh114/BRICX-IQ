// Fixture: a test imports the test-only support freely.
import { roleGrants } from "./support/auth.js";
import { startKeycloak } from "@bricx/keycloak-realm/testing";
export { roleGrants, startKeycloak };
