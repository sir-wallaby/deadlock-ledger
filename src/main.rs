//! deadlock-gc-history: fetch own-account Deadlock match history directly from
//! the Steam Game Coordinator (GC message 9112), bypassing third-party APIs.
//!
//! Outputs (XDG data dir):
//!   match-history.json  Full match history (API-compatible shape). The
//!                       ranked fields are populated from an interval-scoped
//!                       GC call (current season) and coalesced from the
//!                       previously stored file for older seasons.
//!   rank-data.json      Current ranked state: the CSORankedProgress "Ranked
//!                       Points" save object (from the account's SO cache)
//!                       + GetRankData (9271).
//!   hero-mmr.json       Per-hero relative MMR (GetHeroMMRRankings, 9234).
//!
//! Commands:
//!   login   Interactive one-time login (password + Steam Guard). Saves a
//!           refresh token and account config for headless runs.
//!   fetch   Headless: reuse the refresh token, pull match history + ranked
//!           state, write the JSON files above. Skips a write if the
//!           existing file already has identical content.
//!   check   Like fetch, but discards the output (sanity check).
//!   status  Show config and refresh-token state.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rpassword::prompt_password;
use serde::{Deserialize, Serialize};
use steam_vent::auth::{
    ClientInfo, ConsoleAuthConfirmationHandler, FileGuardDataStore, MachineId, Os, RefreshToken,
};
use steam_vent::Connection;
use steam_vent::ConnectionTrait;
use steam_vent::ServerList;
use steam_vent_proto_common::protobuf;
use steam_vent_proto_common::protobuf::Enum;
use steam_vent_proto_common::protobuf::Message;
use steam_vent_proto_common::protobuf::MessageField;
use steam_vent_proto_deadlock::citadel_gcmessages_client::{
    cmsg_client_to_gcget_hero_mmrrankings_response,
    cmsg_client_to_gcget_match_history_response,
    cmsg_client_to_gcget_match_history_response::Match,
    cmsg_gcto_client_get_rank_data_response,
    CMsgClientToGCGetHeroMMRRankings, CMsgClientToGCGetHeroMMRRankingsResponse,
    CMsgClientToGCGetMatchHistory, CMsgClientToGCGetMatchHistoryResponse,
    CMsgClientToGCGetRankData, CMsgGCToClientGetRankDataResponse, CSORankedProgress,
};
use steam_vent_proto_deadlock::citadel_gcmessages_common::{ECitadelGameMode, ECitadelMatchMode};
use steam_vent_proto_deadlock::gcsdk_gcmessages::{
    cmsg_socache_subscribed, CMsgClientWelcome, CMsgSOIDOwner, CMsgSOCacheSubscribed,
    CMsgSOMultipleObjects,
};
use steam_vent_proto_deadlock::gcsystemmsgs::ESOMsg;
use steam_vent_proto_deadlock::GCHandshake as DeadlockGCHandshake;
use steam_vent::RawNetMessage;
use tokio_stream::Stream;
use tokio_stream::StreamExt;

const DEADLOCK_APP_ID: u32 = 1422450;
const STEAM64_BASE: u64 = 76_561_197_960_265_728;
const MAX_PAGES: u32 = 500;

