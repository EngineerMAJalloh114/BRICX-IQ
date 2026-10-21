// Fixture: production code importing production modules only, including
// names that merely resemble the test-only paths.
import { noGrants } from "./grants-source.js";
import { realm } from "@bricx/keycloak-realm/realm";
import { supportFor } from "../support/test-like.js";
export { noGrants, realm, supportFor };
