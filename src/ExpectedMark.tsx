import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { ExpectedMark } from './types';
import { markedAt } from './expected';
import { useI18n } from './i18n';

const MAX_REASON = 500;
/** Characters as the server counts them: code points, so an emoji is one, not two UTF-16 units. */
const length = (text: string) => [...text].length;
const bounded = (text: string) =>
  length(text) > MAX_REASON ? [...text].slice(0, MAX_REASON).join('') : text;

/** "Mark as expected": opens the inline form; the accessible name says which observation. */
export function ExpectedButton({
  subject,
  open,
  onClick,
}: {
  subject: string;
  open: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      className="expected-button"
      aria-expanded={open}
      aria-label={t('Mark as expected: {subject}', { subject })}
      onClick={onClick}
    >
      {t('Mark as expected')}
    </button>
  );
}

/**
 * Inline form of a mark: optional reason (up to 500 characters, counted as the server does), confirm, cancel
 * and one sentence on where the mark holds. Enter confirms and Escape cancels; an error of the API stays in the
 * form. `initial` brings back the reason of a mark undone in this session.
 */
export function ExpectedForm({
  subject,
  onSubmit,
  onCancel,
  initial = '',
  onDraft,
}: {
  subject: string;
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
  initial?: string;
  /** Each change of the reason, so that a form closed by another can come back with it. */
  onDraft?: (reason: string) => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState(() => bounded(initial));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await onSubmit(reason);
    } catch (e) {
      setError((e as Error).message);
      setPending(false);
    }
  }
  return (
    <form
      className="expected-form"
      aria-label={t('Mark as expected: {subject}', { subject })}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <label htmlFor={id}>{t('Reason (optional)')}</label>
      <div className="expected-form-field">
        <input
          id={id}
          autoFocus
          value={reason}
          placeholder={t('For example: file created by the agent while running')}
          onChange={(event) => {
            const value = bounded(event.target.value);
            setReason(value);
            onDraft?.(value);
          }}
        />
        <small>
          {length(reason)}/{MAX_REASON}
        </small>
      </div>
      <p>{t('Only in this app; the CLI keeps reporting it.')}</p>
      {error && (
        <p className="expected-error" role="alert">
          {error}
        </p>
      )}
      <div className="expected-form-actions">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? t('Marking…') : t('Mark as expected')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('Cancel')}
        </button>
      </div>
    </form>
  );
}

/**
 * "Marked as expected on <date>: <reason>" and the action that undoes it ("Unmark" or, for a mark
 * without observation, "Remove mark").
 */
export function ExpectedNote({
  mark,
  subject,
  onUndo,
  undo,
}: {
  mark: ExpectedMark;
  subject: string;
  onUndo: () => Promise<void>;
  undo?: string;
}) {
  const { t, rich } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const action = undo ?? t('Unmark');
  return (
    <div className="expected-note">
      <span>
        {mark.reason
          ? rich('Marked as expected on {date}: <quote>{reason}</quote>', {
              date: markedAt(mark.at),
              reason: mark.reason,
              quote: (chunks) => <q>{chunks}</q>,
            })
          : t('Marked as expected on {date} (no reason)', { date: markedAt(mark.at) })}
      </span>
      <button
        aria-label={t('{action}: {subject}', { action, subject })}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError('');
          try {
            await onUndo();
          } catch (e) {
            setError((e as Error).message);
            setPending(false);
          }
        }}
      >
        {action}
      </button>
      {error && (
        <span className="expected-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
