import { describe, expect, it } from "vitest";

import {
  assertDailyPartition,
  buildPartitionPlan,
  InvalidPartitionPlanError,
} from "../../src/database/partitions/partition-plan.js";

describe("buildPartitionPlan", () => {
  it("uses exact UTC daily half-open boundaries", () => {
    const plan = buildPartitionPlan(new Date("2026-08-08T23:59:59.999Z"), 1);

    expect(plan).toEqual([
      {
        name: "logs_20260807",
        start: "2026-08-07T00:00:00.000Z",
        end: "2026-08-08T00:00:00.000Z",
      },
      {
        name: "logs_20260808",
        start: "2026-08-08T00:00:00.000Z",
        end: "2026-08-09T00:00:00.000Z",
      },
      {
        name: "logs_20260809",
        start: "2026-08-09T00:00:00.000Z",
        end: "2026-08-10T00:00:00.000Z",
      },
      {
        name: "logs_20260810",
        start: "2026-08-10T00:00:00.000Z",
        end: "2026-08-11T00:00:00.000Z",
      },
    ]);
  });

  it.each([
    ["leap day", "2024-02-29T12:00:00.000Z", "logs_20240228", "logs_20240302"],
    ["month end", "2025-04-30T12:00:00.000Z", "logs_20250429", "logs_20250502"],
    ["year end", "2025-12-31T12:00:00.000Z", "logs_20251230", "logs_20260102"],
  ])("handles %s", (_case, currentTime, firstName, lastName) => {
    const plan = buildPartitionPlan(new Date(currentTime), 1);

    expect(plan[0]?.name).toBe(firstName);
    expect(plan.at(-1)?.name).toBe(lastName);
  });

  it("includes the retention window, current day, and two future days", () => {
    const plan = buildPartitionPlan(new Date("2026-08-08T01:02:03.000Z"), 30);

    expect(plan).toHaveLength(33);
    expect(plan[0]?.name).toBe("logs_20260709");
    expect(plan.at(-1)?.name).toBe("logs_20260810");
  });

  it("produces stable names and boundaries", () => {
    const currentTime = new Date("2026-08-08T01:02:03.000Z");

    expect(buildPartitionPlan(currentTime, 30)).toEqual(buildPartitionPlan(currentTime, 30));
  });

  it.each([0, -1, 3_651, 1.5, Number.NaN])(
    "rejects invalid retention value %s",
    (retentionDays) => {
      expect(() => buildPartitionPlan(new Date(), retentionDays)).toThrow(
        InvalidPartitionPlanError,
      );
    },
  );

  it("rejects invalid dates", () => {
    expect(() => buildPartitionPlan(new Date("invalid"), 30)).toThrow(InvalidPartitionPlanError);
  });

  it("rejects generated structures that contain identifier syntax", () => {
    expect(() => {
      assertDailyPartition({
        name: "logs_20260808;DROP_TABLE",
        start: "2026-08-08T00:00:00.000Z",
        end: "2026-08-09T00:00:00.000Z",
      });
    }).toThrow(InvalidPartitionPlanError);
  });
});
