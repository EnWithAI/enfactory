# Fintech baseline

We are a fintech studio. Every product we build meets this baseline unless the client accepts a gap **in writing**
(recorded as a decision with the client's name and reason). The compliance officer checks it at planning and before each release.

1. **Authentication.** Every user signs in. Use strong authentication (passkeys/WebAuthn, or password + second factor). Where payments
   or account access are involved, apply SCA (PSD2). Sessions expire; sensitive actions re-authenticate.
2. **Authorisation.** Least privilege, roles where there is more than one kind of user, and no admin backdoors.
3. **Encryption.** TLS for everything in transit; sensitive data encrypted at rest with managed keys; no secrets in code or logs.
4. **Audit trail.** Every money movement and every security-relevant action is logged immutably: who, what, when, from where.
5. **Money correctness.** Integer minor units, explicit currencies, idempotent operations (no double-charge), and reconciliation.
6. **Privacy.** Data minimisation, retention rules, a lawful basis for processing (GDPR), and data residency as agreed.
7. **Compliance scope.** PCI DSS, PSD2/open banking, KYC/AML and local licensing are assessed for every engagement; what applies is in the requirements.
8. **Security testing.** Threat model per release, dependency and secret scanning, and no known critical/high/medium vulnerabilities at release.
9. **Design quality.** A defined design system, reviewed on real rendered screens, not only on a written spec.
