import { Gift, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  useAccountGiftPreview,
  useClaimAccountGifts,
  useRefreshAccountQuota,
  useCaptchaConfig,
  type GiftClaimResult,
  type GiftPreviewPlan,
} from "../hooks/quota";
import { getErrorMessage } from "../data/api";
import { toast } from "../lib/toast";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Badge } from "./ui/badge";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";

const SOURCE_LABEL: Record<GiftPreviewPlan["source"], string> = {
  marketing: "Banner",
  preview: "Billing",
  incentive: "Task",
};

// DeepSeek-V4.1-Flash Captcha SDK URL (same as ShinRyu04/zcode-bridge-mod)
const CAPTCHA_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

function claimResultToast(state: GiftClaimResult["state"], detail: string | null): void {
  const message: Record<string, { tone: "success" | "warning" | "error"; title: string }> = {
    claimed: { tone: "success", title: "Gift plans claimed" },
    already_claimed: { tone: "success", title: "Gift plans already claimed" },
    nothing: { tone: "success", title: "No gift plans to claim" },
    captcha: { tone: "warning", title: "CAPTCHA required — solving..." },
    partial: { tone: "warning", title: "Gift claim only partially completed" },
    error: { tone: "error", title: "Gift claim failed" },
  };
  const entry = message[state] ?? { tone: "error" as const, title: "Gift claim failed" };
  if (entry.tone === "success") toast.success(entry.title, detail);
  else if (entry.tone === "warning") toast.warning(entry.title, detail);
  else toast.error(entry.title, detail);
}

// DeepSeek-V4.1-Flash Captcha SDK global types
interface AliyunCaptchaWindow {
  initAliyunCaptcha?: (config: {
    SceneId: string;
    region: string;
    prefix: string;
    mode: string;
    language: string;
    showErrorTip: boolean;
    element: string;
    button: string;
    getInstance: (instance: { show?: () => void } | null) => void;
    success: (param: string | unknown) => void;
    fail: (error: { message?: string } | string) => void;
  }) => void;
  AliyunCaptchaConfig?: { region: string; prefix: string };
}

declare global {
  interface Window extends AliyunCaptchaWindow {}
}

// Load DeepSeek-V4.1-Flash Captcha SDK
function loadCaptchaSdk(): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (window.initAliyunCaptcha) { resolve(); return promise; }
  const script = document.createElement("script");
  script.src = CAPTCHA_SDK_URL;
  script.async = true;
  script.onload = () => resolve();
  script.onerror = () => {
    reject(new Error("Failed to load captcha SDK"));
  };
  document.head.appendChild(script);
  return promise;
}

// Solve captcha and return verification params
function solveCaptcha(config: { region: string; prefix: string; sceneId: string }): Promise<{ param: string; region: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ param: string; region: string }>();
  
  loadCaptchaSdk().then(() => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)";
    wrap.innerHTML = `
      <div style="background:var(--surface-1, #1a1f25);color:var(--text-primary, #e6edf3);border:1px solid var(--border, #2a3038);border-radius:14px;padding:20px 22px;max-width:360px;text-align:center">
        <div style="font-weight:600;margin-bottom:6px">Security Check</div>
        <p style="margin:0 0 14px;font-size:12px;color:var(--text-tertiary, #8b949e)">Solve the captcha to claim this plan.</p>
        <div id="cartethyia-captcha-widget"></div>
        <button id="cartethyia-captcha-verify" class="btn primary" type="button" style="margin-top:10px">Verify</button>
        <button id="cartethyia-captcha-cancel" class="btn ghost" type="button" style="margin-top:10px;margin-left:8px">Cancel</button>
      </div>
    `;
    document.body.appendChild(wrap);
    
    const done = (param: string) => { wrap.remove(); resolve({ param, region: config.region }); };
    const fail = (err?: string) => { wrap.remove(); reject(new Error(err || "Captcha cancelled")); };
    
    const cancelBtn = wrap.querySelector("#cartethyia-captcha-cancel") as HTMLButtonElement | null;
    if (cancelBtn) cancelBtn.onclick = () => fail();
    
    try {
      window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
      window.initAliyunCaptcha?.({
        SceneId: config.sceneId,
        region: config.region,
        prefix: config.prefix,
        mode: "popup",
        language: "en",
        showErrorTip: true,
        element: "#cartethyia-captcha-widget",
        button: "#cartethyia-captcha-verify",
        getInstance: (instance: { show?: () => void } | null) => { 
          try { instance?.show?.(); } catch { /* ignore */ } 
        },
        success: (param: string | unknown) => {
          const p = typeof param === "string" ? param.trim() : "";
          p ? done(p) : fail("Captcha failed");
        },
        fail: (err: { message?: string } | string) => {
          const msg = typeof err === "string" ? err : err?.message;
          fail(msg || "Captcha failed");
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Captcha failed";
      fail(msg);
    }
  }).catch(reject);
  
  return promise;
}

