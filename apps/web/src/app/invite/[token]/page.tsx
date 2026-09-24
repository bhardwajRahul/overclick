import { NebulaAtmosphere } from "../../../components/nebula-atmosphere";
import { db } from "../../../lib/db";
import { dict } from "../../../lib/i18n";
import { inspectInvitation } from "../../../lib/invitations";
import { APP_VERSION } from "../../../lib/updates";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";

/**
 * The only way in after the first admin (OCL-222): a link an admin generated
 * for one email and one organization. Used, expired, withdrawn or tampered,
 * it says so and offers sign in; valid, it asks for a password and, once set,
 * sends the member on to install.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const ws = await db().query.workspace.findFirst();
  const t = dict(ws?.language);
  const found = await inspectInvitation(db(), decodeURIComponent(token));

  return (
    <div className="nb nebula-surface nb-center nb-auth">
      <NebulaAtmosphere />
      <div className="stage">
        <div className="auth-shell">
          <aside className="auth-aside">
            <p className="auth-mark">
              over<span>click</span>
            </p>
            <p className="auth-lead">{t.auth.asideLead}</p>
            <ul className="auth-facts">
              <li>{t.auth.factHosted}</li>
              <li>{t.auth.factOpen}</li>
              <li>{t.auth.factAgents}</li>
            </ul>
          </aside>
          <div className="panel auth-card nebula-glass">
            <p className="brand">{t.auth.brand}</p>
            {found.ok ? (
              <>
                <h1>{t.auth.inviteTitle}</h1>
                <p className="sub">
                  {t.auth.inviteSub(found.email, found.organizationName)}
                </p>
                <InviteForm
                  token={decodeURIComponent(token)}
                  email={found.email}
                  lang={ws?.language ?? "en"}
                />
              </>
            ) : (
              <>
                <h1>{t.auth.inviteRefusedTitle}</h1>
                <p className="auth-err" role="alert">
                  {t.auth.inviteRefused[found.reason]}
                </p>
                <a className="btn-next" href="/login">
                  {t.auth.inviteToLogin}
                </a>
              </>
            )}
            <p className="foot">v{APP_VERSION} · {t.auth.foot}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
