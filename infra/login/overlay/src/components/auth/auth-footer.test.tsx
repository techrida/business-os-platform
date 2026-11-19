import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loginFooterLinks } from '../../lib/login-footer-links';
import { AuthFooter } from './auth-footer';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('login footer links', () => {
  it('omits both items when the deployment leaves them unset', () => {
    vi.stubEnv('LOGIN_HELP_URL', undefined);
    vi.stubEnv('LOGIN_PRIVACY_URL', '  ');
    render(<AuthFooter {...loginFooterLinks()} />);

    expect(screen.queryByText('Need help?')).toBeNull();
    expect(screen.queryByText('Privacy')).toBeNull();
  });

  it('reads each destination at render time', () => {
    vi.stubEnv('LOGIN_HELP_URL', 'https://help.example.com/login');
    vi.stubEnv('LOGIN_PRIVACY_URL', undefined);
    const { rerender } = render(<AuthFooter {...loginFooterLinks()} />);

    expect(screen.getByRole('link', { name: 'Need help?' }).getAttribute('href')).toBe(
      'https://help.example.com/login',
    );
    expect(screen.queryByText('Privacy')).toBeNull();

    vi.stubEnv('LOGIN_HELP_URL', 'javascript:alert(1)');
    vi.stubEnv('LOGIN_PRIVACY_URL', 'https://example.com/privacy');
    rerender(<AuthFooter {...loginFooterLinks()} />);

    expect(screen.queryByText('Need help?')).toBeNull();
    expect(screen.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe(
      'https://example.com/privacy',
    );
  });
});
