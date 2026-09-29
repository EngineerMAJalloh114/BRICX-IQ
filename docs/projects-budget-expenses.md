# Projects, budgets and expenses

Builds on [foundations](foundations.md). Database: `apps/api/migrations/0003_projects_budget_expenses.sql`.
Shared logic for the app and API: `packages/shared/src/{projects,expenses,budget}.ts`.
Screens: `apps/mobile/src/screens/{ProjectsScreen,ProjectScreen}.tsx`.

## Records and offline sync

- Ids are UUIDs generated on the device, so a project, budget line or expense can be
  created offline and keep its id after it syncs.
- Devices receive everything in the organisations they belong to
  (`infra/powersync/sync-rules.yaml`), plus exchange rates so expenses in any currency
  can be converted offline. Organisations, memberships and rates are read-only on devices.
- Changes upload through `POST /sync/upload`. Before applying each one the API checks the
  user's role in the row's organisation (`apps/api/src/upload.ts`); the database then
  enforces the workflow rules again. A change either rule refuses returns 422 and the
  device drops it and takes the server's copy.
- Budget lines and expenses take their organisation from their project; clients never
  send it. `created_by`, the approval stamps and timestamps are set by the server.
- Rows are never hard-deleted. Setting `deleted_at` hides them and syncs the deletion.
- A retried upload that repeats values the server already has changes nothing and adds
  no audit entries.

## Projects and budgets

- A project has one **currency** (`projects.currency`). Budget lines are in it, and every expense is
  converted into it. It cannot change once the project has budget lines or expenses. The project's
  budget is the sum of its lines.
- Project codes are unique per organisation, ignoring case.
- A budget line with expenses booked to it cannot be deleted.

## Expenses

- Entered in whatever currency was paid. The exchange rate to the project currency is
  **locked when the expense is entered**, using the rate in force on the day it was
  paid (the organisation's own rate wins over a global one on the same date). The rate,
  its date, its source (`same_currency`, `organisation`, `global`, `manual`) and the
  converted amount are stored. Reports never shift when rates change later.
- A rate typed in by hand needs a reason.
- The database checks the stored base amount matches the amount at the stored rate.
- Workflow: `draft → submitted → approved | rejected`; a submitter can withdraw back to
  draft, and a rejected expense can be reopened. Only drafts can be edited or deleted.
  Approved expenses are final.
- **Nobody approves or rejects their own expense**, whatever their role.
- Rejecting needs a reason.

| Action                               | Who                                                              |
| ------------------------------------ | ---------------------------------------------------------------- |
| Create, edit, delete, submit a draft | Its creator with `expenses.create`; approvers can edit any draft |
| Withdraw                             | The submitter                                                    |
| Approve, reject                      | `expenses.approve`, not the submitter                            |
| Reopen a rejected expense            | Its creator, or an approver                                      |

Projects need `projects.create`, `projects.edit` or `projects.delete`, and budget lines
need `budget.edit`, in the project's organisation.

## Budget against actual

`project_budget_summary` (SQL) and `summarizeBudget()` (TypeScript) report, in the project
currency, the budget, approved spend, spend awaiting approval, what remains, percent used,
and whether approved plus pending spend exceeds the budget. `summarizeBudget` also breaks it
down per budget line and shows spend not booked to a line.

## Audit

All three tables are audited by the foundation trigger, so every create, edit, status
change and deletion is in `audit_log` with the before and after row and the acting user.
