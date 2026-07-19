from flask import Flask, render_template, jsonify, request
import pickle
import pandas as pd
from sklearn.metrics.pairwise import cosine_similarity
from dotenv import load_dotenv

import tmdb_service

load_dotenv()

app = Flask(__name__)

# =========================
# LOAD DATA
# =========================
df = pickle.load(open("df.pkl", "rb"))
tfidf_matrix = pickle.load(open("tfidf_matrix.pkl", "rb"))

# BUG FIX: ~12,695 rows store `popularity` as a string instead of a float,
# which crashes any sort_values() call on this column. Coerce to numeric.
df["popularity"] = pd.to_numeric(df["popularity"], errors="coerce").fillna(0.0)

# BUG FIX: the dataset has ~3170 duplicate titles. The old code trusted
# indices.pkl as-is, so indices[title] could return a Series instead of a
# single int and break `tfidf_matrix[idx]`. We rebuild a clean, deduplicated
# title -> row index map here, keeping the most popular version of each title.
df = df.reset_index(drop=True)
df["_orig_idx"] = df.index

df_sorted_by_popularity = df.sort_values("popularity", ascending=False)
indices = (
    df_sorted_by_popularity
    .drop_duplicates(subset="title", keep="first")
    .set_index("title")["_orig_idx"]
)

# normalized lookup for case-insensitive search/recommend
_title_lookup = {t.lower(): t for t in indices.index}

# BUG FIX / FEATURE: genres column is a single space-separated string
# (e.g. "Animation Comedy Family"), but a few genre names are themselves
# two words ("Science Fiction", "TV Movie") — a naive .split() breaks
# those into meaningless single-word tokens ("Science", "Fiction").
# Join the known compounds with an underscore before splitting so they
# survive as one token; underscore is swapped back to a space for display.
_COMPOUND_GENRES = {"Science Fiction": "Science_Fiction", "TV Movie": "TV_Movie"}
df["_genres_norm"] = df["genres"]
for original, joined in _COMPOUND_GENRES.items():
    df["_genres_norm"] = df["_genres_norm"].str.replace(original, joined, regex=False)

_genre_counts = {}
for g_str in df["_genres_norm"].dropna():
    for g in g_str.split():
        _genre_counts[g] = _genre_counts.get(g, 0) + 1
TOP_GENRES = [g.replace("_", " ") for g, _ in sorted(_genre_counts.items(), key=lambda x: -x[1])][:12]

# FEATURE: AI Mood Recommendation. "AI" here is a lightweight, explainable
# genre + keyword scorer (no external model call) — each mood maps to the
# genres that best fit it, plus overview/tagline keywords that nudge the
# ranking within those genres.
MOOD_MAP = {
    "Happy":     {"label": "😄 Happy",     "genres": ["Comedy", "Family", "Animation"], "keywords": ["fun", "joy", "laugh", "hilarious", "feel-good"]},
    "Sad":       {"label": "😢 Sad",       "genres": ["Drama"],                         "keywords": ["loss", "grief", "tragedy", "heartbreak", "emotional"]},
    "Romantic":  {"label": "❤️ Romantic",  "genres": ["Romance"],                       "keywords": ["love", "romance", "heart", "wedding"]},
    "Thrilling": {"label": "⚡ Thrilling",  "genres": ["Thriller", "Action", "Crime"],   "keywords": ["danger", "chase", "suspense", "heist"]},
    "Scary":     {"label": "👻 Scary",     "genres": ["Horror", "Mystery"],             "keywords": ["fear", "horror", "haunted", "terrifying"]},
    "Relaxed":   {"label": "🌿 Relaxed",   "genres": ["Documentary", "Family"],         "keywords": ["calm", "peaceful", "nature", "journey"]},
    "Adventurous": {"label": "🧭 Adventurous", "genres": ["Adventure", "Fantasy", "Science Fiction"], "keywords": ["adventure", "quest", "explore", "epic"]},
}


