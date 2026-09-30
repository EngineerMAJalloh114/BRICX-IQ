# 0012. File uploads: S3 multipart with presigned part URLs

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C12

## Context

Stack v1 left resumable uploads open: tus **or** S3 multipart. Field photos and documents are uploaded over unreliable networks and must resume.

## Decision

Use **S3 multipart uploads with presigned part URLs**, resumable from a local upload queue on the device.

## Consequences

Positive:
- No extra tus server to run.
- Works with any S3-compatible store (MinIO locally).

Negative:
- The client owns part tracking and resume logic, which must be tested under network loss. (architect-reviewed 2026-09-30)
- Abandoned multipart uploads must be cleaned up (bucket lifecycle rule) or they accrue storage cost. (architect-reviewed 2026-09-30)
- Presigned URLs expire, so long-offline devices must request fresh ones before resuming. (architect-reviewed 2026-09-30)

## Alternatives rejected

- **tus**: requires an extra tus server.
