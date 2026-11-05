/**
 * `/system/usage/cache` and `/system/usage/summary` must report the same
 * hit rate over the same window. The cache endpoint used to divide by
 * input + output while the summary divided by input, so two Usage surfaces
 * disagreed; cached tokens are a subset of the prompt, never of the output.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { DrizzleObservabilityStore } from "../../src/console/observability/store";
import { apiKeys, providers, telemetryEvents, tenants } from "../../src/persistence/schema";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "carte-usage-cache-rate-"));
  const sqlite = createSqliteDatabase(join(dir, "q.sqlite"));
  await applySqliteMigrations(sqlite);
  const { db } = buildSqliteHandle(sqlite);
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "usage-cache-rate", status: "active" })
    .returning({ id: tenants.id });
  if (tenant === undefined) throw new Error("tenant insert returned no row");
  await db.insert(providers).values({ id: "p" });
  const [key] = await db
    .insert(apiKeys)
    .values({
      tenantId: tenant.id,
      keyMode: "personal",
      keyHash: "hash-rate",
      label: "k",
      scopes: ["routing:invoke"],
    })
    .returning({ id: apiKeys.id });
  return {
    db,
    tenantId: tenant.id,
    apiKeyId: key?.id ?? "",
    cleanup: () => {
      try { sqlite.close(); } catch { /* already closed */ }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* retry */ }
      }
    },
  };
}

describe("usage cache hit rate", () => {
  test("cache endpoint divides by input, matching summary and the raw counters", async () => {
    const fx = await fixture();
    try {
      // Output is deliberately large: an input+output denominator would read
      // 26.67% here instead of the true 40%.
      await fx.db.insert(telemetryEvents).values({
        id: crypto.randomUUID(),
        tenantId: fx.tenantId,
        requestId: crypto.randomUUID(),
        createdAt: new Date(),
        sourceSurface: "chat",
        requestedModel: "wk/hy4",
        clientName: "bun",
        providerId: "p",
        apiKeyId: fx.apiKeyId,
        status: "completed",
        httpStatus: 200,
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 500,
      });

      const store = new DrizzleObservabilityStore(fx.db, undefined);
      const period = "24h";
      const cache = await store.usageCache(fx.tenantId, period);
      const summary = await store.usageSummary(fx.tenantId, period);

      expect(cache.value.inputTokens).toBe(1_000);
      expect(cache.value.cachedTokens).toBe(400);
      expect(cache.value.hitRate).toBe(40);
      expect(summary.value.totals.cachedTokens).toBe(400);
      expect(summary.value.totals.cacheHitRate).toBe(40);
      expect(cache.value.hitRate).toBe(summary.value.totals.cacheHitRate);
    } finally {
      fx.cleanup();
    }
  });
});
