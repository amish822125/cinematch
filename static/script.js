// =========================================================
// THEME (Dark / Light mode)
// =========================================================
function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    document.getElementById("iconMoon").classList.toggle("hidden", theme === "light");
    document.getElementById("iconSun").classList.toggle("hidden", theme === "dark");
    localStorage.setItem("cinematch_theme", theme);
}

function toggleTheme() {
    let current = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "dark" ? "light" : "dark");
}

(function initTheme() {
    let saved = localStorage.getItem("cinematch_theme");
    let prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(saved || (prefersLight ? "light" : "dark"));
})();

// =========================================================
// FAVORITES (stored client-side as an array of movie IDs)
// =========================================================
const FAV_KEY = "cinematch_favorites";

function getFavorites() {
    try {
        return JSON.parse(localStorage.getItem(FAV_KEY)) || [];
    } catch (e) {
        return [];
    }
}

function isFavorite(id) {
    return getFavorites().includes(id);
}

function toggleFavorite(id, event) {
    event.stopPropagation();
    let favs = getFavorites();
    let idx = favs.indexOf(id);

    if (idx === -1) {
        favs.push(id);
    } else {
        favs.splice(idx, 1);
    }

    localStorage.setItem(FAV_KEY, JSON.stringify(favs));

    document.querySelectorAll(`.favBtn[data-id="${id}"]`).forEach(btn => {
        btn.classList.toggle("active", favs.includes(id));
    });
}

// =========================================================
// CARD RENDERING (shared by grid + rows)
// =========================================================
function heartIcon(filled) {
    return filled
        ? `<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.2 2 4.5 5.6 4c2-.3 3.9.6 5 2.3C11.7 4.6 13.6 3.7 15.6 4c3.6.5 5.2 4.2 3.6 7.7C19.5 16.4 12 21 12 21z" fill="currentColor"/></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.2 2 4.5 5.6 4c2-.3 3.9.6 5 2.3C11.7 4.6 13.6 3.7 15.6 4c3.6.5 5.2 4.2 3.6 7.7C19.5 16.4 12 21 12 21z" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`;
}

function movieCard(movie) {

    let poster = movie.poster
        ? `<img src="${movie.poster}" alt="${movie.title} poster" loading="lazy">`
        : `No poster`;

    let matchBadge = (movie.match !== undefined)
        ? `<div class="matchBadge">${movie.match}% match</div>`
        : "";

    let fav = isFavorite(movie.id);

    let year = movie.year ? movie.year : "—";
    let rating = movie.rating ? Number(movie.rating).toFixed(1) : "—";

    return `
        <div class="card" onclick="openMovie(${movie.id})" tabindex="0"
             onkeydown="if(event.key==='Enter') openMovie(${movie.id})">

            <div class="poster">
                ${poster}
            </div>

            <button class="favBtn ${fav ? "active" : ""}" data-id="${movie.id}"
                    onclick="toggleFavorite(${movie.id}, event)"
                    aria-label="Toggle favorite">
                ${heartIcon(fav)}
            </button>

            ${matchBadge}

            <div class="cardBody">
                <h3>${movie.title}</h3>
                <div class="metaLine">${year} &middot; ★ ${rating}</div>
            </div>

        </div>
    `;
}

function renderGrid(el, data) {
    el.innerHTML = data
        .map((m, i) => movieCard(m).replace('class="card"', `class="card" style="--i:${i}"`))
        .join("");
}

// =========================================================
// SECTION VISIBILITY (single-page-app style show/hide)
// =========================================================
const ALL_SECTIONS = [
    "heroBanner", "homeSections", "searchResults",
    "moodSection", "favoritesSection", "analyticsSection", "detailSection"
];

function hideAllSections() {
    ALL_SECTIONS.forEach(id => document.getElementById(id).classList.add("hidden"));
}

function goHome() {
    hideAllSections();
    document.getElementById("heroBanner").classList.remove("hidden");
    document.getElementById("homeSections").classList.remove("hidden");
    document.getElementById("searchInput").value = "";
}

// =========================================================
// HERO BANNER
// =========================================================
let heroMovieId = null;

async function loadHero() {
    try {
        let res = await fetch("/api/hero");
        let movie = await res.json();

        heroMovieId = movie.id;

        let heroEl = document.getElementById("heroBanner");
        if (movie.backdrop) {
            heroEl.style.backgroundImage = `url("${movie.backdrop}")`;
        }

        document.getElementById("heroTitle").textContent = movie.title;
        document.getElementById("heroOverview").textContent =
            movie.overview || "Pick a movie you love — CineMatch scores every other title in the catalog by plot and genre similarity.";

        document.getElementById("heroMoreBtn").onclick = () => openMovie(heroMovieId);
    } catch (e) {
        console.error("Hero load failed", e);
    }
}

function surpriseMe() {
    // re-roll the hero pick and jump straight into its detail page
    fetch("/api/hero")
        .then(r => r.json())
        .then(movie => openMovie(movie.id));
}

