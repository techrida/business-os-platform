import { BOS_LIGHT_ONLY } from '@bos/locale';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Order matters: tokens first, our deliberate overrides of them, then the self-hosted font, then
// the base styles that use all three.
import '@/styles/tokens.css';
import '@/styles/token-overrides.css';
import '@fontsource-variable/outfit';
import '@/styles/globals.css';

import { WorkspaceToaster } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';

export const metadata: Metadata = {
  title: 'Business OS',
};

// The vitals reporter is mounted in the signed-in `(app)` layout, not here: its receiver needs a
// session, so on the login and notice pages every beacon was a 401.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme={BOS_LIGHT_ONLY ? 'light' : undefined}>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <WorkspaceToaster />
      </body>
    </html>
  );
}