/** Shared by provider accounts and quota management; never runs automatically. */
export function ClaimGiftsButton({ accountId, accountName }: {
  readonly accountId: string;
  readonly accountName: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const claim = useClaimAccountGifts(accountId);
  const refresh = useRefreshAccountQuota(accountId);
  const captchaConfig = useCaptchaConfig(accountId, open);

  const runClaim = async () => {
    // First, try claim without captcha
    claim.mutate(undefined, {
      onSuccess: async (result) => {
        // If captcha required, solve it and retry
        if (result.state === "captcha") {
          const config = captchaConfig.data;
          if (!config?.enabled || !config.region || !config.prefix || !config.sceneId) {
            toast.error("CAPTCHA required", "Captcha config not available. Please try again or claim from ZCode app.");
            return;
          }
          try {
            toast.warning("CAPTCHA required", "Solving captcha...");
            const solved = await solveCaptcha({
              region: config.region,
              prefix: config.prefix,
              sceneId: config.sceneId,
            });
            // Retry claim with captcha
            claim.mutate({ 
              captchaVerifyParam: solved.param, 
              captchaVerifyRegion: solved.region 
            }, {
              onSuccess: (retryResult) => {
                const detail = [
                  retryResult.claimed.length > 0 ? `Claimed: ${retryResult.claimed.join(", ")}` : null,
                  retryResult.detail,
                ].filter(Boolean).join(" · ");
                claimResultToast(retryResult.state, detail);
                if (retryResult.claimed.length > 0) {
                  refresh.mutate(undefined);
                }
              },
              onError: (error) => toast.error(
                "Gift claim failed",
                getErrorMessage(error, "Unable to claim gift plans"),
              ),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Captcha failed";
            toast.error("Captcha failed", msg);
          }
          return;
        }
        
        const detail = [
          result.claimed.length > 0 ? `Claimed: ${result.claimed.join(", ")}` : null,
          result.detail,
        ].filter(Boolean).join(" · ");
        claimResultToast(result.state, detail);
        if (result.claimed.length > 0) {
          refresh.mutate(undefined, {
            onSuccess: (refreshed) => {
              if (!refreshed.ok) {
                toast.warning("Gifts claimed; quota refresh failed", refreshed.message);
              }
            },
            onError: (error) => toast.warning(
              "Gifts claimed; quota refresh failed",
              getErrorMessage(error, "Refresh quota manually"),
            ),
          });
        }
      },
      onError: (error) => toast.error(
        "Gift claim failed",
        getErrorMessage(error, "Unable to claim gift plans"),
      ),
    });
  };

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        title="Preview claimable ZCode gift plans"
        aria-label={`Preview gifts for ${accountName}`}
        disabled={claim.isPending}
        icon={claim.isPending ? <Loader2 size={12} className="animate-spin" /> : <Gift size={12} />}
        onClick={() => setOpen(true)}
      >
        Claim gifts
      </Button>
      <GiftPreviewDialog
        accountId={accountId}
        accountName={accountName}
        open={open}
        onClose={() => setOpen(false)}
        onClaim={runClaim}
        claiming={claim.isPending}
      />
    </>
  );
}

function GiftPreviewDialog({ accountId, accountName, open, onClose, onClaim, claiming }: {
  readonly accountId: string;
  readonly accountName: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onClaim: () => void;
  readonly claiming: boolean;
}): ReactNode {
  const preview = useAccountGiftPreview(accountId, open);
  const plans = preview.data?.plans ?? [];
  const unread = preview.data?.unread ?? [];

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={`Claimable Gift Plans — ${accountName}`}>
      <div className="flex flex-col gap-6">
        {preview.isPending ? (
          <LoadingState compact label="Checking ZCode gift sources…" />
        ) : preview.isError ? (
          <ErrorState
            compact
            message="Failed to read gift plans"
            onRetry={() => void preview.refetch()}
          />
        ) : plans.length === 0 ? (
          <EmptyState
            compact
            title="No gift plan offered"
            message={unread.length > 0 ? unread.join(" · ") : "No claimable gift plan offered right now."}
            icon={<Gift size={20} />}
          />
        ) : (
          <div className="max-h-170 overflow-y-auto rounded-control border border-inner-border">
            <div className="flex flex-col divide-y divide-inner-border">
              {plans.map((plan) => {
                const progress = plan.progress;
                const claimable = plan.source !== "incentive" || progress === undefined ||
                  progress.state === "completed" ||
                  (progress.target > 0 && progress.current >= progress.target);
                return (
                  <div key={plan.planId} className="flex items-center justify-between gap-4 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-caption font-semibold text-text-primary">
                          {plan.name ?? plan.planId}
                        </span>
                        <Badge tone={claimable ? "ok" : "warn"}>{SOURCE_LABEL[plan.source]}</Badge>
                      </div>
                      <div className="mt-1 truncate text-micro text-text-tertiary">{plan.planId}</div>
                      {(plan.entitlements?.length ?? 0) > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {plan.entitlements?.map((ent, index) => (
                            <span
                              key={index}
                              className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-micro text-text-secondary"
                            >
                              {ent.showName ?? "Tokens"}
                              {ent.grantUnits !== null && ent.grantUnits > 0 && (
                                <span className="ml-1 tabular-nums">
                                  {ent.grantUnits >= 1e6
                                    ? `${(ent.grantUnits / 1e6).toFixed(0)}M`
                                    : ent.grantUnits.toLocaleString()}
                                </span>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                      {progress !== undefined && (
                        <div
                          className="mt-1.5 flex items-center gap-2 text-micro text-text-tertiary"
                          title={progress.state ?? undefined}
                        >
                          <span className="tabular-nums">Progress: {progress.current} / {progress.target}</span>
                          {progress.state && (
                            <span className="capitalize">{progress.state.replace("_", " ")}</span>
                          )}
                          {plan.inviteCode && <span className="font-mono">Code: {plan.inviteCode}</span>}
                        </div>
                      )}
                    </div>
                    <Badge tone={claimable ? "ok" : "disabled"} dot>
                      {claimable ? "Claimable" : "In progress"}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-micro text-text-tertiary">
            Claims the highest-priority plan; unknown replies surface as failures.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={claiming || (preview.data?.claimableCount ?? 0) === 0}
              icon={claiming ? <Loader2 size={12} className="animate-spin" /> : <Gift size={12} />}
              onClick={onClaim}
              aria-label="Claim highest priority gift"
            >
              {claiming ? "Claiming…" : "Claim highest priority"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
