"""ULID Generator.

Universally Unique Lexicographically Sortable Identifier.

Mirrors the TypeScript ``ulid.ts`` (itself ported from quox-dashboard's
``src/lib/aee/ulid.js``). Zero dependencies. 26-character Crockford Base32,
monotonic within the same millisecond.

Format: ``TTTTTTTTTTRRRRRRRRRRRRRRRR``
  - ``T`` = timestamp (10 chars, 48 bits, ms since Unix epoch)
  - ``R`` = randomness (16 chars, 80 bits)
"""

from __future__ import annotations

import secrets
import threading
import time

CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ENCODING_LENGTH = 32
ULID_LENGTH = 26
TIME_LENGTH = 10
RANDOM_LENGTH = 16

# Maximum timestamp (10889-08-02T05:31:50.655Z).
MAX_TIME = (2**48) - 1

# Track last timestamp and random values for monotonicity within a ms. Guarded
# by a lock so concurrent threads cannot corrupt the shared increment state
# (which would otherwise emit duplicate ULIDs under contention).
_last_time = 0
_last_random = [0] * RANDOM_LENGTH
_lock = threading.Lock()


def _encode_time(timestamp: int) -> str:
    if timestamp > MAX_TIME:
        raise ValueError("ULID timestamp overflow")

    chars = [""] * TIME_LENGTH
    for i in range(TIME_LENGTH - 1, -1, -1):
        mod = timestamp % ENCODING_LENGTH
        chars[i] = CROCKFORD_BASE32[mod]
        timestamp = timestamp // ENCODING_LENGTH
    return "".join(chars)


def _generate_randomness() -> list[int]:
    """Generate the random component using a cryptographically secure source.

    Uses ``secrets`` (never a non-secure PRNG), mirroring the TS insistence on
    ``crypto.getRandomValues``.
    """
    return [secrets.randbelow(ENCODING_LENGTH) for _ in range(RANDOM_LENGTH)]


def _encode_random(random: list[int]) -> str:
    return "".join(CROCKFORD_BASE32[v] for v in random)


def _increment_random(random: list[int]) -> list[int]:
    """Increment the random component for within-ms monotonicity."""
    new_random = list(random)
    for i in range(RANDOM_LENGTH - 1, -1, -1):
        if new_random[i] < ENCODING_LENGTH - 1:
            new_random[i] += 1
            return new_random
        new_random[i] = 0
    raise ValueError("ULID random overflow (too many IDs in same millisecond)")


def ulid(timestamp: int | None = None) -> str:
    """Generate a new ULID.

    :param timestamp: Optional millisecond timestamp (defaults to now).
    :returns: 26-character ULID string.
    """
    global _last_time, _last_random

    if timestamp is None:
        timestamp = int(time.time() * 1000)

    # Ensure monotonicity within the same millisecond (and non-decreasing time).
    # An explicit timestamp at or below _last_time (clock skew or out-of-order
    # backfill) is CLAMPED up to _last_time with an incremented random component,
    # so output never sorts backwards relative to a prior id. The lock makes the
    # read-modify-write atomic across threads.
    with _lock:
        if timestamp <= _last_time:
            _last_random = _increment_random(_last_random)
            timestamp = _last_time
        else:
            _last_time = timestamp
            _last_random = _generate_randomness()

        return _encode_time(timestamp) + _encode_random(_last_random)


def ulid_time(id: str) -> int:
    """Extract the Unix millisecond timestamp encoded in a ULID."""
    if not isinstance(id, str) or len(id) != ULID_LENGTH:
        raise ValueError("Invalid ULID format")

    time_chars = id[:TIME_LENGTH].upper()
    timestamp = 0
    for char in time_chars:
        index = CROCKFORD_BASE32.find(char)
        if index == -1:
            raise ValueError(f"Invalid character in ULID: {char}")
        timestamp = timestamp * ENCODING_LENGTH + index
    return timestamp


def is_valid_ulid(id: object) -> bool:
    """Validate a ULID format (26 chars, Crockford Base32 alphabet)."""
    if not isinstance(id, str) or len(id) != ULID_LENGTH:
        return False
    upper = id.upper()
    return all(char in CROCKFORD_BASE32 for char in upper)


def prefixed_ulid(prefix: str) -> str:
    """Generate a ULID with a category prefix.

    e.g. ``prefixed_ulid('CONV')`` -> ``'CONV_01ARZ3NDEKTSV4RRFFQ69G5FAV'``.
    """
    return f"{prefix}_{ulid()}"


def compare_ulid(a: str, b: str) -> int:
    """Compare two ULIDs for lexicographic sorting (-1, 0, or 1)."""
    if a < b:
        return -1
    if a > b:
        return 1
    return 0
