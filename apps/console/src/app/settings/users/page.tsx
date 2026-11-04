// Who can use the console: invited partner staff, each signing in with their own work account.
// Admins manage rates, markup, credentials, users and alerts; members do everything else.

import { users } from "@launchpad/db";
import { asc, inArray } from "drizzle-orm";
import Link from "next/link";
import { currentUser, isAdmin } from "@/lib/auth.ts";
import { db } from "@/lib/db.ts";
import { formatAgo } from "@/lib/format.ts";
import { inviteUser, removeUser, setUserRole } from "../actions.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users · Settings" };

type Props = { searchParams: Promise<{ error?: string; invited?: string; saved?: string; removed?: string }> };

const ERRORS: Record<string, string> = {
  invite: "Enter a valid email address and a role.",
  exists: "That person is already a user.",
  role: "Choose Admin or Member.",
  self: "You can't change your own role or remove yourself. Ask another admin.",
};

const ROLE_LABELS = { partner_admin: "Admin", partner_member: "Member" } as const;

export default async function UsersPage({ searchParams }: Props) {
  const { error, invited, saved, removed } = await searchParams;
  const me = await currentUser();
  const admin = isAdmin(me);
  const now = new Date();
  const rows = await db()
    .select()
    .from(users)
    .where(inArray(users.role, ["partner_admin", "partner_member"]))
    .orderBy(asc(users.email));

  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href="/settings">Settings</Link>
      </p>
      <div className="page-head">
        <h1>Users</h1>
        <p className="muted">
          People sign in with their Microsoft or Google work account. Only invited addresses get in. Admins manage rates, markup,
          credentials, users and alerts; members manage customers, deployments, content, widgets and reports.
        </p>
      </div>
      {me.setupMode && (
        <p className="notice" data-tone="warning" role="note">
          The console is in setup mode, so nobody signs in by name yet. You can invite people now; they can sign in once work-account
          sign-in is connected.
        </p>
      )}
      {error && ERRORS[error] && (
        <p className="notice" data-tone="critical" role="alert">
          {ERRORS[error]}
        </p>
      )}
      {(invited || saved || removed) && (
        <p className="notice" role="status">
          {invited ? "Invitation saved. They can sign in now." : removed ? "User removed." : "Role changed."}
        </p>
      )}

      <section className="panel">
        <h2>People</h2>
        {rows.length === 0 ? (
          <p className="muted">Nobody yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Last sign-in</th>
                  {admin && <th scope="col">Change</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.name ?? u.email}
                      {u.name && <span className="sub">{u.email}</span>}
                    </td>
                    <td>{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}</td>
                    <td>{u.lastLoginAt ? formatAgo(u.lastLoginAt, now) : <span className="muted">Not yet</span>}</td>
                    {admin && (
                      <td>
                        {u.id === me.id ? (
                          <span className="muted">You</span>
                        ) : (
                          <div className="actions">
                            <form action={setUserRole.bind(null, u.id)} className="inline">
                              <label className="sr-only" htmlFor={`role-${u.id}`}>
                                Role for {u.email}
                              </label>
                              <select id={`role-${u.id}`} name="role" defaultValue={u.role}>
                                <option value="partner_member">Member</option>
                                <option value="partner_admin">Admin</option>
                              </select>
                              <button type="submit" className="button secondary">
                                Save
                              </button>
                            </form>
                            <form action={removeUser.bind(null, u.id)}>
                              <button type="submit" className="link-button">
                                Remove<span className="sr-only"> {u.email}</span>
                              </button>
                            </form>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {admin && (
        <form className="panel form" action={inviteUser}>
          <h2>Invite someone</h2>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input id="email" name="email" type="email" required autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="name">Name (optional)</label>
              <input id="name" name="name" autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="role">Role</label>
              <select id="role" name="role" defaultValue="partner_member">
                <option value="partner_member">Member</option>
                <option value="partner_admin">Admin</option>
              </select>
            </div>
          </div>
          <button className="button" type="submit">
            Invite
          </button>
        </form>
      )}
    </main>
  );
}
