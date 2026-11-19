import type { ReactNode } from 'react';

export function AuthFooter({
  children,
  helpHref,
  privacyHref,
}: {
  children?: ReactNode;
  helpHref?: string;
  privacyHref?: string;
}) {
  return (
    <footer className="bos-footer">
      <small className="bos-footer-copy">© {new Date().getFullYear()} Business OS</small>
      <div className="bos-footer-end">
        {children}
        <FooterItem href={helpHref}>Need help?</FooterItem>
        <FooterItem href={privacyHref}>Privacy</FooterItem>
      </div>
    </footer>
  );
}

function FooterItem({ href, children }: { href?: string; children: ReactNode }) {
  return href ? (
    <a className="bos-footer-item bos-footer-link" href={href}>
      {children}
    </a>
  ) : null;
}
