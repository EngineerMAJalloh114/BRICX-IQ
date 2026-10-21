// Devices' repository (P5-03, ADR 0063): every statement runs in the `tx`
// TxRunner hands over, as bricx_app under the own-row policies of
// bricx.devices (user_id = app.current_user_id(); UPDATE on name,
// last_seen_at and revoked_at only). A unique violation on insert
// (SQLSTATE 23505: the id belongs to a row this user cannot see, so to
// another user) is ApiError("request.conflict") (409).
import { type Tx, sqlstateOf } from "@bricx/db/database";
import { devices } from "@bricx/db/schema";
import { Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors/api-error.js";
import { type DeviceData, PLATFORMS } from "./devices.dto.js";

const UNIQUE_VIOLATION = "23505";

const iso = (column: typeof devices.createdAt) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const isoOrNull = (column: typeof devices.revokedAt) =>
  sql<
    string | null
  >`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const columns = {
  id: devices.id,
  platform: devices.platform,
  name: devices.name,
  createdAt: iso(devices.createdAt),
  lastSeenAt: iso(devices.lastSeenAt),
  trusted: devices.trusted,
  revokedAt: isoOrNull(devices.revokedAt),
};

type Platform = (typeof PLATFORMS)[number];
const isPlatform = (value: string): value is Platform =>
  (PLATFORMS as readonly string[]).includes(value);

/** The row as the DTO: the platform column is text in the table. */
function asDevice(
  row: Omit<DeviceData, "platform"> & { platform: string },
): DeviceData {
  if (!isPlatform(row.platform)) {
    throw new Error("devices: unknown platform in the table");
  }
  return { ...row, platform: row.platform };
}

export interface NewDevice {
  readonly id: string;
  readonly userId: string;
  readonly platform: Platform;
  readonly name: string;
  /** ISO 8601 UTC, from the Clock. */
  readonly now: string;
}

@Injectable()
export class DevicesRepository {
  /** Inserts one row; a unique violation is ApiError("request.conflict"). */
  async insert(tx: Tx, device: NewDevice): Promise<DeviceData> {
    let rows: (Omit<DeviceData, "platform"> & { platform: string })[];
    try {
      rows = await tx
        .insert(devices)
        .values({
          id: device.id,
          userId: device.userId,
          platform: device.platform,
          name: device.name,
          createdAt: device.now,
          lastSeenAt: device.now,
        })
        .returning(columns);
    } catch (error) {
      if (sqlstateOf(error) === UNIQUE_VIOLATION) {
        throw new ApiError("request.conflict");
      }
      throw error;
    }
    const [row] = rows;
    if (row === undefined) throw new Error("insert returned no row");
    return asDevice(row);
  }

  /** The caller's device with `id`, if any (RLS hides other users'). */
  async findById(tx: Tx, id: string): Promise<DeviceData | undefined> {
    const [row] = await tx
      .select(columns)
      .from(devices)
      .where(eq(devices.id, id));
    return row === undefined ? undefined : asDevice(row);
  }

  /** The caller's devices, by id (UUIDv7, so by time). */
  async listMine(tx: Tx): Promise<DeviceData[]> {
    const rows = await tx
      .select(columns)
      .from(devices)
      .orderBy(asc(devices.id));
    return rows.map(asDevice);
  }

  /** Sets revoked_at on the caller's open device `id`; false when none. */
  async revoke(tx: Tx, id: string, now: string): Promise<boolean> {
    const rows = await tx
      .update(devices)
      .set({ revokedAt: now })
      .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
      .returning({ id: devices.id });
    return rows.length > 0;
  }
}
