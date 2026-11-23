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
use futures::{Stream, StreamExt as _};
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
    (
        "/theatre.js",
        "text/javascript",
        include_str!("../assets/theatre.js"),
    ),
    (
        "/agentsandbox.js",
        "text/javascript",
        include_str!("../assets/agentsandbox.js"),
    ),
    (
        "/agentsandbox.css",
        "text/css",
        include_str!("../assets/agentsandbox.css"),
    ),
    (
        "/admin.js",
        "text/javascript",
        include_str!("../assets/admin.js"),
    ),
    (
        "/admin.css",
        "text/css",
        include_str!("../assets/admin.css"),
    ),
];

/// The page for each view.
const fn page(view: View) -> &'static str {
    match view {
        View::Classic => include_str!("../assets/index.html"),
        View::AgentSandbox => include_str!("../assets/agentsandbox.html"),
        View::Admin => include_str!("../assets/admin.html"),
    }
}

/// The cookie that remembers the view last picked in the page's View menu.
const VIEW_COOKIE: &str = "recess-view";
/// Its name while the menu was called Theme; still read.
const OLD_VIEW_COOKIE: &str = "recess-theme";

/// What the page shows. The API behind every view is the same, so switching keeps the run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum View {
    /// Your run, as stage cards.
    Classic,
    /// Your run as a wireframe 3D journey: the request sealed into an envelope and carried
    /// through the issuer, the broker, the Kubernetes API and the sandbox VM.
    #[value(name = "agentsandbox", alias = "wired-3d")]
    AgentSandbox,
    /// Every live agent in the cluster, in the same 3D theatre; read-only.
    #[value(alias = "watch")]
    Admin,
}

impl View {
    const ALL: [Self; 3] = [Self::Classic, Self::AgentSandbox, Self::Admin];

    /// The name in `--view`, `?view=` and the cookie.
    const fn slug(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::AgentSandbox => "agentsandbox",
            Self::Admin => "admin",
        }
    }

    /// A view by its name, or by the name it had before (`wired-3d`, `watch`): links, cookies
    /// and config files from then keep working.
    fn from_slug(s: &str) -> Option<Self> {
        let s = match s {
            "wired-3d" => "agentsandbox",
            "watch" => "admin",
            other => other,
        };
        Self::ALL.into_iter().find(|t| t.slug() == s)
    }
}

struct App {
    view: View,
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
    /// What the admin page shows, watched once for every viewer.
    fleet: Arc<crate::admin::Fleet>,
    /// Set on Ctrl-C: every open event stream ends, so the graceful shutdown is not left
    /// waiting on a page that would otherwise stream forever.
    stopping: tokio::sync::watch::Sender<bool>,
}

/// A future that is ready once the server is stopping.
fn stopped(app: &App) -> impl std::future::Future<Output = ()> + Send + use<> {
    let mut rx = app.stopping.subscribe();
    async move {
        let _ = rx.wait_for(|s| *s).await;
    }
}

type Shared = Arc<App>;

