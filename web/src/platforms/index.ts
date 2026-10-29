import { lazy, type ComponentProps, type ComponentType } from 'react';
import type { ToolSignIn } from '../AuthenticationPage';
import { conjurSignIn } from './conjur/ConjurSignIn';
import type { ConjurWorkspace } from './conjur/ConjurWorkspace';

// Frontend half of each dedicated platform, keyed by the backend platform ID
// from /api/v1/platforms. A platform missing here simply has no custom sign-in.
export const dedicatedSignIn: Readonly<Record<string, ToolSignIn>> = {
  conjur: conjurSignIn,
};

export type PlatformWorkspaceProps = ComponentProps<typeof ConjurWorkspace>;

// A platform missing here gets the generic feature list on its home page.
export const dedicatedWorkspace: Readonly<Record<string, ComponentType<PlatformWorkspaceProps>>> = {
  conjur: lazy(() => import('./conjur/ConjurWorkspace').then((module) => ({ default: module.ConjurWorkspace }))),
  terraform: lazy(() => import('./terraform/TerraformWorkspace').then((module) => ({ default: module.TerraformWorkspace }))),
};
