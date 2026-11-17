'use client';

import { PLAYBOOK_LIMITS } from '@cue/shared';
import Link from 'next/link';
import { useActionState, useId, useState } from 'react';
import { buttonClass } from '@/components/button-styles';
import { SubmitButton } from '@/components/submit-button';
import { FIELD } from '@/lib/playbook-form';
import type { PlaybookFormState } from './actions';

export interface PlaybookFormValues {
  name: string;
  productDescription: string;
  idealCustomer: string;
  toneNotes: string;
  objections: { objection: string; good_response: string }[];
}

interface ObjectionRow {
  key: string;
  objection: string;
  good_response: string;
}

const IDLE: PlaybookFormState = { status: 'idle' };

/**
 * Create/edit form. Fields are controlled (React state), so the user's input
 * survives a failed validation round-trip; React would otherwise reset an
 * uncontrolled form after the action runs.
 */
export function PlaybookForm({
  action,
  initial,
  submitLabel,
  pendingLabel,
}: {
  action: (state: PlaybookFormState, formData: FormData) => Promise<PlaybookFormState>;
  initial: PlaybookFormValues;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const errors = state.status === 'error' ? state.fieldErrors : {};

  const [name, setName] = useState(initial.name);
  const [productDescription, setProductDescription] = useState(initial.productDescription);
  const [idealCustomer, setIdealCustomer] = useState(initial.idealCustomer);
  const [toneNotes, setToneNotes] = useState(initial.toneNotes);

  // Stable keys so React keeps each row's DOM (and focus) when rows are removed.
  // Initial keys are index-based (same on server and client); new rows get a
  // random key in the click handler, which only runs in the browser.
  const [rows, setRows] = useState<ObjectionRow[]>(() =>
    initial.objections.map((o, i) => ({ key: `initial-${String(i)}`, ...o })),
  );

  const updateRow = (key: string, patch: Partial<ObjectionRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const addRow = () => {
    setRows((rs) => [...rs, { key: crypto.randomUUID(), objection: '', good_response: '' }]);
  };
  const removeRow = (key: string) => {
    setRows((rs) => rs.filter((r) => r.key !== key));
  };

  return (
    <form action={formAction} className="space-y-8" noValidate>
      {state.status === 'error' && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {state.message}
        </div>
      )}

      <section className="space-y-5">
        <TextField
          label="Name"
          name={FIELD.name}
          value={name}
          onChange={setName}
          maxLength={PLAYBOOK_LIMITS.name}
          error={errors.name}
          placeholder="e.g. Mid-market outbound"
          required
        />
        <TextField
          label="Product description"
          name={FIELD.productDescription}
          value={productDescription}
          onChange={setProductDescription}
          maxLength={PLAYBOOK_LIMITS.productDescription}
          error={errors.productDescription}
          hint="What you sell and the outcome it delivers, in plain words."
          multiline
          rows={4}
          required
        />
        <TextField
          label="Ideal customer"
          name={FIELD.idealCustomer}
          value={idealCustomer}
          onChange={setIdealCustomer}
          maxLength={PLAYBOOK_LIMITS.idealCustomer}
          error={errors.idealCustomer}
          hint="Company size, industry, the buyer and the champion."
          multiline
          rows={3}
          required
        />
      </section>

      <section aria-labelledby="objections-heading" className="space-y-4">
        <div>
          <h2 id="objections-heading" className="text-base font-semibold">
            Objections
          </h2>
          <p className="text-sm text-neutral-600">
            Pushback you expect, and a good way to answer it. Cue uses these when suggesting lines.
          </p>
        </div>

        {errors.objections && <p className="text-sm text-red-700">{errors.objections}</p>}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500">
            No objections yet.
          </p>
        ) : (
          <ol className="space-y-4">
            {rows.map((row, i) => (
              <li key={row.key} className="rounded-xl border border-neutral-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Objection {i + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      removeRow(row.key);
                    }}
                    className="rounded text-sm text-neutral-500 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-neutral-900"
                    aria-label={`Remove objection ${String(i + 1)}`}
                  >
                    Remove
                  </button>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="What they say"
                    name={FIELD.objection}
                    value={row.objection}
                    onChange={(v) => {
                      updateRow(row.key, { objection: v });
                    }}
                    maxLength={PLAYBOOK_LIMITS.objectionText}
                    error={errors[`objections.${String(i)}.objection`]}
                    placeholder="“We already have this in our ERP.”"
                    multiline
                    rows={3}
                  />
                  <TextField
                    label="Good response"
                    name={FIELD.goodResponse}
                    value={row.good_response}
                    onChange={(v) => {
                      updateRow(row.key, { good_response: v });
                    }}
                    maxLength={PLAYBOOK_LIMITS.objectionText}
                    error={errors[`objections.${String(i)}.good_response`]}
                    placeholder="Ask how many invoices still get matched by hand."
                    multiline
                    rows={3}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}

        {rows.length < PLAYBOOK_LIMITS.objections && (
          <button type="button" onClick={addRow} className={buttonClass('secondary')}>
            + Add objection
          </button>
        )}
      </section>

      <section>
        <TextField
          label="Tone notes"
          name={FIELD.toneNotes}
          value={toneNotes}
          onChange={setToneNotes}
          maxLength={PLAYBOOK_LIMITS.toneNotes}
          error={errors.toneNotes}
          hint="How suggestions should sound, e.g. “consultative, never pushy”."
          multiline
          rows={3}
          optional
        />
      </section>

      <div className="flex items-center justify-end gap-3 border-t border-neutral-200 pt-6">
        <Link href="/playbooks" className={buttonClass('ghost')}>
          Cancel
        </Link>
        <SubmitButton pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function TextField({
  label,
  name,
  value,
  onChange,
  maxLength,
  error,
  hint,
  placeholder,
  multiline = false,
  rows,
  required = false,
  optional = false,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  error?: string | undefined;
  hint?: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  required?: boolean;
  /** Show an "(optional)" marker next to the label. */
  optional?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint && !error ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');
  const inputClass = `block w-full rounded-lg border bg-white px-3 py-2 text-sm shadow-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 ${
    error
      ? 'border-red-400 focus:border-red-500 focus:ring-red-200'
      : 'border-neutral-300 focus:border-neutral-500 focus:ring-neutral-200'
  }`;
  const shared = {
    id,
    name,
    value,
    maxLength,
    placeholder,
    required,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
    className: inputClass,
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-neutral-900">
        {label}
        {optional && <span className="ml-1 font-normal text-neutral-500">(optional)</span>}
      </label>
      {multiline ? (
        <textarea
          {...shared}
          rows={rows}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      ) : (
        <input
          {...shared}
          type="text"
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      )}
      {hint && !error && (
        <p id={hintId} className="text-xs text-neutral-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
