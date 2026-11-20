// Copyright (c) 2026 Erick Bourgeois, Low Tide
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

use crate::engine::{KubeTarget, Run, Settings};

const COOKIE: &str = "low_tide";

struct App {
    secret: String,
    defaults: Settings,
    kube: KubeTarget,
    demo: bool,
    run: Mutex<Option<Arc<Run>>>,
}

type Shared = Arc<App>;

pub async fn serve(
    listen: SocketAddr,
    defaults: Settings,
    kube: KubeTarget,
    open: bool,
    demo: bool,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        listen.ip().is_loopback(),
        "--listen {listen}: loopback only; this server starts logins and claims as you"
    );
    let mut b = [0u8; 24];
    aws_lc_rs::rand::fill(&mut b).map_err(|_| anyhow::anyhow!("no randomness"))?;
    let app = Arc::new(App {
        secret: hex::encode(b),
        defaults,
        kube,
        demo,
        run: Mutex::new(None),
    });
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let addr = listener.local_addr()?;
    let link = format!("http://{addr}/?t={}", app.secret);
    eprintln!("low-tide on http://{addr}; open this link (it carries this server's key):");
    println!("{link}");
    if open {
        crate::engine::open_browser(&link);
    }

    let api = Router::new()
        .route("/api/config", get(config))
        .route("/api/run", post(start))
        .route("/api/cancel", post(cancel))
        .route("/api/delete", post(delete))
        .route("/api/events", get(events))
        .route(
            "/app.js",
            get(|| async { asset("text/javascript", include_str!("../assets/app.js")) }),
        )
        .route(
            "/app.css",
            get(|| async { asset("text/css", include_str!("../assets/app.css")) }),
        )
        .route_layer(middleware::from_fn_with_state(app.clone(), require_cookie));
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
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
            "open the link low-tide printed at start",
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
        let mut r = Redirect::to("/").into_response();
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            r.headers_mut().insert(header::SET_COOKIE, v);
        }
        return r;
    }
    if !has_cookie(&app, &headers) {
        return (
            StatusCode::FORBIDDEN,
            "open the link low-tide printed at start",
        )
            .into_response();
    }
    asset(
        "text/html; charset=utf-8",
        include_str!("../assets/index.html"),
    )
}

async fn config(State(app): State<Shared>) -> Response {
    let session = mediatore_client::Session::default_path()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let current = lock(&app.run)
        .as_ref()
        .map(|r| json!({"id": r.id, "finished": r.finished()}));
    Json(json!({
        "defaults": app.defaults,
        "sessionPath": session,
        "kubeContext": app.kube.context,
        "kubeconfig": app.kube.kubeconfig,
        "run": current,
        "demo": app.demo,
    }))
    .into_response()
}

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({"error": msg.into()}))).into_response()
}

async fn start(State(app): State<Shared>, Json(s): Json<Settings>) -> Response {
    if let Err(e) = crate::util::split_workload(&s.workload) {
        return err(StatusCode::BAD_REQUEST, e.to_string());
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
    let id = run.id.clone();
    if app.demo {
        tokio::spawn(crate::demo::run(run, s.workload));
    } else {
        tokio::spawn(run.execute(s, app.kube.clone()));
    }
    (StatusCode::ACCEPTED, Json(json!({"id": id}))).into_response()
}

async fn cancel(State(app): State<Shared>) -> StatusCode {
    if let Some(r) = lock(&app.run).as_ref() {
        r.cancel();
    }
    StatusCode::NO_CONTENT
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

#[derive(Deserialize)]
struct EventsQuery {
    run: Option<String>,
    from: Option<usize>,
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
