// Validation for the settings form. Pure, so it runs under node:test.

export interface SettingsInput {
  partnerName: string;
  // Price per nuclia token in the contract currency; undefined removes it.
  rate: number | undefined;
  markupPercent: number;
}

export type SettingsField = keyof SettingsInput;

export const FIELD_ERRORS: Record<SettingsField, string> = {
  partnerName: "Keep the agency name under 120 characters.",
  rate: "The contract rate must be a number, 0 or more.",
  markupPercent: "The markup must be a percentage from 0 to 1000.",
};

export function parseSettingsForm(form: FormData): { value: SettingsInput } | { error: SettingsField } {
  const text = (name: SettingsField) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const number = (name: SettingsField) => (text(name) === "" ? undefined : Number(text(name)));

  const partnerName = text("partnerName");
  if (partnerName.length > 120) return { error: "partnerName" };
  const rate = number("rate");
  if (rate !== undefined && !(Number.isFinite(rate) && rate >= 0)) return { error: "rate" };
  const markupPercent = number("markupPercent") ?? 0;
  if (!(Number.isFinite(markupPercent) && markupPercent >= 0 && markupPercent <= 1000)) return { error: "markupPercent" };
  return { value: { partnerName, rate, markupPercent } };
}