def resolve_title(raw_title: str):
    """Case-insensitive exact title match. Returns canonical title or None."""
    return _title_lookup.get(raw_title.strip().lower())


def movie_to_dict(row, poster_info=None):
    poster_info = poster_info or {}
    return {
        "id": int(row.name),
        "title": row.get("title", ""),
        "genres": row.get("genres", ""),
        "overview": row.get("overview", ""),
        "rating": row.get("vote_average", ""),
        "year": str(poster_info.get("release_date", ""))[:4],
        "poster": poster_info.get("poster_url", ""),
        "backdrop": poster_info.get("backdrop_url", ""),
        "tmdb_id": poster_info.get("tmdb_id"),
    }


def rows_to_json_with_posters(rows_df):
    """Attach TMDB posters in parallel, then build the JSON payload."""
    titles = rows_df["title"].tolist()
    poster_map = tmdb_service.get_poster_info_bulk(titles)
    return [
        movie_to_dict(row, poster_map.get(row["title"], {}))
        for _, row in rows_df.iterrows()
    ]


# =========================
# ROUTES
# =========================
@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/movies")
def movies():
    page = max(int(request.args.get("page", 1)), 1)
    per_page = min(int(request.args.get("per_page", 30)), 50)

    # show most popular movies first instead of arbitrary dataset order
    ordered = df.sort_values("popularity", ascending=False)
    start = (page - 1) * per_page
    sample = ordered.iloc[start:start + per_page]

    return jsonify(rows_to_json_with_posters(sample))


@app.route("/api/genres")
def genres():
    """Ranked list of genres present in this dataset, for the homepage rows."""
    return jsonify(TOP_GENRES)


@app.route("/api/movies/genre/<genre>")
def movies_by_genre(genre):
    """One row's worth of movies for a given genre, sorted by popularity."""
    limit = min(int(request.args.get("limit", 20)), 40)

    genre_token = genre.replace(" ", "_")
    mask = df["_genres_norm"].str.contains(rf"\b{genre_token}\b", case=False, na=False, regex=True)
    result = df[mask].sort_values("popularity", ascending=False).head(limit)

    return jsonify(rows_to_json_with_posters(result))


@app.route("/api/hero")
def hero():
    """A featured movie (with backdrop) for the Netflix-style hero banner.
    Picked randomly from the top 20 most popular titles so it's not the
    exact same movie on every page load, but always something well-known."""
    top20 = df.sort_values("popularity", ascending=False).head(20)
    row = top20.sample(1).iloc[0]
    poster_info = tmdb_service.get_poster_info(row["title"])
    return jsonify(movie_to_dict(row, poster_info))


@app.route("/api/search")
def search():
    q = request.args.get("q", "").strip().lower()
    if not q:
        return jsonify([])

    result = df[df["title"].str.lower().str.contains(q, na=False)]
    result = result.sort_values("popularity", ascending=False).head(15)

    return jsonify(rows_to_json_with_posters(result))


@app.route("/api/movie/<int:id>")
def movie(id):
    if id < 0 or id >= len(df):
        return jsonify({"error": "Movie not found"}), 404

    row = df.iloc[id]
    poster_info = tmdb_service.get_poster_info(row["title"])
    return jsonify(movie_to_dict(row, poster_info))


@app.route("/api/recommend")
def recommend():
    raw_title = request.args.get("title", "")
    limit = min(int(request.args.get("limit", 8)), 30)

    canonical_title = resolve_title(raw_title)
    if canonical_title is None:
        return jsonify([])

    idx = int(indices[canonical_title])

    sim_scores = cosine_similarity(tfidf_matrix[idx], tfidf_matrix).flatten()
    movie_indices = sim_scores.argsort()[::-1][1:limit + 1]

    result = df.iloc[movie_indices]
    titles = result["title"].tolist()
    poster_map = tmdb_service.get_poster_info_bulk(titles)

    output = []
    for pos, (_, row) in zip(movie_indices, result.iterrows()):
        item = movie_to_dict(row, poster_map.get(row["title"], {}))
        # cosine similarity is 0-1; surface it as a % match for the UI
        item["match"] = round(float(sim_scores[pos]) * 100, 1)
        output.append(item)

    return jsonify(output)


