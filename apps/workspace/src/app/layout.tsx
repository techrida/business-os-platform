import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { WebVitals } from '@/components/web-vitals';

export const metadata: Metadata = {
  title: 'Business OS',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Inline margin reset: CSS modules cannot style `body` (their selectors must be local). */}
      <body style={{ margin: 0 }}>
        <WebVitals />
        {children}
      </body>
    </html>
  );
}
