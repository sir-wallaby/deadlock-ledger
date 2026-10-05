const STEAM_ID64_BASE = 76561197960265728n;

// Classify a raw user input into one of:
//   { kind: 'empty' }
//   { kind: 'steamId64', steamId64 }
//   { kind: 'accountId', accountId }
//   { kind: 'username', username }
export function classifyInput(raw) {
    const t = String(raw || '').trim();
    if (!t) return { kind: 'empty' };

    const profileUrl = t.match(/profiles\/(\d{17})/);
    if (profileUrl) return { kind: 'steamId64', steamId64: profileUrl[1] };

    const vanityUrl = t.match(/\/id\/([A-Za-z0-9._-]+)/);
    if (vanityUrl) return { kind: 'username', username: vanityUrl[1] };

    if (/^\d{17}$/.test(t)) return { kind: 'steamId64', steamId64: t };

    if (/^\d{1,10}$/.test(t)) return { kind: 'accountId', accountId: Number(t) };

    return { kind: 'username', username: t };
}

export function steamId64ToAccountId(steamId64) {
    return Number(BigInt(steamId64) - STEAM_ID64_BASE);
}

export function accountIdToSteamId64(accountId) {
    return (BigInt(accountId) + STEAM_ID64_BASE).toString();
}
