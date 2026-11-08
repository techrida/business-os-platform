import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Order matters: tokens first, then the self-hosted font, then the base styles that use both.
import '@/styles/tokens.css';
import '@fontsource-variable/outfit';
import '@/styles/globals.css';

import { WebVitals } from '@/components/web-vitals';

export const metadata: Metadata = {
  title: 'Business OS',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WebVitals />
        {children}
      </body>
    </html>
  );
}
