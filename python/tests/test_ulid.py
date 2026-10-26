import re
import threading
import time

import pytest

from quox_aee import compare_ulid, is_valid_ulid, prefixed_ulid, ulid
from quox_aee.ulid import ulid_time

ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def test_produces_26_char_crockford_base32():
    id_ = ulid()
    assert len(id_) == 26
    assert ULID_RE.match(id_)


def test_encodes_supplied_timestamp_recoverably():
    # Use "now": a non-decreasing timestamp is never clamped, so it round-trips.
    t = int(time.time() * 1000)
    id_ = ulid(t)
    assert ulid_time(id_) == t


def test_monotonic_within_same_millisecond():
    t = 1700000000000
    ids = [ulid(t) for _ in range(50)]
    for i in range(1, len(ids)):
        assert compare_ulid(ids[i - 1], ids[i]) < 0


def test_never_produces_duplicates_in_tight_loop():
    seen = {ulid() for _ in range(1000)}
    assert len(seen) == 1000


def test_lexicographically_increasing_across_advancing_timestamps():
    a = ulid(1000)
    b = ulid(2000)
    assert a < b


def test_is_valid_ulid():
    assert is_valid_ulid(ulid()) is True
    assert is_valid_ulid("not-a-ulid") is False
    assert is_valid_ulid("01ARZ3NDEKTSV4RRFFQ69G5FAI") is False  # contains I
    assert is_valid_ulid(12345) is False


def test_prefixed_ulid_prepends_category_and_underscore():
    id_ = prefixed_ulid("CONV")
    assert id_.startswith("CONV_")
    assert is_valid_ulid(id_[5:])


def test_ulid_time_rejects_malformed_input():
    with pytest.raises(ValueError, match="Invalid ULID"):
        ulid_time("short")
    # 'I' in the time portion (first 10 chars) is not a Crockford Base32 char.
    with pytest.raises(ValueError, match="Invalid character"):
        ulid_time("0I000000000000000000000000")


def test_compare_ulid_returns_zero_for_equal():
    assert compare_ulid("A", "A") == 0
    assert compare_ulid("B", "A") == 1


def test_explicit_past_timestamp_after_future_does_not_sort_backwards():
    base = int(time.time() * 1000) + 100_000
    future = ulid(base + 1000)
    past = ulid(base)
    # Monotonic output: the later call sorts AFTER (>=) the earlier one.
    assert past >= future
    # The clamped timestamp is lifted to lastTime, never a time before future.
    assert ulid_time(past) == ulid_time(future)


def test_threading_no_duplicates_under_concurrency():
    ids: list[str] = []
    list_lock = threading.Lock()

    def worker():
        local = [ulid() for _ in range(200)]
        with list_lock:
            ids.extend(local)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # The module-state lock guarantees every id is unique across threads.
    assert len(ids) == len(set(ids))
