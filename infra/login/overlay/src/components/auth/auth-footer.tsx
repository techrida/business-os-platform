import type { ReactNode } from 'react';

/**
 * Bottom row of the form column: copyright on the start side, help and privacy on the end side.
 * `children` is the existing footer slot (the language switcher) and is rendered on the end side.
 *
 * "Need help?" and "Privacy" are plain text on purpose: the shell is a client-safe component and has no
 * configured destination for either (ZITADEL serves legal links per organisation, at request time). Pass
 * `helpHref` / `privacyHref` once real URLs exist and they become links.
 */
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
  ) : (
    <span className="bos-footer-item">{children}</span>
  );
}
