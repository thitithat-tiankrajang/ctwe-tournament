#!/usr/bin/env python3
"""Merge per-step k6 summaries + the actuator monitor CSV into out/report.md.

The verdict ("maximum stable concurrent viewers") is the largest step whose error rate and
card/versions p95 stayed inside the budgets (ERROR_BUDGET, P95_BUDGET_MS — same env the k6
thresholds use)."""
import csv
import json
import os
import sys
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "out")
ERROR_BUDGET = float(os.environ.get("ERROR_BUDGET", "0.01"))
P95_BUDGET_MS = float(os.environ.get("P95_BUDGET_MS", "1000"))


def metric(summary, name, key, default=None):
    entry = summary.get("metrics", {}).get(name)
    if not entry:
        return default
    return entry.get(key, default)


def fmt(value, unit="", digits=1):
    if value is None:
        return "–"
    return f"{value:,.{digits}f}{unit}"


def mbps(total_bytes, seconds):
    if total_bytes is None or not seconds:
        return None
    return (total_bytes * 8) / seconds / 1_000_000


def monitor_window(rows, start, end):
    window = [r for r in rows if start <= r["epoch"] <= end]
    if not window:
        return {}
    def series(key):
        values = [r[key] for r in window if r[key] is not None]
        return values or None
    out = {}
    for key in ("process_cpu", "system_cpu", "jvm_used_bytes", "sse_public", "sse_staff", "db_active", "db_pending"):
        values = series(key)
        if values:
            out[key] = {"max": max(values), "avg": sum(values) / len(values)}
    return out


def main():
    steps = json.load(open(OUT / "steps.json"))
    monitor_rows = []
    monitor_path = OUT / "monitor.csv"
    if monitor_path.exists():
        for row in csv.DictReader(open(monitor_path)):
            parsed = {"epoch": int(row["epoch"])}
            for key in ("process_cpu", "system_cpu", "jvm_used_bytes", "sse_public", "sse_staff", "db_active", "db_pending"):
                parsed[key] = float(row[key]) if row.get(key) else None
            monitor_rows.append(parsed)

    results = []
    for step in steps:
        summary_path = OUT / f"step-{step['viewers']}.summary.json"
        if not summary_path.exists():
            continue
        summary = json.load(open(summary_path))
        seconds = max(1, step["end"] - step["start"])
        error_rate = metric(summary, "http_req_failed", "value", 0.0) or 0.0
        p95 = metric(summary, "http_req_duration", "p(95)")
        p99 = metric(summary, "http_req_duration", "p(99)")
        server = monitor_window(monitor_rows, step["start"], step["end"])
        # Concurrent SSE occupancy comes from the backend gauge (the only cross-VU truth);
        # the client-side counter is the fallback when the monitor was not running.
        sse_peak = server.get("sse_public", {}).get("max") if server else None
        if sse_peak is None:
            sse_peak = metric(summary, "sse_connected_total", "count", 0)
        results.append({
            "viewers": step["viewers"],
            "seconds": seconds,
            "error_rate": error_rate,
            "http_avg": metric(summary, "http_req_duration", "avg"),
            "http_p95": p95,
            "http_p99": p99,
            "sse_connected": metric(summary, "sse_connected_total", "count", 0),
            "sse_rejected": metric(summary, "sse_rejected_total", "count", 0),
            "sse_peak": sse_peak,
            "polling_users": metric(summary, "polling_users_total", "count", 0),
            "sse_lat_p95": metric(summary, "sse_event_latency_ms", "p(95)"),
            "sse_lat_p99": metric(summary, "sse_event_latency_ms", "p(99)"),
            "cache_hit_rate": metric(summary, "edge_cache_hits", "value"),
            "staff_saves": metric(summary, "staff_saves_total", "count", 0),
            "recv_bytes": metric(summary, "data_received", "count"),
            "sent_bytes": metric(summary, "data_sent", "count"),
            "server": server,
            "stable": error_rate <= ERROR_BUDGET and (p95 is None or p95 <= P95_BUDGET_MS),
        })

    max_stable = max((r["viewers"] for r in results if r["stable"]), default=None)

    lines = ["# Load test report", ""]
    lines.append(f"- Budgets: error rate ≤ {ERROR_BUDGET:.2%}, HTTP p95 ≤ {P95_BUDGET_MS:.0f} ms")
    lines.append(f"- **Maximum stable concurrent viewers: {max_stable if max_stable is not None else 'none — no step met the budgets'}**")
    lines.append("")
    lines.append("| Viewers | Stable | Err rate | HTTP avg | HTTP p95 | HTTP p99 | SSE conn (peak) | Polling sessions | SSE evt p95 | SSE evt p99 | Edge hit | In Mbps | Out Mbps | CPU max | RAM max | Staff saves |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in results:
        server = r["server"]
        cpu = server.get("process_cpu", {}).get("max") if server else None
        ram = server.get("jvm_used_bytes", {}).get("max") if server else None
        lines.append("| {v} | {stable} | {err} | {avg} | {p95} | {p99} | {sse} | {poll} | {sl95} | {sl99} | {hit} | {inm} | {outm} | {cpu} | {ram} | {saves} |".format(
            v=r["viewers"],
            stable="✅" if r["stable"] else "❌",
            err=f"{r['error_rate']:.3%}",
            avg=fmt(r["http_avg"], " ms"),
            p95=fmt(r["http_p95"], " ms"),
            p99=fmt(r["http_p99"], " ms"),
            sse=fmt(r["sse_peak"], "", 0),
            poll=fmt(r["polling_users"], "", 0),
            sl95=fmt(r["sse_lat_p95"], " ms"),
            sl99=fmt(r["sse_lat_p99"], " ms"),
            hit=f"{r['cache_hit_rate']:.1%}" if r["cache_hit_rate"] is not None else "–",
            inm=fmt(mbps(r["recv_bytes"], r["seconds"]), "", 2),
            outm=fmt(mbps(r["sent_bytes"], r["seconds"]), "", 2),
            cpu=f"{cpu:.0%}" if cpu is not None else "–",
            ram=f"{ram / 1_048_576:,.0f} MiB" if ram is not None else "–",
            saves=fmt(r["staff_saves"], "", 0),
        ))
    lines.append("")
    lines.append("Notes")
    lines.append("- Bandwidth is measured at the load generator (client side of TLS): In = server→viewers, Out = viewers→server.")
    lines.append("- SSE event latency compares the event's server timestamp with receive time; generator/server clock skew shifts it uniformly.")
    lines.append("- SSE connections above the runtime cap are rejected with 503 by design; those viewers appear under 'Polling sessions' (a viewer re-entering the poll loop counts again).")
    lines.append("- CPU/RAM come from the backend actuator (process view). Confirm against Render/Neon dashboards for the host view.")
    if not monitor_rows:
        lines.append("- Server monitor was not running: CPU/RAM/SSE-gauge columns are empty.")

    (OUT / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