#[allow(clippy::too_many_arguments)] // one per CLI option group, passed straight through
pub async fn serve(
    view: View,
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
        view,
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
        fleet: crate::admin::Fleet::new(),
        stopping: tokio::sync::watch::channel(false).0,
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
        .route("/api/admin", get(admin_events))
        .route("/api/admin/output", get(admin_output))
        .route_layer(middleware::from_fn_with_state(app.clone(), require_cookie));
    let api = ASSETS.iter().fold(api, |r, &(path, ct, body)| {
        r.route(path, get(move || async move { asset(ct, body) }))
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/admin", get(admin_page))
        // Its address before the rename, for links and bookmarks.
        .route("/watch", get(|| async { Redirect::permanent("/admin") }))
        .merge(api)
        .layer(middleware::from_fn(guard))
        .with_state(app.clone());

    let shutdown = {
        let app = app.clone();
        async move {
            let _ = tokio::signal::ctrl_c().await;
            eprintln!("recess: stopping (Ctrl-C again to stop at once)");
            if let Some(r) = lock(&app.run).as_ref() {
                r.cancel();
            }
            app.stopping.send_replace(true);
            // Should anything still hold the shutdown up: a second Ctrl-C, or five seconds.
            tokio::spawn(async {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    () = tokio::time::sleep(Duration::from_secs(5)) => {}
                }
                std::process::exit(130);
            });
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
    view: Option<String>,
    /// `?view=`'s old name.
    theme: Option<String>,
}

impl IndexQuery {
    fn asked(&self) -> Option<&str> {
        self.view.as_deref().or(self.theme.as_deref())
    }
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

/// The view to show: the one asked for, else the one picked last, else the server's.
fn view_for(default: View, asked: Option<&str>, headers: &HeaderMap) -> View {
    asked
        .and_then(View::from_slug)
        .or_else(|| cookie(headers, VIEW_COOKIE).and_then(View::from_slug))
        .or_else(|| cookie(headers, OLD_VIEW_COOKIE).and_then(View::from_slug))
        .unwrap_or(default)
}

async fn index(
    State(app): State<Shared>,
    Query(q): Query<IndexQuery>,
    headers: HeaderMap,
) -> Response {
    if let Some(t) = q.t.as_deref() {
        // The key leaves the address bar; a view asked for with it stays.
        let to = q
            .asked()
            .and_then(View::from_slug)
            .map_or_else(|| "/".to_owned(), |v| format!("/?view={}", v.slug()));
        return trade_key(&app, t, &to);
    }
    if !has_cookie(&app, &headers) {
        return (
            StatusCode::FORBIDDEN,
            "open the link recess printed at start",
        )
            .into_response();
    }
    let view = view_for(app.view, q.asked(), &headers);
    let mut r = asset("text/html; charset=utf-8", page(view));
    if q.asked().is_some() {
        let remember = format!(
            "{VIEW_COOKIE}={}; Path=/; SameSite=Strict; Max-Age=31536000",
            view.slug()
        );
        if let Ok(v) = HeaderValue::from_str(&remember) {
            r.headers_mut().insert(header::SET_COOKIE, v);
        }
    }
    r
}

/// The key in the printed link, traded for the cookie, then on to `to` without it.
fn trade_key(app: &App, t: &str, to: &str) -> Response {
    if aws_lc_rs::constant_time::verify_slices_are_equal(t.as_bytes(), app.secret.as_bytes())
        .is_err()
    {
        return (StatusCode::FORBIDDEN, "wrong key").into_response();
    }
    let cookie = format!("{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", app.secret);
    let mut r = Redirect::to(to).into_response();
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        r.headers_mut().insert(header::SET_COOKIE, v);
    }
    r
}

/// `/admin`: the Admin view at its own address, for a link or a bookmark; picking it from the
/// View menu goes through `/?view=admin` and is remembered. `?t=` trades the key as `/` does.
async fn admin_page(
    State(app): State<Shared>,
    Query(q): Query<IndexQuery>,
    headers: HeaderMap,
) -> Response {
    if let Some(t) = q.t.as_deref() {
        return trade_key(&app, t, "/admin");
    }
    if !has_cookie(&app, &headers) {
        return (
            StatusCode::FORBIDDEN,
            "open the link recess printed at start",
        )
            .into_response();
    }
    asset("text/html; charset=utf-8", page(View::Admin))
}

/// The admin page's stream: the whole picture, then each change. The first viewer starts the
/// watches (or the demo's fleet); a viewer that falls behind gets the whole picture again.
async fn admin_events(
    State(app): State<Shared>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let fleet = app.fleet.clone();
    if fleet.first() {
        if app.demo {
            tokio::spawn(crate::admin::demo(fleet.clone()));
        } else {
            match app
                .kube_client
                .get_or_try_init(|| crate::engine::kube_client(&app.kube))
                .await
            {
                Ok(c) => crate::admin::spawn(&fleet, c, app.kube.broker_namespace.clone()),
                Err(e) => fleet.note("cluster", &format!("kube: {e:#}")),
            }
        }
    }
    let start: Option<tokio::sync::broadcast::Receiver<Arc<str>>> = None;
    let stream = futures::stream::unfold((fleet, start), |(fleet, rx)| async move {
        let Some(mut rx) = rx else {
            let (snap, rx) = fleet.subscribe();
            return Some((Ok(SseEvent::default().data(snap)), (fleet, Some(rx))));
        };
        match rx.recv().await {
            Ok(msg) => Some((Ok(SseEvent::default().data(&*msg)), (fleet, Some(rx)))),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                let (snap, rx) = fleet.subscribe();
                Some((Ok(SseEvent::default().data(snap)), (fleet, Some(rx))))
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => None,
        }
    });
    let stream = stream.take_until(stopped(&app));
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

#[derive(Deserialize)]
struct OutputQuery {
    ns: String,
    name: String,
}

/// A Kubernetes object name: what may go into the broker's URL path, and nothing else.
fn kube_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

/// One sandbox's output, for the admin page's Output tab: the broker's stream as the
/// signed-in user, which the broker allows only for the sandbox's owner.
#[allow(clippy::result_large_err)] // axum handler: the error is the response
async fn admin_output(
    State(app): State<Shared>,
    Query(q): Query<OutputQuery>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, Response> {
    if !kube_name(&q.ns) || !kube_name(&q.name) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "ns and name are Kubernetes names",
        ));
    }
    let stream = crate::admin::output(app.claim.clone(), q.ns, q.name, app.demo)
        .map(|v| Ok(SseEvent::default().data(v.to_string())))
        .take_until(stopped(&app));
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
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
    let stream = stream.take_until(stopped(&app));
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
    fn only_a_kubernetes_name_reaches_the_brokers_url() {
        assert!(kube_name("sandbox-f8e3aa8a"));
        assert!(kube_name("team-a"));
        for bad in ["", "../claims", "a/b", "A", "x?y", "a b", &"a".repeat(254)] {
            assert!(!kube_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn every_file_each_page_loads_is_served() {
        for html in View::ALL.map(page) {
            let refs = local_refs(html);
            assert!(!refs.is_empty(), "the page loads its script and stylesheet");
            for r in refs {
                assert!(
                    ["/", "/admin"].contains(&r) || ASSETS.iter().any(|(path, _, _)| *path == r),
                    "{r} is referenced by a page but not served"
                );
            }
        }
    }

    #[test]
    fn the_two_pages_differ_and_share_the_cli_previews() {
        assert_ne!(page(View::Classic), page(View::AgentSandbox));
        assert_ne!(page(View::AgentSandbox), page(View::Admin));
        for view in View::ALL {
            assert!(local_refs(page(view)).contains(&"/cli.js"));
        }
    }

    #[test]
    fn every_page_offers_every_view_with_its_own_selected() {
        for view in View::ALL {
            let html = page(view);
            assert!(html.contains(r#"id="view""#), "{view:?} has the View menu");
            for v in View::ALL {
                let opt = format!(r#"<option value="{}""#, v.slug());
                assert!(html.contains(&opt), "{view:?} offers {v:?}");
            }
            let selected = format!(r#"<option value="{}" selected"#, view.slug());
            assert!(html.contains(&selected), "{view:?} shows itself picked");
        }
    }

    #[test]
    fn the_view_asked_for_wins_then_the_one_picked_last_then_the_servers() {
        let headers = |c: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::COOKIE, HeaderValue::from_str(c).unwrap());
            h
        };
        let pick = view_for;
        let none = HeaderMap::new();
        let picked = headers("recess=k; recess-view=admin");
        let picked_before = headers("recess=k; recess-theme=wired-3d");
        assert_eq!(pick(View::Classic, None, &none), View::Classic);
        assert_eq!(pick(View::Classic, None, &picked), View::Admin);
        assert_eq!(
            pick(View::Classic, None, &picked_before),
            View::AgentSandbox,
            "the old cookie, and the old name in it, are still read"
        );
        assert_eq!(
            pick(View::Classic, Some("watch"), &none),
            View::Admin,
            "the old name in a link"
        );
        assert_eq!(
            pick(View::AgentSandbox, Some("classic"), &picked),
            View::Classic
        );
        assert_eq!(
            pick(View::AgentSandbox, Some("bogus"), &none),
            View::AgentSandbox
        );
    }
}
