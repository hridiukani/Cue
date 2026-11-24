/** Text inputs and textareas. */
export function fieldClass(hasError = false): string {
  return `block w-full rounded-sm border bg-card px-3 py-2 text-[15px] placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 ${
    hasError
      ? 'border-destructive focus:border-destructive focus:ring-destructive/20'
      : 'border-input focus:border-ring focus:ring-ring/20'
  }`;
}

export const labelClass = 'block text-sm font-medium text-foreground';
export const hintClass = 'text-xs text-muted-foreground';
export const errorTextClass = 'text-xs text-destructive';

/**
 * A select drawn as an underlined value with a chevron, as in the call
 * library's filters. Wrap it in a `relative` element next to <SelectChevron />.
 */
export const underlineSelectClass =
  'block w-full appearance-none border-0 border-b border-border bg-transparent py-1.5 pr-7 text-[15px] text-foreground focus:border-ring focus:outline-none';
