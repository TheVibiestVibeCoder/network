<?php
/**
 * Small per-account choices that should follow a person from device to
 * device - for now only how the Projects page lists them (cards or a list).
 *
 * Kept in app_settings as "pref:<person>:<name>", the person being the user
 * id or "owner" for the owner login (which has no users row). Only the
 * names and values in ALLOWED can be stored.
 */

class UserPrefs
{
    public const ALLOWED = [
        'project_view' => ['cards', 'list'],
    ];

    /** Every preference of the signed-in person, defaults filled in. */
    public static function all(PDO $db): array
    {
        $prefs = [];
        foreach (self::ALLOWED as $name => $values) {
            $prefs[$name] = self::get($db, $name);
        }
        return $prefs;
    }

    /** One preference of the signed-in person; its first allowed value when unset. */
    public static function get(PDO $db, string $name): string
    {
        $values = self::ALLOWED[$name] ?? null;
        if ($values === null) {
            throw new InvalidArgumentException('Unknown preference');
        }
        $key = self::key($name);
        if ($key === null) {
            return $values[0];
        }

        $stmt = $db->prepare('SELECT value FROM app_settings WHERE key = :key');
        $stmt->execute(['key' => $key]);
        $value = $stmt->fetchColumn();

        return in_array($value, $values, true) ? $value : $values[0];
    }

    /** Store one preference of the signed-in person; false for an unknown name or value. */
    public static function set(PDO $db, string $name, string $value): bool
    {
        $key = self::key($name);
        if ($key === null || !in_array($value, self::ALLOWED[$name] ?? [], true)) {
            return false;
        }

        $db->prepare("
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (:key, :value, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        ")->execute(['key' => $key, 'value' => $value]);

        return true;
    }

    private static function key(string $name): ?string
    {
        $me = Auth::currentUser();
        if ($me === null || !isset(self::ALLOWED[$name])) {
            return null;
        }
        $person = !empty($me['is_owner']) ? 'owner' : (string) (int) $me['id'];

        return 'pref:' . $person . ':' . $name;
    }
}
