"""
TMDB integration - fetches poster + release date for local dataset titles.
Falls back gracefully to no-poster if TMDB_API_KEY is missing or a title
isn't found, so the app never crashes because of this.
"""
import os
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

TMDB_API_KEY = os.getenv("TMDB_API_KEY", "").strip()
TMDB_SEARCH_URL = "https://api.themoviedb.org/3/search/movie"
TMDB_VIDEOS_URL = "https://api.themoviedb.org/3/movie"
TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500"
TMDB_BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280"

# in-memory cache: title -> {"poster_url": ..., "release_date": ...}
_cache = {}


def _fetch_one(title: str) -> dict:
    if title in _cache:
        return _cache[title]

    result = {"poster_url": "", "backdrop_url": "", "release_date": "", "tmdb_id": None}

    if not TMDB_API_KEY:
        _cache[title] = result
        return result

    try:
        resp = requests.get(
            TMDB_SEARCH_URL,
            params={"api_key": TMDB_API_KEY, "query": title, "include_adult": "false"},
            timeout=5,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
        if results:
            top = results[0]
            poster_path = top.get("poster_path")
            backdrop_path = top.get("backdrop_path")
            result["poster_url"] = f"{TMDB_IMG_BASE}{poster_path}" if poster_path else ""
            result["backdrop_url"] = f"{TMDB_BACKDROP_BASE}{backdrop_path}" if backdrop_path else ""
            result["release_date"] = top.get("release_date", "") or ""
            result["tmdb_id"] = top.get("id")
    except requests.RequestException:
        pass  # keep empty defaults, never crash the request

    _cache[title] = result
    return result


def get_trailer_key(tmdb_id) -> str:
    """Returns a YouTube video key for the movie's official trailer, or ''."""
    if not TMDB_API_KEY or not tmdb_id:
        return ""

    cache_key = f"trailer:{tmdb_id}"
    if cache_key in _cache:
        return _cache[cache_key]

    key = ""
    try:
        resp = requests.get(
            f"{TMDB_VIDEOS_URL}/{tmdb_id}/videos",
            params={"api_key": TMDB_API_KEY},
            timeout=5,
        )
        resp.raise_for_status()
        vids = resp.json().get("results", [])
        # prefer an official YouTube "Trailer", fall back to any YouTube video
        trailer = next(
            (v for v in vids if v.get("site") == "YouTube" and v.get("type") == "Trailer"),
            next((v for v in vids if v.get("site") == "YouTube"), None),
        )
        if trailer:
            key = trailer.get("key", "")
    except requests.RequestException:
        pass

    _cache[cache_key] = key
    return key


def get_poster_info(title: str) -> dict:
    """Single title lookup (cached)."""
    return _fetch_one(title)


def get_poster_info_bulk(titles: list, max_workers: int = 10) -> dict:
    """
    Parallel lookup for a list of titles (used by list/grid endpoints so
    the whole page doesn't wait on TMDB one request at a time).
    Returns {title: {poster_url, release_date}}.
    """
    out = {}
    uncached = [t for t in titles if t not in _cache]

    if uncached:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(_fetch_one, t): t for t in uncached}
            for future in as_completed(futures):
                t = futures[future]
                out[t] = future.result()

    for t in titles:
        if t in _cache:
            out[t] = _cache[t]

    return out
