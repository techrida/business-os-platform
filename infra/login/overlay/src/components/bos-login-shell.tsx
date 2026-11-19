import { AuthAside } from '@/components/auth/auth-aside';
import { AuthBrand } from '@/components/auth/auth-brand';
import { AuthFooter } from '@/components/auth/auth-footer';
import type { ReactNode } from 'react';

/**
 * Split login card: auth column on the start side, decorative workspace overview aside on the end side.
 * `footer` (the language switcher) is rendered in the footer row of the auth column. Layout and breakpoints
 * live in styles/bos-shell.css. Must stay usable from client components (global-error.tsx imports it).
 */
export function LoginShell({
  children,
  footer,
  helpHref,
  privacyHref,
}: {
  children: ReactNode;
  footer?: ReactNode;
  helpHref?: string;
  privacyHref?: string;
}) {
  return (
    <main className="bos-login-page">
      <div className="bos-login-card">
        <div className="bos-shell-main bos-auth">
          <AuthBrand />
          <div className="bos-shell-body">
            <div className="bos-shell-content">{children}</div>
          </div>
          <AuthFooter helpHref={helpHref} privacyHref={privacyHref}>
            {footer}
          </AuthFooter>
        </div>
        <AuthAside />
      </div>
    </main>
  );
}
