# AWS: how the factory deploys and validates

```
factory host ── gh workflow run deploy.yml -f environment=staging ──▶ GitHub Actions
   │                                                                     │ OIDC (no stored keys)
   │                                                                     ▼
   │                                                  sts:AssumeRoleWithWebIdentity → factory-deploy-staging
   │                                                                     │ deploy → smoke test → auto-rollback on failure
   │
   └─ SRE agent ── AWS_PROFILE=factory-readonly-staging ──▶ CloudWatch alarms, logs, ECS/Lambda describe (read-only)
```

- **Deploy credentials never reach the factory or any agent.** The factory can only *trigger* a workflow. The workflow gets
  short-lived credentials through OIDC, and only for jobs running in the matching GitHub Environment.
- **The validation credentials are read-only**, with an explicit deny on secrets, KMS decrypt, S3 reads, and IAM. Only the `sre`
  and `release-manager` roles receive them (`aws: true` in org.yaml). Every other agent has `AWS_*` stripped.

## Setup (once per AWS account / environment)

1. Deploy the IAM stack (repeat for production with `Environment=production`):
   ```bash
   aws cloudformation deploy --profile <admin-profile-for-that-account> --region eu-west-2 \
     --stack-name software-factory-iam --template-file templates/aws/factory-iam.yaml \
     --capabilities CAPABILITY_NAMED_IAM --parameter-overrides \
       GitHubOrg=<org> RepoPattern='*' Environment=staging CreateOIDCProvider=true \
       DeployPolicyArns=<arn of your least-privilege deploy policy> \
       FactoryPrincipalArn=<arn of the IAM user/role the factory host runs as>
   ```
2. In each product repo, go to Settings → Environments → `staging` / `production`, and set the variables `AWS_DEPLOY_ROLE_ARN` (stack output),
   `AWS_REGION`, and `HEALTH_URL`. Optionally, add *Required reviewers* on `production` for a second human gate inside GitHub.
3. Copy `templates/product-repo/.github/workflows/deploy.yml` into each deployable repo, and fill in the Deploy and Rollback steps.
   After `sf discover`, `memory/product/repos/<name>.md` documents how each repo deploys today.
4. On the factory host, add the read-only profiles to `~/.aws/config`:
   ```ini
   [profile factory-readonly-staging]
   role_arn = <FactoryReadOnlyRoleArn output, staging account>
   source_profile = <the host's base identity>
   region = eu-west-2

   [profile factory-readonly-production]
   role_arn = <FactoryReadOnlyRoleArn output, production account>
   source_profile = <the host's base identity>
   region = eu-west-2
   ```
5. Check it: `aws sts get-caller-identity --profile factory-readonly-staging`.

## Important

Stripping env vars only stops *accidental* use. An agent with a shell can still read `~/.aws/credentials`. Run the factory
on a dedicated host (EC2/container) whose only AWS identity is the one allowed to assume the read-only roles. Don't run it on
a laptop with admin profiles.
