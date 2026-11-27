import assert from "node:assert/strict";
import test from "node:test";

import {
  canManageTournament,
  hasStaffAccess,
  isOperator,
  ROLE_ADMIN,
  ROLE_DIRECTOR,
  ROLE_STAFF,
} from "./roles";

test("only an authenticated director can manage a competition from the card workspace", () => {
  for (const [role, canManage, operator] of [
    [ROLE_ADMIN, false, false],
    [ROLE_DIRECTOR, true, true],
    [ROLE_STAFF, false, true],
  ] as const) {
    const auth = { authenticated: true, roles: [role] };
    assert.equal(canManageTournament(auth), canManage, role);
    assert.equal(isOperator(auth), operator, role);
    assert.equal(hasStaffAccess(auth), true, role);
  }
});

test("unknown roles and authentication loss remove access to the card workspace", () => {
  for (const auth of [
    { authenticated: true, roles: [] },
    { authenticated: true, roles: ["ROLE_UNKNOWN"] },
    { authenticated: false, roles: [ROLE_ADMIN, ROLE_DIRECTOR, ROLE_STAFF] },
  ]) {
    assert.equal(canManageTournament(auth), false);
    assert.equal(isOperator(auth), false);
    assert.equal(hasStaffAccess(auth), false);
  }
});
