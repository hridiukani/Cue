'use client';

import { underlineSelectClass } from '@/components/form-styles';

/**
 * A filter: muted label, then an underlined select with a chevron. Changing it
 * submits its form (filters live in the URL); without JavaScript the form's
 * <noscript> Apply button does the same.
 */
export function FilterSelect({
  label,
  name,
  defaultValue,
  allLabel,
  options,
}: {
  label: string;
  name: string;
  defaultValue: string;
  /** The "no filter" option, e.g. "All datasets". */
  allLabel: string;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <label className="flex items-baseline gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="relative inline-block min-w-36">
        <select
          name={name}
          defaultValue={defaultValue}
          className={underlineSelectClass}
          onChange={(e) => {
            e.currentTarget.form?.requestSubmit();
          }}
        >
          <option value="">{allLabel}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="pointer-events-none absolute right-1 top-1/2 size-4 -translate-y-1/2 fill-none stroke-current stroke-[1.5]"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </span>
    </label>
  );
}
