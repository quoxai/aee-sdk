"""Shared test helpers.

The conformance fixtures live OUTSIDE the Python package, in the monorepo's
``conformance/`` directory, so both the TypeScript and Python suites consume the
identical files. Resolve them via a relative path from this test file.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

# python/tests/conftest.py -> python/tests -> python -> aee-sdk (repo root)
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CONFORMANCE_DIR = _REPO_ROOT / "conformance"
FIXTURES_DIR = CONFORMANCE_DIR / "fixtures"


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf8"))


def files_in(directory: Path) -> list[Path]:
    return sorted(p for p in directory.iterdir() if p.suffix == ".json")


@pytest.fixture
def conformance_dir() -> Path:
    return CONFORMANCE_DIR


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES_DIR
