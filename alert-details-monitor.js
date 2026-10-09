//
// New Relic Scripted API Monitor
// Runtime: New (Node.js 18) — uses $http, $secure, assert
//
// Purpose:
//   Discover every account visible to the API key, then for each account
//   page through its NRQL alert conditions via NerdGraph, then count them
//   and write the totals to NRDB as a custom metric named
//   "usage.alerts" via the Metric API. Counts are grouped by
//   alertAccountId, alertAccountName, conditionType, enabled,
//   baselineDirection, usesAnomalies and usesPredictions, with one metric
//   data point per combination.
//
//   Covers NRQL static, baseline, and outlier conditions. Flags whether a
//   condition is configured to use predictive alerting (static conditions
//   with a `predictBy` term) or anomaly/baseline alerting (baseline
//   conditions with a `baselineDirection`); outlier conditions have
//   neither, so both flags come back false for them.
//
// Required secure credentials (Synthetics > Secure credentials):
//   NEW_RELIC_API_KEY     - a NerdGraph-capable User API key (read access to entities/alerts)
//   NR_INSERT_LICENSE_KEY - a license key (or Ingest API key) for the account the
//                           metrics should be written into
//
// Docs:
//   https://docs.newrelic.com/docs/synthetics/synthetic-monitoring/scripting-monitors/write-scripted-api-tests/
//   https://docs.newrelic.com/docs/apis/nerdgraph/get-started/introduction-new-relic-nerdgraph/
//   https://docs.newrelic.com/docs/data-apis/ingest-apis/metric-api/introduction-metric-api/
//

const assert = require('assert');

// TODO: switch to EU endpoints if this account is EU-region hosted:
//   NerdGraph:   https://api.eu.newrelic.com/graphql
//   Metric API:  https://metric-api.eu.newrelic.com/metric/v1
const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';

const NERDGRAPH_API_KEY = $secure.NEW_RELIC_API_KEY;
const INSIGHTS_INSERT_KEY = $secure.NR_INSERT_LICENSE_KEY;

// The Metric API infers the target account from the key, so no account ID is needed.
const METRIC_API_URL = 'https://metric-api.newrelic.com/metric/v1';

const METRIC_NAME = 'usage.alerts';

const ACCOUNTS_QUERY = `
  query AccessibleAccounts {
    actor {
      accounts {
        id
        name
      }
    }
  }
`;

const ALERT_CONDITIONS_QUERY = `
  query AlertConditionsSearch($accountId: Int!, $cursor: String) {
    actor {
      account(id: $accountId) {
        alerts {
          asNrqlConditionsSearch(searchCriteria: {nameLike: "%"}, cursor: $cursor) {
            nrqlConditions {
              __typename
              ... on AlertsAsNrqlStaticCondition {
                enabled
                terms {
                  prediction {
                    predictBy
                  }
                }
              }
              ... on AlertsAsNrqlBaselineCondition {
                enabled
                baselineDirection
              }
              ... on AlertsAsNrqlOutlierCondition {
                enabled
              }
            }
            nextCursor
          }
        }
      }
    }
  }
`;

function httpPostJson(url, headers, body) {
  console.log(`[DEBUG] POST ${url}`);

  return new Promise((resolve, reject) => {
    $http.post(
      {
        url,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body),
      },
      (err, response, respBody) => {
        if (err) {
          console.log(`[DEBUG] POST ${url} errored: ${err}`);
          return reject(err);
        }
        console.log(`[DEBUG] POST ${url} -> ${response.statusCode}`);
        resolve({ response, body: respBody });
      }
    );
  });
}

async function nerdGraphRequest(query, variables) {
  const { response, body } = await httpPostJson(
    NERDGRAPH_URL,
    { 'API-Key': NERDGRAPH_API_KEY },
    { query, variables }
  );

  assert.equal(
    response.statusCode,
    200,
    `NerdGraph request failed with status ${response.statusCode}: ${JSON.stringify(body)}`
  );

  // $http auto-parses JSON bodies when the response is application/json,
  // so `body` may already be an object rather than a raw string.
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;

  // NerdGraph can return HTTP 200 with a partial result: some fields come
  // back null and a matching entry shows up in `errors` (e.g. FORBIDDEN on
  // a specific sub-account type). Callers decide how strict to be about
  // that — this just surfaces both halves rather than throwing.
  return { data: parsed.data, errors: parsed.errors || [] };
}

