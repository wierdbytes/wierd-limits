import { expect, test } from "bun:test";
import { Langfuse, OVERLAP_MS, base64, loadCredentials, sync } from "../herdr-mod/langfuse.js";

test("base64 matches Buffer for the keys", () => {
  for (const s of ["pk-lf-1:sk-lf-2", "a", "ab", "abc", "pk-lf-0a1b2c3d:sk-lf-9f8e7d6c5b"]) {
    expect(base64(s)).toBe(Buffer.from(s).toString("base64"));
  }
});

test("credentials come from the first file that has all three", async () => {
  const files = { "/a": "{nope", "/b": JSON.stringify({ publicKey: "pk" }), "/c": JSON.stringify({ publicKey: "pk", secretKey: "sk", host: "https://lf.example/" }) };
  const creds = await loadCredentials(async p => files[p] ?? null, ["/missing", "/a", "/b", "/c"]);
  expect(creds).toEqual({ host: "https://lf.example", publicKey: "pk", secretKey: "sk", file: "/c" });
});

function fakeFetch(routes, calls) {
  return async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const u = new URL(url);
    const body = routes(u.pathname, Object.fromEntries(u.searchParams));
    return new Response(JSON.stringify(body.json ?? body), { status: body.status ?? 200 });
  };
}

const row = (name, value, ts, metadata = {}) => ({ id: `${name}-${ts}`, name, value, timestamp: new Date(ts).toISOString(), metadata });

test("the first sync asks for each series' newest, later ones only for what is new", async () => {
  const calls = [];
  const now = Date.parse("2026-11-10T13:30:00Z");
  const client = new Langfuse({ host: "https://lf.example", publicKey: "pk", secretKey: "sk" }, fakeFetch((path, q) => {
    if (path === "/api/public/v2/metrics") return { data: [{ name: "rl.claude.a1.5h", count_count: 3 }, { name: "", count_count: 0 }] };
    if (path === "/api/public/v3/scores" && q.name) return { data: [row("rl.claude.a1.5h", 40, now - 600_000, { resets_at: "1794321600" })] };
    if (path === "/api/public/v3/scores") return { data: [row("rl.claude.a1.5h", 41, now - 5_000, { resets_at: "1794321600" }), row("turn_count", 3, now - 5_000)], meta: {} };
    return { status: 404, json: {} };
  }, calls));

  const first = await sync(client, null, now);
  expect(calls[0].auth).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
  expect(calls.map(c => new URL(c.url).pathname)).toEqual(["/api/public/v2/metrics", "/api/public/v3/scores", "/api/public/v3/scores"]);
  expect(first.cursor).toBe(now);
  expect(first.accounts["claude.a1"].limits["5h"].utilization).toBe(41);

  calls.length = 0;
  const later = await sync(client, first, now + 10_000);
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0].url).searchParams.get("fromTimestamp")).toBe(new Date(now - OVERLAP_MS).toISOString());
  expect(later.accounts).toEqual(first.accounts);
});

test("errors carry the status", async () => {
  const client = new Langfuse({ host: "https://lf.example", publicKey: "pk", secretKey: "sk" }, async () => new Response("{}", { status: 401 }));
  await expect(client.get("/v3/scores")).rejects.toMatchObject({ status: 401, message: "Langfuse rejected the keys (401)" });
  const offline = new Langfuse({ host: "https://lf.example", publicKey: "pk", secretKey: "sk" }, async () => { throw new Error("dns"); });
  await expect(offline.get("/v3/scores")).rejects.toMatchObject({ offline: true });
});
