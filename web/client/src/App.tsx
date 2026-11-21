import { useCallback, useEffect, useMemo, useState } from "react";
import type { Member } from "../../src/api-types.ts";
import { api } from "./api.ts";
import styles from "./components/App.module.css";
import { LoginView } from "./components/LoginView.tsx";
import { OverviewView } from "./components/OverviewView.tsx";
import { SearchView } from "./components/SearchView.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { WondrousTailsView } from "./components/WondrousTailsView.tsx";
import { SessionContext } from "./session.ts";
import { isView, type View } from "./views.ts";

type Auth = { status: "checking" } | { status: "signedOut" } | { status: "signedIn"; member: Member };

/** URL state: ?q= for search (shareable links), ?view= for the other tabs (see views.ts). */
function readUrl(): { view: View; query: string } {
  const params = new URL(location.href).searchParams;
  const view = params.get("view");
  return { view: isView(view) ? view : "search", query: params.get("q") ?? "" };
}

function writeUrl(view: View, query: string): void {
  const url = new URL(location.href);
  url.search = "";
  if (view !== "search") url.searchParams.set("view", view);
  else if (query.trim()) url.searchParams.set("q", query.trim());
  history.replaceState(null, "", url);
}

export function App() {
  const [auth, setAuth] = useState<Auth>({ status: "checking" });
  const [{ view, query }, setRoute] = useState(readUrl);

  useEffect(() => {
    api
      .me()
      .then(({ member }) => setAuth({ status: "signedIn", member }))
      .catch(() => setAuth({ status: "signedOut" }));
  }, []);

  useEffect(() => writeUrl(view, query), [view, query]);

  const signedOut = useCallback(() => setAuth({ status: "signedOut" }), []);
  const session = useMemo(() => ({ signedOut }), [signedOut]);

  async function signOut() {
    await api.signOut().catch(() => undefined);
    signedOut();
  }

  const member = auth.status === "signedIn" ? auth.member : null;

  return (
    <>
      <TopBar member={member} view={view} onNavigate={(v) => setRoute((r) => ({ ...r, view: v }))} onSignOut={signOut} />
      <main className={styles.main}>
        <SessionContext value={session}>
          {auth.status === "signedOut" && <LoginView onSignedIn={(m) => setAuth({ status: "signedIn", member: m })} />}
          {member && view === "search" && <SearchView query={query} onQueryChange={(q) => setRoute((r) => ({ ...r, query: q }))} />}
          {member && view === "overview" && <OverviewView />}
          {member && view === "wt" && <WondrousTailsView />}
        </SessionContext>
      </main>
    </>
  );
}
