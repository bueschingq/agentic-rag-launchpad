// Labelled form controls, with their help and error text tied to the control for screen readers.

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

interface FieldProps {
  name: string;
  label: string;
  error?: string;
  help?: ReactNode;
}

export interface Option {
  value: string;
  label: string;
}

function a11y(name: string, error?: string, help?: ReactNode) {
  const ids = [help ? `${name}-help` : "", error ? `${name}-error` : ""].filter(Boolean);
  return { id: name, name, "aria-invalid": error ? true : undefined, "aria-describedby": ids.length ? ids.join(" ") : undefined };
}

function Field({ name, label, error, help, children }: FieldProps & { children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      {children}
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

export function TextField({ name, label, error, help, ...input }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field name={name} label={label} error={error} help={help}>
      <input {...input} {...a11y(name, error, help)} />
    </Field>
  );
}

export function SelectField({
  name,
  label,
  error,
  help,
  options,
  ...select
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement> & { options: Option[] }) {
  return (
    <Field name={name} label={label} error={error} help={help}>
      <select {...select} {...a11y(name, error, help)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextAreaField({ name, label, error, help, ...textarea }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field name={name} label={label} error={error} help={help}>
      <textarea {...textarea} {...a11y(name, error, help)} />
    </Field>
  );
}

// Above the form after a failed submit: its own client module, as it takes focus.
export { ErrorSummary } from "./error-summary.tsx";
