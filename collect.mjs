import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SNAPSHOT_DIR = path.join("data", "snapshots");
const LATEST_PATH = path.join("data", "latest.json");
const API_URL = "https://api.github.com/search/repositories";
const REQUEST_INTERVAL_MS = 2_000;
const MAX_RETRIES = 3;
const DAY_MS = 24 * 60 * 60 * 1_000;

// 通常は10ページ取得する。動作確認時だけページ数を少なくできるようにする。
const pages = Number.parseInt(process.env.COLLECT_PAGES ?? "10", 10);
if (!Number.isInteger(pages) || pages < 1 || pages > 10) {
  throw new Error("COLLECT_PAGES は1から10の整数で指定してください");
}

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "github-momentum-collector",
};
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

let lastRequestAt = 0;

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    // Search APIの制限を避けるため、再試行も含め全リクエストの間隔を空ける。
    const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();

    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response;

      const detail = await response.text();
      if (attempt === MAX_RETRIES) {
        throw new Error(`GitHub API error ${response.status}: ${detail}`);
      }
      console.warn(`HTTP ${response.status}: 再試行します (${attempt + 1}/${MAX_RETRIES})`);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      console.warn(`通信エラー: 再試行します (${attempt + 1}/${MAX_RETRIES})`);
    }

    // 1秒、2秒、4秒と指数的に待機する。
    await sleep(1_000 * 2 ** attempt);
  }

  throw new Error("GitHub APIからデータを取得できませんでした");
}

function parseSnapshotDate(fileName) {
  const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(fileName);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]
    ? null
    : { date: match[1], timestamp: date.getTime(), fileName };
}

async function main() {
  const collected = [];
  for (let page = 1; page <= pages; page += 1) {
    const query = new URLSearchParams({
      q: "stars:>5000",
      sort: "stars",
      order: "desc",
      per_page: "100",
      page: String(page),
    });
    const response = await fetchWithRetry(`${API_URL}?${query}`);
    const body = await response.json();
    if (!Array.isArray(body.items)) throw new Error("GitHub APIの応答形式が不正です");
    collected.push(...body.items);
    console.log(`${page}/${pages} ページを取得しました`);
  }

  const generatedAt = new Date();
  const today = generatedAt.toISOString().slice(0, 10);
  const todayTimestamp = Date.parse(`${today}T00:00:00.000Z`);
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  // 毎日蓄積するスナップショットには、勢いの計算に必要な名前とstar数だけを保存する。
  const snapshot = collected.map((repo) => [repo.full_name, repo.stargazers_count]);
  await writeFile(path.join(SNAPSHOT_DIR, `${today}.json`), JSON.stringify(snapshot));

  const snapshotDates = (await readdir(SNAPSHOT_DIR))
    .map(parseSnapshotDate)
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);

  // 7日以内にある過去分のうち、最も古い日を比較元にする。
  const comparison = snapshotDates.find((entry) => {
    const elapsed = (todayTimestamp - entry.timestamp) / DAY_MS;
    return elapsed >= 1 && elapsed <= 7;
  });
  let previousByName = null;
  let velocityDays = null;
  if (comparison) {
    const previous = JSON.parse(
      await readFile(path.join(SNAPSHOT_DIR, comparison.fileName), "utf8"),
    );
    if (
      !Array.isArray(previous) ||
      previous.some(
        (repo) =>
          !Array.isArray(repo) ||
          repo.length !== 2 ||
          typeof repo[0] !== "string" ||
          typeof repo[1] !== "number",
      )
    ) {
      throw new Error(`${comparison.fileName} の形式が不正です`);
    }
    previousByName = new Map(previous);
    velocityDays = (todayTimestamp - comparison.timestamp) / DAY_MS;
  }

  const repos = collected.map((repo) => {
    const previousStars = previousByName?.get(repo.full_name);
    const velocity = previousStars !== undefined
      ? Number(((repo.stargazers_count - previousStars) / velocityDays).toFixed(1))
      : null;
    return {
      full_name: repo.full_name,
      html_url: repo.html_url,
      language: repo.language,
      description: repo.description?.slice(0, 120) ?? null,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      open_issues: repo.open_issues_count,
      pushed_at: repo.pushed_at,
      created_at: repo.created_at,
      archived: repo.archived,
      velocity,
      velocity_days: previousStars !== undefined ? velocityDays : null,
    };
  });

  // 累計star上位200件と勢い上位200件を合わせ、重複を除いて累計star順に並べる。
  const topByStars = [...repos].sort((a, b) => b.stars - a.stars).slice(0, 200);
  const topByVelocity = repos
    .filter((repo) => repo.velocity !== null)
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, 200);
  const selectedByName = new Map(
    [...topByStars, ...topByVelocity].map((repo) => [repo.full_name, repo]),
  );
  const selectedRepos = [...selectedByName.values()].sort((a, b) => b.stars - a.stars);

  const latest = {
    generated_at: generatedAt.toISOString(),
    observed_since: snapshotDates[0].date,
    days_recorded: snapshotDates.length,
    compared_with: comparison?.date ?? null,
    total_tracked: collected.length,
    repos: selectedRepos,
  };
  await writeFile(LATEST_PATH, JSON.stringify(latest));
  console.log(`${collected.length}件を収集し、${LATEST_PATH} を更新しました`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
