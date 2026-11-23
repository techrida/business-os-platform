import { AuthHeading } from '@/components/auth/auth-heading';

/** Unknown address: shown inside the login layout so it keeps the light shell instead of Next's own dark 404. */
export default function NotFound() {
  return (
    <AuthHeading
      title="Page not found"
      lead="This address does not exist. Return to the sign-in page and try again."
    />
  );
}