/// The current ranked season's interval — `m_unInterval` from
/// ranked_seasons.vdata (S1 = 1, S2 = 2). Not the SO's
/// CSORankedProgress `rank_interval` (a different GC-internal id space).
/// Bump per season; S2 ends 2027-03-11 22:00Z.
const RANK_INTERVAL: u32 = 2;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .expect("HOME not set")
}
fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"))
        .join("deadlock-gc-history")
}
fn data_dir() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local").join("share"))
        .join("deadlock-gc-history")
}
fn token_path() -> PathBuf {
    data_dir().join("refresh_token")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Config {
    account: String,
    steam64: u64,
}

impl Config {
    fn path() -> PathBuf {
        config_dir().join("config.json")
    }
    fn load() -> Result<Self> {
        let raw = fs::read_to_string(Self::path())
            .with_context(|| "no config found — run: deadlock-gc-history login")?;
        Ok(serde_json::from_str(&raw)?)
    }
    fn save(&self) -> Result<()> {
        fs::create_dir_all(config_dir())?;
        fs::write(Self::path(), serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
    fn account32(&self) -> u32 {
        (self.steam64 - STEAM64_BASE) as u32
    }
}

/// JSON row mirroring the api.deadlock-api.com match-history shape.
///
/// `player_match_outcome` uses the GC's real outcome enum (0=invalid,
/// 1=win, 2=loss, 3=penalized, 4=penalized party, 5=not-scored). When the
/// server leaves it unset (0, e.g. for older matches) it falls back to
/// 1 (win) / 2 (loss) from `match_result == player_team`.
///
/// The ranked fields are set only on ranked matches (the GC populates them
/// only in the interval-scoped call); `None` serializes as `null`, matching
/// the API's shape for unranked matches.
#[derive(Serialize)]
struct MatchOut {
    match_id: u64,
    hero_id: u32,
    match_duration_s: u32,
    start_time: u32,
    match_result: u32,
    player_team: u32,
    player_kills: u32,
    player_deaths: u32,
    player_assists: u32,
    last_hits: u32,
    denies: u32,
    hero_level: u32,
    net_worth: u32,
    objectives_mask_team0: u64,
    objectives_mask_team1: u64,
    team_abandoned: bool,
    abandoned_time_s: u32,
    match_mode: u32,
    game_mode: u32,
    game_mode_version: u32,
    brawl_score_team0: u32,
    brawl_score_team1: u32,
    brawl_avg_round_time_s: u32,
    player_match_outcome: u32,
    account_id: u32,
    ranked_display_badge: Option<u32>,
    ranked_delta: Option<i32>,
    ranked_calibration_match: Option<u32>,
    ranked_used_demotion_protection: Option<bool>,
    low_pri_pool: Option<bool>,
}

fn enum_val<T: protobuf::Enum>(opt: &Option<protobuf::EnumOrUnknown<T>>) -> i32 {
    opt.as_ref().map(|e| e.value()).unwrap_or(0)
}

impl MatchOut {
    /// True if any of the 5 ranked fields is set.
    fn has_ranked_data(&self) -> bool {
        self.ranked_display_badge.is_some()
            || self.ranked_delta.is_some()
            || self.ranked_calibration_match.is_some()
            || self.ranked_used_demotion_protection.is_some()
            || self.low_pri_pool.is_some()
    }
}

fn to_json(m: &Match, account32: u32) -> MatchOut {
    let player_team = enum_val(&m.player_team) as u32;
    let match_result = m.match_result();
    let won = match_result == player_team;
    // The GC sends the real outcome enum; 0 (Invalid) means the server didn't
    // set it (older matches), so fall back to the team comparison.
    let real = enum_val(&m.player_match_outcome);
    let player_match_outcome = if real == 0 {
        if won { 1 } else { 2 }
    } else {
        real as u32
    };
    MatchOut {
        match_id: m.match_id(),
        hero_id: m.hero_id(),
        match_duration_s: m.match_duration_s(),
        start_time: m.start_time(),
        match_result,
        player_team,
        player_kills: m.player_kills(),
        player_deaths: m.player_deaths(),
        player_assists: m.player_assists(),
        last_hits: m.last_hits(),
        denies: m.denies(),
        hero_level: m.hero_level(),
        net_worth: m.net_worth(),
        objectives_mask_team0: m.objectives_mask_team0(),
        objectives_mask_team1: m.objectives_mask_team1(),
        team_abandoned: m.team_abandoned(),
        abandoned_time_s: m.abandoned_time_s(),
        match_mode: enum_val(&m.match_mode) as u32,
        game_mode: enum_val(&m.game_mode) as u32,
        game_mode_version: m.game_mode_version(),
        brawl_score_team0: m.brawl_score_team0(),
        brawl_score_team1: m.brawl_score_team1(),
        brawl_avg_round_time_s: m.brawl_avg_round_time_s(),
        player_match_outcome,
        account_id: account32,
        ranked_display_badge: m.has_ranked_display_badge().then(|| m.ranked_display_badge()),
        ranked_delta: m.has_ranked_delta().then(|| m.ranked_delta()),
        ranked_calibration_match: m
            .has_ranked_calibration_match()
            .then(|| m.ranked_calibration_match()),
        ranked_used_demotion_protection: m
            .has_ranked_used_demotion_protection()
            .then(|| m.ranked_used_demotion_protection()),
        low_pri_pool: m.has_low_pri_pool().then(|| m.low_pri_pool()),
    }
}

/// One stored row's identity + ranked fields — the coalesce source.
#[derive(Deserialize)]
struct StoredRow {
    match_id: u64,
    ranked_display_badge: Option<u32>,
    ranked_delta: Option<i32>,
    ranked_calibration_match: Option<u32>,
    ranked_used_demotion_protection: Option<bool>,
    low_pri_pool: Option<bool>,
}

/// Carry the previously stored ranked fields forward for rows the fresh
/// fetch left unset: the interval call covers only one interval, so older
/// intervals' ranked matches are never re-fetched and their fields must not
/// be cleared. Fresh values always win.
fn coalesce_stored_ranked(rows: &mut [MatchOut], path: &Path) {
    let Ok(raw) = fs::read_to_string(path) else {
        return; // first run — nothing stored yet
    };
    let Ok(stored) = serde_json::from_str::<Vec<StoredRow>>(&raw) else {
        eprintln!(
            "warning: cannot parse {} for ranked coalesce — skipping",
            path.display()
        );
        return;
    };
    let stored_by_id: HashMap<u64, &StoredRow> = stored.iter().map(|r| (r.match_id, r)).collect();
    let mut matched = 0usize;
    for row in rows.iter_mut() {
        let Some(prev) = stored_by_id.get(&row.match_id) else {
            continue;
        };
        matched += 1;
        row.ranked_display_badge = row.ranked_display_badge.or(prev.ranked_display_badge);
        row.ranked_delta = row.ranked_delta.or(prev.ranked_delta);
        row.ranked_calibration_match = row
            .ranked_calibration_match
            .or(prev.ranked_calibration_match);
        row.ranked_used_demotion_protection = row
            .ranked_used_demotion_protection
            .or(prev.ranked_used_demotion_protection);
        row.low_pri_pool = row.low_pri_pool.or(prev.low_pri_pool);
    }
    eprintln!("ranked coalesce: {matched}/{len} rows matched the stored file", len = rows.len());
}

fn fmt_ts(unix: u32) -> String {
    // Avoid a time crate dependency: UTC via std is not available, so use a
    // naive civil-from-days conversion.
    let days = (unix / 86400) as i64;
    let secs = unix % 86400;
    let (h, mi, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02} UTC")
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Current ranked state: the CSORankedProgress save object (the "Ranked
/// Points" bar) merged with the GetRankData (9271) response. Fields the GC
/// left unset are omitted from the JSON.
#[derive(Serialize)]
struct RankDataOut {
    account_id: u32,
    fetched_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    rank_type: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rank: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_rank: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    demote_protect_games: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    calibrate_games: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    win_bit_mask: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    match_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rank_interval: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leaderboard_rank: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_leaderboard_rank: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_match_hero_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_match_outcome: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_match_kills: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_match_deaths: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_match_assists: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    requires_calibration: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_rank_confidence: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    calibrated_rank_confidence: Option<i32>,
}

#[derive(Serialize)]
struct HeroMmrRow {
    hero_id: u32,
    relative_mmr: i32,
}

#[derive(Serialize)]
struct HeroMmrOut {
    account_id: u32,
    fetched_at: u64,
    heroes: Vec<HeroMmrRow>,
}

fn build_rank_data(
    account32: u32,
    rp: Option<&CSORankedProgress>,
    rd: Option<&CMsgGCToClientGetRankDataResponse>,
) -> RankDataOut {
    RankDataOut {
        account_id: account32,
        fetched_at: now_unix(),
        rank_type: rp.and_then(|r| {
            r.has_rank_type().then(|| r.rank_type().value() as u32)
        }),
        progress: rp.and_then(|r| r.has_progress().then(|| r.progress())),
        max_progress: rp.and_then(|r| r.has_max_progress().then(|| r.max_progress())),
        rank: rp.and_then(|r| r.has_rank().then(|| r.rank())),
        max_rank: rp.and_then(|r| r.has_max_rank().then(|| r.max_rank())),
        demote_protect_games: rp
            .and_then(|r| r.has_demote_protect_games().then(|| r.demote_protect_games())),
        calibrate_games: rp
            .and_then(|r| r.has_calibrate_games().then(|| r.calibrate_games())),
        win_bit_mask: rp.and_then(|r| r.has_win_bit_mask().then(|| r.win_bit_mask())),
        match_count: rp.and_then(|r| r.has_match_count().then(|| r.match_count())),
        rank_interval: rp.and_then(|r| r.has_rank_interval().then(|| r.rank_interval())),
        leaderboard_rank: rp
            .and_then(|r| r.has_leaderboard_rank().then(|| r.leaderboard_rank())),
        max_leaderboard_rank: rp
            .and_then(|r| r.has_max_leaderboard_rank().then(|| r.max_leaderboard_rank())),
        last_match_hero_id: rp
            .and_then(|r| r.has_last_match_hero_id().then(|| r.last_match_hero_id())),
        last_match_outcome: rp.and_then(|r| {
            r.has_last_match_outcome()
                .then(|| r.last_match_outcome().value() as u32)
        }),
        last_match_kills: rp
            .and_then(|r| r.has_last_match_kills().then(|| r.last_match_kills())),
        last_match_deaths: rp
            .and_then(|r| r.has_last_match_deaths().then(|| r.last_match_deaths())),
        last_match_assists: rp
            .and_then(|r| r.has_last_match_assists().then(|| r.last_match_assists())),
        requires_calibration: rd
            .and_then(|d| d.has_requires_calibration().then(|| d.requires_calibration())),
        current_rank_confidence: rd
            .and_then(|d| d.has_current_rank_confidence().then(|| d.current_rank_confidence())),
        calibrated_rank_confidence: rd.and_then(|d| {
            d.has_calibrated_rank_confidence()
                .then(|| d.calibrated_rank_confidence())
        }),
    }
}

/// Flatten one SO cache message into (type_id, blob) pairs, logging the
/// types seen (the ranked SO's type id is the one we're hunting for).
fn so_blobs<'a>(cache: &'a CMsgSOCacheSubscribed, label: &str) -> Vec<(i32, &'a [u8])> {
    let mut blobs = Vec::new();
    for obj in &cache.objects {
        let type_id = obj.type_id.unwrap_or(0);
        eprintln!(
            "{label} SO cache: type {type_id}, {} object(s)",
            obj.object_data.len()
        );
        for blob in &obj.object_data {
            blobs.push((type_id, blob.as_slice()));
        }
    }
    blobs
}

/// Scan (type_id, blob) pairs for this account's CSORankedProgress.
///
/// The SO type id is not in the public protos, so detection is by parse:
/// the blob must decode as a CSORankedProgress for this account with at
/// least one ranked field set (other account SOs, e.g. cabal membership,
/// share field 1 account_id but have no ranked fields).
fn ranked_progress_from(
    blobs: &[(i32, &[u8])],
    account32: u32,
) -> Option<CSORankedProgress> {
    for (type_id, blob) in blobs {
        let Ok(rp) = CSORankedProgress::parse_from_bytes(blob) else {
            continue;
        };
        let plausible = rp.has_progress()
            || rp.has_max_progress()
            || rp.has_rank()
            || rp.has_max_rank()
            || rp.has_match_count()
            || rp.has_win_bit_mask();
        if rp.has_account_id() && rp.account_id() == account32 && plausible {
            eprintln!("ranked progress: found in SO type {type_id}");
            return Some(rp);
        }
    }
    None
}

/// Drain a pre-subscribed SO stream (kind 24) until the settle deadline,
/// looking for this account's CSORankedProgress. Returns the progress if
/// found, and whether any SO message arrived at all.
async fn drain_so_stream<S>(
    so_rx: &mut S,
    account32: u32,
    settle: Duration,
    label: &str,
) -> (Option<CSORankedProgress>, bool)
where
    S: Stream<Item = Result<CMsgSOCacheSubscribed, steam_vent::NetworkError>> + Unpin,
{
    let mut got_any = false;
    let deadline = tokio::time::Instant::now() + settle;
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        match tokio::time::timeout(deadline - now, so_rx.next()).await {
            Ok(Some(Ok(rsp))) => {
                got_any = true;
                if let Some(rp) = ranked_progress_from(&so_blobs(&rsp, label), account32) {
                    return (Some(rp), true);
                }
            }
            Ok(Some(Err(e))) => {
                eprintln!("warning: {label} SO message failed to parse ({e})");
                break;
            }
            // Stream ended (connection closed) or deadline.
            Ok(None) | Err(_) => break,
        }
    }
    (None, got_any)
}

/// Scan one raw GC message (from the filter's rest buffer) for this
/// account's CSORankedProgress. Handles the two SO push kinds: 24 (cache
/// subscribed — the post-welcome push) and 26 (update multiple).
fn ranked_from_raw(raw: &RawNetMessage, account32: u32) -> Option<CSORankedProgress> {
    if raw.kind == ESOMsg::k_ESOMsg_CacheSubscribed {
        let Ok(rsp) = CMsgSOCacheSubscribed::parse_from_bytes(&raw.data) else {
            return None;
        };
        return ranked_progress_from(&so_blobs(&rsp, "SO push"), account32);
    }
    if raw.kind == ESOMsg::k_ESOMsg_UpdateMultiple {
        let Ok(upd) = CMsgSOMultipleObjects::parse_from_bytes(&raw.data) else {
            return None;
        };
        let mut blobs = Vec::new();
        for obj in upd.objects_added.iter().chain(upd.objects_modified.iter()) {
            let type_id = obj.type_id.unwrap_or(0);
            eprintln!("SO update: type {type_id}");
            if let Some(data) = &obj.object_data {
                blobs.push((type_id, data.as_slice()));
            }
        }
        return ranked_progress_from(&blobs, account32);
    }
    None
}

/// Acquire the CSORankedProgress save object ("Ranked Points").
///
/// The GC pushes the account's SO cache (kind 24) right after the
/// welcome — before any request. That push usually wins the race against
/// our subscription and lands in the filter's rest buffer, so that is
/// checked first; the pre-subscribed stream is drained next (in case we
/// won the race), then the rest buffer again (a late push that lost the
/// race). Last resort: an active subscription request — CMsgSOCacheSubscribed
/// (kind 24) with a range of SO type ids, every returned blob parse-tested
/// (the type id for CSORankedProgress is not public). Best effort: None
/// on any failure.
async fn fetch_ranked_progress<S>(
    gc: &steam_vent::GameCoordinator,
    so_rx: &mut S,
    account32: u32,
    account64: u64,
    welcome: &CMsgClientWelcome,
) -> Option<CSORankedProgress>
where
    S: Stream<Item = Result<CMsgSOCacheSubscribed, steam_vent::NetworkError>> + Unpin,
{
    for cache in &welcome.outofdate_subscribed_caches {
        if let Some(rp) = ranked_progress_from(&so_blobs(cache, "welcome"), account32) {
            return Some(rp);
        }
    }

    // The post-welcome push is usually already in the rest buffer.
    for raw in gc.unprocessed() {
        if let Some(rp) = ranked_from_raw(&raw, account32) {
            return Some(rp);
        }
    }

    // If we won the race, the push is in the pre-subscribed stream; the
    // settle also covers a push that is still in flight.
    let (found, _) =
        drain_so_stream(so_rx, account32, Duration::from_secs(2), "SO push").await;
    if let Some(rp) = found {
        return Some(rp);
    }

    // A late push that lost the race lands back in the rest buffer.
    for raw in gc.unprocessed() {
        if let Some(rp) = ranked_from_raw(&raw, account32) {
            return Some(rp);
        }
    }

    // Fallback: an active subscription request. The known account SO ids
    // (101-110) plus headroom for the ranked-season additions, requested
    // in one message. The first attempt omits owner_soid (the GC knows
    // the session's account); the retries add an explicit account SOID.
    let mut attempts: Vec<Option<CMsgSOIDOwner>> = vec![None];
    for id in [account64, account32 as u64] {
        attempts.push(Some(CMsgSOIDOwner {
            type_: Some(0),
            id: Some(id),
            ..Default::default()
        }));
    }
    for owner in attempts {
        let mut req = CMsgSOCacheSubscribed::new();
        for type_id in 101..=150 {
            let mut entry = cmsg_socache_subscribed::SubscribedType::new();
            entry.set_type_id(type_id);
            req.objects.push(entry);
        }
        if let Some(o) = &owner {
            req.owner_soid = MessageField::some(o.clone());
        }
        if gc.send(req).await.is_err() {
            eprintln!("warning: SOCacheSubscribed send failed — skipping ranked progress");
            return None;
        }

        // Subscribe before the reply can arrive.
        let mut rx = gc.on::<CMsgSOCacheSubscribed>();
        let (found, replied) =
            drain_so_stream(&mut rx, account32, Duration::from_secs(8), "SO reply").await;
        if let Some(rp) = found {
            return Some(rp);
        }
        // The GC answered the first format; the owner_soid retries are
        // unlikely to do better.
        if replied {
            break;
        }
    }
    None
}

async fn fetch_rank_data(
    gc: &steam_vent::GameCoordinator,
) -> Option<CMsgGCToClientGetRankDataResponse> {
    if gc.send(CMsgClientToGCGetRankData::new()).await.is_err() {
        eprintln!("warning: GetRankData send failed — skipping");
        return None;
    }
    let rsp: CMsgGCToClientGetRankDataResponse = match gc.one().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("warning: GetRankData response failed ({e}) — skipping");
            return None;
        }
    };
    if rsp.result() != cmsg_gcto_client_get_rank_data_response::EResultCode::k_Succeeded {
        eprintln!("warning: GetRankData result {:?} — skipping", rsp.result());
        return None;
    }
    Some(rsp)
}

async fn fetch_hero_mmr(gc: &steam_vent::GameCoordinator, account32: u32) -> Option<Vec<(u32, i32)>> {
    let req = CMsgClientToGCGetHeroMMRRankings {
        target_account_id: Some(account32),
        ..Default::default()
    };
    if gc.send(req).await.is_err() {
        eprintln!("warning: GetHeroMMRRankings send failed — skipping");
        return None;
    }
    let rsp: CMsgClientToGCGetHeroMMRRankingsResponse = match gc.one().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("warning: GetHeroMMRRankings response failed ({e}) — skipping");
            return None;
        }
    };
    if rsp.result() != cmsg_client_to_gcget_hero_mmrrankings_response::EResult::k_eSuccess {
        eprintln!("warning: GetHeroMMRRankings result {:?} — skipping", rsp.result());
        return None;
    }
    Some(
        rsp.heroes
            .iter()
            .map(|h| (h.hero_id(), h.relative_mmr()))
            .collect(),
    )
}

