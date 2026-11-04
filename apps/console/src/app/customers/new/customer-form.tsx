"use client";

// The customer form, for new customers and for editing. Contact rows can be added and
// removed; their indexes may have gaps, which the parser expects. After a failed save every
// field keeps what was typed.

import { useActionState, useState } from "react";
import { ErrorSummary, SelectField, TextField } from "@/components/fields.tsx";
import { emptyForm, type FormState } from "@/lib/form-state.ts";
import { BILLING_METHOD_LABELS, KB_ACCESS_LABELS, LANGUAGE_OPTIONS, options, PAYMENT_TERMS_LABELS } from "@/lib/labels.ts";
import { saveCustomer } from "./actions.ts";

const contactIndexes = (values: Record<string, string>) => {
  const found = [...new Set(Object.keys(values).flatMap((k) => /^contacts\.(\d+)\./.exec(k)?.[1] ?? []))].map(Number);
  return found.length ? found.sort((a, b) => a - b) : [0];
};

interface Props {
  next?: string;
  action?: (previous: FormState, form: FormData) => Promise<FormState>;
  // Editing: the saved customer, as form values.
  initial?: FormState;
  submitLabel?: string;
}

export function CustomerForm({ next, action: save = saveCustomer, initial = emptyForm, submitLabel = "Create customer" }: Props) {
  const [state, action, pending] = useActionState(save, initial);
  const { errors, values } = state;
  const value = (name: string, fallback = "") => values[name] ?? fallback;
  const [rows, setRows] = useState(() => contactIndexes(values));
  const [sameAsPrimary, setSameAsPrimary] = useState(() => (Object.keys(values).length ? values["billing.sameAsPrimary"] === "on" : true));
  const customerLanguage = value("language", "en");
  // "Name visitors see" starts as the customer name and follows it until someone changes it.
  const [name, setName] = useState(() => value("name"));
  const [shown, setShown] = useState(() => value("displayName"));
  const [shownEdited, setShownEdited] = useState(() => Boolean(values.displayName) && values.displayName !== values.name);

  return (
    <form key={state.attempt} className="form wide" action={action} noValidate>
      <ErrorSummary errors={errors} />
      {next && <input type="hidden" name="next" value={next} />}

      <fieldset className="panel">
        <legend>Customer</legend>
        <TextField
          name="name"
          label="Customer name (required)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          maxLength={120}
          required
          autoComplete="off"
          help="Your name for the customer, for example 'Telerik (pilot 2026)'. Alerts, Fleet and History use it; visitors never see it."
        />
        <TextField
          name="displayName"
          label="Name visitors see (required)"
          value={shownEdited ? shown : name}
          onChange={(e) => {
            setShown(e.target.value);
            setShownEdited(true);
          }}
          error={errors.displayName}
          maxLength={120}
          required
          autoComplete="off"
          help="How the chat, the install guide and lead emails name the client, for example 'Telerik'. It starts as the customer name: change it when that's your own label."
        />
        <SelectField
          name="language"
          label="Default language"
          options={LANGUAGE_OPTIONS}
          defaultValue={customerLanguage}
          error={errors.language}
          help="New deployments answer and label the chat in this language unless you choose another."
        />
        <TextField
          name="budget"
          label="Monthly budget (optional)"
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          defaultValue={value("budget")}
          error={errors.budget}
          help="Alerts at 80% and 100%, by email or webhook, and on the fleet page."
        />
        <SelectField
          name="budgetMode"
          label="At 100% of the budget"
          options={[
            { value: "alert", label: "Send an alert only" },
            { value: "stop", label: "Take the chat offline until next month" },
          ]}
          defaultValue={value("budgetMode", "alert")}
          help="Offline, visitors see the offline message instead of the chat."
        />
      </fieldset>

      <fieldset className="panel">
        <legend>Contacts</legend>
        <p className="help">
          Contacts with KB access get an invitation to each new deployment's Knowledge Box in the Agentic RAG dashboard.
        </p>
        {errors.contacts && <p className="field-error">{errors.contacts}</p>}
        {rows.map((i, n) => {
          const f = (field: string) => `contacts.${i}.${field}`;
          const primaryChecked = values.primary === undefined ? n === 0 : values.primary === String(i);
          return (
            <fieldset className="contact" key={i}>
              <legend>Contact {n + 1}</legend>
              <div className="field-grid">
                <TextField
                  name={f("name")}
                  label="Name (required)"
                  defaultValue={value(f("name"))}
                  error={errors[f("name")]}
                  autoComplete="off"
                />
                <TextField
                  name={f("email")}
                  label="Email (required)"
                  type="email"
                  defaultValue={value(f("email"))}
                  error={errors[f("email")]}
                  autoComplete="off"
                />
                <TextField
                  name={f("phone")}
                  label="Phone (optional)"
                  type="tel"
                  defaultValue={value(f("phone"))}
                  error={errors[f("phone")]}
                />
                <TextField name={f("title")} label="Job title (optional)" defaultValue={value(f("title"))} error={errors[f("title")]} />
                <SelectField
                  name={f("language")}
                  label="Language"
                  options={[{ value: "", label: "Same as the customer" }, ...LANGUAGE_OPTIONS]}
                  defaultValue={value(f("language"))}
                  error={errors[f("language")]}
                />
                <SelectField
                  name={f("kbRole")}
                  label="Knowledge Box access"
                  options={options(KB_ACCESS_LABELS, "No access, not invited")}
                  defaultValue={value(f("kbRole"))}
                  error={errors[f("kbRole")]}
                  help="Agentic RAG emails the invite when the Knowledge Box is created. Not yet tested against a live account: check the contact received it."
                />
              </div>
              <div className="contact-actions">
                <label className="inline">
                  <input type="radio" name="primary" value={String(i)} defaultChecked={primaryChecked} /> Primary contact
                </label>
                {rows.length > 1 && (
                  <button type="button" className="link-button" onClick={() => setRows(rows.filter((r) => r !== i))}>
                    Remove contact {n + 1}
                  </button>
                )}
              </div>
            </fieldset>
          );
        })}
        <button type="button" className="button secondary" onClick={() => setRows([...rows, Math.max(...rows) + 1])}>
          Add another contact
        </button>
      </fieldset>

      <details
        className="panel billing-details"
        open={
          Object.keys(values).some((k) => k.startsWith("billing.") && values[k] && k !== "billing.sameAsPrimary") ||
          Object.keys(errors).some((k) => k.startsWith("billing."))
        }
      >
        <summary>Billing (can wait)</summary>
        <fieldset className="plain-fieldset">
          <legend className="sr-only">Billing</legend>
          <p className="help">No card or bank numbers here: keep them in your billing system and reference the customer's record below.</p>
          <label className="inline">
            <input
              type="checkbox"
              name="billing.sameAsPrimary"
              checked={sameAsPrimary}
              onChange={(e) => setSameAsPrimary(e.target.checked)}
            />{" "}
            Bill the primary contact
          </label>
          {!sameAsPrimary && (
            <div className="field-grid">
              <TextField
                name="billing.contactName"
                label="Billing contact"
                defaultValue={value("billing.contactName")}
                error={errors["billing.contactName"]}
              />
              <TextField
                name="billing.contactEmail"
                label="Billing email"
                type="email"
                defaultValue={value("billing.contactEmail")}
                error={errors["billing.contactEmail"]}
              />
            </div>
          )}
          <div className="field-grid">
            <TextField
              name="billing.line1"
              label="Address"
              defaultValue={value("billing.line1")}
              error={errors["billing.line1"]}
              autoComplete="off"
            />
            <TextField
              name="billing.line2"
              label="Address line 2"
              defaultValue={value("billing.line2")}
              error={errors["billing.line2"]}
              autoComplete="off"
            />
            <TextField name="billing.city" label="City" defaultValue={value("billing.city")} error={errors["billing.city"]} />
            <TextField
              name="billing.region"
              label="State or region"
              defaultValue={value("billing.region")}
              error={errors["billing.region"]}
            />
            <TextField
              name="billing.postalCode"
              label="Postal code"
              defaultValue={value("billing.postalCode")}
              error={errors["billing.postalCode"]}
            />
            <TextField name="billing.country" label="Country" defaultValue={value("billing.country")} error={errors["billing.country"]} />
            <SelectField
              name="billing.method"
              label="Payment method"
              options={options(BILLING_METHOD_LABELS, "Not set")}
              defaultValue={value("billing.method")}
              error={errors["billing.method"]}
            />
            <SelectField
              name="billing.terms"
              label="Payment terms"
              options={options(PAYMENT_TERMS_LABELS, "Not set")}
              defaultValue={value("billing.terms")}
              error={errors["billing.terms"]}
            />
            <TextField
              name="billing.poNumber"
              label="PO number"
              defaultValue={value("billing.poNumber")}
              error={errors["billing.poNumber"]}
            />
            <TextField name="billing.taxId" label="Tax ID" defaultValue={value("billing.taxId")} error={errors["billing.taxId"]} />
          </div>
          <TextField
            name="billing.externalRef"
            label="Billing system reference"
            defaultValue={value("billing.externalRef")}
            error={errors["billing.externalRef"]}
            help="The customer's ID in Stripe, QuickBooks or wherever you invoice from."
          />
        </fieldset>
      </details>

      <button className="button" type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
