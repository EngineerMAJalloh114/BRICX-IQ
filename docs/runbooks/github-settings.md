# GitHub repository settings (owner applies; P1-06, ADR 0031)

Claude never changes repository settings. The owner applies these by hand or with the `gh` commands below (run them as the repo admin; `R=EngineerMAJalloh114/BRICX-IQ`).

## Who authors PRs here, and why review rules need a bypass

PRs opened by Claude threads are created with the owner's GitHub account (EngineerMAJalloh114). GitHub never lets a PR's author approve it. If `main` required one approval or code-owner review with no bypass, every Claude PR would be blocked forever, because the owner is the only human reviewer.

So `main` gets **two rulesets**:

1. **`main: protect`** has **no bypass**: required CI checks, squash only, linear history, no force push, no deletion. Nobody, including the admin, merges red CI.
2. **`main: review`** requires one approval and code-owner review. The repository-admin role may bypass it **for pull requests only**. The owner merges their own (Claude-authored) PRs through that bypass, which GitHub logs. The bypass skips review only, never CI, because CI lives in ruleset 1. Dependabot PRs are authored by `dependabot[bot]`, so the owner's approval counts for them, and the rule applies in full.

When a second human reviewer joins, remove the bypass from `main: review`.

Note: this repository is public (checked 2026-10-01), so rulesets work on any plan. If it ever becomes private, rulesets need GitHub Pro, Team or Enterprise.

## 1. Merge settings (Settings → General → Pull Requests)

- Allow squash merging only; untick merge commits and rebase merging.
- Squash commit title: **Pull request title** (not "default"; for a one-commit PR the default uses the commit message, which pr-title never checked). Message: pull request title and description.
- Automatically delete head branches: on.

```bash
gh api -X PATCH repos/$R \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true
```

## 2. Actions settings (Settings → Actions → General)

- Workflow permissions: **Read repository contents and packages permissions**; untick "Allow GitHub Actions to create and approve pull requests".
- Actions permissions: **Allow select actions**: `actions/checkout@*`, `actions/setup-node@*`, `pnpm/action-setup@*` (local actions are always allowed). Tick **Require actions to be pinned to a full-length commit SHA**.
- Fork pull request workflows: require approval for all external contributors.

```bash
gh api -X PUT repos/$R/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
gh api -X PUT repos/$R/actions/permissions \
  -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
gh api -X PUT repos/$R/actions/permissions/selected-actions --input - <<'JSON'
{ "github_owned_allowed": false, "verified_allowed": false,
  "patterns_allowed": ["actions/checkout@*", "actions/setup-node@*", "pnpm/action-setup@*"] }
JSON
gh api -X PUT repos/$R/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors
```

## 3. Rulesets (Settings → Rules → Rulesets)

Required check names are the CI job names: `install`, `verify`, `security`, `pr-title` (GitHub Actions app id 15368). Apply after the P1-06 PR has run CI once.

```bash
gh api -X POST repos/$R/rulesets --input - <<'JSON'
{
  "name": "main: protect",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "install", "integration_id": 15368 },
          { "context": "verify", "integration_id": 15368 },
          { "context": "security", "integration_id": 15368 },
          { "context": "pr-title", "integration_id": 15368 } ] } }
  ]
}
JSON

gh api -X POST repos/$R/rulesets --input - <<'JSON'
{
  "name": "main: review",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"] } }
  ]
}
JSON
```

(`actor_id` 5 is the built-in Repository admin role.)

## 4. Check it worked

```bash
gh api repos/$R/rulesets --jq '.[] | [.name, .enforcement] | @tsv'
gh api repos/$R/rules/branches/main --jq '.[].type' | sort | uniq -c
gh api repos/$R/actions/permissions
```

Expected: both rulesets `active`; rules include deletion, non_fast_forward, required_linear_history, pull_request (twice), required_status_checks; `allowed_actions: selected`, `sha_pinning_required: true`.

## After P2-02: require the `integration` check

P2-02 (ADR 0035) adds the CI `integration` job. Once it has run once on GitHub (so the check context exists), add it to the required checks of ruleset "main: protect". `PUT` replaces the ruleset's rules, so this reads the current rules, appends `integration`, and writes them back:

```bash
R=EngineerMAJalloh114/BRICX-IQ
ID=$(gh api repos/$R/rulesets --jq '.[] | select(.name == "main: protect") | .id')
gh api repos/$R/rulesets/$ID --jq '{rules: [.rules[] | if .type == "required_status_checks" then .parameters.required_status_checks += [{"context": "integration", "integration_id": 15368}] else . end]}' > rules.json
gh api -X PUT repos/$R/rulesets/$ID --input rules.json
gh api repos/$R/rulesets/$ID --jq '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'
```

The last command should list `install`, `verify`, `security`, `pr-title` and `integration`.
