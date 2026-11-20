<?php
/**
 * Our invoices beyond Bookkeeping: the hand-made links of an invoice to its
 * project and company, and the invoices from before Bookkeeping (2025).
 *
 * Links (invoice_links), by invoice number - for an invoice from Bookkeeping
 * as for one in the archive. project_id / company_id: an id links it, 0 says
 * "none" on purpose, NULL leaves it to the automatic match (invoice-list.js).
 *
 * The archive (invoice_archive) holds what Livio's invoice list says about
 * an invoice: number, dates, status, customer, contact, subject, amounts. It
 * feeds the invoice list on Financials and the company figures, nothing
 * else: no VAT, no cashflow, no year's result, no Bookkeeping.
 */

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

class InvoiceArchive
{
    public const MAX_ROWS = 1000;

    /** number => { project_id, company_id } */
    public static function links(PDO $db): array
    {
        $out = [];
        foreach ($db->query("SELECT invoice_number, project_id, company_id FROM invoice_links")->fetchAll() as $row) {
            $out[$row['invoice_number']] = [
                'project_id' => $row['project_id'] === null ? null : (int) $row['project_id'],
                'company_id' => $row['company_id'] === null ? null : (int) $row['company_id'],
            ];
        }
        return $out;
    }

    /**
     * Set what an invoice is linked to. Each side: an id, 0 for none, null for
     * automatic; a side left out of $in stays as it is.
     */
    public static function link(PDO $db, string $number, array $in): void
    {
        $number = trim($number);
        if ($number === '' || mb_strlen($number) > 64) {
            throw new InvalidArgumentException('An invoice number is required');
        }
        $current = self::links($db)[$number] ?? ['project_id' => null, 'company_id' => null];
        $side = static function (string $key) use ($in, $current) {
            if (!array_key_exists($key, $in)) {
                return $current[$key];
            }
            $v = $in[$key];
            if ($v === null || $v === '') {
                return null;
            }
            if (!is_numeric($v) || (int) $v < 0) {
                throw new InvalidArgumentException($key . ' must be an id, 0 or null');
            }
            return (int) $v;
        };
        $project = $side('project_id');
        $company = $side('company_id');
        if ($project) {
            $stmt = $db->prepare("SELECT 1 FROM projects WHERE id = :id");
            $stmt->execute(['id' => $project]);
            if (!$stmt->fetchColumn()) {
                throw new InvalidArgumentException('That project does not exist');
            }
        }
        if ($company) {
            $stmt = $db->prepare("SELECT 1 FROM companies WHERE id = :id");
            $stmt->execute(['id' => $company]);
            if (!$stmt->fetchColumn()) {
                throw new InvalidArgumentException('That company does not exist');
            }
        }
        if ($project === null && $company === null) {
            $db->prepare("DELETE FROM invoice_links WHERE invoice_number = :n")->execute(['n' => $number]);
            return;
        }
        $actor = Auth::actor();
        $db->prepare("
            INSERT INTO invoice_links (invoice_number, project_id, company_id, updated_at, updated_by, updated_by_name)
            VALUES (:n, :p, :c, CURRENT_TIMESTAMP, :a, :an)
            ON CONFLICT(invoice_number) DO UPDATE SET project_id = excluded.project_id, company_id = excluded.company_id,
                updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name
        ")->execute(['n' => $number, 'p' => $project, 'c' => $company, 'a' => $actor['id'], 'an' => $actor['name']]);
    }

    /** Every archived invoice, oldest number first. */
    public static function all(PDO $db): array
    {
        $rows = $db->query("
            SELECT id, invoice_number, kind, invoice_date, due_date, paid_date, customer, contact, subject, net, vat, gross
            FROM invoice_archive ORDER BY invoice_date, invoice_number
        ")->fetchAll();
        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
            foreach (['net', 'vat', 'gross'] as $key) {
                $row[$key] = $row[$key] === null ? null : (float) $row[$key];
            }
        }
        return $rows;
    }

    /**
     * Add or replace archived invoices, by number. Each row as the invoice
     * list has it, already parsed: { invoice_number, invoice_date, due_date,
     * paid_date, customer, contact, subject, net, vat, gross }.
     *
     * @return array{added: int, replaced: int}
     */
    public static function import(PDO $db, array $rows): array
    {
        if (count($rows) > self::MAX_ROWS) {
            throw new InvalidArgumentException('At most ' . self::MAX_ROWS . ' invoices at once');
        }
        $clean = [];
        foreach ($rows as $i => $row) {
            $clean[] = self::cleanRow(is_array($row) ? $row : [], $i + 1);
        }
        $actor = Auth::actor();
        $exists = $db->prepare("SELECT 1 FROM invoice_archive WHERE invoice_number = :n");
        $save = $db->prepare("
            INSERT INTO invoice_archive (invoice_number, kind, invoice_date, due_date, paid_date, customer, contact, subject,
                net, vat, gross, created_by, created_by_name)
            VALUES (:n, :kind, :d, :due, :paid, :customer, :contact, :subject, :net, :vat, :gross, :a, :an)
            ON CONFLICT(invoice_number) DO UPDATE SET kind = excluded.kind, invoice_date = excluded.invoice_date,
                due_date = excluded.due_date, paid_date = excluded.paid_date, customer = excluded.customer,
                contact = excluded.contact, subject = excluded.subject, net = excluded.net, vat = excluded.vat,
                gross = excluded.gross
        ");
        $added = 0;
        $replaced = 0;
        foreach ($clean as $row) {
            $exists->execute(['n' => $row['invoice_number']]);
            $exists->fetchColumn() ? $replaced++ : $added++;
            $save->execute([
                'n' => $row['invoice_number'], 'kind' => $row['kind'], 'd' => $row['invoice_date'], 'due' => $row['due_date'],
                'paid' => $row['paid_date'], 'customer' => $row['customer'], 'contact' => $row['contact'],
                'subject' => $row['subject'], 'net' => $row['net'], 'vat' => $row['vat'], 'gross' => $row['gross'],
                'a' => $actor['id'], 'an' => $actor['name'],
            ]);
        }
        return ['added' => $added, 'replaced' => $replaced];
    }

    public static function delete(PDO $db, int $id): void
    {
        $db->prepare("DELETE FROM invoice_archive WHERE id = :id")->execute(['id' => $id]);
    }

    private static function cleanRow(array $row, int $line): array
    {
        $text = static function ($v, int $max): ?string {
            if (!is_string($v) && !is_numeric($v)) {
                return null;
            }
            $v = trim(preg_replace('/\s+/u', ' ', (string) $v));
            return $v === '' ? null : mb_substr($v, 0, $max);
        };
        $date = static function ($v) use ($line): ?string {
            if ($v === null || $v === '') {
                return null;
            }
            $d = DateTime::createFromFormat('!Y-m-d', (string) $v);
            if (!$d || $d->format('Y-m-d') !== (string) $v) {
                throw new InvalidArgumentException('Line ' . $line . ': dates must be YYYY-MM-DD');
            }
            return (string) $v;
        };
        $money = static function ($v) use ($line): ?float {
            if ($v === null || $v === '') {
                return null;
            }
            if (!is_numeric($v) || abs((float) $v) > 1e9) {
                throw new InvalidArgumentException('Line ' . $line . ': amounts must be numbers');
            }
            return round((float) $v, 2);
        };

        $number = $text($row['invoice_number'] ?? null, 64);
        if ($number === null) {
            throw new InvalidArgumentException('Line ' . $line . ': the invoice number is missing');
        }
        $net = $money($row['net'] ?? null);
        $vat = $money($row['vat'] ?? null);
        $gross = $money($row['gross'] ?? null);
        if ($gross === null && $net !== null) {
            $gross = round($net + ($vat ?? 0), 2);
        }
        if ($net === null && $gross !== null) {
            $net = round($gross - ($vat ?? 0), 2);
        }
        return [
            'invoice_number' => $number,
            'kind' => ($gross ?? $net ?? 0) < 0 ? 'credit_note' : 'invoice',
            'invoice_date' => $date($row['invoice_date'] ?? null),
            'due_date' => $date($row['due_date'] ?? null),
            'paid_date' => $date($row['paid_date'] ?? null),
            'customer' => $text($row['customer'] ?? null, 255),
            'contact' => $text($row['contact'] ?? null, 255),
            'subject' => $text($row['subject'] ?? null, 2000),
            'net' => $net,
            'vat' => $vat,
            'gross' => $gross,
        ];
    }
}