// =========================================================
// GENRE ROWS
// =========================================================
async function loadGenreRows() {
    try {
        let res = await fetch("/api/genres");
        let genreList = await res.json();

        let container = document.getElementById("genreRows");
        container.innerHTML = "";

        for (let genre of genreList) {
            let rowRes = await fetch(`/api/movies/genre/${encodeURIComponent(genre)}?limit=20`);
            let movies = await rowRes.json();
            if (!movies.length) continue;

            let rowEl = document.createElement("div");
            rowEl.className = "genreRow";
            rowEl.innerHTML = `
                <div class="rowTitle">${genre}</div>
                <div class="rowScroll"></div>
            `;
            renderGrid(rowEl.querySelector(".rowScroll"), movies);
            container.appendChild(rowEl);
        }
    } catch (e) {
        console.error("Genre rows load failed", e);
    }
}

// =========================================================
// CATALOG GRID (paginated, "Explore the catalog")
// =========================================================
let currentPage = 1;
const PER_PAGE = 30;

async function loadMovies(page = 1, append = false) {

    let res = await fetch(`/api/movies?page=${page}&per_page=${PER_PAGE}`);
    let data = await res.json();

    let grid = document.getElementById("moviesGrid");

    if (append) {
        let temp = document.createElement("div");
        renderGrid(temp, data);
        while (temp.firstChild) grid.appendChild(temp.firstChild);
    } else {
        renderGrid(grid, data);
    }

    currentPage = page;

    let loadMoreBtn = document.getElementById("loadMoreBtn");
    if (loadMoreBtn) {
        loadMoreBtn.style.display = data.length < PER_PAGE ? "none" : "block";
    }
}

function loadMoreMovies() {
    loadMovies(currentPage + 1, true);
}

// =========================================================
// SEARCH (text + voice)
// =========================================================
async function searchMovies() {

    let q = document.getElementById("searchInput").value;

    if (q.length < 2) {
        // show the home view again, but DON'T touch the input's value —
        // the user is still typing, clearing it here breaks search entirely
        hideAllSections();
        document.getElementById("heroBanner").classList.remove("hidden");
        document.getElementById("homeSections").classList.remove("hidden");
        return;
    }

    let res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    let data = await res.json();

    hideAllSections();
    document.getElementById("searchResults").classList.remove("hidden");

    document.getElementById("searchCount").textContent =
        `${data.length} title${data.length === 1 ? "" : "s"} found`;
    renderGrid(document.getElementById("searchGrid"), data);
}

function startVoiceSearch() {
    let SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        alert("Voice search isn't supported in this browser. Try Chrome on desktop or Android.");
        return;
    }

    let recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let micBtn = document.getElementById("micBtn");
    micBtn.classList.add("listening");

    recognition.onresult = (event) => {
        let transcript = event.results[0][0].transcript;
        document.getElementById("searchInput").value = transcript;
        searchMovies();
    };

    recognition.onerror = () => {
        micBtn.classList.remove("listening");
    };

    recognition.onend = () => {
        micBtn.classList.remove("listening");
    };

    recognition.start();
}

// =========================================================
// AI MOOD RECOMMENDATION
// =========================================================
let activeMood = null;

async function showMoodSection() {
    hideAllSections();
    document.getElementById("moodSection").classList.remove("hidden");

    if (!document.getElementById("moodButtons").children.length) {
        let res = await fetch("/api/moods");
        let moodList = await res.json();

        document.getElementById("moodButtons").innerHTML = moodList.map(m => `
            <button class="moodBtn" data-mood="${m.key}" onclick="pickMood('${m.key}')">
                ${m.label}
            </button>
        `).join("");
    }
}

async function pickMood(moodKey) {
    activeMood = moodKey;

    document.querySelectorAll(".moodBtn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mood === moodKey);
    });

    let res = await fetch(`/api/mood/${encodeURIComponent(moodKey)}?limit=20`);
    let data = await res.json();
    renderGrid(document.getElementById("moodGrid"), data);
}

// =========================================================
// FAVORITES PAGE
// =========================================================
async function showFavoritesSection() {
    hideAllSections();
    document.getElementById("favoritesSection").classList.remove("hidden");

    let favIds = getFavorites();
    let grid = document.getElementById("favoritesGrid");
    let emptyMsg = document.getElementById("favEmptyMsg");

    document.getElementById("favCount").textContent =
        `${favIds.length} saved title${favIds.length === 1 ? "" : "s"}`;

    if (!favIds.length) {
        grid.innerHTML = "";
        emptyMsg.classList.remove("hidden");
        return;
    }
    emptyMsg.classList.add("hidden");

    let res = await fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(favIds),
    });
    let data = await res.json();
    renderGrid(grid, data);
}

// =========================================================
// ANALYTICS DASHBOARD
// =========================================================
let genreChartInstance = null;
let ratingChartInstance = null;

