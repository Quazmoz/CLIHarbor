import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { installFakeBackend, verifyAndResetFakeBackend } from './fakeBackend';

// jsdom has no layout engine; route changes call scrollTo and would log noise.
window.scrollTo = () => {};

// Every test starts with an empty, fail-loud backend. A component that calls
// the network without the test declaring that route fails the test instead
// of silently hitting jsdom's real fetch (which rejects relative URLs and is
// swallowed by the component's error state). Tests that stub fetch themselves
// replace this; tests that call installFakeBackend(...) add their routes.
beforeEach(() => {
  installFakeBackend();
});

afterEach(() => {
  cleanup();
  try {
    verifyAndResetFakeBackend();
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.replaceState({}, '', '/');
  }
});
