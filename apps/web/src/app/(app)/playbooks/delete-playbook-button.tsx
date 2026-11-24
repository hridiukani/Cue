'use client';

import { useActionState, useState } from 'react';
import { buttonClass } from '@/components/button-styles';
import { SubmitButton } from '@/components/submit-button';
import type { DeleteState } from './actions';

const IDLE: DeleteState = { status: 'idle' };

/** Two-step delete: first click asks for confirmation, second click deletes. */
export function DeletePlaybookButton({
  action,
  playbookName,
}: {
  action: (state: DeleteState) => Promise<DeleteState>;
  playbookName: string;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-3">
      {state.status === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      {confirming ? (
        <form action={formAction} className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-foreground">
            Delete <strong className="font-medium">{playbookName}</strong>? This can’t be undone.
          </span>
          <SubmitButton variant="danger" pendingLabel="Deleting…">
            Yes, delete
          </SubmitButton>
          <button
            type="button"
            className={buttonClass('ghost')}
            onClick={() => {
              setConfirming(false);
            }}
          >
            Keep it
          </button>
        </form>
      ) : (
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Delete playbook
        </button>
      )}
    </div>
  );
}
