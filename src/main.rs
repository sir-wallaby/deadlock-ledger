//! deadlock-gc-history: fetch own-account Deadlock match history directly from
//! the Steam Game Coordinator (GC message 9112), bypassing third-party APIs.
//!
//! Commands:
//!   login   Interactive one-time login (password + Steam Guard). Saves a
//!           refresh token and account config for headless runs.
//!   fetch   Headless: reuse the refresh token, pull the full match history,
//!           write a JSON array in the same shape as
//!           api.deadlock-api.com /v1/players/{id}/match-history. Skips the
//!           write if the existing file already has identical content.
//!   check   Like fetch, but discards the output (sanity check).
//!   status  Show config and refresh-token state.

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
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
use steam_vent_proto_deadlock::citadel_gcmessages_client::{
    cmsg_client_to_gcget_match_history_response,
    cmsg_client_to_gcget_match_history_response::Match,
    CMsgClientToGCGetMatchHistory, CMsgClientToGCGetMatchHistoryResponse,
};
use steam_vent_proto_deadlock::GCHandshake as DeadlockGCHandshake;

const DEADLOCK_APP_ID: u32 = 1422450;
const STEAM64_BASE: u64 = 76_561_197_960_265_728;
const MAX_PAGES: u32 = 500;

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
/// `player_match_outcome` is synthesized: the proto exposes no outcome enum,
/// only a `not_scored` flag (set when the player quit or the match otherwise
/// doesn't count) — that maps to 5 (not-scored); otherwise 1 (win) / 2
/// (loss) from `match_result == player_team`. The penalized values (3/4) are
/// not distinguishable from the GC and stay the app's problem.
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
}

fn enum_val<T: protobuf::Enum>(opt: &Option<protobuf::EnumOrUnknown<T>>) -> i32 {
    opt.as_ref().map(|e| e.value()).unwrap_or(0)
}

fn to_json(m: &Match, account32: u32) -> MatchOut {
    let player_team = enum_val(&m.player_team) as u32;
    let match_result = m.match_result();
    let won = match_result == player_team;
    let player_match_outcome = if m.not_scored() { 5 } else if won { 1 } else { 2 };
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
    }
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

async fn fetch_matches(cfg: &Config, out: Option<PathBuf>, write: bool) -> Result<()> {
    let conn = connect_gc(cfg).await?;
    let (gc, _welcome) = conn
        .game_coordinator(&DeadlockGCHandshake::default())
        .await
        .with_context(|| format!("GC connect (appid {})", DEADLOCK_APP_ID))?;
    eprintln!("GC connected");

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

    all.sort_by_key(|m| std::cmp::Reverse(m.start_time()));
    let mut seen = HashSet::new();
    let mut rows: Vec<MatchOut> = Vec::with_capacity(all.len());
    for m in &all {
        if seen.insert(m.match_id()) {
            rows.push(to_json(m, cfg.account32()));
        }
    }

    let json = serde_json::to_string_pretty(&rows)?;
    if let Some(newest) = rows.first() {
        eprintln!(
            "total: {} matches, newest: {} (match {})",
            rows.len(),
            fmt_ts(newest.start_time),
            newest.match_id
        );
    }
    if !write {
        // `check` mode: the round trip succeeded, discard the output.
        return Ok(());
    }
    let out_path = out.unwrap_or_else(|| data_dir().join("match-history.json"));
    if let Ok(existing) = fs::read(&out_path) {
        if existing.as_slice() == json.as_bytes() {
            eprintln!("unchanged — skipped write to {}", out_path.display());
            return Ok(());
        }
    }
    fs::create_dir_all(out_path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| std::path::Path::new(".")))?;
    let tmp = out_path.with_extension("json.tmp");
    fs::write(&tmp, &json)?;
    fs::rename(&tmp, &out_path)?;
    eprintln!("wrote {} matches to {}", rows.len(), out_path.display());
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
    match fs::metadata(data_dir().join("match-history.json")) {
        Ok(m) => {
            let age = m
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|d| format!("{:?}", d))
                .unwrap_or_default();
            println!("data:     {}-byte file, last written {}", m.len(), age);
        }
        Err(_) => println!("data:     no match-history.json yet"),
    }
    Ok(())
}

fn arg_after(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
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
            fetch_matches(&cfg, arg_after(&args, "--out").map(PathBuf::from), true).await
        }
        Some("check") => {
            let cfg = Config::load()?;
            fetch_matches(&cfg, None, false).await
        }
        Some("status") => run_status(),
        _ => {
            eprintln!(
                "usage:\n  deadlock-gc-history login [--account NAME] [--steam64 ID]\n  deadlock-gc-history fetch [--out PATH]\n  deadlock-gc-history check\n  deadlock-gc-history status"
            );
            std::process::exit(2);
        }
    }
}
