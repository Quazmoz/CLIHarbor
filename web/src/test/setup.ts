import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout engine; route changes call scrollTo and would log noise.
window.scrollTo = () => {};

afterEach(() => cleanup());
