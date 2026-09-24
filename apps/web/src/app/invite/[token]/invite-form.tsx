"use client";

import { useActionState, useState } from "react";
import { acceptInvitationAction, type AcceptState } from "../../../actions/team";
import { Icon } from "../../../components/icon";
import { dict } from "../../../lib/i18n";

/** Password for the invited email; the email itself is fixed by the invitation. */
export function InviteForm({
  token,
  email,
  lang,
}: {
  token: string;
  email: string;
  lang: string;
}) {
  const t = dict(lang);
  const [state, action, pending] = useActionState<AcceptState, FormData>(
    acceptInvitationAction,
    null,
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const longEnough = password.length >= 8;
  const matches = confirm.length > 0 && confirm === password;

  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      <div className="field">
        <label htmlFor="invite-email">
          <span>{t.auth.email}</span>
        </label>
        <input
          id="invite-email"
          className="input"
          type="email"
          autoComplete="username"
          value={email}
          readOnly
        />
      </div>
      <div className="field">
        <label htmlFor="invite-password">
          <span>{t.auth.password}</span>
        </label>
        <input
          id="invite-password"
          className="input"
          name="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="invite-password-rule"
        />
        <p
          className={`auth-rule${longEnough ? " ok" : password.length > 0 ? " bad" : ""}`}
          id="invite-password-rule"
        >
          {longEnough ? <Icon name="check" label={null} size={12} /> : null}
          {t.auth.passwordRule}
        </p>
      </div>
      <div className="field">
        <label htmlFor="invite-confirm">
          <span>{t.auth.confirmPassword}</span>
        </label>
        <input
          id="invite-confirm"
          className="input"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={confirm.length > 0 && !matches ? true : undefined}
          aria-describedby={confirm.length > 0 && !matches ? "invite-confirm-rule" : undefined}
        />
        {confirm.length > 0 && !matches ? (
          <p className="auth-rule bad" id="invite-confirm-rule">
            {t.auth.confirmMismatch}
          </p>
        ) : null}
      </div>
      {state?.error ? (
        <p className="auth-err" role="alert">
          {state.error}
        </p>
      ) : null}
      <button
        className="btn-next"
        type="submit"
        disabled={!longEnough || !matches || pending}
      >
        {pending ? t.auth.inviteAccepting : t.auth.inviteAccept}
      </button>
    </form>
  );
}
