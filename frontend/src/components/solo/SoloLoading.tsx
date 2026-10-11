/**
 * The solo screens' loading state, centred on the screen: a turning gold
 * hex, the message, and an indeterminate bar like the boot loader's. On a
 * failure it shows what went wrong and offers to try again.
 */
export default function SoloLoading({ message, error, onRetry }: {
  message: string;
  error?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="cc-solo-loading" role={error ? 'alert' : 'status'} aria-live="polite">
      <div className={`cc-solo-loading-card${error ? ' is-failed' : ''}`}>
        <span className="cc-solo-loading-hex" aria-hidden="true"><i /></span>
        <div className="cc-solo-loading-text">{error ? 'Lost at sea' : message}</div>
        <div className="cc-scr-ornament" aria-hidden="true"><i /></div>
        {error ? (
          <>
            <div className="cc-solo-loading-error">{error}</div>
            {onRetry && (
              <button type="button" className="cc-btn-secondary cc-solo-loading-retry" onClick={onRetry}>
                Try again
              </button>
            )}
          </>
        ) : (
          <span className="cc-solo-loading-track" aria-hidden="true"><i /></span>
        )}
      </div>
    </div>
  );
}