async function fetchAccessibleAccounts() {
  const { data, errors } = await nerdGraphRequest(ACCOUNTS_QUERY, {});

  assert.ok(
    errors.length === 0,
    `NerdGraph returned errors: ${JSON.stringify(errors)}`
  );

  const accounts = data.actor.accounts;

  console.log(`[DEBUG] discovered ${accounts.length} accessible accounts`);

  return accounts;
}

async function fetchAlertConditionsForAccount(account) {
  const conditions = [];
  let cursor = null;
  let page = 1;

  do {
    console.log(
      `[DEBUG] fetching alert conditions for account ${account.id} (${account.name}), page ${page} (cursor=${cursor})`
    );

    const { data, errors } = await nerdGraphRequest(ALERT_CONDITIONS_QUERY, {
      accountId: account.id,
      cursor,
    });

    if (errors.length > 0) {
      console.log(
        `[DEBUG] account ${account.id} (${account.name}) returned errors, skipping: ${JSON.stringify(errors)}`
      );
      return conditions;
    }

    const accountData = data.actor.account;
    if (!accountData) {
      console.log(`[DEBUG] no alerts access for account ${account.id}, skipping`);
      return conditions;
    }

    const results = accountData.alerts.asNrqlConditionsSearch;
    if (!results) {
      console.log(`[DEBUG] no NRQL conditions search result for account ${account.id}, skipping`);
      return conditions;
    }

    console.log(`[DEBUG] page ${page} returned ${results.nrqlConditions.length} conditions`);

    conditions.push(...results.nrqlConditions);
    cursor = results.nextCursor;
    page += 1;
  } while (cursor);

  return conditions;
}

function countConditions(account, conditions, groups) {
  for (const condition of conditions) {
    const hasPrediction = (condition.terms || []).some(
      (term) => term.prediction && term.prediction.predictBy != null
    );
    const baselineDirection = condition.baselineDirection != null ? condition.baselineDirection : null;

    // "accountId" is a reserved attribute name in NRDB, so the condition's own
    // account is stored under alertAccountId / alertAccountName.
    const attributes = {
      alertAccountId: account.id,
      alertAccountName: account.name,
      baselineDirection,
      conditionType: condition.__typename,
      enabled: condition.enabled,
      usesAnomalies: baselineDirection != null,
      usesPredictions: hasPrediction,
    };
    const key = JSON.stringify(attributes);
    const group = groups.get(key);

    if (group) {
      group.value += 1;
    } else {
      groups.set(key, { attributes, value: 1 });
    }
  }
}

function toMetrics(groups, timestamp) {
  return Array.from(groups.values()).map(({ attributes, value }) => ({
    name: METRIC_NAME,
    // A point-in-time count of conditions, so a gauge rather than a count metric.
    type: 'gauge',
    value,
    timestamp,
    // Metric API rejects null attribute values, so drop them.
    attributes: Object.fromEntries(
      Object.entries(attributes).filter(([, v]) => v != null)
    ),
  }));
}

async function postMetrics(metrics) {
  const { response, body } = await httpPostJson(
    METRIC_API_URL,
    { 'Api-Key': INSIGHTS_INSERT_KEY },
    [{ metrics }]
  );

  assert.ok(
    response.statusCode === 200 || response.statusCode === 202,
    `Metric API insert failed with status ${response.statusCode}: ${JSON.stringify(body)}`
  );
}

async function main() {
  console.log('[DEBUG] starting usage.alerts sync');

  const accounts = await fetchAccessibleAccounts();

  assert.ok(accounts.length > 0, 'expected at least one accessible account from NerdGraph');

  const groups = new Map();
  let totalConditions = 0;

  for (const account of accounts) {
    const conditions = await fetchAlertConditionsForAccount(account);
    console.log(`[DEBUG] account ${account.id} (${account.name}) has ${conditions.length} conditions`);

    countConditions(account, conditions, groups);
    totalConditions += conditions.length;
  }

  const metrics = toMetrics(groups, Date.now());
  console.log(`[DEBUG] built ${metrics.length} ${METRIC_NAME} data points covering ${totalConditions} conditions across ${accounts.length} accounts`);

  if (metrics.length > 0) {
    await postMetrics(metrics);
  }

  console.log(`Wrote ${metrics.length} ${METRIC_NAME} data points covering ${totalConditions} conditions.`);
}

// Unhandled rejections surface as a failed check in the Synthetics runtime.
main().catch((err) => {
  throw err;
});
