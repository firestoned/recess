// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The web front end: one page, served on loopback, fed by server-sent events.
//!
//! The server starts logins and claims as you, so it is guarded: loopback only, the Host
//! header checked (DNS rebinding), and a key in the printed link traded for a SameSite=Strict
//! HttpOnly cookie that every route but the trade requires. POSTs take JSON only, which a
//! cross-site form cannot send without a preflight.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::Stream;
use serde::Deserialize;
use serde_json::json;

use crate::engine::{KubeTarget, Run};
use crate::settings::{ClaimSettings, LoginSettings};

const COOKIE: &str = "recess";

/// The pages' scripts and stylesheets, served behind the cookie like the API: path, type, body.
const ASSETS: &[(&str, &str, &str)] = &[
    (
        "/app.js",
        "text/javascript",
        include_str!("../assets/app.js"),
    ),
    ("/app.css", "text/css", include_str!("../assets/app.css")),
    (
        "/cli.js",
        "text/javascript",
        include_str!("../assets/cli.js"),
    ),
    ("/3d.js", "text/javascript", include_str!("../assets/3d.js")),
    ("/3d.css", "text/css", include_str!("../assets/3d.css")),
];

/// The page for each theme.
const fn page(theme: Theme) -> &'static str {
    match theme {
        Theme::Classic => include_str!("../assets/index.html"),
        Theme::Wired3d => include_str!("../assets/3d.html"),
    }
}

/// The cookie that remembers the theme last picked in the page's dropdown.
const THEME_COOKIE: &str = "recess-theme";

/// How the run is shown; the API behind every theme is the same, so switching keeps the run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Theme {
    /// The stage cards.
    Classic,
    /// The wireframe 3D journey: the request sealed into an envelope and carried through the
    /// issuer, the broker, the Kubernetes API and the sandbox VM.
    #[value(name = "wired-3d")]
    Wired3d,
}

impl Theme {
    const ALL: [Self; 2] = [Self::Classic, Self::Wired3d];

    /// The name in `--theme`, `?theme=` and the cookie.
    const fn slug(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::Wired3d => "wired-3d",
        }
    }

    fn from_slug(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.slug() == s)
    }
}

struct App {
    theme: Theme,
    secret: String,
    login: LoginSettings,
    claim: ClaimSettings,
    kube: KubeTarget,
    demo: bool,
    config_note: Option<String>,
    kube_client: tokio::sync::OnceCell<kube::Client>,
    run: Mutex<Option<Arc<Run>>>,
    /// The issuer the latest login used, which the TLS probe dials.
    issuer: Mutex<(String, String)>,
    /// TLS probes by target, kept a minute.
    tls: Mutex<std::collections::HashMap<&'static str, (std::time::Instant, serde_json::Value)>>,
}

type Shared = Arc<App>;

#[allow(clippy::too_many_arguments)] // one per CLI option group, passed straight through
pub async fn serve(
    theme: Theme,
    listen: SocketAddr,
    login: LoginSettings,
    claim: ClaimSettings,
    kube: KubeTarget,
    open: bool,
    demo: bool,
    config_note: Option<String>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        listen.ip().is_loopback(),
        "--listen {listen}: loopback only; this server starts logins and claims as you"
    );
    let mut b = [0u8; 24];
    aws_lc_rs::rand::fill(&mut b).map_err(|_| anyhow::anyhow!("no randomness"))?;
    let app = Arc::new(App {
        theme,
        secret: hex::encode(b),
        login,
        claim,
        kube,
        demo,
        config_note,
        kube_client: tokio::sync::OnceCell::new(),
        run: Mutex::new(None),
        issuer: Mutex::new((String::new(), String::new())),
        tls: Mutex::new(std::collections::HashMap::new()),
    });
    *lock(&app.issuer) = (app.login.issuer.clone(), app.login.ca_file.clone());
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let addr = listener.local_addr()?;
    let link = format!("http://{addr}/?t={}", app.secret);
    eprintln!("recess on http://{addr}; open this link (it carries this server's key):");
    println!("{link}");
    if open {
        crate::engine::open_browser(&link);
    }

    let api = Router::new()
        .route("/api/config", get(config))
        .route("/api/login", post(start))
        .route("/api/create", post(create))
        .route("/api/cancel", post(cancel))
        .route("/api/delete", post(delete))
        .route("/api/events", get(events))
        .route("/api/recent", get(recent))
        .route("/api/tls", get(tls))
        .route_layer(middleware::from_fn_with_state(app.clone(), require_cookie));
    let api = ASSETS.iter().fold(api, |r, &(path, ct, body)| {
        r.route(path, get(move || async move { asset(ct, body) }))
    });
    let router = Router::new()
        .route("/", get(index))
        .merge(api)
        .layer(middleware::from_fn(guard))
        .with_state(app.clone());

    let shutdown = {
        let app = app.clone();
        async move {
            let _ = tokio::signal::ctrl_c().await;
            if let Some(r) = lock(&app.run).as_ref() {
                r.cancel();
            }
        }
    };
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn asset(ct: &'static str, body: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, ct),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// Host check and security headers on every response.
async fn guard(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    let name = host.rsplit_once(':').map_or(host, |(h, _)| h);
    let name = name.trim_start_matches('[').trim_end_matches(']');
    let loopback = name == "localhost"
        || name
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !loopback {
        return (StatusCode::FORBIDDEN, "forbidden host").into_response();
    }
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        ),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    resp
}

