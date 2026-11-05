// What a form action hands back to its form: an error per field, and what was typed.
//
// React resets a form after its action runs. Inputs come back with what was typed, but a
// <select> returns to the default it was first rendered with, so forms are keyed on `attempt`
// and remount after each failed submit with every field set from `values`.

import type { FormErrors } from "./customer-form.ts";

export interface FormState {
  errors: FormErrors;
  values: Record<string, string>;
  attempt: number;
}

export const emptyForm: FormState = { errors: {}, values: {}, attempt: 0 };

export function failed(previous: FormState, form: FormData, errors: FormErrors): FormState {
  const values: Record<string, string> = {};
  for (const [name, value] of form) if (typeof value === "string" && !name.startsWith("$")) values[name] = value;
  return { errors, values, attempt: previous.attempt + 1 };
}
