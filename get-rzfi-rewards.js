#!/usr/bin/env node
/**
 * Compute rZFI rewards earned by a wallet on Merkl between two UTC dates.
 *
 *   node get-rzfi-rewards.js [address] [from-iso] [to-iso] [tokenSymbol]
 *
 * Defaults match the requested query:
 *   0xc567230d56f1066a0f86594882e75aa6a1a6fcf7, 2026-04-07 → 2026-04-19 (excl), rZFI
 *
 * Why this works:
 *   - /v4/users/{address}/rewards is cumulative and has no date filter, BUT
 *     each `breakdowns[].reason` is `day-N` (1-indexed from the campaign start).
 *   - We resolve `startTimestamp` for every campaign distributing the token,
 *     map each `day-N` back to a UTC timestamp, then sum days inside [from, to).
 */

const API = 'https://api.merkl.xyz';
const SECS_PER_DAY = 86_400;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} on ${url}`);
  return res.json();
}

async function fetchCampaigns(tokenSymbol) {
  const out = [];
  for (let page = 0; ; page += 1) {
    const batch = await getJson(`${API}/v4/campaigns?tokenSymbol=${tokenSymbol}&page=${page}&items=100`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

async function fetchUserRewards(address, chainIds) {
  const all = [];
  for (let breakdownPage = 0; ; breakdownPage += 1) {
    const data = await getJson(
      `${API}/v4/users/${address}/rewards?chainId=${chainIds.join(',')}&breakdownPage=${breakdownPage}`
    );
    all.push(data);
    const hasMore = data.some((c) => c.rewards.some((r) => r.breakdowns.length === 1000));
    if (!hasMore) return all.flat();
  }
}

const parseDay = (reason) => {
  const m = /^day-(\d+)$/.exec(reason);
  return m ? parseInt(m[1], 10) : null;
};

const fmt = (wei, decimals) => {
  const base = 10n ** BigInt(decimals);
  return `${(wei / base).toString()}.${(wei % base).toString().padStart(decimals, '0').slice(0, 6)}`;
};

async function main() {
  const address = process.argv[2] || '0xc567230d56f1066a0f86594882e75aa6a1a6fcf7';
  const fromIso = process.argv[3] || '2026-04-07T00:00:00Z';
  const toIso = process.argv[4] || '2026-04-19T00:00:00Z';
  const symbol = process.argv[5] || 'rZFI';

  const fromTs = Math.floor(Date.parse(fromIso) / 1000);
  const toTs = Math.floor(Date.parse(toIso) / 1000);

  const campaigns = await fetchCampaigns(symbol);
  const byId = Object.fromEntries(campaigns.map((c) => [c.campaignId, c]));
  const chainIds = [...new Set(campaigns.map((c) => c.distributionChainId))];

  const userChains = await fetchUserRewards(address, chainIds);

  const matches = [];
  for (const chain of userChains) {
    for (const reward of chain.rewards) {
      if (reward.token.symbol !== symbol) continue;
      for (const bd of reward.breakdowns) {
        const day = parseDay(bd.reason);
        const camp = byId[bd.campaignId];
        if (day == null || !camp) continue;
        const ts = Number(camp.startTimestamp) + (day - 1) * SECS_PER_DAY;
        if (ts >= fromTs && ts < toTs) {
          matches.push({ ts, day, amount: BigInt(bd.amount), campaignId: bd.campaignId, decimals: reward.token.decimals });
        }
      }
    }
  }

  matches.sort((a, b) => a.ts - b.ts);
  const decimals = matches[0]?.decimals ?? 18;
  const total = matches.reduce((acc, m) => acc + m.amount, 0n);

  console.log(`Address  : ${address}`);
  console.log(`Token    : ${symbol}`);
  console.log(`Window   : ${fromIso}  →  ${toIso}  (end exclusive)`);
  console.log(`Chain(s) : ${chainIds.join(', ')}`);
  console.log(`Days     : ${matches.length}`);
  console.log('');
  for (const m of matches) {
    console.log(
      `  ${new Date(m.ts * 1000).toISOString()}  day-${String(m.day).padEnd(3)} ${fmt(m.amount, m.decimals)} ${symbol}  (${m.campaignId.slice(0, 10)}…)`
    );
  }
  console.log('');
  console.log(`TOTAL ${symbol} earned in window: ${fmt(total, decimals)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