/// Atomic write that skips the rename when the content is unchanged.
fn write_json_if_changed(path: PathBuf, value: &impl Serialize) -> Result<()> {
    let json = serde_json::to_string_pretty(value)?;
    if let Ok(existing) = fs::read(&path) {
        if existing.as_slice() == json.as_bytes() {
            eprintln!("unchanged — skipped write to {}", path.display());
            return Ok(());
        }
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json)?;
    fs::rename(&tmp, &path)?;
    eprintln!("wrote {}", path.display());
    Ok(())
}

/// Fetch one ranked interval's match history. The GC gates the five ranked
/// fields on game_mode + match_mode + rank_interval all being set (a plain
/// call returns every one unset); with the interval set, the response holds
/// the whole interval's ranked history in a single page, each row carrying
/// the fields. ranked_type stays unset — live-verified irrelevant. Best
/// effort: empty on any failure — a failure only costs the fresh fields,
/// the coalesce keeps the stored ones.
async fn fetch_ranked_interval(
    gc: &steam_vent::GameCoordinator,
    account32: u32,
    interval: u32,
) -> Vec<Match> {
    let req = CMsgClientToGCGetMatchHistory {
        account_id: Some(account32),
        game_mode: Some(ECitadelGameMode::k_ECitadelGameMode_Normal.into()),
        match_mode: Some(ECitadelMatchMode::k_ECitadelMatchMode_Ranked.into()),
        rank_interval: Some(interval),
        ..Default::default()
    };
    if gc.send(req).await.is_err() {
        eprintln!("warning: ranked-interval GetMatchHistory send failed — skipping");
        return Vec::new();
    }
    let rsp: CMsgClientToGCGetMatchHistoryResponse = match gc.one().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("warning: ranked-interval GetMatchHistory failed ({e}) — skipping");
            return Vec::new();
        }
    };
    if rsp.result() != cmsg_client_to_gcget_match_history_response::EResult::k_eResult_Success {
        eprintln!(
            "warning: ranked-interval GetMatchHistory result {:?} — skipping",
            rsp.result()
        );
        return Vec::new();
    }
    if rsp.continue_cursor() != 0 {
        eprintln!(
            "warning: ranked-interval response paged (cursor {}) — expected the whole interval in one page",
            rsp.continue_cursor()
        );
    }
    eprintln!("ranked interval {interval}: {} match(es)", rsp.matches.len());
    rsp.matches
}

