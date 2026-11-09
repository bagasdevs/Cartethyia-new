/**
 * ZCode gift-plan claims (the promo packs).
 *
 * This is **not** a check-in: ZCode has no streak, no daily credit and no
 * status/claim pair like the Buddy family. Its gift plans sit unclaimed on the
 * account until a claim is posted, and where they are offered is the tricky
 * part:
 *
 * - `/api/v1/zcode-plan/billing/preview` lists the plans the account may claim;
 * - the app's marketing feed (`/api/v1/marketing/touch`) lists the **banner**
 *   promos — a weekend build that appears in neither `preview` nor `current`
 *   while the app shows its banner.
 *
 * Both reads and the claim are app-only endpoints: a Bearer token alone is
 * answered `3001 parameter error` before auth. They need `X-Device-Mid` (the
 * gateway validates it as a UUID and never binds it to the account) and
 * `X-ZCode-App-Version`.
 *
 * The reply is judged by the body, never the HTTP status: `0` claimed, `1003`
 * already claimed, `3007` the app's Aliyun attestation is missing.
 */
import { createHash } from "node:crypto";
import { sleep } from "../../../shared/sleep";
import { asCoercedNumber, asRecord, asTrimmedString } from "../../../shared/coerce";
import type { ValidatedFetch } from "../../../network/outbound-fetch";

