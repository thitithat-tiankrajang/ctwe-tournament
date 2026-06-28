# Event load tests

Run these only against a staging deployment containing three cards with 400 players each.
The public test is safe/read-only. The staff test writes match results.

## Public viewers

Flash opening by 5,000 viewers:

```bash
k6 run -e BASE_URL=https://staging.example.com -e VIEWERS=5000 -e MODE=burst \
  load-tests/k6/public-viewers.js
```

Sustained viewers with one refresh cycle per visible viewer every 50-70 seconds:

```bash
k6 run -e BASE_URL=https://staging.example.com -e VIEWERS=5000 -e MODE=sustained \
  -e HOLD=10m load-tests/k6/public-viewers.js
```

A local laptop usually cannot generate 5,000 realistic TLS clients. Use a sufficiently large
runner or distributed k6 for the certification run. Start at 100, 500, 1,000, 2,500, then 5,000.

## Concurrent staff writes

Prepare one card in `RESULT_COLLECTION`, with at least ten unconfirmed matches and ten distinct
staging accounts:

```bash
k6 run -e BASE_URL=https://staging.example.com \
  -e STAFF_USERS='staff01:secret1,staff02:secret2,staff03:secret3' \
  -e STAFF_COUNT=10 -e SAVES_PER_STAFF=10 -e CARD_ID=UUID \
  load-tests/k6/staff-results.js
```

Never pass production credentials in shell history or CI logs. Prefer an environment file with
restricted permissions on a dedicated staging runner.