async fn connect_gc(cfg: &Config) -> Result<steam_vent::Connection> {
    let raw = fs::read_to_string(token_path())
        .with_context(|| "no saved refresh token — run: deadlock-gc-history login")?;
    let token = RefreshToken::new(raw.trim().to_string())
        .context("parsing saved refresh token")?;
    match token.remaining_lifetime() {
        Some(remaining) => {
            eprintln!("refresh token expires in {:?}", remaining);
        }
        None => bail!("refresh token expired — run: deadlock-gc-history login"),
    }
    let server_list = ServerList::discover().await.context("server discovery")?;
    let mut conn = Connection::login_with_refresh_token(&server_list, &token)
        .await
        .context("login with refresh token")?;
    let sid = conn.steam_id().steam64();
    if sid != cfg.steam64 {
        bail!("logged in as {} but config expects {}", sid, cfg.steam64);
    }
    conn.set_timeout(Duration::from_secs(30));
    eprintln!("connected as {} ({})", cfg.account, sid);
    Ok(conn)
}

async fn fetch_matches(
    cfg: &Config,
    out: Option<PathBuf>,
    interval: u32,
    write: bool,
) -> Result<()> {
    let conn = connect_gc(cfg).await?;
    let (gc, welcome) = conn
        .game_coordinator(&DeadlockGCHandshake::default())
        .await
        .with_context(|| format!("GC connect (appid {})", DEADLOCK_APP_ID))?;
    eprintln!("GC connected");

    // The GC pushes the account's SO cache (kind 24) right after the
    // welcome, before any request — subscribe before it can arrive.
    let mut so_rx = gc.on::<CMsgSOCacheSubscribed>();

    let mut all: Vec<Match> = Vec::new();
    let mut cursor: u64 = 0;
    let mut done = false;
    for page in 0..MAX_PAGES {
        let req = CMsgClientToGCGetMatchHistory {
            account_id: Some(cfg.account32()),
            continue_cursor: Some(cursor),
            ..Default::default()
        };
        gc.send(req).await.context("send GetMatchHistory")?;
        let rsp: CMsgClientToGCGetMatchHistoryResponse = gc
            .one()
            .await
            .context("GetMatchHistory response")?;
        if rsp.result() != cmsg_client_to_gcget_match_history_response::EResult::k_eResult_Success
        {
            bail!("GC returned result {:?}", rsp.result());
        }
        let page_len = rsp.matches.len();
        let next = rsp.continue_cursor();
        all.extend(rsp.matches);
        eprintln!("page {page}: {page_len} matches (cursor {cursor} -> {next})");
        if page_len == 0 || next == 0 || next == cursor {
            done = true;
            break;
        }
        cursor = next;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if !done {
        eprintln!("warning: stopped at the {MAX_PAGES}-page limit — history may be truncated");
    }

    // The interval-scoped call's rows are a field-wise superset of the plain
    // rows (they carry the ranked fields), so for a ranked match the
    // interval row replaces the plain one.
    let interval_rows = fetch_ranked_interval(&gc, cfg.account32(), interval).await;
    let interval_by_id: HashMap<u64, &Match> =
        interval_rows.iter().map(|m| (m.match_id(), m)).collect();

    all.sort_by_key(|m| std::cmp::Reverse(m.start_time()));
    let mut seen = HashSet::new();
    let mut rows: Vec<MatchOut> = Vec::with_capacity(all.len());
    for m in &all {
        if seen.insert(m.match_id()) {
            let fresh = interval_by_id.get(&m.match_id()).copied().unwrap_or(m);
            rows.push(to_json(fresh, cfg.account32()));
        }
    }
    // An interval row missing from the main pages (only possible if the main
    // loop hit the page cap) still belongs in the history.
    for m in &interval_rows {
        if seen.insert(m.match_id()) {
            rows.push(to_json(m, cfg.account32()));
        }
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r.start_time));

    if let Some(newest) = rows.first() {
        eprintln!(
            "total: {} matches, newest: {} (match {})",
            rows.len(),
            fmt_ts(newest.start_time),
            newest.match_id
        );
    }

    // ---- Ranked state (S2) ----
    // CSORankedProgress ("Ranked Points") is the account's SO cache,
    // pushed by the GC right after the welcome (see fetch_ranked_progress);
    // GetRankData (9271) and GetHeroMMRRankings (9234) are explicit
    // round-trips. All run in check and fetch modes.
    let ranked = fetch_ranked_progress(&gc, &mut so_rx, cfg.account32(), cfg.steam64, &welcome).await;
    let rank_data = fetch_rank_data(&gc).await;
    let hero_mmr = fetch_hero_mmr(&gc, cfg.account32()).await;

    match &ranked {
        Some(rp) => eprintln!(
            "ranked: rank {} progress {}/{} demote_protect {} calibrate {} match_count {}",
            rp.rank(),
            rp.progress(),
            rp.max_progress(),
            rp.demote_protect_games(),
            rp.calibrate_games(),
            rp.match_count()
        ),
        None => eprintln!("ranked: CSORankedProgress unavailable (SO cache)"),
    }
    if let Some(rd) = &rank_data {
        eprintln!(
            "rank data: requires_calibration {} current_confidence {} calibrated_confidence {}",
            rd.requires_calibration(),
            rd.current_rank_confidence(),
            rd.calibrated_rank_confidence()
        );
    }
    match &hero_mmr {
        Some(mmr) => {
            eprintln!("hero mmr: {} heroes", mmr.len());
            for (hero_id, value) in mmr {
                eprintln!("  hero {hero_id}: {value}");
            }
        }
        None => eprintln!("hero mmr: unavailable"),
    }

    // Coalesce in both modes so `check` is a faithful dry run of `fetch`.
    let out_path = out.unwrap_or_else(|| data_dir().join("match-history.json"));
    coalesce_stored_ranked(&mut rows, &out_path);
    let with_ranked = rows.iter().filter(|r| r.has_ranked_data()).count();
    eprintln!("ranked fields on {with_ranked}/{len} rows", len = rows.len());

    if !write {
        // `check` mode: the round trip succeeded, discard the output.
        return Ok(());
    }
    write_json_if_changed(out_path, &rows)?;

    if ranked.is_some() || rank_data.is_some() {
        let rank_out = build_rank_data(cfg.account32(), ranked.as_ref(), rank_data.as_ref());
        write_json_if_changed(data_dir().join("rank-data.json"), &rank_out)?;
    }
    if let Some(mmr) = hero_mmr {
        let mmr_out = HeroMmrOut {
            account_id: cfg.account32(),
            fetched_at: now_unix(),
            heroes: mmr
                .into_iter()
                .map(|(hero_id, relative_mmr)| HeroMmrRow {
                    hero_id,
                    relative_mmr,
                })
                .collect(),
        };
        write_json_if_changed(data_dir().join("hero-mmr.json"), &mmr_out)?;
    }
    Ok(())
}

