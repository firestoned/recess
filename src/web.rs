// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The web front end: one page, fed by server-sent events. It runs in one of two modes.
//!
//! **On your machine** (no `--oidc-issuer`): the server starts logins and claims as you and
//! reads the cluster with your kubeconfig, so it is guarded: loopback only, the Host header
//! checked (DNS rebinding), and a key in the printed link traded for a SameSite=Strict
//! HttpOnly cookie that every route but the trade requires.
//!
//! **Shared, behind Dex** (`--oidc-issuer`, `--public-url`): everyone signs in first
//! ([`crate::signin`]), and every Kubernetes read made for them carries their own ID token, so
//! the API server applies their RBAC; the process's own credentials are never used for them.
//! It may listen beyond loopback; the Host header must be the public URL's. Runs (a login to
//! mediatore, a claim) are refused: they act with the session of whoever started the server.
//!
//! In both, POSTs take JSON only, which a cross-site form cannot send without a preflight.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Extension;
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
use crate::signin::{self, Sessions, User};

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
    /// Shared behind Dex: the sessions, and the Host browsers use. None on your machine.
    shared: Option<Sharing>,
}

/// What the shared mode needs at hand.
struct Sharing {
    sessions: Arc<Sessions>,
    host: String,
    /// Cookies get `Secure` when the public URL is https.
    secure: bool,
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
    sign_in: signin::Settings,
) -> anyhow::Result<()> {
    let shared = if sign_in.enabled() {
        let public = signin::public_url(&sign_in.public_url)?;
        let provider = signin::Provider::discover(sign_in).await?;
        let base = if demo {
            kube::Config::new("https://kubernetes.invalid".parse()?)
        } else {
            crate::engine::kube_config(&kube).await?
        };
        let sessions = Sessions::new(provider, base);
        let sweep = sessions.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                sweep.sweep();
            }
        });
        Some(Sharing {
            sessions,
            host: signin::public_host(&public),
            secure: public.starts_with("https://"),
        })
    } else {
        anyhow::ensure!(
            listen.ip().is_loopback(),
            "--listen {listen}: loopback only; this server starts logins and claims as you \
             (to share it beyond loopback, put it behind Dex: --oidc-issuer and --public-url)"
        );
        None
    };
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
        shared,
    });
    *lock(&app.issuer) = (app.login.issuer.clone(), app.login.ca_file.clone());
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let addr = listener.local_addr()?;
    if let Some(sh) = &app.shared {
        eprintln!(
            "recess on http://{addr}, served as {}; everyone signs in with {}",
            sh.host,
            sh.sessions.provider.issuer()
        );
    } else {
        let link = format!("http://{addr}/?t={}", app.secret);
        eprintln!("recess on http://{addr}; open this link (it carries this server's key):");
        println!("{link}");
        if open {
            crate::engine::open_browser(&link);
        }
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
        .route("/api/layout", get(layout).put(save_layout))
        .route("/api/admin", get(admin_events))
        .route("/api/admin/output", get(admin_output))
        .route("/auth/logout", post(sign_out))
        .route_layer(middleware::from_fn_with_state(app.clone(), require_access));
    let api = ASSETS.iter().fold(api, |r, &(path, ct, body)| {
        r.route(path, get(move || async move { asset(ct, body) }))
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/admin", get(admin_page))
        // Its address before the rename, for links and bookmarks.
        .route("/watch", get(|| async { Redirect::permanent("/admin") }))
        .route("/auth/login", get(sign_in_start))
        .route(signin::CALLBACK, get(sign_in_callback))
        .merge(api)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app.clone());

    let shutdown = {
        let app = app.clone();
        async move {
            stop_signal().await;
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

/// Ctrl-C, or SIGTERM (a pod being stopped).
async fn stop_signal() {
    #[cfg(unix)]
    {
        let term = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut s) => {
                    s.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = term => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
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

/// Whether a `Host` header names this machine.
fn loopback_host(host: &str) -> bool {
    let name = host.rsplit_once(':').map_or(host, |(h, _)| h);
    let name = name.trim_start_matches('[').trim_end_matches(']');
    name == "localhost"
        || name
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// Host check and security headers on every response. `/healthz` answers any Host (a
/// kubelet's probe names the pod's address) and says nothing but "ok".
async fn guard(State(app): State<Shared>, req: Request, next: Next) -> Response {
    if req.uri().path() == "/healthz" {
        return (StatusCode::OK, "ok").into_response();
    }
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    let allowed = loopback_host(host)
        || app
            .shared
            .as_ref()
            .is_some_and(|sh| host.eq_ignore_ascii_case(&sh.host));
    if !allowed {
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

/// The signed-in person for these headers, in the shared mode.
fn user_of(app: &App, headers: &HeaderMap) -> Option<Arc<User>> {
    let sh = app.shared.as_ref()?;
    sh.sessions.get(cookie(headers, signin::SESSION_COOKIE)?)
}

/// The API's gate: the key's cookie on your machine; a live session when shared, whose user
/// rides on the request for the handlers.
async fn require_access(State(app): State<Shared>, mut req: Request, next: Next) -> Response {
    if app.shared.is_some() {
        let Some(user) = user_of(&app, req.headers()) else {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "sign in first", "signIn": "/auth/login"})),
            )
                .into_response();
        };
        req.extensions_mut().insert(user);
    } else if !has_cookie(&app, req.headers()) {
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
    uri: axum::http::Uri,
) -> Response {
    if app.shared.is_some() {
        if user_of(&app, &headers).is_none() {
            return to_sign_in(&uri);
        }
    } else if let Some(t) = q.t.as_deref() {
        // The key leaves the address bar; a view asked for with it stays.
        let to = q
            .asked()
            .and_then(View::from_slug)
            .map_or_else(|| "/".to_owned(), |v| format!("/?view={}", v.slug()));
        return trade_key(&app, t, &to);
    } else if !has_cookie(&app, &headers) {
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
    uri: axum::http::Uri,
) -> Response {
    if app.shared.is_some() {
        if user_of(&app, &headers).is_none() {
            return to_sign_in(&uri);
        }
    } else if let Some(t) = q.t.as_deref() {
        return trade_key(&app, t, "/admin");
    } else if !has_cookie(&app, &headers) {
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
    user: Option<Extension<Arc<User>>>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let fleet = match &user {
        Some(u) => u.fleet.clone(),
        None => app.fleet.clone(),
    };
    if fleet.first() {
        if let Some(u) = &user {
            // The signed-in person's own picture: watched with their token, so the API server
            // shows them what their RBAC allows and notes the rest.
            if app.demo {
                u.hold([tokio::spawn(crate::admin::demo(fleet.clone())).abort_handle()]);
            } else {
                u.hold(crate::admin::spawn(
                    &fleet,
                    &u.client,
                    app.kube.broker_namespace.clone(),
                ));
            }
        } else if app.demo {
            tokio::spawn(crate::admin::demo(fleet.clone()));
        } else {
            match app
                .kube_client
                .get_or_try_init(|| crate::engine::kube_client(&app.kube))
                .await
            {
                Ok(c) => {
                    crate::admin::spawn(&fleet, c, app.kube.broker_namespace.clone());
                }
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
    if let Some(r) = no_runs(&app) {
        return Err(r);
    }
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

async fn config(State(app): State<Shared>, user: Option<Extension<Arc<User>>>) -> Response {
    if let Some(u) = user {
        let c = lock(&u.claims).clone();
        let (kube_user, kube_groups) = lock(&u.seen_as).clone().unwrap_or_default();
        return Json(json!({
            "user": {"name": c.name, "email": c.email, "groups": c.groups,
                     "kubeUser": kube_user, "kubeGroups": kube_groups},
            "issuer": app.shared.as_ref().map(|sh| sh.sessions.provider.issuer()),
            "runs": false,
            "demo": app.demo,
            "login": app.login,
            "claim": app.claim,
        }))
        .into_response();
    }
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
        "runs": true,
    }))
    .into_response()
}

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({"error": msg.into()}))).into_response()
}

/// Runs are refused when shared: a login to mediatore and a claim would act with the session
/// of whoever started the server, not the person signed in.
fn no_runs(app: &App) -> Option<Response> {
    app.shared.as_ref().map(|_| {
        err(
            StatusCode::FORBIDDEN,
            "this Recess is shared: it shows the cluster as you, and starts no runs. To run a \
             workload, use recess on your own machine.",
        )
    })
}

/// Off to the issuer, and back to `uri` after.
fn to_sign_in(uri: &axum::http::Uri) -> Response {
    let next = uri.path_and_query().map_or("/", |p| p.as_str());
    let mut u = reqwest::Url::parse("http://x/auth/login").expect("a constant URL");
    u.query_pairs_mut().append_pair("next", next);
    Redirect::to(&format!("/auth/login?{}", u.query().unwrap_or_default())).into_response()
}

#[derive(Deserialize)]
struct SignInQuery {
    next: Option<String>,
}

/// `/auth/login`: a new sign-in, bound to this browser by a cookie holding its `state`.
async fn sign_in_start(State(app): State<Shared>, Query(q): Query<SignInQuery>) -> Response {
    let Some(sh) = &app.shared else {
        return (StatusCode::NOT_FOUND, "no sign-in on this server").into_response();
    };
    match sh.sessions.provider.begin(q.next.as_deref().unwrap_or("/")) {
        Ok((state, pending, url)) => {
            sh.sessions.stash(state.clone(), pending);
            let mut r = Redirect::to(&url).into_response();
            set_cookie(
                &mut r,
                &signin::cookie(signin::LOGIN_COOKIE, &state, sh.secure, Some(600)),
            );
            r
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("sign-in: {e:#}")).into_response(),
    }
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

fn set_cookie(r: &mut Response, c: &str) {
    if let Ok(v) = HeaderValue::from_str(c) {
        r.headers_mut().append(header::SET_COOKIE, v);
    }
}

/// A sign-in that did not finish: said in plain text, with the way to try again.
fn sign_in_failed(why: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        format!("Sign-in failed: {why}\n\nTry again: /auth/login\n"),
    )
        .into_response()
}

/// `/auth/callback`: the issuer's answer. The `state` must be the one this browser started;
/// the code is traded for tokens, and the API server is asked who they make you, before the
/// session opens: a token it will not take is refused here rather than on every read.
async fn sign_in_callback(
    State(app): State<Shared>,
    Query(q): Query<CallbackQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(sh) = &app.shared else {
        return (StatusCode::NOT_FOUND, "no sign-in on this server").into_response();
    };
    if let Some(e) = &q.error {
        let d = q.error_description.as_deref().unwrap_or_default();
        return sign_in_failed(&format!("the issuer answered {e} {d}"));
    }
    let (Some(code), Some(state)) = (q.code.as_deref(), q.state.as_deref()) else {
        return sign_in_failed("the issuer's answer has no code");
    };
    let bound = cookie(&headers, signin::LOGIN_COOKIE).is_some_and(|c| {
        aws_lc_rs::constant_time::verify_slices_are_equal(c.as_bytes(), state.as_bytes()).is_ok()
    });
    let Some(pending) = sh.sessions.take(state).filter(|_| bound) else {
        return sign_in_failed(
            "this answer is not for a sign-in this browser started (or it took over ten minutes)",
        );
    };
    let tokens = match sh.sessions.provider.finish(&pending, code).await {
        Ok(t) => t,
        Err(e) => return sign_in_failed(&format!("{e:#}")),
    };
    let (sid, user) = match sh.sessions.open(tokens) {
        Ok(x) => x,
        Err(e) => return sign_in_failed(&format!("{e:#}")),
    };
    if !app.demo {
        match signin::whoami(&user.client).await {
            Ok(who) => *lock(&user.seen_as) = Some(who),
            Err(e) => {
                sh.sessions.close(&sid);
                return sign_in_failed(&format!(
                    "the Kubernetes API server did not accept your token ({e}). Its \
                     authentication must trust this issuer for the audience Recess asks for \
                     (--oidc-audience, else --oidc-client-id)."
                ));
            }
        }
    }
    let mut r = Redirect::to(Sessions::next_of(&pending)).into_response();
    set_cookie(
        &mut r,
        &signin::cookie(signin::SESSION_COOKIE, &sid, sh.secure, None),
    );
    set_cookie(
        &mut r,
        &signin::cookie(signin::LOGIN_COOKIE, "", sh.secure, Some(0)),
    );
    r
}

/// `POST /auth/logout`: the session ends, its watches stop, its tokens are dropped.
async fn sign_out(State(app): State<Shared>, headers: HeaderMap) -> Response {
    let Some(sh) = &app.shared else {
        return StatusCode::NO_CONTENT.into_response();
    };
    if let Some(sid) = cookie(&headers, signin::SESSION_COOKIE) {
        sh.sessions.close(sid);
    }
    let mut r = StatusCode::NO_CONTENT.into_response();
    set_cookie(
        &mut r,
        &signin::cookie(signin::SESSION_COOKIE, "", sh.secure, Some(0)),
    );
    r
}

/// `mediatore login` with the form's options: a new run, which mints the token and then waits
/// for the workload. The issuer is required; one login per claim, as the CLI.
async fn start(State(app): State<Shared>, Json(login): Json<LoginSettings>) -> Response {
    if let Some(r) = no_runs(&app) {
        return r;
    }
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
    if let Some(r) = no_runs(&app) {
        return r;
    }
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
    if let Some(r) = no_runs(&app) {
        return r;
    }
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
    if let Some(r) = no_runs(&app) {
        return r;
    }
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
async fn recent(State(app): State<Shared>, user: Option<Extension<Arc<User>>>) -> Response {
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
    if let Some(u) = user {
        // Shared: the signed-in person's sandboxes, listed with their token.
        let c = lock(&u.claims).clone();
        let issuer = app
            .shared
            .as_ref()
            .map(|sh| sh.sessions.provider.issuer().to_owned())
            .unwrap_or_default();
        let ids: Vec<String> = [c.name, c.subject, c.email]
            .into_iter()
            .filter(|x| !x.is_empty())
            .collect();
        return match crate::kubeinfo::recent_sandboxes(u.client.clone(), &ns, &issuer, &ids, 12)
            .await
        {
            Ok(items) => {
                Json(json!({"items": items, "namespace": ns, "mine": true})).into_response()
            }
            Err(e) => err(
                StatusCode::BAD_GATEWAY,
                format!("listing sandboxes in {ns}: {e:#}"),
            ),
        };
    }
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
/// The 3D views whose layout can be saved, and how many nodes each may move.
const LAYOUT_VIEWS: [&str; 2] = ["agentsandbox", "admin"];
const LAYOUT_MAX: usize = 512;

/// What Ctrl-drag moved, by view, then by node: an offset from where the code stands it.
type Layout = std::collections::BTreeMap<String, std::collections::BTreeMap<String, [f64; 3]>>;

/// One view's layout, as the page sends it after a move.
#[derive(Deserialize)]
struct LayoutPut {
    view: String,
    moved: std::collections::BTreeMap<String, [f64; 3]>,
}

/// One save at a time: each reads the file, changes its view and writes it back.
static LAYOUT_LOCK: Mutex<()> = Mutex::new(());

fn read_layout(path: &std::path::Path) -> Layout {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// The saved layout, and whether this server saves one: on your machine, not when shared (then
/// each browser keeps its own, in localStorage: theatre.js `saveLayout`).
async fn layout(State(app): State<Shared>) -> Response {
    let path = crate::config::layout_path().filter(|_| app.shared.is_none());
    let views = path.as_deref().map(read_layout).unwrap_or_default();
    Json(json!({"editable": path.is_some(), "views": views})).into_response()
}

fn check_layout(put: &LayoutPut) -> Result<(), String> {
    if !LAYOUT_VIEWS.contains(&put.view.as_str()) {
        return Err(format!("no layout is kept for the view {:?}", put.view));
    }
    if put.moved.len() > LAYOUT_MAX {
        return Err(format!("more than {LAYOUT_MAX} nodes moved"));
    }
    for (k, v) in &put.moved {
        if k.is_empty() || k.len() > 256 {
            return Err("a node's key is empty or longer than 256".into());
        }
        if v.iter().any(|x| !x.is_finite() || x.abs() > 1000.0) {
            return Err(format!("{k}: an offset out of range"));
        }
    }
    Ok(())
}

fn write_layout(path: &std::path::Path, put: LayoutPut) -> anyhow::Result<()> {
    let _one = lock(&LAYOUT_LOCK);
    let mut all = read_layout(path);
    if put.moved.is_empty() {
        all.remove(&put.view);
    } else {
        all.insert(put.view, put.moved);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&all)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

async fn save_layout(State(app): State<Shared>, Json(put): Json<LayoutPut>) -> Response {
    if app.shared.is_some() {
        return err(
            StatusCode::FORBIDDEN,
            "this Recess is shared: moves are kept in each browser, not on the server",
        );
    }
    if let Err(e) = check_layout(&put) {
        return err(StatusCode::BAD_REQUEST, e);
    }
    let Some(path) = crate::config::layout_path() else {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "no home directory to keep the layout in",
        );
    };
    match tokio::task::spawn_blocking(move || write_layout(&path, put)).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the layout was not saved: {e:#}"),
        ),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the layout was not saved: {e}"),
        ),
    }
}

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
    if let Some(r) = no_runs(&app) {
        return Err(r);
    }
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

    #[test]
    fn a_layout_is_checked_then_kept_per_view() {
        let put = |view: &str, moved: &[(&str, [f64; 3])]| LayoutPut {
            view: view.into(),
            moved: moved.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect(),
        };
        assert!(check_layout(&put("agentsandbox", &[("spire", [1.0, 0.0, -2.5])])).is_ok());
        assert!(check_layout(&put("classic", &[])).is_err());
        assert!(check_layout(&put("admin", &[("", [0.0; 3])])).is_err());
        assert!(check_layout(&put("admin", &[("gw/a", [f64::NAN, 0.0, 0.0])])).is_err());
        assert!(check_layout(&put("admin", &[("gw/a", [1e6, 0.0, 0.0])])).is_err());

        let dir = std::env::temp_dir().join(format!("recess-layout-{}", std::process::id()));
        let path = dir.join("layout.json");
        write_layout(&path, put("agentsandbox", &[("spire", [1.0, 0.0, 2.0])])).unwrap();
        write_layout(&path, put("admin", &[("gw/a", [0.0, 1.0, 0.0])])).unwrap();
        let all = read_layout(&path);
        assert_eq!(all["agentsandbox"]["spire"], [1.0, 0.0, 2.0]);
        assert_eq!(all["admin"]["gw/a"], [0.0, 1.0, 0.0]);
        // Everything put back: the view is dropped from the file.
        write_layout(&path, put("admin", &[])).unwrap();
        assert!(!read_layout(&path).contains_key("admin"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

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

    /// The names a script declares at its top level: in a classic script, globals.
    fn top_level_names(js: &str) -> std::collections::BTreeSet<&str> {
        js.lines()
            .filter_map(|l| {
                [
                    "async function ",
                    "function ",
                    "const ",
                    "let ",
                    "var ",
                    "class ",
                ]
                .iter()
                .find_map(|kw| l.strip_prefix(kw))
            })
            .filter_map(|rest| {
                rest.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
                    .next()
                    .filter(|n| !n.is_empty())
            })
            .collect()
    }

    #[test]
    fn no_two_scripts_on_a_page_declare_the_same_name() {
        // A page's scripts share one global scope: a name declared in two of them is one
        // function, and the later script's replaces the other's (AgentSandbox's signedIn() once
        // ran on every load in place of cli.js's, stamping sheet 01 before anyone signed in).
        for view in View::ALL {
            let scripts: Vec<(&str, std::collections::BTreeSet<&str>)> = local_refs(page(view))
                .into_iter()
                .filter(|r| {
                    std::path::Path::new(r)
                        .extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("js"))
                })
                .map(|r| {
                    let body = ASSETS.iter().find(|(path, _, _)| *path == r).unwrap().2;
                    (r, top_level_names(body))
                })
                .collect();
            for (i, (a, an)) in scripts.iter().enumerate() {
                for (b, bn) in &scripts[i + 1..] {
                    let both: Vec<_> = an.intersection(bn).collect();
                    assert!(
                        both.is_empty(),
                        "{view:?}: {a} and {b} both declare {both:?}"
                    );
                }
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
