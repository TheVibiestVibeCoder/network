<?php
/**
 * Reading calendar objects for the team calendar
 *
 * One CalDAV object (a VCALENDAR with one event and, for a series, its moved
 * or changed occurrences) goes in; what the CRM stores comes out: the master
 * event's fields, and every occurrence inside the sync window with series,
 * exceptions and overrides already applied by sabre/vobject.
 *
 * Times: timed occurrences come out in UTC ('Y-m-d H:i:s'), all-day ones as
 * plain dates ('Y-m-d', end exclusive) - an all-day appointment is on that
 * date wherever you look at it from. Times without a zone ("floating") are
 * read in CALENDAR_TIMEZONE.
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
use Sabre\VObject\Reader;
use Sabre\VObject\Recur\EventIterator;
use Sabre\VObject\Recur\NoInstancesException;

final class CalendarIcs
{
    private const UTC_FORMAT = 'Y-m-d H:i:s';
    private const DATE_FORMAT = 'Y-m-d';

    /** Hosts whose links are treated as a video call. */
    private const VIDEO_HOSTS = [
        'meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com',
        'whereby.com', 'meet.jit.si', 'webex.com', 'gotomeeting.com', 'meet.goto.com',
    ];

    /**
     * Read one object.
     *
     * Returns null when it holds no event at all (a to-do, say).
     *
     * @return array{
     *   uid: string,
     *   master: array,
     *   instances: list<array>,
     *   recurring: bool,
     *   archivable: bool
     * }|null
     */
    public static function read(string $ics, DateTimeImmutable $windowStart, DateTimeImmutable $windowEnd, DateTimeImmutable $retentionCutoff): ?array
    {
        // Only reading needs sabre/vobject; pages that merely show the
        // calendar do not pay for the autoloader.
        require_once APP_ROOT . '/vendor/autoload.php';

        $vcalendar = Reader::read(self::normalize($ics), Reader::OPTION_FORGIVING | Reader::OPTION_IGNORE_INVALID_LINES);
        if (!$vcalendar instanceof VCalendar) {
            return null;
        }

        $events = [];
        foreach ($vcalendar->select('VEVENT') as $event) {
            $events[] = $event;
        }
        if (!$events) {
            return null;
        }

        // The master is the event without a RECURRENCE-ID; a lone override
        // (the server holds only one moved occurrence) stands in for it.
        $master = $events[0];
        foreach ($events as $event) {
            if (!isset($event->{'RECURRENCE-ID'})) {
                $master = $event;
                break;
            }
        }
        $uid = trim((string) $master->UID);
        $recurring = isset($master->RRULE) || isset($master->RDATE) || count($events) > 1 || isset($master->{'RECURRENCE-ID'});
        $localZone = new DateTimeZone(CALENDAR_TIMEZONE);

        $masterFields = self::fields($master, $localZone);

        // Occurrences in the window. expand() needs a UID on every event.
        $instances = [];
        if ($uid !== '') {
            $expanded = $vcalendar->expand($windowStart, $windowEnd, $localZone);
            foreach ($expanded->select('VEVENT') as $occurrence) {
                $fields = self::fields($occurrence, $localZone);
                $fields['recurrence_id'] = isset($occurrence->{'RECURRENCE-ID'})
                    ? self::stamp($occurrence->{'RECURRENCE-ID'}->getDateTime($localZone), $occurrence->{'RECURRENCE-ID'}->hasTime())
                    : null;
                $instances[] = $fields;
            }
        }

        return [
            'uid'        => $uid,
            'master'     => $masterFields,
            'instances'  => $instances,
            'recurring'  => $recurring,
            'archivable' => self::finishedBefore($vcalendar, $master, $uid, $recurring, $retentionCutoff, $localZone),
        ];
    }

    /** Hash of what an object says, independent of line-ending differences. */
    public static function hash(string $ics): string
    {
        return hash('sha256', self::normalize($ics));
    }

    /** The first video-call link in an occurrence's location, URL or description. */
    public static function videoLink(?string ...$texts): ?string
    {
        foreach ($texts as $text) {
            if ($text === null || $text === '') {
                continue;
            }
            if (preg_match_all('#https?://[^\s<>"\')\]]+#i', $text, $matches)) {
                foreach ($matches[0] as $url) {
                    $host = strtolower((string) parse_url($url, PHP_URL_HOST));
                    foreach (self::VIDEO_HOSTS as $videoHost) {
                        if ($host === $videoHost || substr($host, -strlen('.' . $videoHost)) === '.' . $videoHost) {
                            return rtrim($url, '.,;');
                        }
                    }
                }
            }
        }
        return null;
    }

    // -------------------------------------------------------------------------

    private static function normalize(string $ics): string
    {
        return trim(str_replace(["\r\n", "\r"], "\n", $ics));
    }

    /** What the CRM keeps of one event or occurrence. */
    private static function fields(VEvent $event, DateTimeZone $localZone): array
    {
        $allDay = isset($event->DTSTART) && !$event->DTSTART->hasTime();
        $start = isset($event->DTSTART) ? $event->DTSTART->getDateTime($localZone) : null;
        $end = self::end($event, $start, $allDay, $localZone);

        $organizer = null;
        if (isset($event->ORGANIZER)) {
            $organizer = [
                'email' => self::address((string) $event->ORGANIZER->getValue()),
                'name'  => isset($event->ORGANIZER['CN']) ? (string) $event->ORGANIZER['CN'] : null,
            ];
        }

        $attendees = [];
        foreach ($event->select('ATTENDEE') as $attendee) {
            $email = self::address((string) $attendee->getValue());
            if ($email === '') {
                continue;
            }
            $attendees[] = [
                'email'    => $email,
                'name'     => isset($attendee['CN']) ? (string) $attendee['CN'] : null,
                'partstat' => isset($attendee['PARTSTAT']) ? strtoupper((string) $attendee['PARTSTAT']) : 'NEEDS-ACTION',
                'role'     => isset($attendee['ROLE']) ? strtoupper((string) $attendee['ROLE']) : 'REQ-PARTICIPANT',
            ];
        }

        return [
            'starts_at'   => $start !== null ? self::stamp($start, !$allDay) : null,
            'ends_at'     => $end !== null ? self::stamp($end, !$allDay) : null,
            'all_day'     => $allDay,
            'summary'     => self::textValue($event, 'SUMMARY'),
            'location'    => self::textValue($event, 'LOCATION'),
            'description' => self::textValue($event, 'DESCRIPTION'),
            'url'         => self::textValue($event, 'URL'),
            'status'      => isset($event->STATUS) ? strtoupper((string) $event->STATUS) : null,
            'class'       => isset($event->CLASS) ? strtoupper((string) $event->CLASS) : 'PUBLIC',
            'transparent' => isset($event->TRANSP) && strtoupper((string) $event->TRANSP) === 'TRANSPARENT',
            'sequence'    => isset($event->SEQUENCE) ? (int) (string) $event->SEQUENCE : 0,
            'organizer'   => $organizer,
            'attendees'   => $attendees,
        ];
    }

    /** DTEND, else DTSTART + DURATION, else one day (all-day) or no length at all. */
    private static function end(VEvent $event, ?DateTimeImmutable $start, bool $allDay, DateTimeZone $localZone): ?DateTimeImmutable
    {
        if (isset($event->DTEND)) {
            return $event->DTEND->getDateTime($localZone);
        }
        if ($start === null) {
            return null;
        }
        if (isset($event->DURATION)) {
            return $start->add($event->DURATION->getDateInterval());
        }
        return $allDay ? $start->modify('+1 day') : $start;
    }

    private static function stamp(DateTimeInterface $time, bool $hasTime): string
    {
        if (!$hasTime) {
            return $time->format(self::DATE_FORMAT);
        }
        return DateTimeImmutable::createFromInterface($time)->setTimezone(new DateTimeZone('UTC'))->format(self::UTC_FORMAT);
    }

    private static function textValue(VEvent $event, string $name): ?string
    {
        if (!isset($event->{$name})) {
            return null;
        }
        $value = trim((string) $event->{$name});
        return $value === '' ? null : $value;
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

    /**
     * True when every occurrence ended before the retention cutoff - the
     * appointment is old enough that the cache drops its contents.
     */
    private static function finishedBefore(VCalendar $vcalendar, VEvent $master, string $uid, bool $recurring, DateTimeImmutable $cutoff, DateTimeZone $localZone): bool
    {
        if (!$recurring) {
            $fields = self::fields($master, $localZone);
            if ($fields['ends_at'] === null) {
                return false;
            }
            $cutoffStamp = $fields['all_day'] ? $cutoff->format(self::DATE_FORMAT) : $cutoff->setTimezone(new DateTimeZone('UTC'))->format(self::UTC_FORMAT);
            return $fields['ends_at'] < $cutoffStamp;
        }
        if ($uid === '') {
            return false;
        }
        try {
            $iterator = new EventIterator($vcalendar, $uid, $localZone);
        } catch (NoInstancesException $e) {
            return true;
        }
        if ($iterator->isInfinite()) {
            return false;
        }
        $iterator->fastForward($cutoff);
        return !$iterator->valid();
    }
}
