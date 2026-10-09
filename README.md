# nr-usage-monitors

New Relic scripted API monitors (Synthetics, Node.js 18 runtime) that collect
usage counts from NerdGraph and write them to NRDB as custom metrics via the
Metric API.

| Script | Metric | Dimensions |
| --- | --- | --- |
| `alert-details-monitor.js` | `usage.alerts` | `alertAccountId`, `alertAccountName`, `conditionType`, `enabled`, `baselineDirection`, `usesAnomalies`, `usesPredictions` |
| `dashboard-details-monitor.js` | `usage.dashboards` | `dashboardAccountId`, `dashboardAccountName`, `permissions` |
| `notebook-details-monitor.js` | `usage.notebooks` | none |
| `scorecard-details-monitor.js` | `usage.scorecards` | none |
| `team-details-monitor.js` | `usage.teams` | none |

Each metric is a gauge: the number of items found when the monitor ran.

## Setup

Create each script as a **Scripted API** monitor (new runtime, Node.js 18) and
add these secure credentials (Synthetics > Secure credentials):

- `NEW_RELIC_API_KEY` - a NerdGraph-capable User API key with read access
- `NR_INSERT_LICENSE_KEY` - a license key or Ingest API key for the account the metrics should be written into

If your account is EU-hosted, switch the NerdGraph and Metric API URLs to the
EU endpoints listed in the TODO comment at the top of each script.

## Checking the data

```
FROM Metric SELECT latest(usage.dashboards) FACET dashboardAccountName, permissions SINCE 1 hour ago
```
