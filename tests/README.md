# Component Auth Test Harness

This folder contains lightweight assets to validate a deployed Component Auth environment without additional tooling.

## Contents

- `manual-test-harness.html` – Standalone HTML page with configurable fields and buttons to exercise `POST /v1/sessions` and `POST /oauth2/token`.
- `new-client.json` – Sample OAuth client payload for seeding a test environment.
- `load-client.ts` – Script to put the sample client (and optionally a random secret) in the table.

## Usage

1. **Seed an OAuth client**

   ```bash
   cd service
   npm install
   TABLE_NAME=identity-service DYNAMODB_ENDPOINT=http://localhost:8000 npx tsx ../tests/load-client.ts \
     --clientFile="../tests/new-client.json" \
     --clientName="Manual Harness Client" \
     --clientScopes="telemetry:read,telemetry:write" \
     --outputSecret=true
   ```

   Arguments are optional; the table comes from `TABLE_NAME` (and `DYNAMODB_ENDPOINT` on a laptop — ADR-0023), the client from `tests/new-client.json`, under a `manual-harness` application it makes if absent. When `--clientName` is provided, the script creates a confidential client with a random secret; use `--outputSecret=true` to print the plain secret for manual testing. (One deployment is one realm — there is no tenant to seed; see [ADR-0018](../docs/design/decisions/0018-collapse-tenant-into-deployment.md).)

2. **Manual Testing via Browser**

   - Open `manual-test-harness.html` in a browser (no server needed).
   - Fill in the base URL, optional visitor ID, and client credentials (copy from the script output). Entries are stored in `localStorage` for convenience.
   - Use the buttons to create sessions and request OAuth tokens. Responses render beneath each form.

3. **Cleanup**

   Remove test clients from the table when finished (`DELETE /admin/v1/clients/{id}`) to avoid cluttering a realm.

## Notes

- The harness assumes the API is reachable from your browser. For environments behind VPNs or internal load balancers, use an appropriate network path.
- The client loader imports the service's store directly; run it with Node 22 from `service/` (its dependencies).