fn has_cookie(app: &App, headers: &HeaderMap) -> bool {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .any(|(k, v)| {
            k == COOKIE
                && aws_lc_rs::constant_time::verify_slices_are_equal(
                    v.as_bytes(),
                    app.secret.as_bytes(),
                )
                .is_ok()
        })
}

async fn require_cookie(State(app): State<Shared>, req: Request, next: Next) -> Response {
    if !has_cookie(&app, req.headers()) {
        return (
            StatusCode::FORBIDDEN,
            "open the link recess printed at start",
        )
            .into_response();
    }
    if req.method() == axum::http::Method::POST
        && !req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json"))
    {
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "application/json only").into_response();
    }
    next.run(req).await
}

#[derive(Deserialize)]
struct IndexQuery {
    t: Option<String>,
    theme: Option<String>,
}

/// A cookie's value by name.
fn cookie<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find_map(|(k, v)| (k == name).then_some(v))
}

/// The theme to show: the one asked for, else the one picked last, else the server's.
fn theme_for(default: Theme, asked: Option<&str>, headers: &HeaderMap) -> Theme {
    asked
        .and_then(Theme::from_slug)
        .or_else(|| cookie(headers, THEME_COOKIE).and_then(Theme::from_slug))
        .unwrap_or(default)
}

async fn index(
    State(app): State<Shared>,
    Query(q): Query<IndexQuery>,
    headers: HeaderMap,
) -> Response {
    if let Some(t) = q.t {
        if aws_lc_rs::constant_time::verify_slices_are_equal(t.as_bytes(), app.secret.as_bytes())
            .is_err()
        {
            return (StatusCode::FORBIDDEN, "wrong key").into_response();
        }
        let cookie = format!("{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", app.secret);
        // The key leaves the address bar; a theme asked for with it stays.
        let to = q
            .theme
            .as_deref()
            .and_then(Theme::from_slug)
            .map_or_else(|| "/".to_owned(), |t| format!("/?theme={}", t.slug()));
        let mut r = Redirect::to(&to).into_response();
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            r.headers_mut().insert(header::SET_COOKIE, v);
        }
        return r;
    }
    if !has_cookie(&app, &headers) {
        return (
            StatusCode::FORBIDDEN,
            "open the link recess printed at start",
        )
            .into_response();
    }
    let theme = theme_for(app.theme, q.theme.as_deref(), &headers);
    let mut r = asset("text/html; charset=utf-8", page(theme));
    if q.theme.is_some() {
        let remember = format!(
            "{THEME_COOKIE}={}; Path=/; SameSite=Strict; Max-Age=31536000",
            theme.slug()
        );
        if let Ok(v) = HeaderValue::from_str(&remember) {
            r.headers_mut().insert(header::SET_COOKIE, v);
        }
    }
    r
}

async fn config(State(app): State<Shared>) -> Response {
    let session = crate::engine::session_path()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let current = lock(&app.run)
        .as_ref()
        .map(|r| json!({"id": r.id, "finished": r.finished(), "waiting": r.waiting()}));
    Json(json!({
        "login": app.login,
        "claim": app.claim,
        "sessionPath": session,
        "kubeContext": app.kube.context,
        "kubeconfig": app.kube.kubeconfig,
        "run": current,
        "demo": app.demo,
        "configFile": app.config_note,
    }))
    .into_response()
}

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({"error": msg.into()}))).into_response()
}

