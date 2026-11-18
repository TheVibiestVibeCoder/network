# Claude connector: payments, bank entries, Financials, cashflow forecast

November 2026, branch `mcp-payments-cashflow` (from `squircle`). The decisions and the connector
side are written up in the crm-mcp repo, `docs/payments-and-cashflow.md`. This page is about what
changed here.

## New MCP actions (includes/McpService.php)

| Action | Reads / writes | What |
|---|---|---|
| `payments.list` | reads | Expected payments across projects: month range, open / paid / all, overdue only, one project; totals per month |
| `projects.archived` | reads | `ProjectArchive::list`, optionally filtered by name or company |
| `bookkeeping.rows` | reads, `MCP_API_FINANCIALS` | Bank entries as Financials reads them (`Cashflow::bankRows`), VAT quarter payments marked, filters and sums |
| `financials.get` | reads, `MCP_API_FINANCIALS` | `Financials::overview` plus balance today, fixed costs per month, debt summary, VAT quarters |
| `financials.forecast` | reads, `MCP_API_FINANCIALS` | `Cashflow::plan` for a scenario and 1-36 months, the year's result, the three scenarios compared |
| `projects.set_payments` | proposes | The project's whole payments list, as one `update` proposal on the field `payments` |
| `projects.mark_payment_paid` | proposes | The same, with one payment (month, amount) flipped to paid |

Richer: `projects.get` (Claude summary, `payments_summary`, links on to-dos), `todos.list` (links),
`bookkeeping.pool` (what the invoice reader found), `meta.financials_available`.

`MCP_API_FINANCIALS=false` in `.env` takes away exactly the three marked actions (default: on).

## Payments on the review path

- The proposal is `kind: update`, `entity_type: project`, payload `{payments: [...]}`, previous
  `{payments: [...]}`. Only one such proposal per project can be open.
- `ReviewQueue::snapshot` includes `payments`, so the sheet marks "Changed since".
- `review.js` shows the lists readably, has no Edit for them, sends `payments` with the `PUT` when
  accepting, and refuses to accept when the project's payments differ from `previous`.

## includes/Cashflow.php - a port, keep it in step

The Financials arithmetic in PHP, function by function from `cashflow.js`, `revenue-forecast.js`,
`project-payments.js` and the bank-row helpers of `bookkeeping.js`. Change one of those, then run

```bash
node tests/cashflow-parity.test.js
```

and port the change until it says `all equal`. Rounding follows `Math.round` (`floor(x + 0.5)`),
sums run in the same order, so the cents agree.

## Tests

```bash
node tests/cashflow-parity.test.js   # PHP port vs browser code, 160 random data sets
php tests/mcp-money.test.php         # the new actions on a scratch database
```

Both need a `.env` in the web root, as every PHP test here does (a copy of `.env.example` with any
`APP_PASSWORD` hash is enough). Neither touches `data/crm.db`.
