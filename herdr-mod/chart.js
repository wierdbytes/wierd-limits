// Drawing a limit's history: the current window as an area (with the even-pace diagonal and
// a tick at now), or several days as bars of the highest reading per bucket.
import { div, PathBuilder, Background } from "gpui-kit";
import { h_flex } from "gpui-base";
import { buckets } from "./reduce.js";

export const CHART_H = 64;
const HOUR = 3600, DAY = 86400;

// What to ask Langfuse for: the window [start, reset) by the minute (by the hour for long
// windows), or the last week (a short window) / four weeks (a weekly one) by the hour.
export function chartRange(l, range, now) {
  const short = (l.window ?? DAY * 7) <= 6 * HOUR;
  if (range === "window" && l.reset_at != null && l.window) {
    const from = l.reset_at - l.window;
    return { from, to: l.reset_at, until: Math.min(now, l.reset_at), granularity: short ? "minute" : "hour" };
  }
  const days = short ? 7 : 28;
  return { from: now - days * DAY, to: now, until: now, granularity: "hour", bars: short ? 84 : 112 };
}

const pct = n => `${Math.round(Math.max(0, Math.min(100, n)) * 100) / 100}%`;

// The window so far as a stepped area: readings only grow inside a window, so each one holds
// until the next. Before the first reading nothing is known (usage may come from elsewhere).
export function windowChart(l, points, r, now, t, color) {
  const span = r.to - r.from;
  const x = ts => pct(((ts - r.from) / span) * 100);
  const y = v => pct(100 - v);
  const pts = points.filter(p => p.t >= r.from - 60 && p.t <= r.to);
  // The latest value known (it may come from ai-usage) closes the series at now.
  if (l.utilization != null && r.until > r.from) {
    const last = pts.at(-1);
    if (!last || l.utilization >= last.v) pts.push({ t: r.until, v: l.utilization });
  }
  const root = div().relative().w_full().h(CHART_H).rounded(4).bg(t.raised).overflow_hidden()
    .child(div().absolute().left(0).top(CHART_H / 2).w_full().h(1).bg(t.border));
  // Even pace: 0% at the window's start, 100% at its reset.
  const even = PathBuilder.stroke(1).move_to("0%", "100%").line_to("100%", "0%").build();
  root.child(globalThis.window.paint_path(even, t.dim).absolute().top(0).left(0).size_full());
  if (pts.length) {
    const fill = PathBuilder.fill().move_to(x(pts[0].t), "100%").line_to(x(pts[0].t), y(pts[0].v));
    const line = PathBuilder.stroke(1.5).move_to(x(pts[0].t), y(pts[0].v));
    for (let i = 1; i < pts.length; i++) {
      for (const b of [fill, line]) b.line_to(x(pts[i].t), y(pts[i - 1].v)).line_to(x(pts[i].t), y(pts[i].v));
    }
    const end = Math.max(pts.at(-1).t, r.until);
    fill.line_to(x(end), y(pts.at(-1).v)).line_to(x(end), "100%").close();
    line.line_to(x(end), y(pts.at(-1).v));
    root.child(globalThis.window.paint_path(fill.build(), Background.solid(color).opacity(0.22)).absolute().top(0).left(0).size_full())
      .child(globalThis.window.paint_path(line.build(), color).absolute().top(0).left(0).size_full());
  }
  // Where the window's time stands.
  if (now < r.to) root.child(div().absolute().top(0).h(CHART_H).w(1).bg(t.foreground).opacity(0.5).left(x(now)));
  return root;
}

// Days as bars: the highest reading in each bucket, coloured by how close it came to the cap.
export function historyChart(points, r, t) {
  const vals = buckets(points, r.from, r.to, r.bars);
  const tone = v => (v >= 90 ? t.ansi1 : v >= 70 ? t.ansi3 : t.ansi2);
  return h_flex().relative().w_full().h(CHART_H).items_end().gap(1).px(1).rounded(4).bg(t.raised).overflow_hidden()
    .child(div().absolute().left(0).top(CHART_H / 2).w_full().h(1).bg(t.border))
    .children(vals.map(v => div().flex_1().min_w(1).rounded_t(1)
      .h(v == null ? 0 : pct(Math.max(3, v)))
      .bg(v == null ? t.raised : tone(v))));
}
