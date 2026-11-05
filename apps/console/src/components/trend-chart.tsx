// The dashboard's line charts, as inline SVG: a sparkline for a figure card, and the cost trend
// with its range picker. The picker is a row of radio buttons; CSS shows the chosen range, so it
// works without script. Every value drawn is also in the daily figures table beside the chart,
// which is how keyboard and screen-reader users read it.

import { formatDay } from "@/lib/format.ts";
import { niceTicks } from "@/lib/metrics.ts";
import { linePaths } from "@/lib/overview.ts";
import { TableScroll } from "./ui.tsx";

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const { line, area } = linePaths(values, 100, 32);
  return (
    <svg className="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface TrendPoint {
  day: string;
  cents: number;
}

interface CostTrendProps {
  points: TrendPoint[];
  ranges: number[];
  money: (cents: number) => string;
  tick: (cents: number) => string;
}

function TrendPlot({ id, points, tick }: { id: string; points: TrendPoint[]; tick: (cents: number) => string }) {
  const ticks = niceTicks(Math.max(0, ...points.map((p) => p.cents)));
  const top = ticks.at(-1) ?? 1;
  const { line, area } = linePaths(
    points.map((p) => p.cents),
    100,
    100,
    top,
  );
  const labels = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  return (
    <div className="trend-chart" aria-hidden="true">
      <div className="trend-plot">
        {ticks.map((t) => (
          <div key={t} className="chart-grid" style={{ bottom: `${(t / top) * 100}%` }}>
            <span>{tick(t)}</span>
          </div>
        ))}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#00d364" stopOpacity="0.35" />
              <stop offset="1" stopColor="#00d364" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id})`} />
          <path d={line} className="trend-line" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <ol className="trend-x">
        {labels.map((i) => (
          <li key={i}>{points[i] ? formatDay(points[i].day) : ""}</li>
        ))}
      </ol>
    </div>
  );
}

export function CostTrend({ points, ranges, money, tick }: CostTrendProps) {
  const longest = ranges.at(-1)!;
  return (
    <div className="cost-trend">
      <fieldset className="segmented range-picker">
        <legend className="sr-only">Range</legend>
        {ranges.map((days) => (
          <label key={days}>
            <input type="radio" name="cost-range" value={days} defaultChecked={days === longest} />
            <span>{days} days</span>
          </label>
        ))}
      </fieldset>
      {ranges.map((days) => {
        const shown = points.slice(-days);
        const total = shown.reduce((n, p) => n + p.cents, 0);
        return (
          <div key={days} className="range" data-range={days}>
            <p className="trend-total">
              <strong>{money(total)}</strong> <span className="muted">over the last {days} days</span>
            </p>
            <TrendPlot id={`trend-fill-${days}`} points={shown} tick={tick} />
          </div>
        );
      })}
      <details className="daily">
        <summary>Daily cost, last {longest} days</summary>
        <TableScroll label="Daily cost">
          <table>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="num">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.day}>
                  <th scope="row">{formatDay(p.day)}</th>
                  <td className="num">{money(p.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </details>
    </div>
  );
}
