export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const base =
  'inline-flex items-center justify-center gap-2 rounded-sm px-5 py-2.5 text-[15px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/85',
  secondary: 'border border-rule bg-transparent text-foreground hover:bg-secondary',
  danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  ghost: 'text-muted-foreground hover:text-foreground',
};

/** Tailwind classes for buttons and button-styled links. */
export function buttonClass(variant: ButtonVariant = 'primary'): string {
  return `${base} ${variants[variant]}`;
}
