<?php
/**
 * The PHP half of tests/cashflow-parity.test.js - do not run on its own.
 *
 * Reads cases as JSON from stdin, runs includes/Cashflow.php on each and
 * writes the results as JSON to stdout. Needs no database.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('APP_ROOT', dirname(__DIR__));
require_once APP_ROOT . '/includes/Cashflow.php';

$in = json_decode((string) stream_get_contents(STDIN), true);
$out = [];

foreach ($in['cases'] as $case) {
    $input = $case['input'];
    $transactions = Cashflow::markVatPayments($input['transactions'], $input['settings']['vat_links'] ?? []);
    $scenario = Cashflow::scenario($case['preset'], $case['overrides'] ?? []);
    $plan = Cashflow::plan([
        'projects' => $input['projects'],
        'costs' => $input['costs'],
        'balances' => $input['balances'],
        'transactions' => $transactions,
        'debts' => $input['debts'],
        'settings' => $input['settings'],
        'scenario' => $scenario,
        'months' => $case['months'],
        'now' => $case['now'],
        'today' => $case['today'],
    ]);
    $twelve = Cashflow::plan([
        'projects' => $input['projects'], 'costs' => $input['costs'], 'balances' => $input['balances'],
        'transactions' => $transactions, 'debts' => $input['debts'], 'settings' => $input['settings'],
        'scenario' => $scenario, 'months' => 12, 'now' => $case['now'], 'today' => $case['today'],
    ]);
    $out[] = [
        'plan' => $plan,
        'year' => Cashflow::yearResult($transactions, $twelve, $case['now']),
        'debts' => Cashflow::debtSummary($input['debts'], $case['today']),
    ];
}

$decimals = [];
foreach ($in['decimals'] as $text) {
    $decimals[] = Cashflow::parseDecimal($text);
}

$columns = [];
foreach ($in['columns'] as $c) {
    $columns[] = Cashflow::detectAmountColumn($c['columns'], $c['rows'], $c['date_column']);
}

echo json_encode(['cases' => $out, 'decimals' => $decimals, 'columns' => $columns]);
