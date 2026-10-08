import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { CyberArkPortalLink, normalizeCyberArkIdentityPortalURL } from './CyberArkPortalLink';

afterEach(() => window.localStorage.clear());

describe('CyberArk portal address', () => {
  test('accepts only a single CyberArk Identity tenant host over HTTPS', () => {
    expect(normalizeCyberArkIdentityPortalURL('https://companyname.cyberark.cloud'))
      .toBe('https://companyname.cyberark.cloud');
    expect(normalizeCyberArkIdentityPortalURL('https://COMPANYNAME.cyberark.cloud/'))
      .toBe('https://companyname.cyberark.cloud');
    for (const unsafe of [
      'http://companyname.cyberark.cloud',
      'https://companyname.cyberark.cloud.evil.example',
      'https://companyname.secretsmgr.cyberark.cloud',
      'https://user:password@companyname.cyberark.cloud',
      'https://companyname.cyberark.cloud/login',
      'https://companyname.cyberark.cloud/?token=abc',
      'https://companyname.cyberark.cloud/#fragment',
      'https://companyname.cyberark.cloud:9443',
      'https://-wrong.cyberark.cloud',
      'https://companyname.cyberark.cloud\n',
      'https://example.com',
    ]) {
      expect(normalizeCyberArkIdentityPortalURL(unsafe)).toBeNull();
    }
  });

  test('never navigates or saves a suggested/default tenant until explicitly configured', () => {
    render(<CyberArkPortalLink />);
    expect(screen.getByPlaceholderText('https://companyname.cyberark.cloud')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save portal address' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Open CyberArk Identity portal' })).not.toBeInTheDocument();

    const field = screen.getByRole('textbox', { name: 'CyberArk Identity login URL' });
    fireEvent.change(field, { target: { value: 'https://companyname.cyberark.cloud.evil.example' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save portal address' })).toBeDisabled();
    expect(window.localStorage.length).toBe(0);

    fireEvent.change(field, { target: { value: 'https://mycompany.cyberark.cloud' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save portal address' }));
    const link = screen.getByRole('link', { name: 'Open CyberArk Identity portal' });
    expect(link).toHaveAttribute('href', 'https://mycompany.cyberark.cloud');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(window.localStorage.length).toBe(1);
  });

  test('treats invalid previously saved browser content as untrusted', () => {
    window.localStorage.setItem('cliharbor.cyberark.identity-portal-url', 'javascript:alert(1)');
    render(<CyberArkPortalLink />);
    expect(screen.getByRole('textbox', { name: 'CyberArk Identity login URL' })).toHaveValue('');
    expect(screen.queryByRole('link', { name: 'Open CyberArk Identity portal' })).not.toBeInTheDocument();
  });
});
