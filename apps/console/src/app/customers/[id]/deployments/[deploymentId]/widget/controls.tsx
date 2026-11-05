"use client";

// Controls the configurator's sections share: where a scanned value came from, what the scan
// suggests and isn't applied yet, a color picker with its hex value, a row of presets, and a
// distance in pixels.

import { parseColor, toHex } from "@launchpad/theme";
import type { ReactNode } from "react";
import { plainSource, type Suggestion } from "@/lib/widget-form.ts";

// A scanned value the partner hasn't changed, and how sure the scan was of it.
export type Scanned = { low: boolean; source: string } | undefined;

export function ScanNote({ scanned }: { scanned: Scanned }) {
  if (!scanned) return null;
  return (
    <span className="scan-note" data-confidence={scanned.low ? "low" : "high"}>
      {scanned.low ? "Check this. " : ""}
      {plainSource(scanned.source)}
    </span>
  );
}

// A color as a small swatch and its value.
export function Swatch({ color }: { color: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "1em",
          height: "1em",
          marginRight: 4,
          verticalAlign: "-0.15em",
          border: "1px solid var(--arag-border)",
          borderRadius: 3,
          background: color,
        }}
      />
      <code>{color}</code>
    </>
  );
}

// What the scan suggests for a field, while the field holds something else. Nothing changes
// until the partner applies it, here or with Apply all. The customer's own "Name visitors see"
// is suggested the same way, but isn't the scan's.
export function FromScan({
  suggestion,
  label,
  onApply,
  children,
}: {
  suggestion: Suggestion | undefined;
  // The field's name, so each Apply button says what it applies.
  label: string;
  onApply: (s: Suggestion) => void;
  // How to show the value, when not as text.
  children?: ReactNode;
}) {
  if (!suggestion) return null;
  return (
    <span className="from-scan" style={{ display: "block", marginTop: 4 }}>
      <span className="scan-note" data-confidence={suggestion.low ? "low" : "high"}>
        {suggestion.low ? "Check this. " : ""}
        {suggestion.source.startsWith("customer") ? "Suggested:" : "From the scan:"}
      </span>{" "}
      {children ?? String(suggestion.value)} <span className="muted">· {plainSource(suggestion.source)}</span>{" "}
      <button type="button" className="link-button" onClick={() => onApply(suggestion)}>
        Apply<span className="sr-only"> the scan's {label.toLowerCase()}</span>
      </button>
    </span>
  );
}

interface ColorFieldProps {
  name: string;
  label: string;
  help?: string;
  value: string;
  onChange: (value: string) => void;
  scanned: Scanned;
  error?: string;
  children?: ReactNode;
  suggestion?: Suggestion;
  onApply?: (s: Suggestion) => void;
}

// A swatch picker and the hex value side by side; either one edits the color.
export function ColorField({ name, label, help, value, onChange, scanned, error, children, suggestion, onApply }: ColorFieldProps) {
  const parsed = parseColor(value);
  const describedBy = [help || scanned || suggestion ? `${name}-help` : "", error ? `${name}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className="field color-field">
      <label htmlFor={name}>{label}</label>
      <div className="color-input">
        <input
          type="color"
          value={parsed ? toHex(parsed) : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label}: picker`}
        />
        <input
          id={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
        />
      </div>
      {(help || scanned || suggestion) && (
        <p id={`${name}-help`} className="help">
          {help} <ScanNote scanned={scanned} />
          {onApply && (
            <FromScan suggestion={suggestion} label={label} onApply={onApply}>
              {suggestion && <Swatch color={String(suggestion.value)} />}
            </FromScan>
          )}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="field-error">
          {error}
        </p>
      )}
      {children}
    </div>
  );
}

interface ChoicesProps<V extends string> {
  name: string;
  legend: string;
  options: { value: V; label: string }[];
  value: V | undefined;
  onChange: (value: V) => void;
  help?: ReactNode;
}

// Presets as a row of radio buttons; none is checked when the value was set by hand.
export function PresetChoices<V extends string>({ name, legend, options, value, onChange, help }: ChoicesProps<V>) {
  return (
    <fieldset className="choices presets">
      <legend className="label">{legend}</legend>
      <div className="preset-row">
        {options.map((o) => (
          <label key={o.value} className="preset">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {help && <p className="help">{help}</p>}
    </fieldset>
  );
}

interface PixelFieldProps {
  name: string;
  label: string;
  value: number | undefined;
  onChange: (px: number) => void;
  help?: string;
  error?: string;
  min?: number;
  max?: number;
}

// A distance typed as a number of pixels.
export function PixelField({ name, label, value, onChange, help, error, min = 0, max = 400 }: PixelFieldProps) {
  const ids = [help ? `${name}-help` : "", error ? `${name}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className="field pixel-field">
      <label htmlFor={name}>{label}</label>
      <div className="pixel-input">
        <input
          id={name}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value ?? ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={ids || undefined}
        />
        <span aria-hidden="true">px</span>
      </div>
      {help && (
        <p id={`${name}-help`} className="help">
          {help}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
