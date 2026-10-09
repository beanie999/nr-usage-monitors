//
// New Relic Scripted API Monitor
// Runtime: New (Node.js 18) — uses $http, $secure, assert
//
// Purpose:
//   Query NerdGraph for every dashboard entity visible to the API key,
//   then count them and write the totals to NRDB as a custom metric
//   named "usage.dashboards" via the Metric API. Counts are grouped by
//   dashboardAccountId, dashboardAccountName and permissions, with one
//   metric data point per combination.
//
// Required secure credentials (Synthetics > Secure credentials):
//   NEW_RELIC_API_KEY     - a NerdGraph-capable User API key (read access to entities)
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

const METRIC_NAME = 'usage.dashboards';

const DASHBOARD_SEARCH_QUERY = `
  query DashboardSearch($cursor: String) {
    actor {
      entitySearch(queryBuilder: {type: DASHBOARD}) {
        results(cursor: $cursor) {
          entities {
            ... on DashboardEntityOutline {
              guid
              name
              permissions
              owner {
                email
                userId
              }
              createdAt
              updatedAt
              dashboardParentGuid
              account {
                id
                name
              }
            }
          }
          nextCursor
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

  assert.ok(
    !parsed.errors,
    `NerdGraph returned errors: ${JSON.stringify(parsed.errors)}`
  );

  return parsed.data;
}

async function fetchAllDashboards() {
  const dashboards = [];
  let cursor = null;
  let page = 1;

  do {
    console.log(`[DEBUG] fetching dashboard page ${page} (cursor=${cursor})`);
    const data = await nerdGraphRequest(DASHBOARD_SEARCH_QUERY, { cursor });
    const results = data.actor.entitySearch.results;

    console.log(`[DEBUG] page ${page} returned ${results.entities.length} entities`);

    dashboards.push(...results.entities);
    cursor = results.nextCursor;
    page += 1;
  } while (cursor);

  console.log(`[DEBUG] total dashboards fetched: ${dashboards.length}`);

  return dashboards;
}

function countDashboards(dashboards) {
  const groups = new Map();

  for (const dashboard of dashboards) {
    // "accountId" is a reserved attribute name in NRDB, so the dashboard's own
    // account is stored under dashboardAccountId / dashboardAccountName.
    const attributes = {
      dashboardAccountId: dashboard.account ? dashboard.account.id : null,
      dashboardAccountName: dashboard.account ? dashboard.account.name : null,
      permissions: dashboard.permissions != null ? dashboard.permissions : null,
    };
    const key = JSON.stringify(attributes);
    const group = groups.get(key);

    if (group) {
      group.value += 1;
    } else {
      groups.set(key, { attributes, value: 1 });
    }
  }

  return Array.from(groups.values());
}

function toMetrics(groups, timestamp) {
  return groups.map(({ attributes, value }) => ({
    name: METRIC_NAME,
    // A point-in-time count of dashboards, so a gauge rather than a count metric.
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
  console.log('[DEBUG] starting usage.dashboards sync');

  const dashboards = await fetchAllDashboards();

  assert.ok(
    dashboards.length > 0,
    'expected at least one dashboard entity from NerdGraph'
  );

  const groups = countDashboards(dashboards);
  const metrics = toMetrics(groups, Date.now());
  console.log(`[DEBUG] built ${metrics.length} ${METRIC_NAME} data points, sample: ${JSON.stringify(metrics[0])}`);

  await postMetrics(metrics);

  console.log(`Wrote ${metrics.length} ${METRIC_NAME} data points covering ${dashboards.length} dashboards.`);
}

// Unhandled rejections surface as a failed check in the Synthetics runtime.
main().catch((err) => {
  throw err;
});
