import { describe, expect, test } from "bun:test";
import {
  fetchZcodeResetCards,
  redeemZcodeResetCard,
  zcodeResetCredential,
} from "../../src/providers/integrations/zcode/reset-cards";
import { listAccountResetCredits, supportsAccountReset } from "../../src/providers/operations/account-reset-service";

const statusEnvelope = (five: number[], week: number[], nowSec = 1_800_000_000) => ({
  code: 0,
  data: {
    available_five_hour_resets: five.map((offset) => ({ expire_at: nowSec + offset })),
    available_week_resets: week.map((offset) => ({ expire_at: nowSec + offset })),
  },
});

function fetcherWith(body: unknown, status = 200) {
  return (async () => Response.json(body, { status })) as unknown as typeof fetch;
}

describe("zcode reset cards", () => {
  test("supportsAccountReset includes zcode", () => {
    expect(supportsAccountReset("zcode")).toBe(true);
    expect(supportsAccountReset("zcode-start")).toBe(false);
  });

  test("a bare JWT and a JSON envelope both yield the bearer", () => {
    expect(zcodeResetCredential("jwt-token")).toBe("jwt-token");
    expect(zcodeResetCredential(JSON.stringify({ accessToken: "env-token" }))).toBe("env-token");
  });

  test("lists unexpired five-hour and weekly cards sorted by expiry", async () => {
    const list = await listAccountResetCredits("zcode", "jwt", fetcherWith(statusEnvelope([7200, 3600], [100_000])));
    expect(list?.availableCount).toBe(3);
    const ids = list?.credits.map((credit) => credit.id) ?? [];
    expect(ids).toEqual([
      "FIVE_HOUR_1800003600",
      "FIVE_HOUR_1800007200",
      "WEEK_1800100000",
    ]);
    expect(list?.credits[0]?.title).toBe("5-hour rate-limit reset");
    expect(list?.credits[2]?.title).toBe("Weekly rate-limit reset");
  });

  test("expired entries are dropped, not listed", async () => {
    const list = await listAccountResetCredits("zcode", "jwt", fetcherWith(statusEnvelope([-100], [], 1)));
    expect(list).toEqual({ credits: [], availableCount: 0 });
  });

  test("a non-ok or rejected status read is null, never an empty list", async () => {
    expect(await listAccountResetCredits("zcode", "jwt", fetcherWith(statusEnvelope([1], [2]), 500))).toBeNull();
    expect(await listAccountResetCredits("zcode", "jwt", fetcherWith({ code: 401 }))).toBeNull();
    expect(await listAccountResetCredits("zcode", "jwt", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBeNull();
  });

  test("successful redemption maps to code reset", async () => {
    const result = await redeemZcodeResetCard("jwt", "FIVE_HOUR", fetcherWith({ code: 0 }));
    expect(result).toMatchObject({ ok: true, code: "reset" });
  });

  test("upstream business codes map to already-used and no-credit", async () => {
    expect((await redeemZcodeResetCard("jwt", "WEEK", fetcherWith({ code: 1003 }))).code).toBe("already_used");
    expect((await redeemZcodeResetCard("jwt", "WEEK", fetcherWith({ code: 1004 }))).code).toBe("no_credit");
    expect((await redeemZcodeResetCard("jwt", "WEEK", fetcherWith({ msg: "nope" }, 400))).status).toBe(400);
  });

  test("a failed fetch is a network error, not a thrown one", async () => {
    const result = await redeemZcodeResetCard("jwt", "WEEK", (async () => { throw new Error("down"); }) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("network_error");
  });

  test("fetchZcodeResetCards alone parses the bank", async () => {
    const list = await fetchZcodeResetCards("jwt", fetcherWith(statusEnvelope([60], [])));
    expect(list?.cards).toHaveLength(1);
    expect(list?.cards[0]?.type).toBe("FIVE_HOUR");
  });
});
