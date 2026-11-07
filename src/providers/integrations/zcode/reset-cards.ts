/**
 * ZCode saved rate-limit reset cards (the 5-hour and weekly credits the
 * Coding Plan hands out when a window is exhausted).
 *
 * Wire contract (verified against the xrouter reference implementation):
 *
 * - `GET https://zcode.z.ai/api/v1/coding-plan/reset/status` lists the bank:
 *   `{ code: 0, data: { available_five_hour_resets: [{ expire_at }],
 *   available_week_resets: [{ expire_at }] } }`. Each entry is a bare expiry
 *   timestamp in epoch seconds — the endpoint carries no per-card id, so the
 *   card id is derived from the bucket type + expiry (`FIVE_HOUR_<sec>` /
 *   `WEEK_<sec>`) and redemption does not reference it.
 * - `POST https://zcode.z.ai/api/v1/coding-plan/reset/use` spends one card
 *   with `{ idempotency_key, reset_type: "FIVE_HOUR" | "WEEK" }`. The upstream
 *   picks which card in that bucket to burn; the idempotency key makes a
 *   retried POST safe.
 *
 * Both calls authenticate with the same ZCode login JWT the start-plan provider
 * stores, and accept the same identity header set as the billing reads. They
 * are kept beside (not inside) the reset-service: that service owns the
 * Codex/Claude wire shapes and the account-repair flow, while this module is
 * only the ZCode HTTP surface. The `zcode` provider's account-reset support
 * glues the two together.
 */
import { randomUUID } from "node:crypto";

import { asCoercedNumber, asRecord, asTrimmedString } from "../../../shared/coerce";
import type { FetchLike } from "../../authentication/oauth-client";
import { authCredential, text } from "../../quota/quota-contracts";

const ZCODE = "https://zcode.z.ai";
const RESET_STATUS_URL = `${ZCODE}/api/v1/coding-plan/reset/status`;
const RESET_USE_URL = `${ZCODE}/api/v1/coding-plan/reset/use`;
/** The Coding Plan client identity; the reset endpoints validate the header. */
const APP_VERSION = "3.17.1";
const PLATFORM = "linux-x64";
const TIMEOUT_MS = 15_000;

export type ZcodeResetType = "FIVE_HOUR" | "WEEK";

export interface ZcodeResetCard {
  /** `FIVE_HOUR_<expirySec>` / `WEEK_<expirySec>` — stable per card. */
  readonly id: string;
  readonly type: ZcodeResetType;
  readonly expiresAt: string;
}

export interface ZcodeResetList {
  readonly cards: readonly ZcodeResetCard[];
  readonly availableCount: number;
}

export interface ZcodeResetRedeemResult {
  readonly ok: boolean;
  readonly alreadyUsed: boolean;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** Identity headers the Coding Plan endpoints require on every call. */
function headers(credential: string, json: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: "application/json",
    "User-Agent": `ZCode/${APP_VERSION}`,
    "X-ZCode-App-Version": APP_VERSION,
    "X-Platform": PLATFORM,
    "X-Client-Language": "en-US",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

/**
 * The stored credential may be the bare login JWT or a JSON envelope (the
 * OAuth layer can persist structured credentials). Only the bearer string the
 * reset endpoints accept comes out of either shape.
 */
export function zcodeResetCredential(credentialRaw: string): string {
  const fields = authCredential(credentialRaw);
  return text(fields.accessToken) ?? text(fields.token) ?? credentialRaw.trim();
}

function cardsFrom(entries: unknown, type: ZcodeResetType): ZcodeResetCard[] {
  if (!Array.isArray(entries)) return [];
  const cards: ZcodeResetCard[] = [];
  for (const entry of entries) {
    const expirySec = asCoercedNumber(asRecord(entry)?.["expire_at"]);
    if (expirySec === undefined || expirySec <= 0) continue;
    const expiresAtMs = expirySec * 1000;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) continue;
    cards.push({
      id: `${type}_${expirySec}`,
      type,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }
  return cards.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
}

/**
 * Lists the unexpired reset cards the account is holding. `null` means the
 * status endpoint did not answer readably; an empty list is authoritative.
 */
export async function fetchZcodeResetCards(
  credentialRaw: string,
  fetcher: FetchLike,
): Promise<ZcodeResetList | null> {
  const credential = zcodeResetCredential(credentialRaw);
  if (!credential) return null;
  let response: Response;
  try {
    response = await fetcher(RESET_STATUS_URL, {
      headers: headers(credential, false),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const payload = asRecord(await response.json().catch(() => null));
  if (!payload || payload["success"] === false) return null;
  const code = payload["code"];
  if (![0, 200, "0", "200"].includes(code as string | number)) return null;
  const data = asRecord(payload["data"]);
  if (!data) return { cards: [], availableCount: 0 };
  const cards = [
    ...cardsFrom(data["available_five_hour_resets"], "FIVE_HOUR"),
    ...cardsFrom(data["available_week_resets"], "WEEK"),
  ];
  return { cards, availableCount: cards.length };
}

/**
 * Redeems one card from the given bucket. The upstream burns the bucket's own
 * choice of card, so the caller's `cardId` selects the type, not an individual
 * entry — the derived ids are how the UI names what it shows.
 */
export async function redeemZcodeResetCard(
  credentialRaw: string,
  type: ZcodeResetType,
  fetcher: FetchLike,
): Promise<ZcodeResetRedeemResult> {
  const credential = zcodeResetCredential(credentialRaw);
  if (!credential) {
    return {
      ok: false, alreadyUsed: false, status: 0,
      code: "missing_credential", message: "The account has no ZCode credential",
    };
  }
  let response: Response;
  try {
    response = await fetcher(RESET_USE_URL, {
      method: "POST",
      headers: headers(credential, true),
      body: JSON.stringify({ idempotency_key: randomUUID(), reset_type: type }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      alreadyUsed: false,
      status: 0,
      code: "network_error",
      message: error instanceof Error ? error.message : "Reset request failed",
    };
  }
  const payload = asRecord(await response.json().catch(() => null));
  const rawCode = payload?.["code"];
  const code = typeof rawCode === "string" && rawCode.trim() !== "" ? rawCode : rawCode;
  const codeOk = code === 0 || code === 200 || code === "0" || code === "200";
  if (response.ok && codeOk && payload?.["success"] !== false) {
    return {
      ok: true, alreadyUsed: false, status: response.status,
      code: "reset", message: "Reset applied",
    };
  }
  if (code === 1003) {
    return {
      ok: false, alreadyUsed: true, status: response.status,
      code: "already_used", message: "That reset was already redeemed",
    };
  }
  if (code === 1004 || code === "no_available_reset") {
    return {
      ok: false, alreadyUsed: false, status: response.status,
      code: "no_credit", message: "No saved reset credit is available",
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false, alreadyUsed: false, status: response.status,
      code: "auth_error", message: "Provider rejected the credential",
    };
  }
  return {
    ok: false,
    alreadyUsed: false,
    status: response.status,
    code: asTrimmedString(code) ?? `http_${response.status}`,
    message:
      asTrimmedString(payload?.["msg"]) ??
      asTrimmedString(payload?.["message"]) ??
      "Reset failed",
  };
}
