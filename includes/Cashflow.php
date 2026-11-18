<?php
/**
 * Cashflow on the server: the Financials tab's arithmetic, for the Claude
 * connector (McpService: financials.forecast, financials.get, bookkeeping.rows).
 *
 * A port of the browser code, function by function and in the same order of
 * operations, so the connector and the tab come to the same numbers:
 *
 *   assets/js/revenue-forecast.js   prepare, budgetFor, isCounted, factorFor, presets
 *   assets/js/project-payments.js   parse, isFull
 *   assets/js/cashflow.js           plan and everything it uses (VAT, debts, the year)
 *   assets/js/bookkeeping.js        transactions(): bank rows as amounts, party, VAT
 *
 * Left out, because only the tab's screens use them: recurringSuggestions,
 * vatCandidates, vatSuggestion and the chart helpers.
 *
 * WHEN THE JS CHANGES, CHANGE THIS TOO. tests/cashflow-parity.test.js runs
 * both on the same data and fails on the first number that differs:
 *
 *     node tests/cashflow-parity.test.js
 *
 * Rounding follows JavaScript's Math.round (half up, also below zero), and
 * sums are taken in the same order, so even the cents agree.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/Financials.php';
require_once __DIR__ . '/InvoiceReader.php';

final class Cashflow
{
    // revenue-forecast.js -----------------------------------------------------

    public const STAGE_KEYS = ['Lead', 'Negotiation', 'Proposal', 'In Progress'];
    public const COMPLETE = 'Complete';

    public const PRESETS = [
        'worst' => ['chance' => 'as', 'budget' => 'low', 'stages' => ['In Progress']],
        'realistic' => ['chance' => 'as', 'budget' => 'mid', 'stages' => self::STAGE_KEYS],
        'best' => ['chance' => 'all', 'budget' => 'high', 'stages' => self::STAGE_KEYS],
    ];
    public const DEFAULT_PRESET = 'realistic';

    private const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // cashflow.js -------------------------------------------------------------

    public const DEFAULT_HORIZON = 12;
    public const PAST_MONTHS = 6;

    private const NAME_NOISE = ['gmbh', 'ltd', 'limited', 'inc', 'llc', 'ag', 'kg', 'og', 'eu', 'co', 'bv', 'sarl', 'se', 'srl',
        'und', 'and', 'the', 'der', 'die', 'das', 'von', 'for', 'für'];

    // =========================================================================
    // Small helpers
    // =========================================================================

    /** Math.round(n * 100) / 100 - half up, as JavaScript rounds, also below zero. */
    public static function round2(float $n): float
    {
        return floor($n * 100 + 0.5) / 100;
    }

    /** parseFloat semantics: a number, or null for nothing / not a number. */
    public static function number($v): ?float
    {
        if ($v === null || $v === '' || is_bool($v)) {
            return null;
        }
        if (is_int($v) || is_float($v)) {
            return is_finite((float) $v) ? (float) $v : null;
        }
        if (preg_match('/^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/', (string) $v, $m)) {
            $n = (float) $m[1];
            return is_finite($n) ? $n : null;
        }
        return null;
    }

    private static function sum(array $list, ?callable $fn = null): float
    {
        $s = 0.0;
        foreach ($list as $x) {
            $s += $fn ? $fn($x) : $x;
        }
        return $s;
    }

    /** Days since 1970 for "YYYY-MM-DD", or null. */
    private static function epochDay(?string $iso): ?int
    {
        if (!is_string($iso) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $iso, $m)) {
            return null;
        }
        return intdiv(gmmktime(0, 0, 0, (int) $m[2], (int) $m[3], (int) $m[1]), 86400);
    }

    private static function daysInMonth(int $year, int $month1to12): int
    {
        return (int) gmdate('t', gmmktime(0, 0, 0, $month1to12, 1, $year));
    }

    // =========================================================================
    // Months (revenue-forecast.js)
    // =========================================================================

    /** The current month as ['year' => Y, 'month' => 0-11], in the CRM's time zone. */
    public static function nowOf(DateTimeInterface $date): array
    {
        return ['year' => (int) $date->format('Y'), 'month' => (int) $date->format('n') - 1];
    }

    public static function offsetOf($value, array $now): ?int
    {
        if (!preg_match('/^(\d{4})-(\d{2})/', (string) ($value ?? ''), $m)) {
            return null;
        }
        $month = (int) $m[2] - 1;
        if ($month < 0 || $month > 11) {
            return null;
        }
        return ((int) $m[1] - $now['year']) * 12 + ($month - $now['month']);
    }

    public static function calendarMonth(int $offset, array $now): array
    {
        $t = $now['month'] + $offset;
        return ['year' => $now['year'] + (int) floor($t / 12), 'month' => (($t % 12) + 12) % 12];
    }

    public static function monthName(int $offset, array $now): string
    {
        $c = self::calendarMonth($offset, $now);
        return self::MONTHS_SHORT[$c['month']] . ' ' . $c['year'];
    }

    /** "YYYY-MM" of a month offset. */
    public static function monthKey(int $offset, array $now): string
    {
        $c = self::calendarMonth($offset, $now);
        return $c['year'] . '-' . str_pad((string) ($c['month'] + 1), 2, '0', STR_PAD_LEFT);
    }

    private static function dayOf($iso): ?int
    {
        return preg_match('/^\d{4}-\d{2}-(\d{2})/', (string) ($iso ?? ''), $m) ? (int) $m[1] : null;
    }

    public static function lastDayOf(int $offset, array $now): string
    {
        $c = self::calendarMonth($offset, $now);
        $last = self::daysInMonth($c['year'], $c['month'] + 1);
        return $c['year'] . '-' . str_pad((string) ($c['month'] + 1), 2, '0', STR_PAD_LEFT) . '-' . str_pad((string) $last, 2, '0', STR_PAD_LEFT);
    }

    // =========================================================================
    // Payments (project-payments.js)
    // =========================================================================

    public static function parsePayments($raw): array
    {
        $list = $raw;
        if (is_string($raw)) {
            $list = json_decode($raw, true);
        }
        if (!is_array($list) || array_values($list) !== $list) {
            return [];
        }
        $out = [];
        foreach ($list as $x) {
            $x = is_array($x) ? $x : [];
            $p = [
                'month' => (string) ($x['month'] ?? ''),
                'amount' => self::number($x['amount'] ?? null),
                'paid' => !empty($x['paid']),
                'full' => !empty($x['full']),
            ];
            if (preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $p['month']) && $p['amount'] !== null && $p['amount'] > 0) {
                $out[] = $p;
            }
        }
        return $out;
    }

    public static function isFull(array $list): bool
    {
        return count($list) === 1 && !empty($list[0]['full']);
    }

    // =========================================================================
    // Projects (revenue-forecast.js)
    // =========================================================================

    /** @return array{items: array, missing: array} */
    public static function prepare(array $projects, array $now): array
    {
        $items = [];
        $missing = [];

        foreach ($projects as $p) {
            $complete = ($p['stage'] ?? null) === self::COMPLETE;
            if (!in_array($p['stage'] ?? null, self::STAGE_KEYS, true) && !$complete) {
                continue;
            }
            if (($p['review_status'] ?? null) === 'pending') {
                continue;
            }

            $min = self::number($p['budget_min'] ?? null);
            $max = self::number($p['budget_max'] ?? null);
            if ($min === null) {
                $min = $max;
            }
            if ($max === null) {
                $max = $min;
            }
            if ($min !== null) {
                $min = max(0.0, $min);
                $max = max(0.0, $max);
            }
            if ($min !== null && $min > $max) {
                [$min, $max] = [$max, $min];
            }

            $chanceRaw = self::number($p['success_chance'] ?? null);
            $s = self::offsetOf($p['start_date'] ?? null, $now);
            $e = self::offsetOf($p['estimated_completion'] ?? null, $now);

            $payments = self::parsePayments($p['payments'] ?? null);
            $planned = self::sum($payments, fn($x) => $x['amount']);
            $full = self::isFull($payments);
            $due = [];
            foreach ($payments as $x) {
                if ($x['paid']) {
                    continue;
                }
                $o = self::offsetOf($x['month'], $now);
                $due[] = ['o' => $o, 'at' => max($o, 0), 'amount' => $x['amount'], 'full' => $x['full'], 'month' => $x['month']];
            }

            $base = [
                'id' => (int) $p['id'],
                'name' => ($p['name'] ?? '') !== '' ? $p['name'] : 'Untitled project',
                'company' => $p['company'] ?? '',
                'stage' => $p['stage'],
            ];

            if ($complete) {
                if (!$due) {
                    continue;
                }
                $items[] = $base + [
                    'chance' => 100.0,
                    'min' => $min ?? 0.0, 'max' => $max ?? 0.0, 's' => $s, 'e' => $e,
                    'undated' => false, 'complete' => true, 'full' => $full,
                    'payments' => count($payments), 'planned' => $planned, 'due' => $due,
                ];
                continue;
            }

            $gaps = [];
            if (($min === null || $max == 0) && !$payments) {
                $gaps[] = 'budget';
            }
            if ($chanceRaw === null) {
                $gaps[] = 'chance';
            }
            if ($s !== null && $e !== null && $e < $s) {
                $gaps[] = 'end before start';
            }
            if ($min === null) {
                $min = 0.0;
                $max = 0.0;
            }

            if ($gaps) {
                $missing[] = $base + ['gaps' => $gaps];
                continue;
            }

            $items[] = $base + [
                'chance' => max(0.0, min(100.0, $chanceRaw)),
                'min' => $min, 'max' => $max, 's' => $s, 'e' => $e,
                'undated' => $e === null && !$full,
                'complete' => false, 'full' => $full,
                'payments' => count($payments), 'planned' => $planned, 'due' => $due,
            ];
        }

        return ['items' => $items, 'missing' => $missing];
    }

    /**
     * A scenario: a preset name, or a preset adjusted - other stages, budget
     * end or chance, single projects switched off.
     */
    public static function scenario(?string $preset = null, array $overrides = []): array
    {
        $key = isset(self::PRESETS[$preset ?? '']) ? $preset : self::DEFAULT_PRESET;
        $s = self::PRESETS[$key] + ['excluded' => []];
        if (isset($overrides['chance'])) {
            $s['chance'] = $overrides['chance'] === 'all' ? 'all' : 'as';
        }
        if (isset($overrides['budget']) && in_array($overrides['budget'], ['low', 'mid', 'high'], true)) {
            $s['budget'] = $overrides['budget'];
        }
        if (isset($overrides['stages']) && is_array($overrides['stages'])) {
            $s['stages'] = array_values(array_filter(self::STAGE_KEYS, fn($k) => in_array($k, $overrides['stages'], true)));
        }
        foreach ((array) ($overrides['excluded'] ?? []) as $id) {
            $s['excluded'][(int) $id] = true;
        }
        $s['name'] = $overrides ? 'custom' : $key;
        return $s;
    }

    public static function budgetFor(array $p, string $budget): float
    {
        if ($p['full'] || $p['complete']) {
            return $p['planned'];
        }
        if ($budget === 'low') {
            return $p['min'];
        }
        if ($budget === 'high') {
            return $p['max'];
        }
        return ($p['min'] + $p['max']) / 2;
    }

    public static function isCounted(array $p, array $settings, bool $respectExcluded = true): bool
    {
        if ($respectExcluded && !empty($settings['excluded'][$p['id']])) {
            return false;
        }
        return $p['complete'] || in_array($p['stage'], $settings['stages'], true);
    }

    public static function factorFor(array $p, array $settings): float
    {
        return $p['complete'] || $settings['chance'] === 'all' ? 1.0 : $p['chance'] / 100;
    }

    // =========================================================================
    // Money in (cashflow.js)
    // =========================================================================

    public static function incomeItems(array $projects, array $scenario, array $now): array
    {
        $prepared = self::prepare($projects, $now);
        $out = [];

        foreach ($prepared['items'] as $p) {
            $counted = self::isCounted($p, $scenario, true);
            $factor = self::factorFor($p, $scenario);
            $base = ['project_id' => $p['id'], 'name' => $p['name'], 'company' => $p['company'], 'stage' => $p['stage'],
                     'chance' => $p['chance'], 'factor' => $factor, 'counted' => $counted];

            foreach ($p['due'] as $x) {
                $out[] = $base + ['kind' => 'payment', 'full' => $x['full'], 'month' => $x['month'], 'due' => $x['o'],
                                  'offset' => max($x['o'], 0), 'overdue' => $x['o'] < 0, 'net' => $x['amount']];
            }

            $rest = max(0.0, self::budgetFor($p, $scenario['budget']) - $p['planned']);
            if ($rest > 0.005) {
                $out[] = $base + [
                    'kind' => 'final',
                    'due' => $p['e'],
                    'offset' => $p['e'] === null ? null : max($p['e'], 0),
                    'overdue' => $p['e'] !== null && $p['e'] < 0,
                    'net' => $rest,
                    'partial' => $p['payments'] > 0,
                ];
            }
        }

        foreach ($out as &$x) {
            $x['expected'] = $x['net'] * $x['factor'];
        }
        unset($x);

        usort($out, function ($a, $b) {
            $nullA = $a['offset'] === null ? 1 : 0;
            $nullB = $b['offset'] === null ? 1 : 0;
            return ($nullA - $nullB)
                ?: ((int) $a['offset'] - (int) $b['offset'])
                ?: ((int) $a['due'] - (int) $b['due'])
                ?: self::compareNames((string) $a['name'], (string) $b['name']);
        });

        return ['items' => $out, 'missing' => $prepared['missing']];
    }

    /**
     * String.prototype.localeCompare: ICU's order where PHP has intl; without
     * it case-insensitive, lowercase first on a tie, as ICU does. Only the
     * order of a month's items depends on it, never a sum.
     */
    private static function compareNames(string $a, string $b): int
    {
        static $collator = null;
        if ($collator === null) {
            $collator = class_exists('Collator') ? new Collator('en') : false;
        }
        if ($collator) {
            return (int) $collator->compare($a, $b);
        }
        return strcasecmp($a, $b) ?: strcmp($b, $a);
    }

    // =========================================================================
    // Money out
    // =========================================================================

    public static function costOccurrences(array $cost, int $months, array $now, ?int $todayDay): array
    {
        $start = self::offsetOf($cost['start_month'] ?? null, $now);
        $monthEnd = self::dayOf(self::lastDayOf(0, $now));
        if ($start === null) {
            return [];
        }
        $amount = self::number($cost['amount'] ?? null) ?: 0.0;

        if (($cost['kind'] ?? '') === 'once') {
            return $start >= 0 && $start < $months ? [['offset' => $start, 'amount' => $amount, 'paid' => false]] : [];
        }

        $interval = max(1, (int) (self::number($cost['interval_months'] ?? null) ?: 1));
        $end = !empty($cost['end_month']) ? (self::offsetOf($cost['end_month'], $now) ?? 0) : PHP_INT_MAX;
        $out = [];
        $i = $start >= 0 ? $start : $start + (int) ceil(-$start / $interval) * $interval;
        for (; $i < $months && $i <= $end; $i += $interval) {
            $day = min((int) (self::number($cost['day'] ?? null) ?: 1), $monthEnd);
            $out[] = ['offset' => $i, 'amount' => $amount, 'paid' => $i === 0 && $todayDay !== null && $day <= $todayDay];
        }
        return $out;
    }

    public static function monthlyFixed(array $costs, array $now): float
    {
        $recurring = array_filter($costs, fn($c) => ($c['kind'] ?? '') !== 'once');
        return self::sum($recurring, function ($c) use ($now) {
            $end = !empty($c['end_month']) ? (self::offsetOf($c['end_month'], $now) ?? 0) : PHP_INT_MAX;
            if ($end < 0) {
                return 0.0;
            }
            return (self::number($c['amount'] ?? null) ?: 0.0) / max(1, (int) (self::number($c['interval_months'] ?? null) ?: 1));
        });
    }

    // =========================================================================
    // The bank
    // =========================================================================

    public static function anchorOf(array $balances): ?array
    {
        $list = array_values(array_filter($balances, fn($b) => is_array($b) && preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($b['as_of'] ?? ''))));
        usort($list, fn($a, $b) => $a['as_of'] < $b['as_of'] ? 1 : ($a['as_of'] > $b['as_of'] ? -1 : ((int) ($b['id'] ?? 0) - (int) ($a['id'] ?? 0))));
        return $list[0] ?? null;
    }

    public static function balanceToday(array $balances, array $transactions): ?array
    {
        $anchor = self::anchorOf($balances);
        if (!$anchor) {
            return null;
        }
        $after = array_values(array_filter($transactions, fn($t) => empty($t['excluded']) && $t['date'] > $anchor['as_of']));
        $movement = self::sum($after, fn($t) => $t['amount']);
        $last = '';
        foreach ($after as $t) {
            if ($t['date'] > $last) {
                $last = $t['date'];
            }
        }
        $anchorAmount = self::number($anchor['amount']) ?: 0.0;
        return [
            'amount' => self::round2($anchorAmount + $movement),
            'anchor' => ['id' => $anchor['id'] ?? null, 'amount' => $anchorAmount, 'as_of' => $anchor['as_of']],
            'movement' => self::round2($movement),
            'rows' => count($after),
            'last_row' => $last !== '' ? $last : null,
        ];
    }

    public static function pastMonths(array $transactions, array $now, ?array $today): array
    {
        $rows = array_values(array_filter($transactions, fn($t) => empty($t['excluded'])));
        if (!$rows) {
            return [];
        }
        $out = [];
        for ($o = -self::PAST_MONTHS; $o < 0; $o++) {
            $prefix = self::monthKey($o, $now);
            $inMonth = array_values(array_filter($rows, fn($t) => substr($t['date'], 0, 7) === $prefix));
            $end = self::lastDayOf($o, $now);
            $out[] = [
                'offset' => $o,
                'month' => $prefix,
                'label' => self::monthName($o, $now),
                'income' => self::round2(self::sum(array_filter($inMonth, fn($t) => $t['amount'] > 0), fn($t) => $t['amount'])),
                'expenses' => self::round2(-self::sum(array_filter($inMonth, fn($t) => $t['amount'] < 0), fn($t) => $t['amount'])),
                'rows' => count($inMonth),
                'closing' => $today ? self::round2($today['amount'] - self::sum(array_filter($rows, fn($t) => $t['date'] > $end), fn($t) => $t['amount'])) : null,
            ];
        }
        foreach ($out as $i => $m) {
            if ($m['rows'] > 0) {
                return array_slice($out, $i);
            }
        }
        return [];
    }

    // =========================================================================
    // The year's result
    // =========================================================================

    public static function yearMonths(array $transactions, array $now, ?array $today): array
    {
        $rows = array_values(array_filter($transactions, fn($t) => empty($t['excluded'])));
        $net = fn($t) => $t['amount'] + (self::number($t['vat'] ?? null) ?: 0.0);
        $out = [];
        for ($m = 0; $m <= $now['month']; $m++) {
            $o = $m - $now['month'];
            $prefix = $now['year'] . '-' . str_pad((string) ($m + 1), 2, '0', STR_PAD_LEFT);
            $inMonth = array_values(array_filter($rows, fn($t) => substr($t['date'], 0, 7) === $prefix));
            $flows = array_filter($inMonth, fn($t) => empty($t['vat_quarter']));
            $income = self::sum(array_filter($flows, fn($t) => $t['amount'] > 0), $net);
            $costs = -self::sum(array_filter($flows, fn($t) => $t['amount'] < 0), $net);
            $end = self::lastDayOf($o, $now);
            $out[] = [
                'offset' => $o,
                'month' => $prefix,
                'label' => self::monthName($o, $now),
                'income' => self::round2($income),
                'costs' => self::round2($costs),
                'result' => self::round2($income - $costs),
                'open' => count(array_filter($inMonth, fn($t) => !empty($t['open']))),
                'rows' => count($inMonth),
                'closing' => $today && $o < 0 ? self::round2($today['amount'] - self::sum(array_filter($rows, fn($t) => $t['date'] > $end), fn($t) => $t['amount'])) : null,
            ];
        }
        return $out;
    }

    /** @param array $plan a plan() reaching at least to December */
    public static function yearResult(array $transactions, array $plan, array $now): array
    {
        $months = self::yearMonths($transactions, $now, $plan['balance']);
        $rest = array_values(array_filter($plan['rows'], fn($r) => self::calendarMonth($r['offset'], $now)['year'] === $now['year']));
        $income = self::round2(self::sum($months, fn($m) => $m['income']));
        $costs = self::round2(self::sum($months, fn($m) => $m['costs']));
        $actual = self::round2($income - $costs);
        $incomeRest = self::round2(self::sum($rest, fn($r) => $r['income']));
        $costsRest = self::round2(self::sum($rest, fn($r) => $r['fixed'] + $r['planned'] + ($r['debt_interest'] ?: 0)));
        $planned = self::round2($incomeRest - $costsRest);
        return [
            'year' => $now['year'],
            'months' => $months,
            'actual' => $actual,
            'planned' => $planned,
            'projected' => self::round2($actual + $planned),
            'income' => $income,
            'costs' => $costs,
            'income_rest' => $incomeRest,
            'costs_rest' => $costsRest,
            'revenue' => self::round2($income + $incomeRest),
            'costs_year' => self::round2($costs + $costsRest),
            'fixed_rest' => self::round2(self::sum($rest, fn($r) => $r['fixed'])),
            'planned_rest' => self::round2(self::sum($rest, fn($r) => $r['planned'])),
        ];
    }

    // =========================================================================
    // Debts
    // =========================================================================

    public static function daysBetween($from, $to): ?int
    {
        $a = self::epochDay(is_string($from) ? $from : null);
        $b = self::epochDay(is_string($to) ? $to : null);
        return $a === null || $b === null ? null : $b - $a;
    }

    public static function debtInterest(array $debt, string $today): array
    {
        $amount = max(0.0, self::number($debt['amount'] ?? null) ?: 0.0);
        $rate = max(0.0, self::number($debt['rate'] ?? null) ?: 0.0);
        $daily = $amount * $rate / 100 / 365;
        $start = $debt['start_date'] ?? null;
        $end = !empty($debt['end_date']) ? $debt['end_date'] : null;
        $sinceStart = self::daysBetween($start, $today);
        $term = $end ? self::daysBetween($start, $end) : null;
        $started = $sinceStart !== null && $sinceStart >= 0;
        $endToToday = $end !== null ? self::daysBetween($end, $today) : null;
        $repaid = $end !== null && $endToToday !== null && $endToToday >= 0;
        $days = $started ? $sinceStart : 0;
        if ($term !== null) {
            $days = min($days, max(0, $term));
        }
        return [
            'days' => $days,
            'daily' => self::round2($daily),
            'to_date' => self::round2($daily * $days),
            'total' => $term === null ? null : self::round2($daily * max(0, $term)),
            'started' => $started,
            'repaid' => $repaid,
            'days_left' => $end === null ? null : max(0, self::daysBetween($today, $end) ?: 0),
        ];
    }

    public static function debtSummary(array $debts, string $today): array
    {
        $list = array_map(fn($d) => $d + ['interest' => self::debtInterest($d, $today)], $debts);
        $open = array_values(array_filter($list, fn($d) => !$d['interest']['repaid']));
        $dated = array_values(array_filter($list, fn($d) => $d['interest']['total'] !== null));
        return [
            'list' => $list,
            'count' => count($list),
            'open_count' => count($open),
            'outstanding' => self::round2(self::sum($open, fn($d) => self::number($d['amount'] ?? null) ?: 0.0)),
            'interest_to_date' => self::round2(self::sum($open, fn($d) => $d['interest']['to_date'])),
            'interest_total' => self::round2(self::sum(array_filter($dated, fn($d) => !$d['interest']['repaid']), fn($d) => $d['interest']['total'])),
            'undated_count' => count(array_filter($open, fn($d) => $d['interest']['total'] === null)),
        ];
    }

    // =========================================================================
    // Names (for telling which bank row pays which cost)
    // =========================================================================

    public static function nameWords($name): array
    {
        $words = preg_split('/[^a-z0-9äöüß]+/u', mb_strtolower((string) ($name ?? ''), 'UTF-8')) ?: [];
        return array_values(array_filter($words, fn($w) => mb_strlen($w, 'UTF-8') >= 3
            && !in_array($w, self::NAME_NOISE, true) && !preg_match('/^\d+$/', $w)));
    }

    // =========================================================================
    // VAT
    // =========================================================================

    public static function quarterOf($iso): ?string
    {
        return preg_match('/^(\d{4})-(\d{2})/', (string) ($iso ?? ''), $m)
            ? $m[1] . '-Q' . (intdiv((int) $m[2] - 1, 3) + 1)
            : null;
    }

    private static function quarterParts($key): ?array
    {
        return preg_match('/^(\d{4})-Q([1-4])$/', (string) ($key ?? ''), $m) ? ['year' => (int) $m[1], 'q' => (int) $m[2]] : null;
    }

    public static function shiftQuarter(string $key, int $n): ?string
    {
        $p = self::quarterParts($key);
        if (!$p) {
            return null;
        }
        $i = $p['year'] * 4 + ($p['q'] - 1) + $n;
        return (int) floor($i / 4) . '-Q' . ((($i % 4) + 4) % 4 + 1);
    }

    public static function quarterLabel(string $key): string
    {
        $p = self::quarterParts($key);
        return $p ? 'Q' . $p['q'] . ' ' . $p['year'] : '';
    }

    public static function quarterEnd(string $key): ?string
    {
        $p = self::quarterParts($key);
        if (!$p) {
            return null;
        }
        $month = $p['q'] * 3;
        return $p['year'] . '-' . str_pad((string) $month, 2, '0', STR_PAD_LEFT) . '-' . self::daysInMonth($p['year'], $month);
    }

    /** The 15th of the second month after the quarter. */
    public static function vatDue(string $key): ?string
    {
        $p = self::quarterParts($key);
        if (!$p) {
            return null;
        }
        $i = $p['year'] * 12 + ($p['q'] * 3 - 1) + 2;
        return intdiv($i, 12) . '-' . str_pad((string) (($i % 12) + 1), 2, '0', STR_PAD_LEFT) . '-15';
    }

    public static function vatLinks($raw): array
    {
        $out = [];
        if (is_object($raw)) {
            $raw = json_decode(json_encode($raw), true);
        }
        if (!is_array($raw)) {
            return $out;
        }
        foreach ($raw as $key => $v) {
            if (!self::quarterParts((string) $key)) {
                continue;
            }
            $v = is_array($v) ? $v : [];
            $rows = array_values(array_filter(array_map(fn($n) => is_numeric($n) ? (float) $n : null, is_array($v['rows'] ?? null) ? $v['rows'] : []),
                fn($n) => $n !== null && floor($n) === $n && $n > 0));
            $out[(string) $key] = ['rows' => array_map('intval', $rows), 'settled' => !empty($v['settled'])];
        }
        return $out;
    }

    /** Marks the rows that pay (or bring back) a quarter's VAT with that quarter. */
    public static function markVatPayments(array $transactions, $rawLinks): array
    {
        $byRow = [];
        foreach (self::vatLinks($rawLinks) as $key => $link) {
            foreach ($link['rows'] as $id) {
                $byRow[$id] = $key;
            }
        }
        return array_map(function ($t) use ($byRow) {
            $key = isset($t['id']) ? ($byRow[(int) $t['id']] ?? null) : null;
            return $key ? array_merge($t, ['vat_quarter' => $key, 'open' => false]) : $t;
        }, $transactions);
    }

    public static function vatFrom(array $settings, string $today): string
    {
        $stored = $settings['vat_from'] ?? null;
        $current = self::quarterOf($today);
        $from = self::quarterParts($stored) ? $stored : self::shiftQuarter($current, -1);
        return $from > $current ? $current : $from;
    }

    public static function vatQuarters(array $transactions, array $settings, string $today): array
    {
        $links = self::vatLinks($settings['vat_links'] ?? null);
        $current = self::quarterOf($today);
        if (!$current) {
            return [];
        }
        $rows = array_values(array_filter($transactions, fn($t) => is_array($t) && empty($t['excluded']) && !empty($t['date'])));
        $out = [];
        for ($key = self::vatFrom($settings, $today); $key <= $current; $key = self::shiftQuarter($key, 1)) {
            $inQ = array_values(array_filter($rows, fn($t) => empty($t['vat_quarter']) && self::quarterOf($t['date']) === $key));
            $collected = -self::sum(array_filter($inQ, fn($t) => self::number($t['vat'] ?? null) !== null && self::number($t['vat']) < 0), fn($t) => self::number($t['vat']));
            $deductible = self::sum(array_filter($inQ, fn($t) => self::number($t['vat'] ?? null) !== null && self::number($t['vat']) > 0), fn($t) => self::number($t['vat']));
            $owed = self::round2($collected - $deductible);
            $payments = array_values(array_filter($rows, fn($t) => ($t['vat_quarter'] ?? null) === $key));
            $manual = !empty($links[$key]['settled']);
            $nil = abs($owed) < 0.005;
            $settled = count($payments) > 0 || $manual;
            $due = self::vatDue($key);
            $out[] = [
                'key' => $key,
                'label' => self::quarterLabel($key),
                'end' => self::quarterEnd($key),
                'due' => $due,
                'collected' => self::round2($collected),
                'deductible' => self::round2($deductible),
                'owed' => $owed,
                'open' => count(array_filter($inQ, fn($t) => !empty($t['open']))),
                'running' => $key === $current,
                'settled' => $settled,
                'manual' => $manual,
                'nil' => $nil,
                'paid' => self::round2(-self::sum($payments, fn($t) => $t['amount'])),
                'payment_rows' => array_map(fn($t) => (int) $t['id'], $payments),
                'overdue' => !$settled && !$nil && $due < $today,
            ];
        }
        return $out;
    }

    // =========================================================================
    // The plan
    // =========================================================================

    /** Which of this month's cost items Bookkeeping already has (indices into $items). */
    private static function bookedCosts(array $items, array $rows): array
    {
        $used = [];
        $paid = [];
        $net = fn($t) => -($t['amount'] + (self::number($t['vat'] ?? null) ?: 0.0));
        $take = function (int $index, callable $test) use (&$used, &$paid, $rows) {
            foreach ($rows as $j => $t) {
                if (!isset($used[$j]) && $test($t)) {
                    $used[$j] = true;
                    $paid[$index] = true;
                    return;
                }
            }
        };
        foreach ($items as $index => $item) {
            $words = self::nameWords($item['cost']['name'] ?? '');
            $take($index, function ($t) use ($words) {
                $party = self::nameWords($t['party'] ?? '');
                foreach ($words as $w) {
                    if (in_array($w, $party, true)) {
                        return true;
                    }
                }
                return false;
            });
        }
        foreach ($items as $index => $item) {
            if (isset($paid[$index])) {
                continue;
            }
            $take($index, fn($t) => abs($net($t) - $item['amount']) <= max(1, $item['amount'] * 0.1));
        }
        return $paid;
    }

    /**
     * Everything the Financials tab shows, for one scenario.
     *   input: projects, costs, balances, transactions (VAT rows marked), debts,
     *          settings, scenario, months (1-36), now, today
     */
    public static function plan(array $input): array
    {
        $now = $input['now'];
        $today = $input['today'];
        $todayDay = self::dayOf($today);
        $months = is_int($input['months'] ?? null) && $input['months'] >= 1 && $input['months'] <= 36 ? $input['months'] : self::DEFAULT_HORIZON;
        $buffer = max(0.0, self::number($input['settings']['buffer'] ?? null) ?: 0.0);
        $transactions = $input['transactions'] ?? [];

        $income = self::incomeItems($input['projects'] ?? [], $input['scenario'], $now);

        $rows = [];
        for ($i = 0; $i < $months; $i++) {
            $rows[] = [
                'offset' => $i, 'month' => self::monthKey($i, $now), 'label' => self::monthName($i, $now),
                'income' => 0.0, 'fixed' => 0.0, 'planned' => 0.0, 'debt' => 0.0, 'debt_interest' => 0.0, 'vat' => 0.0,
                'items' => ['income' => [], 'costs' => [], 'debts' => [], 'vat' => []],
            ];
        }

        foreach ($income['items'] as $x) {
            if (!$x['counted'] || $x['offset'] === null || $x['offset'] >= $months) {
                continue;
            }
            $rows[$x['offset']]['income'] += $x['expected'];
            $rows[$x['offset']]['items']['income'][] = $x;
        }

        $costs = array_map(fn($c) => $c + ['occurrences' => self::costOccurrences($c, $months, $now, $todayDay)], $input['costs'] ?? []);
        $monthPrefix = self::monthKey(0, $now);
        $bookedOut = array_values(array_filter($transactions, fn($t) => empty($t['excluded']) && empty($t['vat_quarter'])
            && $t['amount'] < 0 && substr((string) $t['date'], 0, 7) === $monthPrefix));

        $items = [];
        foreach ($costs as $c) {
            foreach ($c['occurrences'] as $o) {
                $items[] = ['cost' => $c, 'amount' => $o['amount'], 'offset' => $o['offset'], 'due' => $o['paid'], 'paid' => false];
            }
        }
        $thisMonth = array_filter($items, fn($x) => $x['offset'] === 0);
        $booked = self::bookedCosts($thisMonth, $bookedOut);
        foreach ($items as $index => &$item) {
            if (isset($booked[$index])) {
                $item['paid'] = true;
            } elseif (($item['cost']['kind'] ?? '') === 'once') {
                $rows[$item['offset']]['planned'] += $item['amount'];
            } else {
                $rows[$item['offset']]['fixed'] += $item['amount'];
            }
            $rows[$item['offset']]['items']['costs'][] = [
                'cost_id' => $item['cost']['id'] ?? null, 'name' => $item['cost']['name'] ?? '',
                'category' => $item['cost']['category'] ?? null, 'kind' => $item['cost']['kind'] ?? null,
                'amount' => $item['amount'], 'due' => $item['due'], 'paid' => $item['paid'],
            ];
        }
        unset($item);

        foreach ($input['debts'] ?? [] as $d) {
            if (empty($d['end_date']) || !((string) $d['end_date'] > (string) $today)) {
                continue;
            }
            $o = self::offsetOf($d['end_date'], $now);
            if ($o === null || $o < 0 || $o >= $months) {
                continue;
            }
            $interest = self::debtInterest($d, $d['end_date'])['total'] ?: 0.0;
            $principal = self::number($d['amount'] ?? null) ?: 0.0;
            $rows[$o]['debt'] += $principal + $interest;
            $rows[$o]['debt_interest'] += $interest;
            $rows[$o]['items']['debts'][] = ['debt_id' => $d['id'] ?? null, 'name' => $d['name'] ?? '', 'lender' => $d['lender'] ?? null,
                                              'principal' => $principal, 'interest' => $interest, 'amount' => self::round2($principal + $interest)];
        }

        $vat = self::vatQuarters($transactions, $input['settings'] ?? [], $today);
        foreach ($vat as $q) {
            if ($q['settled'] || $q['nil']) {
                continue;
            }
            $o = self::offsetOf($q['due'], $now);
            if ($o === null) {
                continue;
            }
            $offset = max($o, 0);
            if ($offset >= $months) {
                continue;
            }
            $rows[$offset]['vat'] += $q['owed'];
            $rows[$offset]['items']['vat'][] = $q + ['offset' => $offset];
        }
        $vatOpen = array_values(array_filter($vat, fn($q) => !$q['settled'] && !$q['nil']));
        $vatNext = $vatOpen[0] ?? null;

        $balance = self::balanceToday($input['balances'] ?? [], $transactions);
        $running = $balance ? $balance['amount'] : 0.0;
        foreach ($rows as &$r) {
            $r['opening'] = self::round2($running);
            $r['out'] = $r['fixed'] + $r['planned'] + $r['debt'] + max($r['vat'], 0);
            $r['in'] = $r['income'] + max(-$r['vat'], 0);
            $r['net'] = $r['in'] - $r['out'];
            $running += $r['net'];
            $r['closing'] = self::round2($running);
            foreach (['income', 'fixed', 'planned', 'debt', 'debt_interest', 'vat', 'out', 'in', 'net'] as $k) {
                $r[$k] = self::round2($r[$k]);
            }
        }
        unset($r);

        $counted = array_values(array_filter($income['items'], fn($x) => $x['counted']));
        $lowest = null;
        foreach ($rows as $r) {
            if ($lowest === null || $r['closing'] < $lowest['closing']) {
                $lowest = $r;
            }
        }
        $below = function (float $level) use ($rows) {
            foreach ($rows as $r) {
                if ($r['closing'] < $level) {
                    return ['offset' => $r['offset'], 'month' => $r['month'], 'label' => $r['label'], 'closing' => $r['closing']];
                }
            }
            return null;
        };
        $overdue = array_filter($counted, fn($x) => $x['overdue']);
        $undated = array_filter($counted, fn($x) => $x['offset'] === null);
        $later = array_filter($counted, fn($x) => $x['offset'] !== null && $x['offset'] >= $months);

        return [
            'months' => $months,
            'buffer' => $buffer,
            'has_balance' => $balance !== null,
            'balance' => $balance,
            'rows' => $rows,
            'past' => self::pastMonths($transactions, $now, $balance),
            'income' => $income['items'],
            'missing' => $income['missing'],
            'vat' => $vat,
            'kpis' => [
                'balance' => $balance ? $balance['amount'] : null,
                'vat_owed' => self::round2(self::sum($vatOpen, fn($q) => $q['owed'])),
                'vat_next' => $vatNext ? ['key' => $vatNext['key'], 'label' => $vatNext['label'], 'due' => $vatNext['due'],
                                          'owed' => $vatNext['owed'], 'overdue' => $vatNext['overdue'], 'running' => $vatNext['running']] : null,
                'vat_total' => self::round2(self::sum($rows, fn($r) => $r['vat'])),
                'income_next3' => self::round2(self::sum(array_slice($rows, 0, 3), fn($r) => $r['income'])),
                'income_total' => self::round2(self::sum($rows, fn($r) => $r['income'])),
                'out_total' => self::round2(self::sum($rows, fn($r) => $r['out'])),
                'fixed_per_month' => self::round2(self::monthlyFixed($input['costs'] ?? [], $now)),
                'fixed_total' => self::round2(self::sum($rows, fn($r) => $r['fixed'])),
                'planned_total' => self::round2(self::sum($rows, fn($r) => $r['planned'])),
                'debt_total' => self::round2(self::sum($rows, fn($r) => $r['debt'])),
                'lowest' => $lowest ? ['offset' => $lowest['offset'], 'month' => $lowest['month'], 'label' => $lowest['label'], 'amount' => $lowest['closing']] : null,
                'end' => $rows ? $rows[count($rows) - 1]['closing'] : null,
                'below_buffer' => $buffer > 0 ? $below($buffer) : null,
                'below_zero' => $below(0.0),
                'overdue' => ['count' => count($overdue), 'amount' => self::round2(self::sum($overdue, fn($x) => $x['expected']))],
                'undated' => ['count' => count($undated), 'amount' => self::round2(self::sum($undated, fn($x) => $x['expected']))],
                'later' => ['count' => count($later), 'amount' => self::round2(self::sum($later, fn($x) => $x['expected']))],
            ],
        ];
    }

    // =========================================================================
    // Bank rows (bookkeeping.js transactions())
    // =========================================================================

    /** An amount as the bank exports write it ("-1.234,56", "(12.00)", "12,50 €"), or null. */
    public static function parseDecimal($value): ?float
    {
        $raw = preg_replace('/^\s+|\s+$/u', '', (string) ($value ?? '')) ?? '';
        if ($raw === '') {
            return null;
        }
        $raw = preg_replace('/[€$£]|\b(?:EUR|USD|CHF|GBP)\b/iu', '', $raw) ?? '';
        $raw = preg_replace('/^\s+|\s+$/u', '', $raw) ?? '';

        $negatedByParens = false;
        if (preg_match('/^\(.+\)$/u', $raw)) {
            $negatedByParens = true;
            $raw = preg_replace('/^\s+|\s+$/u', '', mb_substr($raw, 1, -1, 'UTF-8')) ?? '';
        }

        if (!preg_match("/(*UCP)^[-+]?[\\d.,'\\s]+$/u", $raw)) {
            return null;
        }

        $dot = strrpos($raw, '.');
        $comma = strrpos($raw, ',');
        $lastSep = max($dot === false ? -1 : $dot, $comma === false ? -1 : $comma);
        if ($lastSep < 0) {
            return null;
        }

        $fracPart = substr($raw, $lastSep + 1);
        if (!preg_match('/^\d{1,2}$/', $fracPart)) {
            return null;
        }

        $intPart = preg_replace("/(*UCP)[.,'\\s]/u", '', substr($raw, 0, $lastSep)) ?? '';
        if (!preg_match('/^[-+]?\d*$/', $intPart)) {
            return null;
        }

        $intText = ($intPart === '' || $intPart === '+' || $intPart === '-') ? $intPart . '0' : $intPart;
        $num = (float) ($intText . '.' . $fracPart);

        return $negatedByParens ? -$num : $num;
    }

    private static function looksLikeDateColumn(string $name): bool
    {
        return preg_match('/date|datum|valuta|buchung/i', $name) === 1;
    }

    /** The column holding the amounts: numeric in most rows, a name like "Betrag" preferred. */
    public static function detectAmountColumn(array $columns, array $rows, ?string $dateColumn): ?string
    {
        if (!$columns || !$rows) {
            return null;
        }
        $best = null;
        foreach ($columns as $name) {
            if ($name === $dateColumn || self::looksLikeDateColumn($name)) {
                continue;
            }
            $parsed = 0;
            foreach ($rows as $row) {
                if (self::parseDecimal($row['data'][$name] ?? null) !== null) {
                    $parsed++;
                }
            }
            if ($parsed === 0) {
                continue;
            }
            $ratio = $parsed / count($rows);
            if ($ratio < 0.5) {
                continue;
            }
            $score = $ratio + (preg_match('/^(betrag|amount|umsatz|summe|value|wert|saldo|total)$/i', trim($name)) ? 1 : 0);
            if ($best === null || $score > $best['score']) {
                $best = ['name' => $name, 'score' => $score];
            }
        }
        return $best['name'] ?? null;
    }

    private static function findColumnByNames(array $columns, array $candidates): ?string
    {
        foreach ($columns as $col) {
            if (in_array(mb_strtolower(trim($col), 'UTF-8'), $candidates, true)) {
                return $col;
            }
        }
        return null;
    }

    /** The VAT a bank row carries, from its invoice: + on a cost (comes back), - on income (owed). */
    private static function rowVat(?array $invoice, ?float $amount): ?float
    {
        if (!$invoice || ($invoice['kind'] ?? null) === 'other' || !isset($invoice['vat']) || !is_numeric($invoice['vat'])) {
            return null;
        }
        if ($amount === null || $amount == 0) {
            return null;
        }
        $gross = is_numeric($invoice['gross'] ?? null) ? (float) $invoice['gross'] : 0.0;
        $share = $gross > 0 && (($invoice['currency'] ?? null) ?: 'EUR') === 'EUR' ? min(1, abs($amount) / $gross) : 1;
        $sign = $amount > 0 ? 1 : -1;
        $vat = -$sign * (float) $invoice['vat'] * $share;
        return self::round2($vat);
    }

    private static function setting(PDO $db, string $key): ?string
    {
        $stmt = $db->prepare("SELECT value FROM bookkeeping_settings WHERE key = :k");
        $stmt->execute(['k' => $key]);
        $value = $stmt->fetchColumn();
        return $value === false ? null : (string) $value;
    }

    /**
     * Every bank row as Financials reads it:
     *   ['amount_column' => ?string, 'rows' => [{id, date, amount, excluded, no_pdf_needed,
     *     party, text, vat, open, data, pdf}]]
     * Rows without a date or an amount are left out, as on the tab.
     */
    public static function bankRows(PDO $db): array
    {
        if (!self::tableExists($db, 'bookkeeping_rows')) {
            return ['amount_column' => null, 'rows' => []];
        }
        $columns = $db->query("SELECT name FROM bookkeeping_columns ORDER BY position, id")->fetchAll(PDO::FETCH_COLUMN);
        $pdfColumns = array_column($db->query("PRAGMA table_info(bookkeeping_pdfs)")->fetchAll(PDO::FETCH_ASSOC), 'name');
        $invoiceSql = in_array('invoice_data', $pdfColumns, true) ? 'p.invoice_data, p.invoice_error' : 'NULL AS invoice_data, NULL AS invoice_error';
        $raw = $db->query("
            SELECT r.id, r.row_date, r.data, r.no_pdf_needed, r.excluded,
                   p.id AS pdf_id, p.original_name AS pdf_name, " . $invoiceSql . "
            FROM bookkeeping_rows r
            LEFT JOIN bookkeeping_pdfs p ON p.row_id = r.id
            ORDER BY (r.row_date IS NULL), r.row_date, r.id
        ")->fetchAll(PDO::FETCH_ASSOC);

        $rows = array_map(fn($r) => array_merge($r, ['data' => json_decode((string) $r['data'], true) ?: []]), $raw);

        $amountColumn = self::detectAmountColumn($columns, $rows, self::setting($db, 'csv_date_column'));
        if ($amountColumn === null) {
            return ['amount_column' => null, 'rows' => []];
        }
        $partyColumn = self::findColumnByNames($columns,
            ['partnername', 'partner', 'payee', 'empfänger', 'empfaenger', 'auftraggeber', 'beschreibung', 'description']);
        $reader = class_exists('InvoiceReader') && InvoiceReader::enabled();

        $out = [];
        foreach ($rows as $r) {
            $amount = self::parseDecimal($r['data'][$amountColumn] ?? null);
            if (empty($r['row_date']) || $amount === null) {
                continue;
            }
            $invoice = null;
            if ($r['invoice_data'] !== null && $r['invoice_data'] !== '') {
                $decoded = json_decode((string) $r['invoice_data'], true);
                $invoice = is_array($decoded) ? $decoded : null;
            }
            $hasPdf = $r['pdf_id'] !== null;
            $out[] = [
                'id' => (int) $r['id'],
                'date' => (string) $r['row_date'],
                'amount' => $amount,
                'excluded' => (int) $r['excluded'] === 1,
                'no_pdf_needed' => (int) $r['no_pdf_needed'] === 1,
                'party' => $partyColumn ? trim((string) ($r['data'][$partyColumn] ?? '')) : '',
                'text' => implode(' ', array_map(fn($v) => is_scalar($v) || $v === null ? (string) $v : json_encode($v), array_values($r['data']))),
                'vat' => $hasPdf ? self::rowVat($invoice, $amount) : null,
                'open' => (!$hasPdf && (int) $r['no_pdf_needed'] !== 1)
                    || ($hasPdf && $invoice === null && ($r['invoice_error'] === null || $r['invoice_error'] === '') && $reader),
                'data' => $r['data'],
                'pdf' => $hasPdf ? ['id' => (int) $r['pdf_id'], 'name' => $r['pdf_name'], 'invoice' => $invoice] : null,
            ];
        }

        return ['amount_column' => $amountColumn, 'rows' => $out];
    }

    // =========================================================================
    // Everything together
    // =========================================================================

    private static function tableExists(PDO $db, string $table): bool
    {
        $stmt = $db->prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :t");
        $stmt->execute(['t' => $table]);
        return (bool) $stmt->fetchColumn();
    }

    /** Today in the CRM's time zone (the calendar's, Europe/Vienna by default). */
    public static function today(): DateTimeImmutable
    {
        $zone = defined('CALENDAR_TIMEZONE') ? CALENDAR_TIMEZONE : 'Europe/Vienna';
        return new DateTimeImmutable('now', new DateTimeZone($zone));
    }

    /**
     * What plan() needs, read from the database: the projects, Financials'
     * costs, balances, debts and settings, and the bank rows with their VAT
     * quarters marked.
     */
    public static function inputs(PDO $db, DateTimeImmutable $today): array
    {
        $projects = $db->query("
            SELECT id, name, company, stage, budget_min, budget_max, success_chance, start_date, estimated_completion,
                   payments, review_status
            FROM projects ORDER BY name ASC
        ")->fetchAll(PDO::FETCH_ASSOC);

        $overview = (new Financials())->overview();
        $bank = self::bankRows($db);
        $settings = $overview['settings'];
        $settings['vat_links'] = self::vatLinks($settings['vat_links'] ?? null);

        return [
            'projects' => $projects,
            'costs' => $overview['costs'],
            'balances' => $overview['balances'],
            'debts' => $overview['debts'],
            'settings' => $settings,
            'transactions' => self::markVatPayments($bank['rows'], $settings['vat_links']),
            'amount_column' => $bank['amount_column'],
            'now' => self::nowOf($today),
            'today' => $today->format('Y-m-d'),
        ];
    }
}
