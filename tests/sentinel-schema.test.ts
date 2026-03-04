import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("standalone watcher schema", () => {
  it("includes deliveryTargets and watcher id format constraints", () => {
    const schemaPath = path.join(process.cwd(), "schema", "sentinel.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

    const watcher = schema?.$defs?.watcher;
    expect(watcher?.properties?.deliveryTargets?.items?.$ref).toBe("#/$defs/deliveryTarget");
    expect(watcher?.properties?.id?.pattern).toBe("^[A-Za-z0-9_-]{1,128}$");
  });
});
