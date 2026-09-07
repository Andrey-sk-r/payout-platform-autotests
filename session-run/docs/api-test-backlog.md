# API Test Backlog

Source analysis: `C:\Users\Andrey\Documents\Codex\2026-05-04\new-chat\olympus-payout-audit\notes\api-swagger-analysis.md`

## P0

- Auth login/refresh and old refresh token rejection.
- Settings `me` and organisation info.
- Employee create with fake phone, document upload, verification, allocate, activate, block.
- Batch create, add line, submit, request OTP, approve.
- Tenant isolation smoke for customer, batch, beneficiary, document, provider credential.

## P1

- Employee identity matrix: ID card, passport, asylum paper.
- Employee list filters: document number, phone, payroll ID, KYC status, card status.
- Card duplicate token and state transitions.
- Beneficiary destination rail matrix and approval/rejection.
- Batch return-for-edit and marked-line behavior.
- Provider credential CRUD with API key privacy checks.
- Org-user invite/update/disable/enable RBAC.

## P2

- CSV upload/import/export permutations.
- Payroll import preview/load.
- Audit-log assertions.
- File upload size boundaries.
- SAST scheduling edge cases.
- Historical batch comparison.
