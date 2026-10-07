import type { ToolSignIn } from '../AuthenticationPage';
import { conjurSignIn } from './conjur/ConjurSignIn';

// Frontend half of each dedicated platform, keyed by the backend platform ID
// from /api/v1/platforms. A platform missing here simply has no custom sign-in.
export const dedicatedSignIn: Readonly<Record<string, ToolSignIn>> = {
  conjur: conjurSignIn,
};
