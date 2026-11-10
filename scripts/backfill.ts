#!/usr/bin/env bun
// Backfills rate-limit scores (rl.<provider>.<account>.<window>) from what already happened:
//
//   Langfuse   pi-langfuse keeps every generation's response headers in its metadata, so each
//              Claude call since tracing started still has its anthropic-ratelimit-unified-*
//              values. The score goes on that generation, as the live ones do.
//   Codex CLI  ~/.codex/sessions and ~/.codex/archived_sessions: every token_count event carries
//              the account's rate_limits. The score goes on session `codex-cli-<rollout id>`.
//
// Readings are parsed by pi-langfuse's own code (src/rate-limits.ts) and thinned the same way
// (on change, plus a 10-minute heartbeat), so backfilled series look like live ones. Score ids
// are derived from the reading, so running it twice writes nothing new. Only readings older than
// the first live score are used.
//
//   bun scripts/backfill.ts                 # what it would write
//   bun scripts/backfill.ts --write         # write it
//   options: --since 2026-08-01  --until <iso>  --no-langfuse  --no-codex
//            --pi-langfuse ../pi-langfuse  --codex-home ~/.codex
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name: string) => args.includes(`--${name}`);
const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

const PI_LANGFUSE = resolve(expand(opt("pi-langfuse", join(import.meta.dir, "..", "..", "pi-langfuse"))!));
const CODEX_HOME = expand(opt("codex-home", process.env.CODEX_HOME || "~/.codex")!);
const WRITE = flag("write");
const SINCE = Date.parse(opt("since", "2026-01-01")!);

const rl = await import(join(PI_LANGFUSE, "src", "rate-limits.ts"));
const config = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "pi-langfuse", "config.json"), "utf8"));
const HOST = String(config.host).replace(/\/+$/, "");
const AUTH = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;

async function api(path: string, params: Record<string, string | undefined> = {}, init?: RequestInit): Promise<any> {
	const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
	const res = await fetch(`${HOST}/api/public${path}${qs.size ? `?${qs}` : ""}`, {
		...init,
		headers: { Authorization: AUTH, "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}

interface Reading {
	at: number; // ms
	reading: any;
	subject: { traceId?: string; observationId?: string; sessionId?: string };
	model?: string;
	source: string;
}

// ---- the first live score: backfill stops there ------------------------------------------------

async function firstLiveScore(): Promise<number> {
	const now = Date.now();
	const names = await api("/v2/metrics", {
		query: JSON.stringify({
			view: "scores-numeric", dimensions: [{ field: "name" }], metrics: [{ measure: "count", aggregation: "count" }],
			filters: [{ column: "name", type: "string", operator: "starts with", value: "rl." }],
			timeDimension: null, fromTimestamp: new Date(now - 60 * 86_400_000).toISOString(), toTimestamp: new Date(now + 60_000).toISOString(),
			orderBy: null, config: { row_limit: 1000 },
		}),
	});
	let first = now;
	for (const name of new Set<string>((names?.data ?? []).map((r: any) => r.name).filter((n: string) => n?.startsWith("rl.")))) {
		let cursor: string | undefined;
		for (let page = 0; page < 50; page++) {
			const r = await api("/v3/scores", { name, limit: "100", fields: "core,details", cursor });
			for (const s of r?.data ?? []) {
				if (String(s.metadata?.source ?? "").startsWith("backfill")) continue;
				first = Math.min(first, Date.parse(s.timestamp));
			}
			cursor = r?.meta?.cursor;
			if (!cursor || (r?.data?.length ?? 0) < 100) break;
		}
	}
	return first;
}

// ---- Langfuse generations ---------------------------------------------------------------------

async function fromLangfuse(until: number): Promise<{ readings: Reading[]; generations: number; withHeaders: number }> {
	const readings: Reading[] = [];
	let cursor: string | undefined, generations = 0, withHeaders = 0;
	for (let page = 0; page < 1000; page++) {
		const r = await api("/v2/observations", {
			type: "GENERATION", limit: "1000", fields: "core,metadata", expandMetadata: "headers",
			fromStartTime: new Date(SINCE).toISOString(), toStartTime: new Date(until).toISOString(), cursor,
		});
		for (const o of r?.data ?? []) {
			generations++;
			const headers = o.metadata?.headers;
			if (!headers || typeof headers !== "object") continue;
			const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
			// The response's own Date header says when the provider answered; the start time is the fallback.
			const at = Date.parse(lower.date ?? "") || Date.parse(o.endTime ?? o.startTime);
			const reading = rl.readingFromHeaders(lower, at / 1000);
			if (!reading) continue;
			withHeaders++;
			readings.push({
				at, reading, model: o.metadata?.actualModel ?? o.metadata?.selectedModel ?? undefined, source: "backfill-langfuse",
				subject: { traceId: o.traceId, observationId: o.id },
			});
		}
		process.stderr.write(`\rLangfuse: ${generations} generations, ${withHeaders} with limits`);
		cursor = r?.meta?.cursor;
		if (!cursor || (r?.data?.length ?? 0) < 1000) break;
	}
	process.stderr.write("\n");
	return { readings, generations, withHeaders };
}

// ---- Codex CLI rollouts -----------------------------------------------------------------------

function rolloutFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let entries: string[];
		try { entries = readdirSync(d); } catch { return; }
		for (const e of entries) {
			const p = join(d, e);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (/^rollout-.*\.jsonl$/.test(e)) out.push(p);
		}
	};
	walk(dir);
	return out;
}

function fromCodex(until: number): Reading[] {
	const readings: Reading[] = [];
	const auth = JSON.parse(readFileSync(join(CODEX_HOME, "auth.json"), "utf8"));
	const accountId = auth?.tokens?.account_id;
	for (const file of [...rolloutFiles(join(CODEX_HOME, "sessions")), ...rolloutFiles(join(CODEX_HOME, "archived_sessions"))]) {
		const session = basename(file, ".jsonl").replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "");
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.includes('"rate_limits":{')) continue;
			let e: any;
			try { e = JSON.parse(line); } catch { continue; }
			const limits = e?.payload?.rate_limits;
			const at = Date.parse(e?.timestamp);
			if (!limits || !at || at < SINCE || at >= until) continue;
			const family = limits.limit_id && limits.limit_id !== "codex" ? limits.limit_id : null;
			const windows = { primary: limits.primary, secondary: limits.secondary };
			// The same shape as the codex.rate_limits stream event pi sees.
			const event = {
				type: "codex.rate_limits",
				plan_type: limits.plan_type || undefined,
				rate_limits: family ? null : { ...windows, limit_reached: limits.rate_limit_reached_type != null },
				additional_rate_limits: family ? [{ limit_id: family, limit_name: limits.limit_name ?? undefined, rate_limits: windows }] : null,
			};
			const reading = rl.readingFromStreamEvent(event, at / 1000);
			if (!reading) continue;
			readings.push({ at, reading: { ...reading, accountId }, source: "backfill-codex-cli", subject: { sessionId: `codex-cli-${session}` } });
		}
	}
	return readings;
}