async fn run_login(account_arg: Option<&str>, steam64_arg: Option<u64>) -> Result<()> {
    let existing = Config::load().ok();
    let account = match account_arg {
        Some(a) => a.to_string(),
        None => match existing.as_ref().map(|c| c.account.clone()) {
            Some(a) => {
                eprintln!("using account '{a}' from config (pass --account to change)");
                a
            }
            None => {
                print!("Steam account name: ");
                use std::io::Write as _;
                std::io::stdout().flush().ok();
                let mut line = String::new();
                std::io::stdin().read_line(&mut line)?;
                let a = line.trim().to_string();
                if a.is_empty() {
                    bail!("no account name");
                }
                a
            }
        },
    };

    let password = prompt_password("Steam password: ").context("reading password")?;
    if password.is_empty() {
        bail!("no password");
    }

    let server_list = ServerList::discover().await.context("server discovery")?;
    let store = FileGuardDataStore::user_cache();
    let mut client_info = ClientInfo::new("deadlock-gc-history".into());
    client_info.machine_id = MachineId::new("deadlock-gc-history");
    client_info.os = Os::Linux;

    eprintln!("logging in (a Steam Guard code may be requested) ...");
    let conn = Connection::login(
        &server_list,
        &account,
        &password,
        store,
        ConsoleAuthConfirmationHandler::default(),
        &client_info,
    )
    .await
    .context("Steam login")?;

    let sid = conn.steam_id().steam64();
    if let Some(expected) = steam64_arg {
        if expected != sid {
            bail!("logged in as {} but expected {}", sid, expected);
        }
    }

    let token = conn.refresh_token().token().to_string();
    fs::create_dir_all(data_dir())?;
    fs::write(token_path(), &token)?;
    fs::set_permissions(token_path(), fs::Permissions::from_mode(0o600))?;

    Config {
        account: account.clone(),
        steam64: sid,
    }
    .save()?;

    eprintln!("logged in as {account} (steam64 {sid})");
    if let Some(remaining) = conn.refresh_token().remaining_lifetime() {
        eprintln!(
            "refresh token saved, valid for {:?} — headless `fetch` reuses it",
            remaining
        );
    }
    Ok(())
}

