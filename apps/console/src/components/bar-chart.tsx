// One series of daily columns, server-rendered HTML with a CSS hover readout. Every value it
// draws is also in the page's daily figures table, which is how keyboard and screen-reader
// users read them; to assistive tech the chart is its one-line summary.

import type { CSSProperties } from "react";
import { niceTicks } from "@/lib/metrics.ts";

export interface BarPoint {
  key: string;
  label: string;
  value: number;
  display: string;
}

interface BarChartProps {
  title: string;
  summary: string;
  points: BarPoint[];
  tick: (value: number) => string;
}

// Readouts near the ends anchor to that side so they stay inside the panel.
const EDGE = 3;

export function BarChart({ title, summary, points, tick }: BarChartProps) {
  const ticks = niceTicks(Math.max(0, ...points.map((p) => p.value)));
  const top = ticks.at(-1) ?? 1;
  const height = (value: number) => `${(value / top) * 100}%`;
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <p className="sr-only">{summary}</p>
      <div className="chart-plot" aria-hidden="true">
        {ticks.map((t) => (
          <div key={t} className="chart-grid" style={{ bottom: height(t) }}>
            <span>{tick(t)}</span>
          </div>
        ))}
        <ol className="chart-bars">
          {points.map((p, i) => {
            const edge = i < EDGE ? "start" : i >= points.length - EDGE ? "end" : undefined;
            return (
              <li key={p.key} data-edge={edge} style={{ "--h": height(p.value) } as CSSProperties}>
                <span className="chart-bar" />
                <span className="chart-tip">
                  <strong>{p.display}</strong>
                  {p.label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {/* A date every 7 days, counting back from the newest. */}
      <ol className="chart-x" aria-hidden="true">
        {points.map((p, i) => (
          <li key={p.key}>{(points.length - 1 - i) % 7 === 0 ? p.label : ""}</li>
        ))}
      </ol>
    </figure>
  );
}
