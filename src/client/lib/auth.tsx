// Signed-in user state, permission checks for the UI (the server enforces the same rules)
import { createContext, useContext, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import { canAct, type LoginInput, type Permission, type SessionUser } from "@shared/auth";

export type AuthStatus = "loading" | "authenticated" | "anonymous" | "unavailable";

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  /** Why the session check failed when status is "unavailable" */
  error: string | null;
  /** True after an explicit sign-out, so the next sign-in doesn't return to the last page */
  signedOut: boolean;
  can: (permission: Permission) => boolean;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  /** After accepting an invite / resetting a password the server already set the session */
  refresh: () => Promise<unknown>;
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const meQueryKey = ["auth", "me"] as const;

async function fetchMe(): Promise<SessionUser | null> {
  try {
    return (await api.get<SessionUser>("/api/auth/me")).data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: meQueryKey, queryFn: fetchMe, staleTime: 60_000, retry: 1 });
  const [signedOut, setSignedOut] = useState(false);

  const login = useMutation({
    mutationFn: (input: LoginInput) => api.post<SessionUser>("/api/auth/login", input),
    onSuccess: (res) => {
      setSignedOut(false);
      qc.setQueryData(meQueryKey, res.data);
    },
  });
  const logout = useMutation({
    mutationFn: () => api.post("/api/auth/logout"),
    onSettled: () => {
      setSignedOut(true);
      qc.clear();
      qc.setQueryData(meQueryKey, null);
    },
  });

  const status: AuthStatus = me.isPending ? "loading" : me.isError ? "unavailable" : me.data ? "authenticated" : "anonymous";
  const user = me.data ?? null;

  const value: AuthContextValue = {
    status,
    user,
    error: me.error ? (me.error as Error).message : null,
    signedOut,
    can: (p) => (user ? canAct(user, p) : false),
    login: async (input) => {
      await login.mutateAsync(input);
    },
    logout: async () => {
      await logout.mutateAsync();
    },
    refresh: () => qc.invalidateQueries({ queryKey: meQueryKey }),
    retry: () => void me.refetch(),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