/// `mediatore login` with the form's options: a new run, which mints the token and then waits
/// for the workload. The issuer is required; one login per claim, as the CLI.
async fn start(State(app): State<Shared>, Json(login): Json<LoginSettings>) -> Response {
    if !app.demo && login.issuer.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "the issuer is required");
    }
    let mut slot = lock(&app.run);
    if slot.as_ref().is_some_and(|r| !r.finished()) {
        return err(
            StatusCode::CONFLICT,
            "a run is in progress; cancel it first",
        );
    }
    let run = Run::new();
    *slot = Some(run.clone());
    drop(slot);
    *lock(&app.issuer) = (login.issuer.clone(), login.ca_file.clone());
    let id = run.id.clone();
    if app.demo {
        tokio::spawn(crate::demo::run(run, login));
    } else {
        tokio::spawn(run.execute(login, app.kube.clone()));
    }
    (StatusCode::ACCEPTED, Json(json!({"id": id}))).into_response()
}

/// `mediatore sandbox create` with the form's options, handed to the run that waits for it.
async fn create(State(app): State<Shared>, Json(c): Json<ClaimSettings>) -> Response {
    let Some(run) = lock(&app.run).clone() else {
        return err(StatusCode::CONFLICT, "log in first");
    };
    match run.submit(c, !app.demo) {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, format!("{e:#}")),
    }
}

/// Cancel the run and release its claim, so it does not wait in the pool's queue unwatched.
async fn cancel(State(app): State<Shared>) -> Response {
    let run = lock(&app.run).clone();
    let Some(run) = run else {
        return StatusCode::NO_CONTENT.into_response();
    };
    match run.cancel_and_release().await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(
            StatusCode::BAD_GATEWAY,
            format!("cancelled, but the claim was not released: {e:#}"),
        ),
    }
}

async fn delete(State(app): State<Shared>) -> Response {
    let run = lock(&app.run).clone();
    let Some(run) = run else {
        return err(StatusCode::NOT_FOUND, "no run");
    };
    match run.delete_sandbox().await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, format!("{e:#}")),
    }
}

/// Your recent sandboxes, from the Kubernetes API: the ones whose subject is the identity in
/// the session file (or every one the kubeconfig may list, without a session), newest first.
async fn recent(State(app): State<Shared>) -> Response {
    if app.demo {
        return Json(
            json!({"items": crate::demo::recent(), "namespace": "sandboxes", "mine": true}),
        )
        .into_response();
    }
    let ns = if app.claim.namespace.is_empty() {
        app.kube.broker_namespace.clone()
    } else {
        app.claim.namespace.clone()
    };
    let (issuer, ids) = crate::engine::session_path()
        .ok()
        .and_then(|p| mediatore_client::Session::load(&p).ok())
        .and_then(|s| {
            crate::util::identity_of(&s.id_token)
                .ok()
                .map(|id| (s.issuer, id))
        })
        .map(|(issuer, id)| {
            let ids = [id.username, id.subject, id.email]
                .into_iter()
                .filter(|x| !x.is_empty())
                .collect::<Vec<_>>();
            (issuer, ids)
        })
        .unwrap_or_default();
    let client = match app
        .kube_client
        .get_or_try_init(|| crate::engine::kube_client(&app.kube))
        .await
    {
        Ok(c) => c.clone(),
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("kube: {e:#}")),
    };
    match crate::kubeinfo::recent_sandboxes(client, &ns, &issuer, &ids, 12).await {
        Ok(items) => {
            Json(json!({"items": items, "namespace": ns, "mine": !ids.is_empty()})).into_response()
        }
        Err(e) => err(
            StatusCode::BAD_GATEWAY,
            format!("listing sandboxes in {ns}: {e:#}"),
        ),
    }
}

#[derive(Deserialize)]
struct EventsQuery {
    run: Option<String>,
    from: Option<usize>,
}

#[derive(Deserialize)]
struct TlsQuery {
    target: String,
}

