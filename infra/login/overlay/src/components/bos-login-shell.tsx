import { Brand } from '@/components/shell/brand';
import type { ReactNode } from 'react';

export function LoginShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="bos-login-page">
      <div className="bos-login-card">
        <Brand />
        {children}
        {footer && <div className="bos-login-footer">{footer}</div>}
      </div>
    </main>
  );
}
