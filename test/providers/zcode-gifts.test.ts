import { describe, expect, test } from "bun:test";
import { claimZcodeGifts, previewZcodeGifts } from "../../src/providers/integrations/zcode-start-plan/gifts";
import type { ValidatedFetch } from "../../src/network/outbound-fetch";

const emptyFeed = { code: 0, data: { deliveries: [] } };
const emptyPreview = { code: 0, msg: "" };

function fixture(feed: unknown, preview: unknown, codes: readonly unknown[] = [], incentive: unknown = { code: 0, data: {} }) {
  let posts = 0;
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetcher: ValidatedFetch = async (url, init) => {
    signals.push(init?.signal);
    if (init?.method === "POST") {
      const code = codes[posts++];
      return code === "not-json" ? new Response("not-json") : Response.json({ code });
    }
    const body = String(url).includes("marketing/touch")
      ? feed
      : String(url).includes("incentive/referral")
        ? incentive
        : preview;
    return body === "not-json" ? new Response("not-json") : Response.json(body);
  };
  return { fetcher, signals, posts: () => posts };
}

const preview = (count: number) => ({ code: 0, data: { plans: Array.from({ length: count }, (_, i) => ({ plan_id: `plan-${i}`, name: `Gift ${i}` })) } });
const claim = (fetcher: ValidatedFetch) => claimZcodeGifts({ accountId: "fixture", credential: "dummy-secret", fetcher });

describe("ZCode gift outcomes", () => {
  test("the documented no-data preview and valid empty feed mean nothing", async () => {
    const upstream = fixture(emptyFeed, emptyPreview);
    expect(await claim(upstream.fetcher)).toEqual({ state: "nothing", claimed: [], detail: null });
    expect(upstream.posts()).toBe(0);
  });

  for (const data of [undefined, null, {}]) {
    test(`successful omitted lists are empty: ${JSON.stringify(data)}`, async () => {
      expect((await claim(fixture({ code: 0, data }, { code: 0, data }).fetcher)).state).toBe("nothing");
    });
  }

  for (const broken of ["not-json", { success: false }, {}, { code: 999 }, { code: 0, data: [] }, { code: 0, data: { plans: {} } }, { code: 0, data: { plans: [null] } }]) {
    test(`invalid preview is failure: ${JSON.stringify(broken)}`, async () => {
      const upstream = fixture(emptyFeed, broken);
      expect((await claim(upstream.fetcher)).state).toBe("error");
      expect(upstream.posts()).toBe(0);
    });
  }

  for (const broken of ["not-json", { success: false }, { code: 0, data: [] }, { code: 0, data: { deliveries: {} } }, { code: 0, data: { deliveries: [null] } }]) {
    test(`invalid feed is failure: ${JSON.stringify(broken)}`, async () => {
      expect((await claim(fixture(broken, emptyPreview).fetcher)).state).toBe("error");
    });
  }

  for (const [code, state] of [[0, "claimed"], [1003, "already_claimed"], [3007, "captcha"], [7777, "error"], ["not-json", "error"]] as const) {
    test(`claim code ${code} means ${state} and every request is bounded`, async () => {
      const upstream = fixture(emptyFeed, preview(1), [code]);
      const result = await claim(upstream.fetcher);
      expect(result.state).toBe(state);
      expect(result.claimed).toEqual(code === 0 ? ["Gift 0"] : []);
      expect(upstream.signals).toHaveLength(4);
      expect(upstream.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    });
  }

  test("marketing banner claims are discovered and deduplicated against preview", async () => {
    const feed = { code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "plan-0" } } }], background: { args: { zcode_plan: { name: "Banner Gift" } } } } }] } };
    const upstream = fixture(feed, preview(1), [0]);
    expect(await claim(upstream.fetcher)).toEqual({ state: "claimed", claimed: ["Banner Gift"], detail: null });
    expect(upstream.posts()).toBe(1);
  });

  test("an invalid marketing claim action is not an empty feed", async () => {
    const feed = { code: 0, data: { deliveries: [{ action: { type: "claim_zcode_plan", args: {} } }] } };
    expect((await claim(fixture(feed, emptyPreview).fetcher)).state).toBe("error");
  });

  test("success false on a claim cannot override the business failure", async () => {
    const upstream = fixture(emptyFeed, preview(1));
    const fetcher: ValidatedFetch = (url, init) => init?.method === "POST"
      ? Promise.resolve(Response.json({ code: 0, success: false })) : upstream.fetcher(url, init);
    expect((await claim(fetcher)).state).toBe("error");
  });

  test("claims only the highest-priority plan", async () => {
    const prioPreview = { code: 0, data: { plans: [
      { plan_id: "p-low", name: "Low", priority: 1 },
      { plan_id: "p-high", name: "High", priority: 9 },
    ] } };
    const upstream = fixture(emptyFeed, prioPreview, [0]);
    const result = await claim(upstream.fetcher);
    expect(result.state).toBe("claimed");
    expect(result.claimed).toEqual(["High"]);
    expect(upstream.posts()).toBe(1);
  });

  test("an unread list is partial even when every discovered gift was already claimed", async () => {
    const result = await claim(fixture("not-json", preview(1), [1003]).fetcher);
    expect(result.state).toBe("partial");
    expect(result.detail).toContain("did not read");
  });

  test("transport credentials are never copied into result details", async () => {
    const result = await claim(async () => { throw new Error("Bearer dummy-secret"); });
    expect(result.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain("dummy-secret");
  });

  test("a completed incentive reward is discovered and claimed", async () => {
    const incentive = {
      code: 0,
      data: { inviter: { rewards: [{ reward_type: "build", title: "Weekend Build", state: "completed", plan: { plan_id: "plan-wk", name: "Weekend Build" } }] } },
    };
    const upstream = fixture(emptyFeed, emptyPreview, [0], incentive);
    expect(await claim(upstream.fetcher)).toEqual({ state: "claimed", claimed: ["Weekend Build"], detail: null });
    expect(upstream.posts()).toBe(1);
  });

  test("an in-progress incentive reward is not claimable", async () => {
    const incentive = {
      code: 0,
      data: { inviter: { rewards: [{ reward_type: "build", title: "Weekend Build", state: "in_progress", current: 1, target: 5, plan: { plan_id: "plan-wk", name: "Weekend Build" } }] } },
    };
    expect((await claim(fixture(emptyFeed, emptyPreview, [], incentive).fetcher)).state).toBe("nothing");
  });

  test("an unread incentive summary is an error, never an empty list", async () => {
    expect((await claim(fixture(emptyFeed, emptyPreview, [], "not-json").fetcher)).state).toBe("error");
  });

  test("a start-plan id activates through the handshake instead of the claim POST", async () => {
    // Exact start-plan ID (no numeric suffix) triggers handshake
    const feed = { code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "zcode-v3-start-plan" } } }] } }] } };
    const balance = { code: 0, data: { plans: [{ plan_id: "zcode-v3-start-plan", status: "active" }] } };
    const fetcher: ValidatedFetch = async (url, init) => {
      const target = String(url);
      if (init?.method === "POST") throw new Error("claim POST must not run for the start plan");
      if (target.includes("billing/balance")) return Response.json(balance);
      if (target.includes("marketing/touch")) return Response.json(feed);
      return Response.json({ code: 0, data: {} });
    };
    expect(await claimZcodeGifts({ accountId: "fixture", credential: "dummy-secret", fetcher }))
      .toEqual({ state: "claimed", claimed: ["zcode-v3-start-plan"], detail: null });
  });

  test("a start-plan handshake without an active plan is a failure, not a success", async () => {
    // Exact start-plan ID (no numeric suffix) triggers handshake
    const feed = { code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "zcode-v3-start-plan" } } }] } }] } };
    const upstream = fixture(feed, emptyPreview);
    expect((await claim(upstream.fetcher)).state).toBe("error");
    expect(upstream.posts()).toBe(0);
  });

  test("a marketing plan with start-plan-like ID claims via POST, not handshake", async () => {
    // Marketing plans with numeric suffix (e.g. -0817) go through POST claim
    const feed = { code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "zcode-v3-start-plan-0817" } } }] } }] } };
    const claimResponse = { code: 0, data: { plan: { plan_id: "zcode-v3-start-plan-0817" } } };
    let postCalled = false;
    const fetcher: ValidatedFetch = async (url, init) => {
      const target = String(url);
      if (init?.method === "POST" && target.includes("billing/claim")) {
        postCalled = true;
        return Response.json(claimResponse);
      }
      if (target.includes("marketing/touch")) return Response.json(feed);
      return Response.json({ code: 0, data: {} });
    };
    const result = await claimZcodeGifts({ accountId: "fixture", credential: "dummy-secret", fetcher });
    expect(postCalled).toBe(true);
    expect(result.state).toBe("claimed");
    expect(result.claimed).toEqual(["zcode-v3-start-plan-0817"]);
  });
});

