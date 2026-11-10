import { describe, expect, test } from "bun:test";
import { applyScores, buckets, foldWindow, mergeData, parseName, rows, seriesPoints } from "../herdr-mod/reduce.js";

const score = (name, value, at, metadata = {}) => ({ id: `${name}@${at}`, name, value, at, metadata });
const md5h = (reset, extra = {}) => ({ resets_at: String(reset), window_s: "18000", label: "5 hours", status: "ok", ...extra });

describe("parseName", () => {
  test("splits provider, account and window", () => {
    expect(parseName("rl.claude.3f9a1c2e.5h")).toEqual({ provider: "claude", account: "3f9a1c2e", limit: "5h" });
    expect(parseName("rl.codex.abc.bengalfox.5h")).toEqual({ provider: "codex", account: "abc", limit: "bengalfox.5h" });
    expect(parseName("tool_call_count")).toBeNull();
    expect(parseName("rl.claude.5h")).toBeNull();
  });
});

describe("foldWindow", () => {
  const w = (utilization, reset_at, at) => ({ utilization, reset_at, at });
  test("within a window the used share only grows", () => {
    expect(foldWindow(w(40, 1000, 10), w(38, 1000, 20))).toMatchObject({ utilization: 40, at: 20 });
    expect(foldWindow(w(40, 1000, 20), w(45, 1000, 10))).toMatchObject({ utilization: 45, at: 20 });
  });
  test("a later window replaces, an earlier one is dropped", () => {
    expect(foldWindow(w(90, 1000, 10), w(2, 19000, 20))).toEqual(w(2, 19000, 20));
    expect(foldWindow(w(2, 19000, 20), w(90, 1000, 30))).toEqual(w(2, 19000, 20));
  });
  test("resets two minutes apart are one window", () => {
    expect(foldWindow(w(0, 1000, 10), w(1, 1100, 20))).toMatchObject({ utilization: 1, reset_at: 1100 });
  });
  test("without resets the newest wins", () => {
    expect(foldWindow(w(50, null, 10), w(20, null, 20))).toEqual(w(20, null, 20));
  });
});

describe("applyScores", () => {
  test("folds readings per account and window, idempotently", () => {
    const scores = [
      score("rl.claude.a1.5h", 40, 100, md5h(18000)),
      score("rl.claude.a1.5h", 38, 110, md5h(18000)),
      score("rl.claude.a1.7d", 10, 100, { resets_at: "600000", window_s: "604800", label: "7 days" }),
      score("rl.codex.b2.5h", 5, 105, md5h(18100, { plan: "plus", account_label: "me@x" })),
      score("tool_call_count", 3, 100),
    ];
    const once = applyScores(null, scores);
    expect(applyScores(once, scores)).toEqual(once);
    expect(Object.keys(once.accounts).sort()).toEqual(["claude.a1", "codex.b2"]);
    expect(once.accounts["claude.a1"].limits["5h"]).toMatchObject({ id: "5h", utilization: 40, reset_at: 18000, window: 18000, at: 110 });
    expect(once.accounts["codex.b2"]).toMatchObject({ plan: "plus", label: "me@x", at: 105 });
  });
});

describe("rows", () => {
  const providers = [{ id: "claude" }, { id: "codex" }, { id: "qwen" }];
  const lf = applyScores(null, [
    score("rl.claude.a1.5h", 40, 1000, md5h(18000)),
    score("rl.claude.a1.7d_opus", 12, 1000, { resets_at: "600000", window_s: "604800", label: "Opus" }),
  ]);

  test("one account keeps the provider id as its key; ai-usage fills in", () => {
    const polled = {
      claude: { provider: "claude", plan: "max 20x", five_hour: { utilization: 35, reset_at: 18000 }, seven_day: { utilization: 20, reset_at: 600000 },
        models: [{ label: "Opus", utilization: 15, reset_at: 600000, window: 604800 }], spend: { enabled: false }, updated_at: 900, error: "rate limited (HTTP 429)" },
      qwen: { provider: "qwen", five_hour: { utilization: 3, reset_at: 5000 }, seven_day: null, updated_at: 900 },
    };
    const r = rows(providers, polled, lf, 1100);
    expect(r.map(x => x.key)).toEqual(["claude", "qwen"]);
    const d = r[0].d;
    expect(d.five_hour.utilization).toBe(40);
    expect(d.seven_day.utilization).toBe(20);
    expect(d.plan).toBe("max 20x");
    expect(d.models).toHaveLength(1);
    expect(d.models[0].utilization).toBe(15);
    expect(d.models[0].series).toBe("7d_opus");
    expect(d.spend).toEqual({ enabled: false });
    expect(d.error).toBeNull();
    expect(r[0].series["5h"]).toBe("rl.claude.a1.5h");
    expect(r[1].d).toBe(polled.qwen);
  });

  test("a stale Langfuse reading lets the poll error through", () => {
    const r = rows(providers, { claude: { provider: "claude", updated_at: 900, error: "boom" } }, lf, 1000 + 3600);
    expect(r[0].d.error).toBe("boom");
  });

  test("several accounts get their own rows and labels", () => {
    const two = applyScores(lf, [score("rl.claude.c3.5h", 5, 2000, md5h(19000, { account_label: "work" }))]);
    const r = rows(providers, { claude: { provider: "claude", plan: "max", updated_at: 1900 } }, two, 2100);
    expect(r.map(x => [x.key, x.label, x.multi])).toEqual([["claude:c3", "work", true], ["claude:a1", "a1", true]]);
    expect(r[0].d.plan).toBe("max");
    expect(r[1].d.plan).toBeNull();
  });
});

describe("charts", () => {
  test("series points skip filler rows", () => {
    const data = [
      { name: "", time_dimension: "2026-11-10T08:23:00Z", max_value: 0, count_count: 0 },
      { name: "rl.claude.a1.5h", time_dimension: "2026-11-10T13:20:00Z", max_value: 69, count_count: 1 },
      { name: "rl.claude.a1.7d", time_dimension: "2026-11-10T13:20:00Z", max_value: 37, count_count: 1 },
    ];
    expect(seriesPoints(data, "rl.claude.a1.5h")).toEqual([{ t: Date.parse("2026-11-10T13:20:00Z") / 1000, v: 69 }]);
  });
  test("buckets keep the highest value", () => {
    expect(buckets([{ t: 0, v: 1 }, { t: 5, v: 3 }, { t: 15, v: 2 }], 0, 40, 4)).toEqual([3, 2, null, null]);
  });
});

test("mergeData without a poll is the Langfuse data", () => {
  const d = { provider: "claude", models: [] };
  expect(mergeData(d, null, 0)).toBe(d);
});
