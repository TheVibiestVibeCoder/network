<?php
/**
 * Writing calendar objects for the team calendar (phase 2)
 *
 * New appointments are built here. Existing ones are edited, never rebuilt:
 * whatever the iPhone wrote into them - its own time zone definitions,
 * EMAIL= parameters, alarms, X-APPLE-... properties - stays (phase 0,
 * recommendation 5). New times are written as local time in
 * CALENDAR_TIMEZONE with a VTIMEZONE, all-day appointments as dates (spec,
 * section 2); an existing appointment keeps the form its times already had.
 *
 * Occurrences are named as the cache names them (calendar_instances.
 * recurrence_id): 'Y-m-d H:i:s' in UTC, or 'Y-m-d' in an all-day series.
 */

// ---------------------------------------------------------------------------
// Direct web access guard
// ---------------------------------------------------------------------------
if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\Property;
use Sabre\VObject\Reader;

final class CalendarIcsWriter
{
    private const PRODID = '-//Disinfo Consulting//CRM Team Calendar//EN';

    /** Reminders the sheet offers, in minutes before the start. */
    public const REMINDERS = [0, 5, 10, 15, 30, 60, 120, 1440];

    /** Repeats the sheet writes; any other rule stays as the phone set it. */
    public const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'];

    private const UTC_FORMAT = 'Y-m-d H:i:s';

