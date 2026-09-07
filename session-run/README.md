# Olympus Payout Platform Tests

Automated API and UI tests for the Olympus Payout Platform.

## Stack

- Node.js
- Playwright Test
- dotenv

## Environments

The project uses separate environment files:

- `.env.dev`
- `.env.test`
- `.env.stage`

Fill the required credentials and OTP values in the file for the environment you want to run.

## Commands

Run all dev tests:

```powershell
npm run test:dev
```

Run all stage tests:

```powershell
npm run test:stage
```

Run all test-environment tests:

```powershell
npm run test:test
```

Run API tests only:

```powershell
npm run test:api:dev
npm run test:api:test
npm run test:api:stage
```

Show HTML report:

```powershell
npm run report
```

## Current Coverage

Initial smoke coverage includes:

- Auth refresh-token rotation.
- Settings current-user endpoint.
- Organisation info endpoint with provider API key privacy assertion.
- Employee Cards API coverage for create validation, fake phone generation, BVA checks, search/filter/pagination, edit validation, detail/audit availability, document/KYC negative checks, uniqueness behavior, notification settings shape, and conditional card lifecycle scenarios.

Next suites should cover employee customers/cards, batches, beneficiaries, organisation users, provider credentials, payroll import, RBAC, and tenant isolation.

## Employee Cards Prepared Data

Some lifecycle tests are skipped until prepared employees are provided in `.env.dev` or `.env.stage`:

- `EMPLOYEE_VERIFIED_NO_CARD_UUID`
- `EMPLOYEE_ALLOCATED_CARD_CUSTOMER_UUID`
- `EMPLOYEE_ACTIVE_CARD_CUSTOMER_UUID`

Destructive card tests are disabled by default. Enable them only for disposable data:

```powershell
ALLOW_MUTATING_CARD_TESTS=true
```
