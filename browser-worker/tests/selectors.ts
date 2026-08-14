// Selector contract with the app under test. All values are env-overridable so the
// Hermes layer (or an operator) can supply its own per run — nothing here is load-bearing
// beyond the dev defaults probed against https://fai.footprints.media (2026-08-14).
export const SEL = {
  loginPath: process.env.QA_LOGIN_PATH ?? '/?auth=login',
  loginEmail: process.env.QA_SEL_LOGIN_EMAIL ?? 'input[name=username]',
  loginPassword: process.env.QA_SEL_LOGIN_PASSWORD ?? 'input[name=password]',
  // exact accessible name of the submit button ("Login", not "Login with Microsoft")
  loginSubmitName: process.env.QA_SEL_LOGIN_SUBMIT ?? 'Login',
  // guest views lack <main>; submenu-container is present on both guest and authed shells
  appShell: process.env.QA_SEL_APP_SHELL ?? 'main, [data-testid=submenu-container]',
  // the app enforces auth CLIENT-SIDE with an in-page gate; there is no HTTP redirect
  gateText: process.env.QA_GATE_TEXT ?? 'Log in to continue',
};