    public static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        $hex = bin2hex($bytes);
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20);
    }

    // =========================================================================
    // A new appointment
    // =========================================================================

    /**
     * @param array{
     *   uid: string, title: string, all_day: bool,
     *   start: DateTimeImmutable, end: DateTimeImmutable,
     *   location?: ?string, description?: ?string, url?: ?string,
     *   organizer?: ?array{email: string, name: string},
     *   attendees?: list<array{email: string, name: string}>,
     *   repeat?: ?array{freq: string, until: ?string},
     *   reminder?: ?int
     * } $event All-day: end is the day after the last one. repeat.until is
     *          the last day (Y-m-d) the series may run on.
     */
    public static function create(array $event): string
    {
        self::boot();
        $vcal = new VCalendar();
        $vcal->PRODID = self::PRODID;
        $now = self::now();
        $vevent = $vcal->add('VEVENT', ['UID' => $event['uid'], 'DTSTAMP' => $now]);
        $vevent->add('CREATED', $now);
        $vevent->add('LAST-MODIFIED', $now);
        $vevent->add('SEQUENCE', '0');
        $vevent->add('SUMMARY', $event['title']);
        self::writeTimes($vcal, $vevent, $event['start'], $event['end'], $event['all_day'], null);
        self::setText($vevent, 'LOCATION', $event['location'] ?? null);
        self::setText($vevent, 'DESCRIPTION', $event['description'] ?? null);
        self::setText($vevent, 'URL', $event['url'] ?? null);
        if (!empty($event['repeat'])) {
            $vevent->add('RRULE', self::rrule($event['repeat'], $event['all_day']));
        }
        self::setTeam($vevent, $event['organizer'] ?? null, $event['attendees'] ?? [], []);
        $vevent->add('STATUS', 'CONFIRMED');
        $vevent->add('TRANSP', 'OPAQUE');
        self::setReminder($vevent, $event['reminder'] ?? null);
        return $vcal->serialize();
    }

    // =========================================================================
    // Changing one
    // =========================================================================

    /**
     * Change the whole appointment ($occurrence null) or one occurrence of a
     * series. Only the keys present in $changes change:
     *
     *   title, location, description, url  ?string
     *   start, end, all_day                 the new times (all-day: end is
     *                                       the day after the last one)
     *   attendees                           the team members taking part
     *                                       besides the organizer:
     *                                       list<{email, name}>; with
     *                                       organizer {email, name} and team
     *                                       (every team address)
     *   repeat                              {freq, until} or null (stop)
     *   reminder                            minutes before, or null
     *
     * Moving a whole series takes $origin, the original start of the
     * occurrence the change was made on: every occurrence moves by the same
     * amount, and the dates that cancelled or moved occurrences point at move
     * with it, so none of them comes loose.
     */
    public static function update(string $ics, array $changes, ?string $occurrence, ?DateTimeImmutable $origin = null): string
    {
        $vcal = self::read($ics);
        $master = self::master($vcal);
        $touched = [];

        if ($occurrence !== null) {
            $target = self::override($vcal, $master, $occurrence);
            self::applyText($target, $changes);
            if (isset($changes['start'], $changes['end'])) {
                self::writeTimes($vcal, $target, $changes['start'], $changes['end'], !$master->DTSTART->hasTime(), $master);
            }
            if (array_key_exists('reminder', $changes)) {
                self::setReminder($target, $changes['reminder']);
            }
            $touched[] = $target;
        } else {
            $overrides = self::overrides($vcal);
            // Occurrences that still say what the series said follow it.
            foreach (['title' => 'SUMMARY', 'location' => 'LOCATION', 'description' => 'DESCRIPTION', 'url' => 'URL'] as $key => $name) {
                if (!array_key_exists($key, $changes)) {
                    continue;
                }
                $before = self::text($master, $name);
                foreach ($overrides as $override) {
                    if (self::text($override, $name) === $before) {
                        self::setText($override, $name, $changes[$key]);
                        $touched[] = $override;
                    }
                }
            }
            self::applyText($master, $changes);

            if (isset($changes['start'], $changes['end'])) {
                if (self::isSeries($master)) {
                    $touched = array_merge($touched, self::moveSeries($vcal, $master, $changes, $origin));
                } else {
                    $allDay = (bool) ($changes['all_day'] ?? !$master->DTSTART->hasTime());
                    self::writeTimes($vcal, $master, $changes['start'], $changes['end'], $allDay, $master);
                }
            }
            if (array_key_exists('repeat', $changes)) {
                self::setRepeat($vcal, $master, $changes['repeat']);
            }
            if (array_key_exists('attendees', $changes)) {
                foreach (array_merge([$master], $overrides) as $event) {
                    self::setTeam($event, $changes['organizer'] ?? null, $changes['attendees'], $changes['team'] ?? []);
                }
                $touched = array_merge($touched, $overrides);
            }
            if (array_key_exists('reminder', $changes)) {
                self::setReminder($master, $changes['reminder']);
            }
            $touched[] = $master;
        }

        $now = self::now();
        $seen = [];
        foreach ($touched as $event) {
            $key = spl_object_id($event);
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $event->SEQUENCE = (string) (((int) (string) ($event->SEQUENCE ?? '0')) + 1);
            $event->DTSTAMP = $now;
            $event->{'LAST-MODIFIED'} = $now;
        }
        return $vcal->serialize();
    }

    /** Cancel one occurrence of a series: an EXDATE, and its override gone. */
    public static function removeOccurrence(string $ics, string $occurrence): string
    {
        $vcal = self::read($ics);
        $master = self::master($vcal);
        if (!self::isSeries($master)) {
            throw new InvalidArgumentException('This appointment does not repeat.');
        }
        foreach (self::overrides($vcal) as $override) {
            if (self::stampOf($override->{'RECURRENCE-ID'}) === $occurrence) {
                $vcal->remove($override);
            }
        }
        self::addLike($master, 'EXDATE', $master, self::occurrenceTime($master, $occurrence));
        $master->SEQUENCE = (string) (((int) (string) ($master->SEQUENCE ?? '0')) + 1);
        $master->DTSTAMP = self::now();
        $master->{'LAST-MODIFIED'} = self::now();
        return $vcal->serialize();
    }

    /** Somebody's answer, in every part of the appointment that lists them. */
    public static function setPartstat(string $ics, string $email, string $partstat): string
    {
        $vcal = self::read($ics);
        $email = strtolower($email);
        $changed = false;
        foreach ($vcal->select('VEVENT') as $event) {
            foreach ($event->select('ATTENDEE') as $attendee) {
                if (self::address((string) $attendee->getValue()) !== $email) {
                    continue;
                }
                if (strtoupper((string) $attendee['PARTSTAT']) !== $partstat) {
                    $attendee['PARTSTAT'] = $partstat;
                    $event->DTSTAMP = self::now();
                    $changed = true;
                }
            }
        }
        return $changed ? $vcal->serialize() : $ics;
    }

    /**
     * Who organizes the appointment and everyone in it with their answer
     * (its master), addresses lowercase.
     *
     * @return array{organizer: ?string, attendees: array<string, string>}
     */
    public static function people(string $ics): array
    {
        $master = self::master(self::read($ics));
        $attendees = [];
        foreach ($master->select('ATTENDEE') as $attendee) {
            $attendees[self::address((string) $attendee->getValue())] = strtoupper((string) ($attendee['PARTSTAT'] ?? '')) ?: 'NEEDS-ACTION';
        }
        return [
            'organizer' => isset($master->ORGANIZER) ? self::address((string) $master->ORGANIZER->getValue()) : null,
            'attendees' => $attendees,
        ];
    }

    /** Somebody's answer in the appointment as a whole (its master). */
    public static function partstat(string $ics, string $email): ?string
    {
        $master = self::master(self::read($ics));
        foreach ($master->select('ATTENDEE') as $attendee) {
            if (self::address((string) $attendee->getValue()) === strtolower($email)) {
                return strtoupper((string) ($attendee['PARTSTAT'] ?? 'NEEDS-ACTION')) ?: 'NEEDS-ACTION';
            }
        }
        return null;
    }

    // =========================================================================
    // Reading what the sheet and the copies need
    // =========================================================================

    /**
     * What an appointment says, without what changes by itself on a phone:
     * stamps, sequence, alarms, X- properties, parameters other than the
     * answers. Two copies with the same fingerprint say the same.
     */
    public static function fingerprint(string $ics): string
    {
        $vcal = self::read($ics);
        $zone = self::zone();
        $parts = [];
        foreach ($vcal->select('VEVENT') as $event) {
            $people = [];
            foreach ($event->select('ATTENDEE') as $attendee) {
                $people[self::address((string) $attendee->getValue())] = strtoupper((string) ($attendee['PARTSTAT'] ?? '')) ?: 'NEEDS-ACTION';
            }
            ksort($people);
            $exdates = [];
            foreach ($event->select('EXDATE') as $exdate) {
                foreach ($exdate->getDateTimes($zone) as $time) {
                    $exdates[] = self::stamp($time, $exdate->hasTime());
                }
            }
            sort($exdates);
            $rule = '';
            if (isset($event->RRULE)) {
                $ruleParts = array_change_key_case($event->RRULE->getParts(), CASE_UPPER);
                ksort($ruleParts);
                $rule = json_encode($ruleParts);
            }
            $key = isset($event->{'RECURRENCE-ID'}) ? self::stampOf($event->{'RECURRENCE-ID'}) : 'master';
            $parts[$key] = [
                'summary'     => self::text($event, 'SUMMARY'),
                'location'    => self::text($event, 'LOCATION'),
                'description' => self::text($event, 'DESCRIPTION'),
                'url'         => self::text($event, 'URL'),
                'status'      => strtoupper((string) ($event->STATUS ?? '')),
                'class'       => strtoupper((string) ($event->CLASS ?? '')),
                'transp'      => strtoupper((string) ($event->TRANSP ?? '')),
                'start'       => isset($event->DTSTART) ? self::stampOf($event->DTSTART) : null,
                'end'         => self::endStamp($event),
                'rrule'       => $rule,
                'exdate'      => $exdates,
                'organizer'   => isset($event->ORGANIZER) ? self::address((string) $event->ORGANIZER->getValue()) : null,
                'attendees'   => $people,
            ];
        }
        ksort($parts);
        return hash('sha256', (string) json_encode($parts));
    }

    /**
     * The parts of an appointment the sheet shows beyond what the cache has:
     * how it repeats and its reminder.
     *
     * @return array{repeat: ?array{freq: string, until: ?string}, repeat_custom: bool, movable_days: bool, reminder: ?int, reminder_custom: bool, series: bool}
     */
    public static function details(string $ics): array
    {
        $master = self::master(self::read($ics));
        [$repeat, $custom, $movable] = self::readRepeat($master);
        [$reminder, $reminderCustom] = self::readReminder($master);
        return [
            'series'          => self::isSeries($master),
            'repeat'          => $repeat,
            'repeat_custom'   => $custom,
            'movable_days'    => $movable,
            'reminder'        => $reminder,
            'reminder_custom' => $reminderCustom,
        ];
    }

    // =========================================================================
    // Times
    // =========================================================================

    /**
     * DTSTART and DTEND. In the form $like's DTSTART has (its TZID, UTC or
     * floating) - unless that is a date and this is timed, or there is no
     * $like: then local time in CALENDAR_TIMEZONE with its VTIMEZONE.
     */
    private static function writeTimes(VCalendar $vcal, VEvent $event, DateTimeImmutable $start, DateTimeImmutable $end, bool $allDay, ?VEvent $like): void
    {
        // Taken before anything is removed: $like may be $event itself.
        $form = $like !== null && isset($like->DTSTART) && $like->DTSTART->hasTime() ? clone $like->DTSTART : null;
        unset($event->DTSTART, $event->DTEND, $event->DURATION);
        if ($allDay) {
            $event->add('DTSTART', $start->format('Ymd'), ['VALUE' => 'DATE']);
            $event->add('DTEND', $end->format('Ymd'), ['VALUE' => 'DATE']);
            return;
        }
        if ($form !== null) {
            self::addInForm($event, 'DTSTART', $form, $start);
            self::addInForm($event, 'DTEND', $form, $end);
            return;
        }
        $zone = self::zone();
        self::ensureTimezone($vcal, $zone);
        $event->add('DTSTART', $start->setTimezone($zone)->format('Ymd\THis'), ['TZID' => $zone->getName()]);
        $event->add('DTEND', $end->setTimezone($zone)->format('Ymd\THis'), ['TZID' => $zone->getName()]);
    }

    /** A date or date-time property in the form of $like's DTSTART. */
    private static function addLike(VEvent $event, string $name, VEvent $like, DateTimeImmutable $value): void
    {
        self::addInForm($event, $name, $like->DTSTART, $value);
    }

    /** A date or date-time property written as $dtstart is: date, floating, with its TZID, or UTC. */
    private static function addInForm(VEvent $event, string $name, Property $dtstart, DateTimeImmutable $value): void
    {
        if (!$dtstart->hasTime()) {
            $event->add($name, $value->format('Ymd'), ['VALUE' => 'DATE']);
        } elseif ($dtstart->isFloating()) {
            $event->add($name, $value->setTimezone(self::zone())->format('Ymd\THis'));
        } elseif (isset($dtstart['TZID'])) {
            $zone = $dtstart->getDateTime(self::zone())->getTimezone();
            $event->add($name, $value->setTimezone($zone)->format('Ymd\THis'), ['TZID' => (string) $dtstart['TZID']]);
        } else {
            $event->add($name, $value->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z'));
        }
    }

    /**
     * Move every occurrence of a series by the change made on one of them:
     * whole days, and a different time of day. The cancelled and moved
     * occurrences' dates move along.
     *
     * @return list<VEvent> overrides that changed too
     */
    private static function moveSeries(VCalendar $vcal, VEvent $master, array $changes, ?DateTimeImmutable $origin): array
    {
        if ($origin === null) {
            throw new InvalidArgumentException('Which occurrence was moved is missing.');
        }
        $zone = self::zone();
        $allDay = !$master->DTSTART->hasTime();
        $from = $origin->setTimezone($zone);
        $to = $changes['start']->setTimezone($zone);
        $days = (int) (new DateTimeImmutable($from->format('Y-m-d'), $zone))->diff(new DateTimeImmutable($to->format('Y-m-d'), $zone))->format('%r%a');
        $seconds = $allDay ? 0 : self::secondsOfDay($to) - self::secondsOfDay($from);
        if ($days === 0 && $seconds === 0) {
            // Same start; only the length may differ.
            $start = self::masterStart($master);
            $length = $changes['end']->getTimestamp() - $changes['start']->getTimestamp();
            self::writeTimes($vcal, $master, $start, self::addSeconds($start, $length, $allDay), $allDay, $master);
            return [];
        }
        if ($days !== 0) {
            [, $custom, $movable] = self::readRepeat($master);
            if ($custom || !$movable) {
                throw new InvalidArgumentException('This series repeats on fixed days set on the phone. Move it to another day there, or change only this occurrence.');
            }
            // A rule naming the weekday or day of the month the series had
            // would keep it there; freq and until say the same without it.
            [$repeat] = self::readRepeat($master);
            if ($repeat !== null) {
                $master->RRULE = self::rrule($repeat, $allDay);
            }
        }
        $shift = static function (DateTimeImmutable $time) use ($days, $seconds, $zone): DateTimeImmutable {
            $local = $time->setTimezone($zone);
            if ($days !== 0) {
                $local = $local->modify(($days > 0 ? '+' : '') . $days . ' days');
            }
            return $seconds !== 0 ? $local->modify(($seconds > 0 ? '+' : '') . $seconds . ' seconds') : $local;
        };

        $length = $changes['end']->getTimestamp() - $changes['start']->getTimestamp();
        $newStart = $shift(self::masterStart($master));
        self::writeTimes($vcal, $master, $newStart, self::addSeconds($newStart, $length, $allDay), $allDay, $master);

        $exdates = [];
        foreach ($master->select('EXDATE') as $exdate) {
            foreach ($exdate->getDateTimes($zone) as $time) {
                $exdates[] = $shift(DateTimeImmutable::createFromInterface($time));
            }
        }
        unset($master->EXDATE);
        foreach ($exdates as $time) {
            self::addLike($master, 'EXDATE', $master, $time);
        }

        $touched = [];
        foreach (self::overrides($vcal) as $override) {
            $rid = DateTimeImmutable::createFromInterface($override->{'RECURRENCE-ID'}->getDateTime($zone));
            $unmoved = isset($override->DTSTART) && self::stampOf($override->DTSTART) === self::stampOf($override->{'RECURRENCE-ID'});
            unset($override->{'RECURRENCE-ID'});
            self::addLike($override, 'RECURRENCE-ID', $master, $shift($rid));
            if ($unmoved) {
                $overrideStart = DateTimeImmutable::createFromInterface($override->DTSTART->getDateTime($zone));
                $overrideEnd = self::endOf($override) ?? $overrideStart;
                self::writeTimes($vcal, $override, $shift($overrideStart), $shift($overrideEnd), $allDay, $master);
            }
            $touched[] = $override;
        }
        return $touched;
    }

    private static function addSeconds(DateTimeImmutable $time, int $seconds, bool $allDay): DateTimeImmutable
    {
        if ($allDay) {
            return $time->modify('+' . max(1, (int) round($seconds / 86400)) . ' days');
        }
        return $time->modify('+' . max(0, $seconds) . ' seconds');
    }

    private static function secondsOfDay(DateTimeImmutable $time): int
    {
        return (int) $time->format('G') * 3600 + (int) $time->format('i') * 60 + (int) $time->format('s');
    }

    private static function masterStart(VEvent $master): DateTimeImmutable
    {
        return DateTimeImmutable::createFromInterface($master->DTSTART->getDateTime(self::zone()));
    }

    private static function endOf(VEvent $event): ?DateTimeImmutable
    {
        $zone = self::zone();
        if (isset($event->DTEND)) {
            return DateTimeImmutable::createFromInterface($event->DTEND->getDateTime($zone));
        }
        if (!isset($event->DTSTART)) {
            return null;
        }
        $start = DateTimeImmutable::createFromInterface($event->DTSTART->getDateTime($zone));
        if (isset($event->DURATION)) {
            return $start->add($event->DURATION->getDateInterval());
        }
        return $event->DTSTART->hasTime() ? $start : $start->modify('+1 day');
    }

    private static function endStamp(VEvent $event): ?string
    {
        $end = self::endOf($event);
        return $end === null || !isset($event->DTSTART) ? null : self::stamp($end, $event->DTSTART->hasTime());
    }

    /** The occurrence that starts at $occurrence (cache form), in the master's own zone. */
    private static function occurrenceTime(VEvent $master, string $occurrence): DateTimeImmutable
    {
        if (!$master->DTSTART->hasTime()) {
            return new DateTimeImmutable($occurrence, self::zone());
        }
        $zone = $master->DTSTART->isFloating() ? self::zone() : $master->DTSTART->getDateTime(self::zone())->getTimezone();
        return (new DateTimeImmutable($occurrence, new DateTimeZone('UTC')))->setTimezone($zone);
    }

    /** A date or date-time property as the cache names occurrences. */
    private static function stampOf(Property $property): string
    {
        $time = $property->getDateTime(self::zone());
        return self::stamp($time, $property->hasTime());
    }

    private static function stamp(DateTimeInterface $time, bool $hasTime): string
    {
        if (!$hasTime) {
            return $time->format('Y-m-d');
        }
        return DateTimeImmutable::createFromInterface($time)->setTimezone(new DateTimeZone('UTC'))->format(self::UTC_FORMAT);
    }

    /**
     * A VTIMEZONE for $zone when the object has none of that name, built
     * from the zone's rules this year: yearly switches on the same weekday
     * of the same month, as in Europe.
     */
    private static function ensureTimezone(VCalendar $vcal, DateTimeZone $zone): void
    {
        foreach ($vcal->select('VTIMEZONE') as $existing) {
            if ((string) $existing->TZID === $zone->getName()) {
                return;
            }
        }
        $year = (int) gmdate('Y');
        $start = (new DateTimeImmutable($year . '-01-01 00:00:00', new DateTimeZone('UTC')))->getTimestamp();
        $end = (new DateTimeImmutable(($year + 1) . '-01-01 00:00:00', new DateTimeZone('UTC')))->getTimestamp();
        $transitions = $zone->getTransitions($start, $end) ?: [];
        $initial = $transitions[0] ?? ['offset' => $zone->getOffset(new DateTime('now', $zone)), 'isdst' => false, 'abbr' => ''];

        $vtimezone = $vcal->add('VTIMEZONE', ['TZID' => $zone->getName()]);
        $changes = array_slice($transitions, 1);
        // DAYLIGHT and STANDARD must be made as components: add() by name
        // would take them for properties.
        if (!$changes) {
            $vtimezone->add($vcal->createComponent('STANDARD', [
                'DTSTART'      => '19700101T000000',
                'TZOFFSETFROM' => self::offset((int) $initial['offset']),
                'TZOFFSETTO'   => self::offset((int) $initial['offset']),
                'TZNAME'       => (string) $initial['abbr'],
            ], false));
            return;
        }
        $previous = (int) $initial['offset'];
        $ordinals = [1 => 'first', 2 => 'second', 3 => 'third', 4 => 'fourth', -1 => 'last'];
        foreach ($changes as $change) {
            $wall = (new DateTimeImmutable('@' . $change['ts']))->setTimezone(new DateTimeZone(self::offset($previous, true)));
            $day = (int) $wall->format('j');
            $ordinal = $day + 7 > (int) $wall->format('t') ? -1 : intdiv($day - 1, 7) + 1;
            $weekday = strtoupper(substr($wall->format('D'), 0, 2));
            $first = new DateTimeImmutable($ordinals[$ordinal] . ' ' . $wall->format('l') . ' of ' . $wall->format('F') . ' 1970');
            $vtimezone->add($vcal->createComponent($change['isdst'] ? 'DAYLIGHT' : 'STANDARD', [
                'DTSTART'      => $first->format('Ymd') . 'T' . $wall->format('His'),
                'RRULE'        => 'FREQ=YEARLY;BYMONTH=' . (int) $wall->format('n') . ';BYDAY=' . $ordinal . $weekday,
                'TZOFFSETFROM' => self::offset($previous),
                'TZOFFSETTO'   => self::offset((int) $change['offset']),
                'TZNAME'       => (string) $change['abbr'],
            ], false));
            $previous = (int) $change['offset'];
        }
    }

    private static function offset(int $seconds, bool $colon = false): string
    {
        $sign = $seconds < 0 ? '-' : '+';
        $seconds = abs($seconds);
        return $sign . sprintf($colon ? '%02d:%02d' : '%02d%02d', intdiv($seconds, 3600), intdiv($seconds % 3600, 60));
    }

    // =========================================================================
    // Series
    // =========================================================================

    private static function isSeries(VEvent $master): bool
    {
        return isset($master->RRULE) || isset($master->RDATE);
    }

    /** The overrides: moved or changed occurrences, each with a RECURRENCE-ID. */
    private static function overrides(VCalendar $vcal): array
    {
        $list = [];
        foreach ($vcal->select('VEVENT') as $event) {
            if (isset($event->{'RECURRENCE-ID'})) {
                $list[] = $event;
            }
        }
        return $list;
    }

    /** The override for one occurrence, made from the master if there is none yet. */
    private static function override(VCalendar $vcal, VEvent $master, string $occurrence): VEvent
    {
        foreach (self::overrides($vcal) as $override) {
            if (self::stampOf($override->{'RECURRENCE-ID'}) === $occurrence) {
                return $override;
            }
        }
        if (!self::isSeries($master)) {
            throw new InvalidArgumentException('This appointment does not repeat.');
        }
        $when = self::occurrenceTime($master, $occurrence);
        $start = self::masterStart($master);
        $end = self::endOf($master) ?? $start;
        $allDay = !$master->DTSTART->hasTime();
        $length = $end->getTimestamp() - $start->getTimestamp();

        $override = clone $master;
        unset($override->RRULE, $override->RDATE, $override->EXDATE, $override->{'RECURRENCE-ID'});
        $vcal->add($override);
        self::addLike($override, 'RECURRENCE-ID', $master, $when);
        self::writeTimes($vcal, $override, $when, self::addSeconds($when, $length, $allDay), $allDay, $master);
        return $override;
    }

    /**
     * How a series repeats, as the sheet can say it.
     *
     * @return array{0: ?array{freq: string, until: ?string}, 1: bool, 2: bool}
     *         [the repeat, or null; true when the rule says more than the
     *         sheet can (stays as the phone set it); true when the series can
     *         move to other days without changing its meaning]
     */
    private static function readRepeat(VEvent $master): array
    {
        if (isset($master->RDATE)) {
            return [null, true, false];
        }
        if (!isset($master->RRULE)) {
            return [null, false, true];
        }
        $parts = array_change_key_case($master->RRULE->getParts(), CASE_UPPER);
        $freq = strtoupper((string) ($parts['FREQ'] ?? ''));
        if (!in_array($freq, self::FREQUENCIES, true)) {
            return [null, true, false];
        }
        $start = self::masterStart($master);
        $until = null;
        foreach ($parts as $key => $value) {
            if ($key === 'FREQ' || $key === 'WKST' || ($key === 'INTERVAL' && (int) $value === 1)) {
                continue;
            }
            if ($key === 'UNTIL') {
                $until = self::untilDate((string) $value);
                continue;
            }
            // The weekday or day of the month the series starts on anyway
            // (the phone writes that out) says nothing more.
            $single = is_array($value) ? (count($value) === 1 ? (string) reset($value) : null) : (string) $value;
            if ($key === 'BYDAY' && $freq === 'WEEKLY' && $single !== null && strtoupper($single) === strtoupper(substr($start->format('D'), 0, 2))) {
                continue;
            }
            if ($key === 'BYMONTHDAY' && $freq === 'MONTHLY' && $single !== null && (int) $single === (int) $start->format('j')) {
                continue;
            }
            return [null, true, false];
        }
        return [['freq' => $freq, 'until' => $until], false, true];
    }

    private static function untilDate(string $value): ?string
    {
        $value = trim($value);
        if (preg_match('/^\d{8}$/', $value)) {
            return DateTimeImmutable::createFromFormat('!Ymd', $value, self::zone())->format('Y-m-d');
        }
        if (preg_match('/^(\d{8}T\d{6})Z$/', $value, $m)) {
            return DateTimeImmutable::createFromFormat('Ymd\THis', $m[1], new DateTimeZone('UTC'))->setTimezone(self::zone())->format('Y-m-d');
        }
        if (preg_match('/^\d{8}T\d{6}$/', $value)) {
            return DateTimeImmutable::createFromFormat('Ymd\THis', $value, self::zone())->format('Y-m-d');
        }
        return null;
    }

    private static function rrule(array $repeat, bool $allDay): string
    {
        $freq = strtoupper((string) $repeat['freq']);
        if (!in_array($freq, self::FREQUENCIES, true)) {
            throw new InvalidArgumentException('Repeat daily, weekly or monthly.');
        }
        $rule = 'FREQ=' . $freq;
        if (!empty($repeat['until'])) {
            $until = DateTimeImmutable::createFromFormat('!Y-m-d', (string) $repeat['until'], self::zone());
            if ($until === false) {
                throw new InvalidArgumentException('The last day of the series must be a date.');
            }
            // RFC 5545: with a local start time, UNTIL is in UTC.
            $rule .= ';UNTIL=' . ($allDay
                ? $until->format('Ymd')
                : $until->setTime(23, 59, 59)->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z'));
        }
        return $rule;
    }

    /** A new repeat, or none: then moved and cancelled occurrences go too. */
    private static function setRepeat(VCalendar $vcal, VEvent $master, ?array $repeat): void
    {
        [, $custom] = self::readRepeat($master);
        if ($custom) {
            throw new InvalidArgumentException('This series repeats in a way set on the phone. Change its repeat there.');
        }
        $allDay = !$master->DTSTART->hasTime();
        if ($repeat === null) {
            unset($master->RRULE, $master->EXDATE, $master->RDATE);
            foreach (self::overrides($vcal) as $override) {
                $vcal->remove($override);
            }
            return;
        }
        $master->RRULE = self::rrule($repeat, $allDay);
    }

    // =========================================================================
    // People, text, reminder
    // =========================================================================

    /**
     * The team in an appointment: ORGANIZER, the organizer as first ATTENDEE
     * and one ATTENDEE per other team member. Attendees from outside the team
     * (written on a phone) stay as they are. Nobody but the organizer left:
     * no ORGANIZER or ATTENDEE at all, a plain appointment.
     *
     * SCHEDULE-AGENT=CLIENT goes on the attendees (spec, section 4; harmless
     * there, phase 0), never on the organizer - the iPhone then stops saving.
     *
     * @param list<array{email: string, name: string}> $attendees
     * @param list<string> $team every team address (who counts as team)
     */
    private static function setTeam(VEvent $event, ?array $organizer, array $attendees, array $team): void
    {
        $team = array_map('strtolower', $team);
        $organizerEmail = isset($event->ORGANIZER) ? self::address((string) $event->ORGANIZER->getValue()) : null;
        if ($organizerEmail === null && $organizer !== null) {
            $organizerEmail = strtolower($organizer['email']);
        }
        $wanted = [];
        foreach ($attendees as $attendee) {
            $email = strtolower($attendee['email']);
            if ($email !== $organizerEmail) {
                $wanted[$email] = $attendee['name'] ?? $email;
            }
        }

        $kept = [];
        foreach ($event->select('ATTENDEE') as $line) {
            $email = self::address((string) $line->getValue());
            $isTeam = in_array($email, $team, true) || isset($wanted[$email]);
            if ($email !== $organizerEmail && $isTeam && !isset($wanted[$email])) {
                $event->remove($line);
                continue;
            }
            $kept[$email] = true;
        }

        $others = array_diff(array_keys($kept), [$organizerEmail]);
        if (!$wanted && !$others) {
            unset($event->ORGANIZER, $event->ATTENDEE);
            return;
        }
        if ($organizerEmail === null) {
            throw new InvalidArgumentException('An appointment with participants needs an organizer.');
        }
        if (!isset($event->ORGANIZER)) {
            $event->add('ORGANIZER', 'mailto:' . $organizerEmail, ['CN' => $organizer['name'] ?? $organizerEmail]);
        }
        if (!isset($kept[$organizerEmail])) {
            $event->add('ATTENDEE', 'mailto:' . $organizerEmail, [
                'CN'       => $organizer['name'] ?? (string) ($event->ORGANIZER['CN'] ?? $organizerEmail),
                'ROLE'     => 'CHAIR',
                'PARTSTAT' => 'ACCEPTED',
            ]);
        }
        foreach ($wanted as $email => $name) {
            if (isset($kept[$email])) {
                continue;
            }
            $event->add('ATTENDEE', 'mailto:' . $email, [
                'CN'             => $name,
                'ROLE'           => 'REQ-PARTICIPANT',
                'PARTSTAT'       => 'NEEDS-ACTION',
                'RSVP'           => 'TRUE',
                'SCHEDULE-AGENT' => 'CLIENT',
            ]);
        }
    }

    private static function applyText(VEvent $event, array $changes): void
    {
        foreach (['title' => 'SUMMARY', 'location' => 'LOCATION', 'description' => 'DESCRIPTION', 'url' => 'URL'] as $key => $name) {
            if (array_key_exists($key, $changes)) {
                self::setText($event, $name, $changes[$key]);
            }
        }
    }

    private static function setText(VEvent $event, string $name, ?string $value): void
    {
        unset($event->{$name});
        $value = $value === null ? '' : trim($value);
        if ($value !== '') {
            $event->add($name, $value);
        }
    }

    private static function text(VEvent $event, string $name): ?string
    {
        if (!isset($event->{$name})) {
            return null;
        }
        $value = trim((string) $event->{$name});
        return $value === '' ? null : $value;
    }

    /** One alarm the given minutes before the start, or none; the phone's alarms make way. */
    private static function setReminder(VEvent $event, ?int $minutes): void
    {
        $event->remove('VALARM');
        if ($minutes === null) {
            return;
        }
        $event->add('VALARM', [
            'ACTION'      => 'DISPLAY',
            'DESCRIPTION' => 'Reminder',
            'TRIGGER'     => $minutes === 0 ? 'PT0S' : '-PT' . $minutes . 'M',
        ]);
    }

    /** @return array{0: ?int, 1: bool} [minutes before the start, or null; true when the alarm is one the sheet cannot show] */
    private static function readReminder(VEvent $event): array
    {
        foreach ($event->select('VALARM') as $alarm) {
            $trigger = $alarm->TRIGGER ?? null;
            if ($trigger === null || strtoupper((string) ($trigger['VALUE'] ?? 'DURATION')) !== 'DURATION'
                || strtoupper((string) ($trigger['RELATED'] ?? 'START')) !== 'START') {
                return [null, true];
            }
            $interval = $trigger->getDateInterval();
            $seconds = (($interval->d * 24 + $interval->h) * 60 + $interval->i) * 60 + $interval->s;
            if ($interval->invert !== 1 && $seconds !== 0) {
                return [null, true];
            }
            $minutes = intdiv($seconds, 60);
            return in_array($minutes, self::REMINDERS, true) ? [$minutes, false] : [null, true];
        }
        return [null, false];
    }

    // =========================================================================

    private static function boot(): void
    {
        require_once APP_ROOT . '/vendor/autoload.php';
    }

    private static function read(string $ics): VCalendar
    {
        self::boot();
        $vcal = Reader::read(str_replace(["\r\n", "\r"], "\n", $ics), Reader::OPTION_FORGIVING | Reader::OPTION_IGNORE_INVALID_LINES);
        if (!$vcal instanceof VCalendar) {
            throw new InvalidArgumentException('Not a calendar object.');
        }
        return $vcal;
    }

    /** The event without a RECURRENCE-ID - or a lone override standing in for it. */
    private static function master(VCalendar $vcal): VEvent
    {
        $first = null;
        foreach ($vcal->select('VEVENT') as $event) {
            $first = $first ?? $event;
            if (!isset($event->{'RECURRENCE-ID'})) {
                return $event;
            }
        }
        if ($first === null) {
            throw new InvalidArgumentException('No appointment in this calendar object.');
        }
        return $first;
    }

    private static function zone(): DateTimeZone
    {
        return new DateTimeZone(CALENDAR_TIMEZONE);
    }

    private static function now(): string
    {
        return gmdate('Ymd\THis\Z');
    }

    /** "mailto:Ada@Example.org" -> "ada@example.org". */
    private static function address(string $value): string
    {
        $value = trim($value);
        if (stripos($value, 'mailto:') === 0) {
            $value = substr($value, 7);
        }
        return strtolower(trim($value));
    }
}
