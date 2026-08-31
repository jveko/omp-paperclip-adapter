import { describe, expect, it } from "vitest";
import { buildUsageWorkProduct, estimateCostPerHeartbeat, fetchBrokerUsage, usageDigest } from "./usage-report.js";

describe("estimateCostPerHeartbeat", () => {
  it("rate card × mean tokens over recent runs (USD per million)", () => {
    const est = estimateCostPerHeartbeat(
      [
        { at: "t", inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500 },
        { at: "t", inputTokens: 3000, outputTokens: 300, cachedInputTokens: 1500 },
      ],
      { input: 2, output: 8, cacheRead: 1, cacheWrite: 0 });
    // input: mean 2000 -> $0.004; output: mean 200 -> $0.0016; cacheRead: mean 1000 -> $0.001
    expect(est).toBeCloseTo(0.0066, 6);
  });
  it("null with no history or no rate card", () => {
    expect(estimateCostPerHeartbeat([], { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(estimateCostPerHeartbeat([{ at: "t", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }], null)).toBeNull();
  });
});

describe("fetchBrokerUsage", () => {
  it("GETs /v1/usage with the bearer token", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string>)?.authorization });
      return new Response(JSON.stringify({ reports: [{ provider: "p", used: 5 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchBrokerUsage({ url: "http://b:8765", token: "tok", fetchImpl });
    expect(out).toEqual({ ok: true, reports: [{ provider: "p", used: 5 }] });
    expect(calls[0].url).toBe("http://b:8765/v1/usage");
    expect(calls[0].auth).toBe("Bearer tok");
  });
  it("degrades to ok:false on network error", async () => {
    const out = await fetchBrokerUsage({ url: "http://127.0.0.1:9", token: "t", fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    expect(out.ok).toBe(false);
  });
  it("degrades to ok:false on a non-2xx response", async () => {
    const out = await fetchBrokerUsage({ url: "http://b", token: "t", fetchImpl: (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch });
    expect(out).toEqual({ ok: false, error: "broker /v1/usage HTTP 403" });
  });
  it("treats a non-array reports body as empty reports", async () => {
    const out = await fetchBrokerUsage({ url: "http://b", token: "t", fetchImpl: (async () => new Response(JSON.stringify({ reports: "nope" }), { status: 200 })) as unknown as typeof fetch });
    expect(out).toEqual({ ok: true, reports: [] });
  });
  it("binds the fetch to a timeout signal and degrades ok:false on abort", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenSignal = init?.signal;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await fetchBrokerUsage({ url: "http://b:8765", token: "tok", timeoutMs: 1234, fetchImpl });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    // aborted -> degrade to cost-only (ok:false)
    const abortImpl = (async () => { throw new Error("The operation was aborted"); }) as unknown as typeof fetch;
    const out = await fetchBrokerUsage({ url: "http://b", token: "t", timeoutMs: 1, fetchImpl: abortImpl });
    expect(out.ok).toBe(false);
  });

});

describe("usageDigest", () => {
  it("stable for same reports + bucketed cost; changes when reports change", () => {
    const a = usageDigest([{ provider: "p", used: 5 }], 0.00561);
    const same = usageDigest([{ provider: "p", used: 5 }], 0.00562); // same 2-sig-fig band
    const changed = usageDigest([{ provider: "p", used: 6 }], 0.00561);
    expect(a).toBe(same);
    expect(a).not.toBe(changed);
  });
  it("separates a ~2% cost drift that absolute 2-dp bucketing would collapse", () => {
    // 0.0056 and 0.0057 both round to "0.01" under absolute 2-dp bucketing, but a
    // relative (significant-digit) bucket keeps them distinct — this pins the fix.
    expect(usageDigest([{ provider: "p", used: 5 }], 0.0056))
      .not.toBe(usageDigest([{ provider: "p", used: 5 }], 0.0057));
  });
  it("buckets null cost as 'na'", () => {
    expect(usageDigest([{ provider: "p", used: 5 }], null)).toBe(usageDigest([{ provider: "p", used: 5 }], undefined as unknown as number | null));
  });
});

describe("buildUsageWorkProduct", () => {
  it("omp-usage artifact; cost-only when reports empty (broker down)", () => {
    const wp = buildUsageWorkProduct({ reports: [], costPerHeartbeatUsd: 0.0056, runId: "r1", capturedAt: "2026-08-31T00:00:00Z" });
    expect(wp.provider).toBe("omp-usage");
    expect(wp.summary).toContain("$0.0056");
    expect(wp.summary).toContain("broker usage unavailable");
    expect(wp.metadata).toMatchObject({ runId: "r1", capturedAt: "2026-08-31T00:00:00Z" });
  });
  it("includes broker reports in the summary when present", () => {
    const wp = buildUsageWorkProduct({ reports: [{ provider: "p", used: 5 }], costPerHeartbeatUsd: 0.0012, runId: "r1", capturedAt: "2026-08-31T00:00:00Z" });
    expect(wp.summary).toContain("$0.0012");
    expect(wp.summary).toContain("{\"provider\":\"p\",\"used\":5}");
  });
});
