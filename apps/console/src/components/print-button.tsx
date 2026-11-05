"use client";

// Opens the browser's print dialog, where "Save as PDF" gives the PDF.

export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className="button secondary" onClick={() => window.print()}>
      {label}
    </button>
  );
}
