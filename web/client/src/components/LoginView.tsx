import { type FormEvent, useState } from "react";
import type { Member } from "../../../src/api-types.ts";
import { api, errorMessage, Unauthorized } from "../api.ts";
import styles from "./LoginView.module.css";
import ui from "./ui.module.css";

export function LoginView({ onSignedIn }: { onSignedIn: (member: Member) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { member } = await api.signIn(apiKey.trim());
      setApiKey("");
      onSignedIn(member);
    } catch (e) {
      setError(e instanceof Unauthorized ? "That key isn't valid (or has been revoked)." : `Sign-in failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${ui.card} ${styles.login}`}>
      <h2>Sign in</h2>
      <p className={ui.muted}>Use the same personal key you put in the FC Hub plugin settings.</p>
      <form className={styles.form} autoComplete="off" onSubmit={submit}>
        <label className={styles.label} htmlFor="api-key">
          API key
        </label>
        <input
          id="api-key"
          type="password"
          placeholder="fch_…"
          required
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: signing in is the only thing to do on this page.
          autoFocus
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className={ui.error} role="alert">
          {error}
        </p>
      </form>
    </section>
  );
}
