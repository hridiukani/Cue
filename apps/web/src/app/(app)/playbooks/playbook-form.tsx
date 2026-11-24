'use client';

import { PLAYBOOK_LIMITS } from '@cue/shared';
import Link from 'next/link';
import { useActionState, useId, useState } from 'react';
import { buttonClass } from '@/components/button-styles';
import { errorTextClass, fieldClass, hintClass, labelClass } from '@/components/form-styles';
import { SubmitButton } from '@/components/submit-button';
import { Eyebrow, Notice } from '@/components/ui';
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
    <form action={formAction} className="space-y-12" noValidate>
      {state.status === 'error' && <Notice tone="error">{state.message}</Notice>}

      <section className="space-y-6">
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

      <section
        aria-labelledby="objections-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <div>
          <h2 id="objections-heading" className="font-serif text-2xl tracking-tight">
            Objections
          </h2>
          <p className="mt-2 text-muted-foreground">
            Pushback you expect, and a good way to answer it. Cue uses these when suggesting lines.
          </p>
        </div>

        {errors.objections && <p className="text-sm text-destructive">{errors.objections}</p>}

        {rows.length === 0 ? (
          <p className="border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No objections yet.
          </p>
        ) : (
          <ol className="space-y-8">
            {rows.map((row, i) => (
              <li key={row.key} className="border-l-2 border-signal pl-5">
                <div className="mb-4 flex items-center justify-between">
                  <Eyebrow>
                    <span className="text-signal">{String(i + 1).padStart(2, '0')}</span> Objection
                  </Eyebrow>
                  <button
                    type="button"
                    onClick={() => {
                      removeRow(row.key);
                    }}
                    className="text-sm text-muted-foreground hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
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

      <section className="border-t border-border pt-10">
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

      <div className="flex items-center justify-end gap-3 border-t border-rule pt-8">
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
  const inputClass = fieldClass(Boolean(error));
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
      <label htmlFor={id} className={labelClass}>
        {label}
        {optional && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
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
        <p id={hintId} className={hintClass}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={errorTextClass}>
          {error}
        </p>
      )}
    </div>
  );
}
