# Password managers — what the page can and cannot suppress

Supersedes `23_P6_CLOSURE.md` §6. That section left the question open ("recorded as an owner
decision, not a closed question"); this closes it. `02_ARCHITECTURE_DECISIONS.md` is frozen and is
not edited — D6 stands unchanged, and this refines how it is implemented.

---

## 1. The report

Every time a password field appeared, the browser offered:

1. a generated password ("Suggest strong password"),
2. the operator's own saved password, and
3. after submitting, "Save password?"

None of the three is wanted. Staff sign in on machines that are **not** centrally managed, so
disabling the manager by enterprise policy is not available.

## 2. What changed

One token, in `src/ui/components/fresh-secret-input.tsx`:

```
autocomplete="new-password"   →   autocomplete="off"
```

`FreshSecretInput` `Omit`s `autoComplete` from its props, so no call site can override it. All
eight call sites — `staff-login`, the `PromptDialog` re-auth, the pairing-swap field — change
together. That is structural, not a convention anyone has to remember.

**Why the previous value was the problem.** P6 chose `new-password` as "the strongest standard
hint", reasoning that `autocomplete="off"` is ignored on password fields. Both halves of that are
true, and the conclusion still did not follow: `new-password` is the exact token that tells Chrome a
field is a *signup* field, so Chrome answers by offering to generate a password. It was buying one
unwanted popup with another.

## 3. The honest ledger

| Popup | Before (`new-password`) | After (`off`) |
|---|---|---|
| "Suggest strong password" | shown | **gone** |
| "Use saved password" | largely suppressed | **may appear** |
| "Save password?" | shown | shown — **unchanged** |

The middle row is a real trade and was accepted with the trade stated. `off` is ignored for autofill
on password fields, and `new-password` had been incidentally suppressing the saved-credential offer.
The change fixes the generation popup and may surface the autofill one.

Third-party managers stay suppressed: `data-1p-ignore`, `data-bwignore`, `data-lpignore`,
`data-protonpass-ignore`, `data-form-type="other"` cover 1Password, Bitwarden, LastPass and Proton.

## 4. The limit, stated plainly

**"Save password?" cannot be suppressed from the page, in any browser, by any attribute.** Chrome
and Safari deliberately ignore page-level attempts to disable their own manager; this was a
considered anti-user-hostility decision on their part, and there is no supported override. It is
browser-controlled and out of the application's reach.

The residual is the one D9 already reasons about: on a shared machine, a saved credential lets the
next person sign in as the previous one, and the audit log records the previous one's identity. The
mitigations that remain are all outside the page — the prominent logout button (D9), the 30-minute
session, and declining the prompt.

## 5. What must not be done to close the gap

| Rejected | Why |
|---|---|
| `type="text"` + `-webkit-text-security` | Hides the characters from the screen and from nothing else — a screen reader reads the password aloud. Measured and rejected as option 2 in `21_P6_P7_PLAN.md` §2.4 |
| Removing the native `<form>` from `staff-login` | Would measurably weaken Chrome's password-form detection, but replaces native validation and Enter-to-submit on the login path for every staff account. Offered and declined; revisit only outside a competition window |
| Enterprise policy (`PasswordManagerEnabled: false`) | The only thing that removes all three popups completely — unavailable, the machines are not managed |
| A hidden decoy password field | A long-dead hack; current Chrome ignores it |

## 6. Verification

`src/ui/components/secret-input-autocomplete.test.ts` guards the token, the `Omit` that makes it
apply everywhere, the `type="password"` masking, the four ignore attributes, and that no raw
`<input type="password">` bypasses the component.

Rendered-DOM verification of the login field was done against the dev server. The **popup behaviour
itself was not verified by the agent** — entering credentials is out of bounds for it, the same
limit recorded in `23_P6_CLOSURE.md` §6. Confirming the generation offer is gone in Chrome and
Safari at `/staff-login` and at the director re-auth dialog is an owner check.
