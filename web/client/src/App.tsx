import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Member } from "../../src/api-types.ts";
import { api } from "./api.ts";
import styles from "./components/App.module.css";
import { LoginView } from "./components/LoginView.tsx";
import { OverviewView } from "./components/OverviewView.tsx";
import { SearchView } from "./components/SearchView.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { WondrousTailsView } from "./components/WondrousTailsView.tsx";
import { clearApiCache } from "./hooks.ts";
import { prefetchView } from "./queries.ts";
import { SessionContext } from "./session.ts";
import { isView, VIEWS, type View } from "./views.ts";

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

  const mainRef = useRef<HTMLElement>(null);
  const pageName = auth.status === "signedIn" ? VIEWS.find((tab) => tab.view === view)!.label : "Sign in";
  const previousPage = useRef<string | null>(null);

  useEffect(() => {
    if (auth.status === "checking") return;
    document.title = `${pageName} · FC Hub`;
    if (previousPage.current !== null && previousPage.current !== pageName) mainRef.current?.focus();
    previousPage.current = pageName;
  }, [auth.status, pageName]);

  useEffect(() => {
    // The opening tab's data loads alongside the sign-in check instead of after it (if signed
    // out, these just fail with 401 and are dropped).
    prefetchView(readUrl().view);
    api
      .me()
      .then(({ member }) => setAuth({ status: "signedIn", member }))
      .catch(() => setAuth({ status: "signedOut" }));
  }, []);

  useEffect(() => writeUrl(view, query), [view, query]);

  const signedOut = useCallback(() => {
    clearApiCache();
    setAuth({ status: "signedOut" });
  }, []);
  const session = useMemo(() => ({ signedOut }), [signedOut]);

  async function signOut() {
    await api.signOut().catch(() => undefined);
    signedOut();
  }

  const member = auth.status === "signedIn" ? auth.member : null;

  return (
    <>
      <a href="#main-content" className={styles.skip}>
        Skip to main content
      </a>
      <TopBar member={member} view={view} onNavigate={(v) => setRoute((r) => ({ ...r, view: v }))} onSignOut={signOut} />
      <main
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
        aria-label={pageName}
        className={member ? `${styles.main} ${styles.hall}` : styles.main}
      >
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