@app.route("/api/moods")
def moods():
    """List of moods for the mood-picker buttons."""
    return jsonify([{"key": k, "label": v["label"]} for k, v in MOOD_MAP.items()])


@app.route("/api/mood/<mood_key>")
def mood_recommend(mood_key):
    """AI Mood Recommendation: filter by the mood's genres, then rank within
    that pool by popularity + a keyword-match boost from overview/tagline."""
    limit = min(int(request.args.get("limit", 20)), 40)

    conf = MOOD_MAP.get(mood_key)
    if conf is None:
        return jsonify([])

    genre_tokens = [g.replace(" ", "_") for g in conf["genres"]]
    pattern = "|".join(rf"\b{g}\b" for g in genre_tokens)
    subset = df[df["_genres_norm"].str.contains(pattern, case=False, na=False, regex=True)].copy()

    keywords = conf["keywords"]

    def keyword_hits(row):
        text = f"{row.get('overview', '')} {row.get('tagline', '')}".lower()
        return sum(text.count(k) for k in keywords)

    subset["_mood_score"] = subset["popularity"] + subset.apply(keyword_hits, axis=1) * 5
    result = subset.sort_values("_mood_score", ascending=False).head(limit)

    return jsonify(rows_to_json_with_posters(result))


@app.route("/api/trailer/<int:id>")
def trailer(id):
    """YouTube trailer key for the Trailer Popup feature."""
    if id < 0 or id >= len(df):
        return jsonify({"key": ""}), 404

    row = df.iloc[id]
    poster_info = tmdb_service.get_poster_info(row["title"])
    key = tmdb_service.get_trailer_key(poster_info.get("tmdb_id"))
    return jsonify({"key": key})


@app.route("/api/favorites", methods=["POST"])
def favorites():
    """Bulk-hydrate a list of favorited movie IDs (sent from localStorage
    on the client) into full movie cards for the Favorites page."""
    ids = request.get_json(silent=True) or []
    ids = [i for i in ids if isinstance(i, int) and 0 <= i < len(df)]

    if not ids:
        return jsonify([])

    result = df.iloc[ids]
    return jsonify(rows_to_json_with_posters(result))


@app.route("/api/analytics")
def analytics():
    """Aggregate stats for the Analytics Dashboard."""
    rated = df[df["vote_average"].notna() & (df["vote_average"] > 0)]

    # rating distribution in 5 buckets of 2 points each
    bins = [0, 2, 4, 6, 8, 10]
    labels = ["0-2", "2-4", "4-6", "6-8", "8-10"]
    rating_counts = pd.cut(rated["vote_average"], bins=bins, labels=labels, include_lowest=True)
    rating_distribution = rating_counts.value_counts().reindex(labels).fillna(0).astype(int).to_dict()

    top_genres = sorted(_genre_counts.items(), key=lambda x: -x[1])[:10]
    top_genres = [{"genre": g.replace("_", " "), "count": c} for g, c in top_genres]

    top_rated = (
        rated[rated["popularity"] > rated["popularity"].quantile(0.5)]  # filter out obscure titles with a single 10/10 vote
        .sort_values("vote_average", ascending=False)
        .head(10)[["title", "vote_average", "popularity"]]
        .rename(columns={"vote_average": "rating"})
        .to_dict(orient="records")
    )

    return jsonify({
        "total_movies": int(len(df)),
        "avg_rating": round(float(rated["vote_average"].mean()), 2),
        "avg_popularity": round(float(df["popularity"].mean()), 2),
        "genre_distribution": top_genres,
        "rating_distribution": rating_distribution,
        "top_rated": top_rated,
    })


if __name__ == "__main__":
    app.run(debug=True)