fn run_status() -> Result<()> {
    match Config::load() {
        Ok(cfg) => {
            println!("config:   {}", Config::path().display());
            println!("account:  {} (steam64 {}, steam32 {})", cfg.account, cfg.steam64, cfg.account32());
        }
        Err(e) => println!("config:   MISSING ({e})"),
    }
    match fs::read_to_string(token_path()) {
        Ok(raw) => match RefreshToken::new(raw.trim().to_string()) {
            Ok(t) => match t.remaining_lifetime() {
                Some(r) => println!("token:    ok, expires in {:?}", r),
                None => println!("token:    EXPIRED — run `login` again"),
            },
            Err(e) => println!("token:    invalid ({e})"),
        },
        Err(_) => println!("token:    MISSING — run `login` first"),
    }
    for name in ["match-history.json", "rank-data.json", "hero-mmr.json"] {
        match fs::metadata(data_dir().join(name)) {
            Ok(m) => {
                let age = m
                    .modified()
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map(|d| format!("{d:?}"))
                    .unwrap_or_default();
                println!("data:     {name}: {} bytes, last written {age}", m.len());
            }
            Err(_) => println!("data:     {name}: missing"),
        }
    }
    Ok(())
}

fn arg_after(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn parse_interval(args: &[String]) -> Option<u32> {
    match arg_after(args, "--interval") {
        Some(v) => match v.parse() {
            Ok(n) => Some(n),
            Err(_) => {
                eprintln!("warning: ignoring invalid --interval value '{v}'");
                None
            }
        },
        None => None,
    }
}

fn parse_steam64(args: &[String]) -> Option<u64> {
    match arg_after(args, "--steam64") {
        Some(v) => match v.parse() {
            Ok(n) => Some(n),
            Err(_) => {
                eprintln!("warning: ignoring invalid --steam64 value '{v}'");
                None
            }
        },
        None => None,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("login") => {
            run_login(arg_after(&args, "--account").as_deref(), parse_steam64(&args)).await
        }
        Some("fetch") => {
            let cfg = Config::load()?;
            let interval = parse_interval(&args).unwrap_or(RANK_INTERVAL);
            fetch_matches(
                &cfg,
                arg_after(&args, "--out").map(PathBuf::from),
                interval,
                true,
            )
            .await
        }
        Some("check") => {
            let cfg = Config::load()?;
            let interval = parse_interval(&args).unwrap_or(RANK_INTERVAL);
            fetch_matches(&cfg, None, interval, false).await
        }
        Some("status") => run_status(),
        _ => {
            eprintln!(
                "usage:\n  deadlock-gc-history login [--account NAME] [--steam64 ID]\n  deadlock-gc-history fetch [--out PATH] [--interval N]\n  deadlock-gc-history check [--interval N]\n  deadlock-gc-history status"
            );
            std::process::exit(2);
        }
    }
}