/// Recess's own TLS handshake with the broker or the issuer (`target=broker|issuer`): what
/// was negotiated and presented. Only those two hosts, the ones this server talks to anyway.
async fn tls(State(app): State<Shared>, Query(q): Query<TlsQuery>) -> Response {
    let (key, url, ca) = match q.target.as_str() {
        "broker" => ("broker", app.claim.url.clone(), app.claim.ca_file.clone()),
        "issuer" => {
            let (u, c) = lock(&app.issuer).clone();
            ("issuer", u, c)
        }
        _ => return err(StatusCode::BAD_REQUEST, "target is broker or issuer"),
    };
    if let Some((at, v)) = lock(&app.tls).get(key)
        && at.elapsed() < Duration::from_secs(60)
    {
        return Json(v.clone()).into_response();
    }
    let result = if app.demo {
        Ok(crate::probe::demo(&url))
    } else {
        crate::probe::probe(&url, &ca).await
    };
    match result {
        Ok(p) => {
            let v = serde_json::to_value(&p).unwrap_or_default();
            lock(&app.tls).insert(key, (std::time::Instant::now(), v.clone()));
            Json(v).into_response()
        }
        Err(e) => err(StatusCode::BAD_GATEWAY, format!("{e:#}")),
    }
}

/// The current run's events, replayed from `from` (or Last-Event-ID), then live.
#[allow(clippy::result_large_err)] // axum handler: the error is the response
async fn events(
    State(app): State<Shared>,
    Query(q): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, Response> {
    let run = lock(&app.run)
        .clone()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no run"))?;
    if q.run.as_ref().is_some_and(|id| *id != run.id) {
        return Err(err(StatusCode::GONE, "that run was replaced"));
    }
    let from = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .map(|n| n + 1)
        .or(q.from)
        .unwrap_or(0);
    let stream = futures::stream::unfold((run, from, false), |(run, from, ended)| async move {
        if ended {
            return None;
        }
        loop {
            let (evs, done, mut rx) = run.since(from);
            if let Some(e) = evs.into_iter().next() {
                let data = serde_json::to_string(&e).unwrap_or_default();
                let ev = SseEvent::default().id(e.seq.to_string()).data(data);
                return Some((Ok(ev), (run, from + 1, false)));
            }
            if done {
                let ev = SseEvent::default().event("end").data("{}");
                return Some((Ok(ev), (run, from, true)));
            }
            let _ = rx.changed().await;
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `src="/..."` and `href="/..."` in a page, the paths it will ask this server for.
    fn local_refs(html: &str) -> Vec<&str> {
        ["src=\"/", "href=\"/"]
            .iter()
            .flat_map(|attr| {
                html.match_indices(attr)
                    .map(move |(i, _)| i + attr.len() - 1)
            })
            .filter_map(|start| html[start..].split('"').next())
            .collect()
    }

    #[test]
    fn every_file_each_page_loads_is_served() {
        for theme in Theme::ALL {
            let refs = local_refs(page(theme));
            assert!(!refs.is_empty(), "the page loads its script and stylesheet");
            for r in refs {
                assert!(
                    ASSETS.iter().any(|(path, _, _)| *path == r),
                    "{r} is referenced by a page but not served"
                );
            }
        }
    }

    #[test]
    fn the_two_pages_differ_and_share_the_cli_previews() {
        assert_ne!(page(Theme::Classic), page(Theme::Wired3d));
        for theme in Theme::ALL {
            assert!(local_refs(page(theme)).contains(&"/cli.js"));
        }
    }

    #[test]
    fn every_page_offers_every_theme_with_its_own_selected() {
        for theme in Theme::ALL {
            let html = page(theme);
            assert!(html.contains(r#"id="theme""#), "{theme:?} has the dropdown");
            for t in Theme::ALL {
                let opt = format!(r#"<option value="{}""#, t.slug());
                assert!(html.contains(&opt), "{theme:?} offers {t:?}");
            }
            let selected = format!(r#"<option value="{}" selected"#, theme.slug());
            assert!(html.contains(&selected), "{theme:?} shows itself picked");
        }
    }

    #[test]
    fn the_theme_asked_for_wins_then_the_one_picked_last_then_the_servers() {
        let headers = |c: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::COOKIE, HeaderValue::from_str(c).unwrap());
            h
        };
        let pick = theme_for;
        let none = HeaderMap::new();
        let picked = headers("recess=k; recess-theme=wired-3d");
        assert_eq!(pick(Theme::Classic, None, &none), Theme::Classic);
        assert_eq!(pick(Theme::Classic, None, &picked), Theme::Wired3d);
        assert_eq!(
            pick(Theme::Wired3d, Some("classic"), &picked),
            Theme::Classic
        );
        assert_eq!(pick(Theme::Wired3d, Some("bogus"), &none), Theme::Wired3d);
    }
}
