import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';

/**
 * Shown in place of a screen's content when its read failed. "Try again" is a plain link to the same
 * address: following it runs the server read again.
 */
export function LoadError({ message, retryHref }: { message: string; retryHref: string }) {
  return (
    <Alert
      tone="error"
      role="alert"
      actions={
        <LinkButton href={retryHref} variant="secondary" size="small">
          Try again
        </LinkButton>
      }
    >
      {message}
    </Alert>
  );
}
