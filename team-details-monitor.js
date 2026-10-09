//
// New Relic Scripted API Monitor
// Runtime: New (Node.js 18) — uses $http, $secure, assert
//
// Purpose:
//   Query NerdGraph (entityManagement) for every team visible to the
//   API key, then write the total count to NRDB as a custom metric named
//   "usage.teams" via the Metric API. The metric has no dimensions.
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

const METRIC_NAME = 'usage.teams';

const TEAM_SEARCH_QUERY = `
  query TeamSearch($cursor: String) {
    actor {
      entityManagement {
        entitySearch(query: "type = 'TEAM'", cursor: $cursor) {
          entities {
            ... on EntityManagementTeamEntity {
              id
              name
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

async function fetchAllTeams() {
  const teams = [];
  let cursor = null;
  let page = 1;

  do {
    console.log(`[DEBUG] fetching team page ${page} (cursor=${cursor})`);
    const data = await nerdGraphRequest(TEAM_SEARCH_QUERY, { cursor });
    const results = data.actor.entityManagement.entitySearch;

    console.log(`[DEBUG] page ${page} returned ${results.entities.length} entities`);

    teams.push(...results.entities);
    cursor = results.nextCursor;
    page += 1;
  } while (cursor);

  console.log(`[DEBUG] total teams fetched: ${teams.length}`);

  return teams;
}

async function postMetric(value, timestamp) {
  const { response, body } = await httpPostJson(
    METRIC_API_URL,
    { 'Api-Key': INSIGHTS_INSERT_KEY },
    // A point-in-time count of teams, so a gauge rather than a count metric.
    [{ metrics: [{ name: METRIC_NAME, type: 'gauge', value, timestamp }] }]
  );

  assert.ok(
    response.statusCode === 200 || response.statusCode === 202,
    `Metric API insert failed with status ${response.statusCode}: ${JSON.stringify(body)}`
  );
}

async function main() {
  console.log('[DEBUG] starting usage.teams sync');

  const teams = await fetchAllTeams();

  assert.ok(
    teams.length > 0,
    'expected at least one team entity from NerdGraph'
  );

  await postMetric(teams.length, Date.now());

  console.log(`Wrote ${METRIC_NAME} = ${teams.length}.`);
}

// Unhandled rejections surface as a failed check in the Synthetics runtime.
main().catch((err) => {
  throw err;
});