const ZCODE = "https://zcode.z.ai";
const BILLING = `${ZCODE}/api/v1/zcode-plan/billing`;
const TOUCH = `${ZCODE}/api/v1/marketing/touch`;
const APP_VERSION = "3.17.2";
const PLATFORM = "linux-x64";
const TIMEOUT_MS = 15_000;
const CLAIMED_ALREADY = 1003;
const CAPTCHA = 3007;
/** The upstream answers these under load; the same call succeeds later. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_TRIES = 3;

export type ZcodeGiftState = "claimed" | "already_claimed" | "nothing" | "captcha" | "partial" | "error";

export interface ZcodeGiftResult {
  readonly state: ZcodeGiftState;
  readonly claimed: readonly string[];
  readonly detail: string | null;
}

/** Stable per account — a per-request device id is itself a jitter signal. */
function deviceMid(accountId: string): string {
  const hash = createHash("sha256").update(`zcode-device\0${accountId}`).digest("hex");
  const variant = ((parseInt(hash[16] as string, 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function headers(credential: string, accountId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": `ZCode/${APP_VERSION}`,
    "X-Device-Mid": deviceMid(accountId),
    "X-Client-Language": "en-US",
    "X-ZCode-App-Version": APP_VERSION,
    "X-Platform": PLATFORM,
  };
}

/** The claim actions a marketing delivery offers, and the plan's own name. */
function bannerClaims(delivery: unknown): { plans: Array<{ planId: string; name: string | null; priority: number }>; malformed: boolean } {
  const ids: string[] = [];
  const names: string[] = [];
  let priority = 0;
  let malformed = false;
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    if (asTrimmedString(record["type"]) === "claim_zcode_plan") {
      const planId = asTrimmedString(asRecord(record["args"])?.["plan_id"]);
      if (planId !== undefined) ids.push(planId);
      else malformed = true;
    }
    const plan = asRecord(record["zcode_plan"]);
    const name = asTrimmedString(plan?.["name"]);
    if (name !== undefined) names.push(name);
    const p = asCoercedNumber(plan?.["priority"]);
    if (p !== undefined) priority = p;
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(delivery, 0);
  const name = names[0] ?? null;
  return { plans: ids.map((planId) => ({ planId, name, priority })), malformed };
}

/** Only a successful, readable envelope can represent an empty list. */
async function read(
  fetcher: ValidatedFetch,
  url: string,
  credential: string,
  accountId: string,
): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  let response = await fetcher(url, {
    method: "GET",
    headers: headers(credential, accountId),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  for (let attempt = 1; RETRY_STATUSES.has(response.status) && attempt < RETRY_TRIES; attempt += 1) {
    await sleep(1_500 * attempt);
    response = await fetcher(url, {
      method: "GET",
      headers: headers(credential, accountId),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  const payload = asRecord(await response.json().catch(() => null));
  if (!response.ok || !payload || payload["success"] === false) return { ok: false, data: null };
  const code = payload["code"];
  if (![0, 200, "0", "200"].includes(code as string | number)) return { ok: false, data: null };
  // Successful empty lists omit data (or return null) on the app endpoints.
  if (payload["data"] == null) return { ok: true, data: null };
  const data = asRecord(payload["data"]);
  return { ok: data !== undefined && data !== null, data: data ?? null };
}

/** One discovered gift plan, as the preview dialog renders it. */
export interface ZcodeGiftPlan {
  readonly planId: string;
  readonly name: string | null;
  /** Upstream `priority`; claim always takes highest-priority claimable plan first. */
  readonly priority: number;
  /** Where the plan was discovered: a marketing banner, billing preview, or a referral reward. */
  readonly source: "marketing" | "preview" | "incentive";
  /** Referral task progress; present only for incentive rewards. */
  readonly progress?: { readonly current: number; readonly target: number; readonly state: string | null };
  readonly inviteCode?: string | undefined;
  /** Billing-preview entitlements, when the plan lists them. */
  readonly entitlements?: readonly { readonly showName: string | null; readonly grantUnits: number | null }[];
}

/**
 * Every plan the account may claim, once each. A `null` for a list means it
 * did not read — never "nothing to claim".
 */
async function toClaim(
  fetcher: ValidatedFetch,
  credential: string,
  accountId: string,
): Promise<{ plans: ZcodeGiftPlan[]; unread: string[] }> {
  const plans: ZcodeGiftPlan[] = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  const add = (plan: ZcodeGiftPlan): void => {
    if (seen.has(plan.planId)) return;
    seen.add(plan.planId);
    plans.push(plan);
  };

  try {
    const feed = await read(fetcher, `${TOUCH}?seq=0`, credential, accountId);
    if (!feed.ok) unread.push("marketing feed did not read");
    else {
      const deliveries = feed.data?.["deliveries"];
      if (deliveries != null && (!Array.isArray(deliveries) || deliveries.some((delivery) => !asRecord(delivery)))) {
        unread.push("marketing feed has no delivery list");
      }
      for (const delivery of Array.isArray(deliveries) ? deliveries : []) {
        const banner = bannerClaims(delivery);
        if (banner.malformed) unread.push("marketing feed has an invalid claim action");
        for (const claim of banner.plans) add({ planId: claim.planId, name: claim.name ?? claim.planId, priority: claim.priority, source: "marketing" });
      }
    }
  } catch {
    unread.push("marketing feed did not read");
  }

  try {
    const preview = await read(
      fetcher,
      `${BILLING}/preview?app_version=${APP_VERSION}&platform=${PLATFORM}`,
      credential,
      accountId,
    );
    if (!preview.ok) unread.push("billing preview did not read");
    else {
      const listed = preview.data?.["plans"];
      if (listed != null && !Array.isArray(listed)) unread.push("billing preview has no plan list");
      for (const entry of Array.isArray(listed) ? listed : []) {
        const plan = asRecord(entry);
        const planId = asTrimmedString(plan?.["plan_id"]);
        if (planId === undefined) {
          unread.push("billing preview has an invalid plan");
          continue;
        }
        const entitlements = Array.isArray(plan?.["entitlements"]) ? plan?.["entitlements"] : [];
        add({
          planId,
          name: asTrimmedString(plan?.["name"]) ?? planId,
          priority: asCoercedNumber(plan?.["priority"]) ?? 0,
          source: "preview",
          ...(entitlements.length > 0 ? { entitlements: entitlements.map((raw) => {
            const entitlement = asRecord(raw);
            return {
              showName: asTrimmedString(entitlement?.["show_name"]) ?? null,
              grantUnits: asCoercedNumber(entitlement?.["grant_units"]) ?? null,
            };
          }) } : {}),
        });
      }
    }
  } catch {
    unread.push("billing preview did not read");
  }

  // Referral/incentive rewards (event gifts such as Weekend/Global Build)
  // live on their own endpoint, not in billing preview. A reward that reached
  // its target (or the completed state) is claimable via the same claim POST;
  // an in-progress one is listed so the operator sees the requirement instead
  // of a bare "nothing to claim".
  try {
    const incentive = await read(fetcher, `${ZCODE}/api/v1/incentive/referral/summary`, credential, accountId);
    if (!incentive.ok) unread.push("incentive summary did not read");
    else {
      const inviter = asRecord(incentive.data?.["inviter"]);
      const rewards = inviter?.["rewards"];
      if (rewards != null && !Array.isArray(rewards)) unread.push("incentive summary has no reward list");
      const inviteCode = asTrimmedString(inviter?.["invite_code"]);
      for (const entry of Array.isArray(rewards) ? rewards : []) {
        const reward = asRecord(entry);
        const plan = asRecord(reward?.["plan"]);
        const planId = asTrimmedString(plan?.["plan_id"]) ?? asTrimmedString(reward?.["reward_type"])
          ?? undefined;
        if (planId === undefined) continue;
        const current = Number(reward?.["current"]);
        const target = Number(reward?.["target"]);
        const state = asTrimmedString(reward?.["state"]) ?? null;
        const hasProgress = Number.isFinite(current) && Number.isFinite(target);
        const eligible = (state === "completed" || state === "achieved") || (hasProgress && target > 0 && current >= target);
        // A reward with neither progress fields nor the completed state is a
        // malformed entry, not an unmet requirement — skip it like the claim
        // path always did.
        if (!eligible && !hasProgress && state !== "in_progress") continue;
        add({
          planId,
          name: asTrimmedString(reward?.["title"]) ?? asTrimmedString(plan?.["name"]) ?? planId,
          priority: 0,
          source: "incentive",
          ...(hasProgress ? { progress: { current, target, state } } : {}),
          ...(inviteCode !== undefined ? { inviteCode } : {}),
        });
      }
    }
  } catch {
    unread.push("incentive summary did not read");
  }

  return { plans, unread };
}

/**
 * Runs the Start Plan activation handshake and confirms the plan went active.
 * The individual GETs are best-effort — activation is judged only by the final
 * balance read, the same signal the desktop client uses.
 */
async function startPlanHandshake(
  fetcher: ValidatedFetch,
  credential: string,
  accountId: string,
): Promise<boolean> {
  const steps = [
    `${TOUCH}?seq=1`,
    `${ZCODE}/api/v1/incentive/referral/summary`,
    `${BILLING}/preview?app_version=${APP_VERSION}`,
  ];
  for (const url of steps) {
    try {
      await fetcher(url, { method: "GET", headers: headers(credential, accountId), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      // A failed step does not stop the sequence; the balance read decides.
    }
  }
  try {
    const balance = await read(
      fetcher,
      `${BILLING}/balance?app_version=${APP_VERSION}`,
      credential,
      accountId,
    );
    if (!balance.ok || !balance.data) return false;
    const plans = Array.isArray(balance.data["plans"]) ? balance.data["plans"] : [];
    return plans.some((entry) => {
      const plan = asRecord(entry);
      return asTrimmedString(plan?.["status"])?.toLowerCase() === "active" &&
        /^zcode-v\d+-start-plan-/.test(asTrimmedString(plan?.["plan_id"]) ?? "");
    });
  } catch {
    return false;
  }
}

/** Posts one claim and says what the body's own code means. */
async function claimOne(
  fetcher: ValidatedFetch,
  credential: string,
  accountId: string,
  planId: string,
): Promise<"claimed" | "already_claimed" | "captcha" | "failed"> {
  // The Start Plan free tier is provisioned by the client's sequential
  // handshake (marketing touch → incentive summary → billing preview →
  // billing balance), not by POSTing to the claim endpoint; that POST answers
  // a rejection for this plan id.
  if (/^zcode-v\d+-start-plan-/.test(planId)) {
    const activated = await startPlanHandshake(fetcher, credential, accountId);
    return activated ? "claimed" : "failed";
  }
  let response = await fetcher(`${BILLING}/claim`, {
    method: "POST",
    headers: headers(credential, accountId),
    body: JSON.stringify({ plan_id: planId }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  for (let attempt = 1; RETRY_STATUSES.has(response.status) && attempt < RETRY_TRIES; attempt += 1) {
    await sleep(1_500 * attempt);
    response = await fetcher(`${BILLING}/claim`, {
      method: "POST",
      headers: headers(credential, accountId),
      body: JSON.stringify({ plan_id: planId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  const payload = asRecord(await response.json().catch(() => null));
  const rawCode = payload?.["code"];
  const code = typeof rawCode === "string" && rawCode.trim() !== "" ? Number(rawCode) : rawCode;
  if (payload?.["success"] === false) return "failed";
  if (code === CAPTCHA) return "captcha";
  if (code === CLAIMED_ALREADY) return "already_claimed";
  if (code === 0 && response.ok) return "claimed";
  return "failed";
}

/** Claims the highest-priority claimable gift plan (upstream `ClaimBest`). */
export async function claimZcodeGifts(args: {
  readonly accountId: string;
  readonly credential: string;
  readonly fetcher: ValidatedFetch;
}): Promise<ZcodeGiftResult> {
  const { accountId, credential, fetcher } = args;
  if (!credential) return { state: "error", claimed: [], detail: "account has no credential" };
  try {
    const { plans: discovered, unread } = await toClaim(fetcher, credential, accountId);
    // An incentive reward whose target is unmet would only draw a rejection
    // from the claim POST; it is "not yet", not a failure. Preview lists it;
    // the claim skips it. Only the highest-priority claimable plan is claimed
    // per run (upstream `ClaimBest`); the rest wait for the next run.
    const claimable = discovered.filter((plan) =>
      plan.source !== "incentive" || plan.progress === undefined ||
      (plan.progress.state === "completed" || plan.progress.state === "achieved") ||
      (plan.progress.target > 0 && plan.progress.current >= plan.progress.target)
    );
    const skipped = discovered.length - claimable.length;
    const plans = claimable.length ? [claimable.reduce((a, b) => (b.priority > a.priority ? b : a))] : [];
    if (plans.length === 0) {
      return unread.length > 0
        ? { state: "error", claimed: [], detail: unread.join("; ") }
        : { state: "nothing", claimed: [], detail: skipped > 0 ? `${skipped} reward(s) have not met their target yet` : null };
    }
    const claimed: string[] = [];
    const already: string[] = [];
    const captcha: string[] = [];
    const failed: string[] = [];
    for (const plan of plans) {
      const outcome = await claimOne(fetcher, credential, accountId, plan.planId).catch(() => "failed" as const);
      const name = plan.name ?? plan.planId;
      if (outcome === "claimed") claimed.push(name);
      else if (outcome === "already_claimed") already.push(name);
      else if (outcome === "captcha") captcha.push(name);
      else failed.push(name);
    }
    const detail = [
      captcha.length ? "CAPTCHA required; claim in the ZCode app" : "",
      failed.length ? `${failed.length} gift claim(s) failed` : "",
      ...unread,
    ].filter(Boolean).join("; ");
    const outcomes = [claimed.length > 0 || already.length > 0, captcha.length > 0, failed.length > 0 || unread.length > 0];
    if (outcomes.filter(Boolean).length > 1) return { state: "partial", claimed, detail: detail || null };
    if (failed.length > 0 || unread.length > 0) return { state: "error", claimed, detail: detail || null };
    if (captcha.length > 0) return { state: "captcha", claimed, detail: detail || null };
    if (claimed.length > 0) return { state: "claimed", claimed, detail: null };
    return { state: "already_claimed", claimed, detail: null };
  } catch {
    return {
      state: "error",
      claimed: [],
      detail: "Gift claim request failed",
    };
  }
}

/** Result of {@link previewZcodeGifts}: what the account could claim right now. */
export interface ZcodeGiftPreview {
  readonly plans: readonly ZcodeGiftPlan[];
  /**
   * Claimable now = marketing/preview plans (they answer the claim POST) plus
   * incentive rewards whose target is met. In-progress rewards are listed but
   * flagged, so the operator sees the requirement instead of an empty list.
   */
  readonly claimableCount: number;
  readonly unread: readonly string[];
}

/**
 * Reads every discovery source without claiming anything. The read failures
 * surface as `unread` — a preview that read nothing is an error state, never
 * a silent "no gifts".
 */
export async function previewZcodeGifts(args: {
  readonly accountId: string;
  readonly credential: string;
  readonly fetcher: ValidatedFetch;
}): Promise<ZcodeGiftPreview> {
  const { accountId, credential, fetcher } = args;
  if (!credential) return { plans: [], claimableCount: 0, unread: ["account has no credential"] };
  try {
    const { plans, unread } = await toClaim(fetcher, credential, accountId);
    const claimableCount = plans.filter((plan) =>
      plan.source !== "incentive" ||
      plan.progress === undefined ||
      (plan.progress.state === "completed" || plan.progress.state === "achieved") ||
      (plan.progress.target > 0 && plan.progress.current >= plan.progress.target)
    ).length;
    return { plans, claimableCount, unread };
  } catch {
    return { plans: [], claimableCount: 0, unread: ["Gift preview request failed"] };
  }
}
