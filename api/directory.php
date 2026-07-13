<?php
/**
 * Contact API alias.
 *
 * Some LiteSpeed/ModSecurity setups apply stricter filters to contact-form-
 * shaped endpoints. Route through a neutral filename while reusing the exact
 * same controller logic from contacts.php.
 */

require __DIR__ . '/contacts.php';
