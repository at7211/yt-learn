import pytest


@pytest.fixture(autouse=True)
def _sequential_chunks(monkeypatch):
    """The fake providers in these tests hand out replies in call order, so chunk segmentation
    runs one at a time here; test_build_parallel.py covers the threaded path explicitly."""
    monkeypatch.setenv("YTLEARN_WORKERS", "1")
