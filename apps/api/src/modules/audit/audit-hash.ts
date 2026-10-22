// The audit hash (P4-05, ADR 0055): hash = sha256(prev_hash ‖ utf8(JCS(row))).
// Since P5-06 (ADR 0067, owner condition 4) it lives with the recorder in
// @bricx/db/audit; this module re-exports it for audit-chain.ts
// (audit:verify) and the tests.
export {
  HASHED_COLUMNS,
  HASH_VERSION,
  type HashedColumn,
  type HashedRow,
  KNOWN_HASH_VERSIONS,
  auditHash,
  genesisHash,
  hashedObject,
} from "@bricx/db/audit";
