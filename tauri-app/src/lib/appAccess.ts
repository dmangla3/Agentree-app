export interface AppAccessState {
  devAuthBypass: boolean;
  usesDesktopAuth: boolean;
  hasDesktopUser: boolean;
  hasDesktopSession: boolean;
  isKindeAuthenticated: boolean;
}

export const hasAppAccess = ({
  devAuthBypass,
  usesDesktopAuth,
  hasDesktopUser,
  hasDesktopSession,
  isKindeAuthenticated,
}: AppAccessState): boolean => (
  devAuthBypass || (
    usesDesktopAuth
      ? hasDesktopUser && hasDesktopSession
      : isKindeAuthenticated
  )
);
