import { createContext, useContext } from "react";

/**
 * Lets any component report that the session has ended (a 401 from the API), so the app can show
 * the sign-in page, without passing a callback down through every view.
 */
export const SessionContext = createContext<{ signedOut: () => void }>({ signedOut: () => undefined });

export function useSignedOut(): () => void {
  return useContext(SessionContext).signedOut;
}
