"""A small, polite HTTP client with an on-disk cache.

UC3M's servers are slow and sometimes mislabel encodings, so pages are cached as raw bytes and
decoded here: UTF-8 when the bytes are valid UTF-8, Windows-1252 otherwise.
"""

from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TypeVar

import requests
import urllib3

log = logging.getLogger(__name__)
T = TypeVar("T")

# aplicaciones.uc3m.es serves an incomplete certificate chain; these are public pages.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


def decode(raw: bytes) -> str:
    """Decode a page whose declared charset can't be trusted."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


class Fetcher:
    """GET with retries, an on-disk cache and a bounded worker pool."""

    def __init__(self, cache_dir: Path, *, refresh: bool = False, workers: int = 6, timeout: float = 40):
        self.cache_dir = cache_dir
        self.refresh = refresh
        self.workers = workers
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "uc3m-course-planner (student project; low request rate)"
        cache_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, url: str) -> Path:
        return self.cache_dir / (hashlib.md5(url.encode()).hexdigest() + ".bin")

    def get(self, url: str) -> str:
        path = self._path(url)
        if path.exists() and not self.refresh:
            return decode(path.read_bytes())
        for attempt in range(4):
            try:
                resp = self.session.get(url, timeout=self.timeout, verify=False)
                resp.raise_for_status()
                break
            except requests.RequestException as exc:
                if attempt == 3:
                    raise
                log.warning("retrying %s (%s)", url, exc)
                time.sleep(2 * (attempt + 1))
        path.write_bytes(resp.content)
        return decode(resp.content)

    def map(self, fn: Callable[[str], T], urls: Iterable[str]) -> dict[str, T]:
        """Fetch and parse many URLs concurrently; returns {url: fn(html)}."""
        urls = list(dict.fromkeys(urls))
        with ThreadPoolExecutor(self.workers) as pool:
            results = pool.map(lambda u: fn(self.get(u)), urls)
            return dict(zip(urls, results, strict=True))
