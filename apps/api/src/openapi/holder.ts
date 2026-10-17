// The document's text and ETag, built once by createApp() and served by
// OpenApiController (P4-08, ADR 0058, decision 3a).
import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";

@Injectable()
export class OpenApiDocumentHolder {
  private current: { text: string; etag: string } | undefined;

  set(text: string): void {
    const digest = createHash("sha256").update(text).digest("base64url");
    this.current = { text, etag: `"${digest}"` };
  }

  get(): { text: string; etag: string } {
    if (this.current === undefined) {
      throw new Error("the OpenAPI document was not built (createApp sets it)");
    }
    return this.current;
  }
}
