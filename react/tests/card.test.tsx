import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { Login } from '../src/Login.js';
import { Register } from '../src/Register.js';

// The card chrome is pure rendering (no network), so we assert on static markup — this is the one
// place the package renders a component, so it pulls in react-dom/server just for these tests (RQ-0016).
const noop = () => {};
const CARD_MARKER = 'min-height:100vh'; // the full-viewport page wrapper only exists in card mode

describe('<Login/> card chrome (RQ-0016)', () => {
  it('renders a bare form with an <h2> title and no card wrapper when card is off', () => {
    const html = renderToStaticMarkup(<Login baseUrl="https://a" clientId="c" onSuccess={noop} />);
    expect(html.startsWith('<form')).toBe(true);
    expect(html).toContain('<h2>Sign in</h2>');
    expect(html).not.toContain(CARD_MARKER);
    expect(html).not.toContain('<h1');
  });

  it('wraps the form in centered card chrome and moves the title into an <h1> header when card is set', () => {
    const html = renderToStaticMarkup(<Login baseUrl="https://a" clientId="c" onSuccess={noop} card />);
    expect(html).toContain(CARD_MARKER);
    expect(html).toContain('box-shadow');
    expect(html).toContain('<h1');
    expect(html).toContain('Sign in');
    expect(html).not.toContain('<h2'); // title is not duplicated in the form
    expect(html).toContain('<form'); // the form is still inside
  });

  it('renders logo, subtitle and footer from card options', () => {
    const html = renderToStaticMarkup(
      <Login
        baseUrl="https://a" clientId="c" onSuccess={noop}
        card={{ logo: 'ACME', subtitle: 'Sign in to Acme', footer: 'Trouble signing in?' }}
      />
    );
    expect(html).toContain('ACME');
    expect(html).toContain('Sign in to Acme');
    expect(html).toContain('Trouble signing in?');
  });

  it('honours fullViewport:false (card without the page wrapper)', () => {
    const html = renderToStaticMarkup(
      <Login baseUrl="https://a" clientId="c" onSuccess={noop} card={{ fullViewport: false }} />
    );
    expect(html).toContain('box-shadow');
    expect(html).not.toContain(CARD_MARKER);
  });
});

describe('<Register/> card chrome (RQ-0016)', () => {
  it('is off by default (bare form, <h2> title)', () => {
    const html = renderToStaticMarkup(<Register baseUrl="https://a" tenantId="t" onSuccess={noop} />);
    expect(html.startsWith('<form')).toBe(true);
    expect(html).toContain('<h2>Create your account</h2>');
    expect(html).not.toContain(CARD_MARKER);
  });

  it('composes card chrome with the invite field', () => {
    const html = renderToStaticMarkup(
      <Register baseUrl="https://a" tenantId="t" onSuccess={noop} card invite={{ required: true, hint: 'From your admin' }} />
    );
    expect(html).toContain(CARD_MARKER);
    expect(html).toContain('<h1');
    expect(html).toContain('Invite code');
    expect(html).toContain('From your admin');
  });
});