// ---- scores -----------------------------------------------------------------------------------

const idOf = (...parts: string[]) => {
	const h = createHash("sha256").update(parts.join("|")).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

const until = opt("until") ? Date.parse(opt("until")!) : await firstLiveScore();
console.log(`backfilling readings from ${new Date(SINCE).toISOString()} until ${new Date(until).toISOString()}`);

const readings: Reading[] = [];
if (!flag("no-langfuse")) {
	const lf = await fromLangfuse(until);
	readings.push(...lf.readings);
}
if (!flag("no-codex")) {
	const codex = fromCodex(until);
	console.log(`Codex CLI: ${codex.length} readings`);
	readings.push(...codex);
}
readings.sort((a, b) => a.at - b.at);

rl.__resetRateLimitStateForTest();
const events: any[] = [];
const series = new Map<string, { n: number; first: number; last: number; max: number }>();
const days = new Map<string, Set<string>>();
for (const r of readings) {
	const account = { slug: rl.accountSlug(r.reading.accountId), label: undefined };
	for (const s of rl.rateLimitScores(r.reading, account, { now: r.at, heartbeatMs: 600_000, model: r.model })) {
		const metadata = { ...s.metadata, source: r.source };
		delete (metadata as any).host;
		const id = idOf(s.name, s.timestamp, r.source);
		events.push({
			id: randomUUID(), type: "score-create", timestamp: s.timestamp,
			body: { id, name: s.name, value: s.value, dataType: "NUMERIC", ...r.subject, metadata },
		});
		const st = series.get(s.name) ?? { n: 0, first: r.at, last: r.at, max: 0 };
		st.n++; st.last = r.at; st.max = Math.max(st.max, s.value);
		series.set(s.name, st);
		const day = s.timestamp.slice(0, 10);
		days.set(day, (days.get(day) ?? new Set()).add(s.name.split(".")[1]));
	}
}

console.log(`\n${readings.length} readings → ${events.length} scores`);
for (const [name, st] of [...series].sort()) {
	console.log(`  ${name.padEnd(28)} ${String(st.n).padStart(5)}  ${new Date(st.first).toISOString().slice(0, 16)} … ${new Date(st.last).toISOString().slice(0, 16)}  max ${st.max}%`);
}
const byMonth = new Map<string, string[]>();
for (const [day, providers] of [...days].sort()) byMonth.set(day.slice(0, 7), [...(byMonth.get(day.slice(0, 7)) ?? []), `${day.slice(8)}${[...providers].sort().map(p => (p === "codex" ? "x" : p[0])).join("")}`]);
console.log("\ndays with readings (c = claude, x = codex):");
for (const [month, list] of byMonth) console.log(`  ${month}: ${list.join(" ")}`);

if (!WRITE) {
	const sample = (src: string) => events.find(e => e.body.metadata.source === src);
	for (const src of ["backfill-langfuse", "backfill-codex-cli"]) if (sample(src)) console.log(`\nexample (${src}):`, JSON.stringify(sample(src)));
	console.log("\ndry run: nothing written (--write to write)");
	process.exit(0);
}
for (let i = 0; i < events.length; i += 200) {
	const batch = events.slice(i, i + 200);
	const r = await api("/ingestion", {}, { method: "POST", body: JSON.stringify({ batch }) });
	const errors = r?.errors ?? [];
	if (errors.length) console.error(`batch ${i / 200}: ${errors.length} errors, e.g. ${JSON.stringify(errors[0])}`);
	process.stderr.write(`\rwritten ${Math.min(i + 200, events.length)} / ${events.length}`);
}
process.stderr.write("\n");