async function showAnalyticsSection() {
    hideAllSections();
    document.getElementById("analyticsSection").classList.remove("hidden");

    let res = await fetch("/api/analytics");
    let stats = await res.json();

    document.getElementById("statsRow").innerHTML = `
        <div class="statCard">
            <div class="statValue">${stats.total_movies.toLocaleString()}</div>
            <div class="statLabel">Total movies</div>
        </div>
        <div class="statCard">
            <div class="statValue">${stats.avg_rating}</div>
            <div class="statLabel">Avg. rating / 10</div>
        </div>
        <div class="statCard">
            <div class="statValue">${stats.avg_popularity}</div>
            <div class="statLabel">Avg. popularity score</div>
        </div>
    `;

    let styles = getComputedStyle(document.documentElement);
    let gold = styles.getPropertyValue("--gold-bright").trim();
    let text = styles.getPropertyValue("--text-muted").trim();
    let hairline = styles.getPropertyValue("--hairline-strong").trim();

    let genreCtx = document.getElementById("genreChart");
    if (genreChartInstance) genreChartInstance.destroy();
    genreChartInstance = new Chart(genreCtx, {
        type: "bar",
        data: {
            labels: stats.genre_distribution.map(g => g.genre),
            datasets: [{ data: stats.genre_distribution.map(g => g.count), backgroundColor: gold }]
        },
        options: {
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: text }, grid: { color: hairline } },
                y: { ticks: { color: text }, grid: { color: hairline } }
            }
        }
    });

    let ratingCtx = document.getElementById("ratingChart");
    if (ratingChartInstance) ratingChartInstance.destroy();
    ratingChartInstance = new Chart(ratingCtx, {
        type: "doughnut",
        data: {
            labels: Object.keys(stats.rating_distribution),
            datasets: [{
                data: Object.values(stats.rating_distribution),
                backgroundColor: ["#5e2029", "#a8763a", "#cf9d4f", "#e3b467", "#f3ece2"]
            }]
        },
        options: { plugins: { legend: { position: "bottom", labels: { color: text } } } }
    });

    document.getElementById("topRatedList").innerHTML = stats.top_rated.map(m => `
        <div class="topRatedRow">
            <span class="trTitle">${m.title}</span>
            <span class="trScore">★ ${Number(m.rating).toFixed(1)}</span>
        </div>
    `).join("");
}

// =========================================================
// MOVIE DETAIL + RECOMMENDATIONS + TRAILER
// =========================================================
let currentMovieId = null;

async function openMovie(id) {

    currentMovieId = id;
    hideAllSections();
    document.getElementById("detailSection").classList.remove("hidden");

    window.scrollTo({ top: 0, behavior: "smooth" });

    let res = await fetch(`/api/movie/${id}`);
    let movie = await res.json();

    let poster = movie.poster
        ? `<img src="${movie.poster}" alt="${movie.title} poster">`
        : `No poster`;

    let genreChips = (movie.genres || "")
        .split(" ")
        .filter(Boolean)
        .map(g => `<span class="chip">${g}</span>`)
        .join("");

    let year = movie.year ? movie.year : "—";
    let rating = movie.rating ? Number(movie.rating).toFixed(1) : "—";

    document.getElementById("movieDetail").innerHTML = `

        <div class="detailBox">

            <div class="detailPoster">
                ${poster}
            </div>

            <div>
                <h1>${movie.title}</h1>

                <div class="detailMeta">${year} &middot; ★ ${rating} / 10</div>

                <p class="overview">${movie.overview}</p>

                <div class="chips">${genreChips}</div>

                <button class="watchTrailerBtn" id="watchTrailerBtn" onclick="loadTrailer(${movie.id})">
                    &#9654; Watch Trailer
                </button>
            </div>

        </div>
    `;

    loadRecommendations(movie.title);
}

async function loadRecommendations(title) {
    let res = await fetch(`/api/recommend?title=${encodeURIComponent(title)}`);
    let data = await res.json();
    renderGrid(document.getElementById("recommendGrid"), data);
}

async function loadTrailer(id) {
    let btn = document.getElementById("watchTrailerBtn");
    btn.disabled = true;
    btn.textContent = "Loading...";

    try {
        let res = await fetch(`/api/trailer/${id}`);
        let data = await res.json();

        btn.disabled = false;
        btn.innerHTML = "&#9654; Watch Trailer";

        if (!data.key) {
            alert("No trailer found for this title.");
            return;
        }

        document.getElementById("trailerFrameWrap").innerHTML =
            `<iframe src="https://www.youtube.com/embed/${data.key}?autoplay=1" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
        document.getElementById("trailerModal").classList.remove("hidden");
    } catch (e) {
        btn.disabled = false;
        btn.innerHTML = "&#9654; Watch Trailer";
        alert("Couldn't load the trailer right now.");
    }
}

function closeTrailer() {
    document.getElementById("trailerModal").classList.add("hidden");
    document.getElementById("trailerFrameWrap").innerHTML = ""; // stop playback
}

function closeTrailerOnOverlay(event) {
    if (event.target.id === "trailerModal") closeTrailer();
}

// =========================================================
// INIT
// =========================================================
loadHero();
loadGenreRows();
loadMovies();