describe("ZCode gift preview", () => {
  const previewOf = (fetcher: ValidatedFetch) =>
    previewZcodeGifts({ accountId: "fixture", credential: "dummy-secret", fetcher });

  test("lists sources with metadata and counts only claimable plans", async () => {
    const incentive = {
      code: 0,
      data: { inviter: { invite_code: "REF123", rewards: [
        { reward_type: "done", title: "Done Task", state: "achieved", plan: { plan_id: "plan-done" } },
        { reward_type: "wip", title: "Wip Task", state: "in_progress", current: 1, target: 5, plan: { plan_id: "plan-wip" } },
      ] } },
    };
    const previewList = { code: 0, data: { plans: [{ plan_id: "plan-bill", name: "Billing Gift", entitlements: [{ show_name: "Tokens", grant_units: 500_000_000 }] }] } };
    const feed = { code: 0, data: { deliveries: [{ banner: { buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "plan-banner" } } }] } }] } };
    const result = await previewOf(fixture(feed, previewList, [], incentive).fetcher);
    // banner + billing + completed task are claimable; the in-progress task is not.
    expect(result.claimableCount).toBe(3);
    expect(result.plans.map((plan) => plan.source)).toEqual(["marketing", "preview", "incentive", "incentive"]);
    expect(result.plans[1]?.entitlements?.[0]?.grantUnits).toBe(500_000_000);
    expect(result.plans[2]?.progress).toBeUndefined();
    expect(result.plans[3]?.progress).toEqual({ current: 1, target: 5, state: "in_progress" });
    expect(result.plans[2]?.inviteCode).toBe("REF123");
    expect(result.unread).toEqual([]);
  });

  test("a preview that read nothing is an error state, not an empty success", async () => {
    const result = await previewOf(fixture("not-json", "not-json", [], "not-json").fetcher);
    expect(result.plans).toEqual([]);
    expect(result.claimableCount).toBe(0);
    expect(result.unread).toHaveLength(3);
  });

  test("preview never issues a claim POST", async () => {
    let posts = 0;
    const fetcher: ValidatedFetch = async (_url, init) => {
      if (init?.method === "POST") posts += 1;
      return Response.json({ code: 0, data: {} });
    };
    await previewOf(fetcher);
    expect(posts).toBe(0);
  });
});
