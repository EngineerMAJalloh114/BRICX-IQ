// Fake readiness probes for the unit tests: each records close() and can
// be switched down. A down probe rejects with a sentinel message that
// must never reach a response or a log line.
import type { Probe } from "../src/common/health/probes.js";

export const PROBE_SENTINEL = "probe-sentinel-c0nn3ction-string";

export interface FakeProbe extends Probe {
  down: boolean;
  closed: number;
}

export function fakeProbe(): FakeProbe {
  const probe: FakeProbe = {
    down: false,
    closed: 0,
    check() {
      return probe.down
        ? Promise.reject(new Error(PROBE_SENTINEL))
        : Promise.resolve();
    },
    close() {
      probe.closed += 1;
      return Promise.resolve();
    },
  };
  return probe;
}

export function fakeProbes() {
  return { db: fakeProbe(), valkey: fakeProbe(), s3: fakeProbe() };
}
