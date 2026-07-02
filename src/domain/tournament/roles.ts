// Role helpers for the three-tier RBAC model: Admin -> Director -> Staff.
export const ROLE_ADMIN = "ROLE_ADMIN";
export const ROLE_DIRECTOR = "ROLE_DIRECTOR";
export const ROLE_STAFF = "ROLE_STAFF";

export type Role = typeof ROLE_ADMIN | typeof ROLE_DIRECTOR | typeof ROLE_STAFF;

interface RoleCarrier {
  authenticated: boolean;
  roles: string[];
}

const has = (auth: RoleCarrier, role: Role) => auth.authenticated && auth.roles.includes(role);

export const isAdmin = (auth: RoleCarrier) => has(auth, ROLE_ADMIN);
export const isDirector = (auth: RoleCarrier) => has(auth, ROLE_DIRECTOR);
/** Result-entry staff (lowest tier): may only enter/edit data within allowed stages. */
export const isResultStaff = (auth: RoleCarrier) => has(auth, ROLE_STAFF);

/**
 * Who may mutate a tournament's cards (pairing, publish, create/delete cards, edit players).
 * Directors only — admins are platform viewers who watch every tournament but never manage cards;
 * their powers are the admin console (creating tournaments and director accounts).
 */
export const canManageTournament = (auth: RoleCarrier) => isDirector(auth);

/**
 * Operators work *inside* a card's workspace pages (pairing, result entry): directors and
 * result-entry staff. Admins and public viewers only watch, so they get the read-only overview.
 */
export const isOperator = (auth: RoleCarrier) => isDirector(auth) || isResultStaff(auth);

/** Any authenticated back-office user (admin/director/staff), i.e. not a public viewer. */
export const hasStaffAccess = (auth: RoleCarrier) => isAdmin(auth) || isDirector(auth) || isResultStaff(auth);
