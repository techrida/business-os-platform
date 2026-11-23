import { AuthHeading } from '@/components/auth/auth-heading';
import Link from 'next/link';

/** Unknown address: shown inside the login layout so it keeps the light shell instead of Next's own dark 404. */
export default function NotFound() {
  return (
    <>
      <AuthHeading title="Page not found" lead="This address does not exist." />
      <p className="bos-switch-line">
        <Link className="bos-link" href="/loginname">
          Go to sign in
        </Link>
      </p>
    </>
  );
}
