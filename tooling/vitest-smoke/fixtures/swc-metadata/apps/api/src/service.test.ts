import { expect, test } from "vitest";

type Recorded = [key: string, value: unknown];
const recorded: Recorded[] = [];

// Stand-in for reflect-metadata: emitted decorator metadata calls
// Reflect.metadata(key, value). Installed before the service module loads.
Object.assign(Reflect, {
  metadata: (key: string, value: unknown) => {
    recorded.push([key, value]);
    return () => undefined;
  },
});

test("emits design:paramtypes for constructor injection", async () => {
  const { Clock, InvoiceService } = await import("./service.js");
  expect(new InvoiceService(new Clock()).clock.zone).toBe("UTC");
  expect(recorded).toContainEqual(["design:paramtypes", [Clock]]);
});
