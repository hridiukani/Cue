export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';

const base =
  'inline-flex items-center justify-center gap-2 rounded-sm text-[15px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60';

const box = 'px-5 py-2.5';

const variants: Record<ButtonVariant, string> = {
  primary: `${box} bg-primary text-primary-foreground hover:bg-primary/85`,
  secondary: `${box} border border-rule bg-transparent text-foreground hover:bg-secondary`,
  danger: `${box} bg-destructive text-destructive-foreground hover:bg-destructive/90`,
  ghost: `${box} text-muted-foreground hover:text-foreground`,
  // Plain text that acts as a button ("Sign out").
  link: 'font-normal text-foreground hover:text-signal',
};

/** Tailwind classes for buttons and button-styled links. */
export function buttonClass(variant: ButtonVariant = 'primary'): string {
  return `${base} ${variants[variant]}`;
}
