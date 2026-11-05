/**
 * WorkBuddy's usage frame, captured verbatim from the live providerResponse of
 * request `542917e9-e21e-466c-b4fb-ae0c255ae0ee` (warm prefix, 2026-11-05).
 *
 * The upstream reports an INCLUSIVE `prompt_tokens` (hit + miss) and also
 * stamps `cache_read_input_tokens: 0`. That zero is present, not absent, so
 * `normalizeUsage` used to classify the frame as Anthropic's fresh-only shape
 * and fold the cached count into `input_tokens` a second time: the client saw
 * `prompt_tokens: 2660` for a 1380-token prompt and every Usage surface read
 * 48% instead of the real 92.75%.
 *
 * This suite pins the mechanism at the canonical owner. Anthropic's genuinely
 * fresh-only frames (and Ollama's `total_tokens == input + output` case) must
 * keep folding under `inclusive`.
 */
import { describe, expect, test } from "bun:test";
import { normalizeUsage } from "../../src/providers/provider-usage";

const WORKBUDDY_WARM = {
  prompt_tokens: 1380,
  completion_tokens: 16,
  total_tokens: 1396,
  completion_tokens_details: {
    accepted_prediction_tokens: 0,
    audio_tokens: 0,
    reasoning_tokens: 16,
    rejected_prediction_tokens: 0,
    cached_tokens: 0,
  },
  prompt_tokens_details: {
    accepted_prediction_tokens: 0,
    audio_tokens: 0,
    reasoning_tokens: 0,
    rejected_prediction_tokens: 0,
    cached_tokens: 1280,
  },
  prompt_cache_hit_tokens: 1280,
  prompt_cache_miss_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  prompt_cache_write_tokens: 0,
  completion_thinking_tokens: 16,
  credit: 0,
  cached_tokens: 0,
} as const;

function withMode(mode: string | undefined, run: () => void): void {
  const previous = process.env.CARTETHYIA_USAGE_INPUT_MODE;
  if (mode === undefined) delete process.env.CARTETHYIA_USAGE_INPUT_MODE;
  else process.env.CARTETHYIA_USAGE_INPUT_MODE = mode;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.CARTETHYIA_USAGE_INPUT_MODE;
    else process.env.CARTETHYIA_USAGE_INPUT_MODE = previous;
  }
}

describe("WorkBuddy usage normalization", () => {
  test("an inclusive prompt with a zero Anthropic read field is not folded twice", () => {
    for (const mode of [undefined, "inclusive", "as-is"] as const) {
      withMode(mode, () => {
        const usage = normalizeUsage({ ...WORKBUDDY_WARM });
        expect(usage.input_tokens).toBe(1380);
        expect(usage.cached_input_tokens).toBe(1280);
        expect(usage.uncached_input_tokens).toBe(100);
      });
    }
  });

  test("prompt_cache_write_tokens is read even when the Anthropic write field is zero", () => {
    const usage = normalizeUsage({
      ...WORKBUDDY_WARM,
      prompt_cache_write_tokens: 256,
      cache_creation_input_tokens: 0,
    });
    expect(usage.cache_write_tokens).toBe(256);
  });

  test("a genuine Anthropic fresh-only frame still folds under inclusive", () => {
    withMode("inclusive", () => {
      const usage = normalizeUsage({
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      });
      expect(usage.input_tokens).toBe(150);
      expect(usage.cached_input_tokens).toBe(40);
      expect(usage.uncached_input_tokens).toBe(100);
    });
  });
});
