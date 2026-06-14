// ============================================================
// reddit.js - Señales de comunidad via Hacker News + RSS cripto
// HN API pública (sin auth) + feeds RSS de medios cripto
// ============================================================

// Hacker News: stories top del día con keywords cripto/macro
const KEYWORDS = ["bitcoin", "crypto", "ethereum", "btc", "fed", "inflation", "macro", "blockchain", "defi", "stablecoin"];

async function getHackerNewsSignals() {
  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!res.ok) throw new Error(`HN HTTP ${res.status}`);
  const ids = await res.json();

  // Cogemos los primeros 60 y filtramos por keywords
  const primeros = ids.slice(0, 150);
  const stories = await Promise.all(
    primeros.map((id) =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
        .then((r) => r.json())
        .catch(() => null)
    )
  );

  return stories
    .filter((s) => {
      if (!s?.title) return false;
      const titulo = s.title.toLowerCase();
      return KEYWORDS.some((k) => titulo.includes(k));
    })
    .map((s) => ({
      titulo: s.title,
      subreddit: "HackerNews",
      score: s.score ?? 0,
      comentarios: s.descendants ?? 0,
      url: s.url ?? `https://news.ycombinator.com/item?id=${s.id}`,
      texto: "",
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

export async function getRedditSignals() {
  try {
    const posts = await getHackerNewsSignals();
    console.log(`   ✓ ${posts.length} posts relevantes (HackerNews)`);
    return posts;
  } catch (e) {
    console.warn("⚠️  HackerNews no disponible:", e.message);
    return [];
  }
}
