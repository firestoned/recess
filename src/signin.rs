// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! Sign-in with an OpenID Connect issuer (Dex), for a Recess shared beyond loopback.
//!
//! Each person signs in with the authorization code flow and PKCE. The tokens stay on the
//! server, keyed by a random session cookie; the browser never holds one. The ID token is
//! issued for the Kubernetes API server's audience (`kubernetes` by default), and every
//! Kubernetes call made for that person carries it as the bearer: the API server verifies it
//! and applies that person's RBAC. Recess grants nothing itself, which is why the token's
//! signature is not checked here: it comes straight from the issuer's token endpoint over
//! TLS (OpenID Connect Core 3.1.3.7), and the API server checks it on every call. What is
//! checked here (issuer, audience, authorized party, expiry, nonce) is what keeps a token
//! meant for someone or something else from being taken as a sign-in.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest as _, Sha256};

/// The session cookie: a random id, the key to the server-side session.
pub const SESSION_COOKIE: &str = "recess-sid";
/// Binds a sign-in's `state` to the browser that started it.
pub const LOGIN_COOKIE: &str = "recess-login";
/// The path Dex redirects back to.
pub const CALLBACK: &str = "/auth/callback";

/// How long a started sign-in may take.
const PENDING_TTL: Duration = Duration::from_secs(600);
/// Sign-ins in flight at most; past it the oldest is dropped (an unauthenticated route).
const PENDING_MAX: usize = 1024;
/// A session not used for this long ends.
const IDLE: Duration = Duration::from_hours(12);
/// The token is refreshed this long before it expires.
const REFRESH_AHEAD: i64 = 120;

/// `--oidc-*` and `--public-url`, as given.
#[derive(Clone, Debug, Default)]
pub struct Settings {
    /// The issuer, as in its discovery document (`https://dex.example.com`).
    pub issuer: String,
    /// The client Recess signs in as.
    pub client_id: String,
    /// A file holding the client's secret; empty for a public client.
    pub client_secret_file: String,
    /// The audience the API server accepts; empty is the client ID. When it differs, Dex is
    /// asked for it as a cross-client audience (`audience:server:client_id:<it>`).
    pub audience: String,
    /// CA certificates (PEM) for the issuer; empty is the system's roots.
    pub ca_file: String,
    /// Scopes; empty is `openid profile email groups offline_access`.
    pub scopes: Vec<String>,
    /// Where browsers reach this server (`https://recess.example.com`).
    pub public_url: String,
}

impl Settings {
    /// Sign-in is on when an issuer is given.
    #[must_use]
    pub fn enabled(&self) -> bool {
        !self.issuer.trim().is_empty()
    }

    fn audience(&self) -> &str {
        if self.audience.is_empty() {
            &self.client_id
        } else {
            &self.audience
        }
    }

    fn scopes(&self) -> Vec<String> {
        let mut s = if self.scopes.is_empty() {
            ["openid", "profile", "email", "groups", "offline_access"]
                .map(String::from)
                .to_vec()
        } else {
            self.scopes.clone()
        };
        if !s.iter().any(|x| x == "openid") {
            s.insert(0, "openid".into());
        }
        if self.audience() != self.client_id {
            s.push(format!("audience:server:client_id:{}", self.audience()));
        }
        s
    }
}

/// The public URL, checked: https, or http on this machine only (the session cookie must not
/// cross a network in clear). Returned without a trailing slash.
///
/// # Errors
/// Not a URL, another scheme, plain http to another host, or a path, query or fragment.
pub fn public_url(raw: &str) -> anyhow::Result<String> {
    let u = reqwest::Url::parse(raw.trim())
        .map_err(|e| anyhow::anyhow!("--public-url {raw:?} is not a URL: {e}"))?;
    let host = u.host_str().unwrap_or_default();
    let local = host == "localhost"
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    anyhow::ensure!(
        u.scheme() == "https" || (u.scheme() == "http" && local),
        "--public-url {raw}: https, or http on localhost only (the session cookie must not cross a network in clear)"
    );
    anyhow::ensure!(
        u.path() == "/" && u.query().is_none() && u.fragment().is_none(),
        "--public-url {raw}: the server's root, with no path, query or fragment"
    );
    Ok(u.as_str().trim_end_matches('/').to_owned())
}

/// The `Host` a browser sends for `public` (with its port when it is not the default).
#[must_use]
pub fn public_host(public: &str) -> String {
    reqwest::Url::parse(public)
        .ok()
        .map(|u| match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_owned(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

/// Where to go after signing in: a path on this server, or `/`.
#[must_use]
pub fn safe_next(next: &str) -> String {
    let ok = next.starts_with('/')
        && !next.starts_with("//")
        && !next.contains('\\')
        && next.len() <= 512
        && next.bytes().all(|b| (0x21..0x7f).contains(&b));
    if ok { next.to_owned() } else { "/".to_owned() }
}

fn random(n: usize) -> anyhow::Result<Vec<u8>> {
    let mut b = vec![0u8; n];
    aws_lc_rs::rand::fill(&mut b).map_err(|_| anyhow::anyhow!("no randomness"))?;
    Ok(b)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// PKCE S256: the challenge for a verifier (RFC 7636).
#[must_use]
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Who signed in, from the ID token's claims.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Claims {
    pub subject: String,
    /// `preferred_username`, else `email`, else the subject.
    pub name: String,
    pub email: String,
    pub groups: Vec<String>,
    pub exp: i64,
}

/// The ID token's claims, checked against what this sign-in expects. The signature is not
/// verified (see the module's documentation).
///
/// # Errors
/// Not a JWT, or the issuer, audience, authorized party, expiry or nonce is not the expected one.
pub fn check(
    token: &str,
    issuer: &str,
    audience: &str,
    client_id: &str,
    nonce: Option<&str>,
    at: i64,
) -> anyhow::Result<Claims> {
    let part = token
        .split('.')
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("the ID token is not a JWT"))?;
    let c: serde_json::Map<String, Value> = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(part.trim_end_matches('='))
            .map_err(|e| anyhow::anyhow!("the ID token's payload: {e}"))?,
    )
    .map_err(|e| anyhow::anyhow!("the ID token's payload: {e}"))?;
    let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or_default();
    let list = |k: &str| -> Vec<String> {
        match c.get(k) {
            Some(Value::String(v)) => vec![v.clone()],
            Some(Value::Array(v)) => v
                .iter()
                .filter_map(|x| x.as_str().map(ToOwned::to_owned))
                .collect(),
            _ => vec![],
        }
    };
    anyhow::ensure!(
        s("iss").trim_end_matches('/') == issuer.trim_end_matches('/'),
        "the ID token is from {:?}, not {issuer:?}",
        s("iss")
    );
    let aud = list("aud");
    anyhow::ensure!(
        aud.iter().any(|a| a == audience),
        "the ID token is for {aud:?}, not {audience:?}: the API server would refuse it"
    );
    let azp = s("azp");
    anyhow::ensure!(
        azp.is_empty() || azp == client_id,
        "the ID token was issued to {azp:?}, not to {client_id:?}"
    );
    anyhow::ensure!(
        azp == client_id || aud.len() == 1,
        "the ID token has several audiences and no authorized party"
    );
    let exp = c.get("exp").and_then(Value::as_i64).unwrap_or(0);
    anyhow::ensure!(exp > at, "the ID token has expired");
    if let Some(n) = nonce {
        anyhow::ensure!(
            aws_lc_rs::constant_time::verify_slices_are_equal(s("nonce").as_bytes(), n.as_bytes())
                .is_ok(),
            "the ID token's nonce is not this sign-in's"
        );
    }
    let name = [s("preferred_username"), s("email"), s("sub")]
        .into_iter()
        .find(|x| !x.is_empty())
        .unwrap_or_default()
        .to_owned();
    Ok(Claims {
        subject: s("sub").to_owned(),
        name,
        email: s("email").to_owned(),
        groups: list("groups"),
        exp,
    })
}

/// The issuer's endpoints and Recess's client there.
pub struct Provider {
    settings: Settings,
    secret: Option<String>,
    http: reqwest::Client,
    authorize: String,
    token: String,
    redirect: String,
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    refresh_token: Option<String>,
}

/// What a token endpoint answered: the ID token, checked, and a refresh token if any.
pub struct Tokens {
    pub id_token: String,
    pub refresh_token: Option<String>,
    pub claims: Claims,
}

/// A sign-in in flight: what the callback needs to finish it.
pub struct Pending {
    nonce: String,
    verifier: String,
    next: String,
    at: Instant,
}

impl Provider {
    /// Read the issuer's discovery document and the client secret.
    ///
    /// # Errors
    /// The issuer unreachable or not the one asked for, a public URL that will not do, or an
    /// unreadable secret file.
    pub async fn discover(settings: Settings) -> anyhow::Result<Self> {
        let public = public_url(&settings.public_url)?;
        mediatore_proto::tls::ensure_provider();
        let tls = if settings.ca_file.is_empty() {
            mediatore_proto::tls::https_client_config()
        } else {
            let pem = std::fs::read(&settings.ca_file)
                .map_err(|e| anyhow::anyhow!("--oidc-ca-file {}: {e}", settings.ca_file))?;
            mediatore_proto::tls::https_client_config_with_ca(&pem)?
        };
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let issuer = settings.issuer.trim().trim_end_matches('/');
        anyhow::ensure!(
            issuer.starts_with("https://"),
            "--oidc-issuer {issuer}: https only"
        );
        let url = format!("{issuer}/.well-known/openid-configuration");
        let d: Discovery = http
            .get(&url)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("{url}: {e}"))?
            .error_for_status()?
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("{url}: {e}"))?;
        anyhow::ensure!(
            d.issuer.trim_end_matches('/') == issuer,
            "{url} names the issuer {:?}, not {issuer:?}",
            d.issuer
        );
        let secret = if settings.client_secret_file.is_empty() {
            None
        } else {
            let s = std::fs::read_to_string(&settings.client_secret_file).map_err(|e| {
                anyhow::anyhow!(
                    "--oidc-client-secret-file {}: {e}",
                    settings.client_secret_file
                )
            })?;
            Some(s.trim().to_owned())
        };
        Ok(Self {
            redirect: format!("{public}{CALLBACK}"),
            settings,
            secret,
            http,
            authorize: d.authorization_endpoint,
            token: d.token_endpoint,
        })
    }

    #[must_use]
    pub fn issuer(&self) -> &str {
        &self.settings.issuer
    }

    /// A new sign-in: its `state`, what to keep for the callback, and where to send the browser.
    ///
    /// # Errors
    /// No randomness, or an authorization endpoint that is not a URL.
    pub fn begin(&self, next: &str) -> anyhow::Result<(String, Pending, String)> {
        let state = URL_SAFE_NO_PAD.encode(random(24)?);
        let nonce = URL_SAFE_NO_PAD.encode(random(24)?);
        let verifier = URL_SAFE_NO_PAD.encode(random(32)?);
        let mut u = reqwest::Url::parse(&self.authorize)?;
        u.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.settings.client_id)
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("scope", &self.settings.scopes().join(" "))
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge", &challenge(&verifier))
            .append_pair("code_challenge_method", "S256");
        let pending = Pending {
            nonce,
            verifier,
            next: safe_next(next),
            at: Instant::now(),
        };
        Ok((state, pending, u.into()))
    }

    async fn token_call(&self, form: &[(&str, &str)]) -> anyhow::Result<TokenResponse> {
        let mut form = form.to_vec();
        form.push(("client_id", &self.settings.client_id));
        if let Some(s) = &self.secret {
            form.push(("client_secret", s));
        }
        let resp = self.http.post(&self.token).form(&form).send().await?;
        let status = resp.status();
        if !status.is_success() {
            // The error and its description only: the body is the issuer's, never echoed whole.
            let v: Value = resp.json().await.unwrap_or_default();
            let what = [
                v["error"].as_str().unwrap_or_default(),
                v["error_description"].as_str().unwrap_or_default(),
            ]
            .into_iter()
            .filter(|x| !x.is_empty())
            .collect::<Vec<_>>()
            .join(": ");
            anyhow::bail!("the issuer's token endpoint answered {status} {what}");
        }
        Ok(resp.json().await?)
    }

    /// Trade the callback's code for tokens.
    ///
    /// # Errors
    /// The issuer refused the code, or the ID token is not one for this sign-in.
    pub async fn finish(&self, pending: &Pending, code: &str) -> anyhow::Result<Tokens> {
        let r = self
            .token_call(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", &self.redirect),
                ("code_verifier", &pending.verifier),
            ])
            .await?;
        self.tokens(r, Some(&pending.nonce))
    }

    /// A new ID token from the refresh token.
    ///
    /// # Errors
    /// The issuer refused the refresh, or the ID token is not one for this client.
    pub async fn refresh(&self, refresh_token: &str) -> anyhow::Result<Tokens> {
        let r = self
            .token_call(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ])
            .await?;
        self.tokens(r, None)
    }

    fn tokens(&self, r: TokenResponse, nonce: Option<&str>) -> anyhow::Result<Tokens> {
        let id_token = r.id_token.ok_or_else(|| {
            anyhow::anyhow!("the issuer returned no ID token (is `openid` among the scopes?)")
        })?;
        let claims = check(
            &id_token,
            &self.settings.issuer,
            self.settings.audience(),
            &self.settings.client_id,
            nonce,
            now(),
        )?;
        Ok(Tokens {
            id_token,
            refresh_token: r.refresh_token,
            claims,
        })
    }
}

/// One signed-in person: their token (behind a lock the kube client reads on every call),
/// that client, their Admin view's fleet, and the tasks that serve it.
pub struct User {
    pub claims: Mutex<Claims>,
    /// The name and groups the API server sees (a SelfSubjectReview), once asked.
    pub seen_as: Mutex<Option<(String, Vec<String>)>>,
    token: Arc<RwLock<String>>,
    refresh: Mutex<Option<String>>,
    pub client: kube::Client,
    pub fleet: Arc<crate::admin::Fleet>,
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    seen: Mutex<Instant>,
    ended: AtomicBool,
}

impl User {
    /// Keep `h` running until the session ends.
    pub fn hold(&self, h: impl IntoIterator<Item = tokio::task::AbortHandle>) {
        lock(&self.tasks).extend(h);
    }

    fn end(&self) {
        self.ended.store(true, Ordering::SeqCst);
        for t in lock(&self.tasks).drain(..) {
            t.abort();
        }
    }

    #[must_use]
    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A kube client for `base`'s cluster that authenticates with whatever `token` holds at the
/// time of each call, and with nothing of the process's own.
///
/// # Errors
/// A cluster configuration the client cannot be built from.
pub fn user_client(
    base: &kube::Config,
    token: Arc<RwLock<String>>,
) -> anyhow::Result<kube::Client> {
    let mut cfg = base.clone();
    cfg.auth_info = kube::config::AuthInfo::default();
    let layer = tower::util::MapRequestLayer::new(
        move |mut req: axum::http::Request<kube::client::Body>| {
            let t = token.read().map(|t| t.clone()).unwrap_or_default();
            if let Ok(mut v) = axum::http::HeaderValue::from_str(&format!("Bearer {t}")) {
                v.set_sensitive(true);
                req.headers_mut()
                    .insert(axum::http::header::AUTHORIZATION, v);
            }
            req
        },
    );
    Ok(kube::client::ClientBuilder::try_from(cfg)?
        .with_layer(&layer)
        .build())
}

/// The sign-ins in flight and the sessions, all in memory: a restart signs everyone out.
pub struct Sessions {
    pub provider: Provider,
    base: kube::Config,
    pending: Mutex<HashMap<String, Pending>>,
    users: Mutex<HashMap<String, Arc<User>>>,
}

/// A session id's key in the map: its SHA-256, so a lookup's timing says nothing of the id.
fn key(sid: &str) -> String {
    hex::encode(Sha256::digest(sid.as_bytes()))
}

impl Sessions {
    #[must_use]
    pub fn new(provider: Provider, base: kube::Config) -> Arc<Self> {
        Arc::new(Self {
            provider,
            base,
            pending: Mutex::new(HashMap::new()),
            users: Mutex::new(HashMap::new()),
        })
    }

    /// Keep a started sign-in, dropping expired ones and, past the cap, the oldest.
    pub fn stash(&self, state: String, p: Pending) {
        let mut g = lock(&self.pending);
        g.retain(|_, v| v.at.elapsed() < PENDING_TTL);
        while g.len() >= PENDING_MAX {
            let Some(oldest) = g.iter().min_by_key(|(_, v)| v.at).map(|(k, _)| k.clone()) else {
                break;
            };
            g.remove(&oldest);
        }
        g.insert(state, p);
    }

    /// The sign-in for `state`, once.
    pub fn take(&self, state: &str) -> Option<Pending> {
        lock(&self.pending)
            .remove(state)
            .filter(|p| p.at.elapsed() < PENDING_TTL)
    }

    /// Where the sign-in for this pending was going.
    #[must_use]
    pub fn next_of(p: &Pending) -> &str {
        &p.next
    }

    /// A new session for `tokens`: its id (the cookie's value) and the user.
    ///
    /// # Errors
    /// No randomness, or a kube client that cannot be built.
    pub fn open(self: &Arc<Self>, tokens: Tokens) -> anyhow::Result<(String, Arc<User>)> {
        let sid = hex::encode(random(32)?);
        let token = Arc::new(RwLock::new(tokens.id_token));
        let user = Arc::new(User {
            claims: Mutex::new(tokens.claims),
            seen_as: Mutex::new(None),
            client: user_client(&self.base, token.clone())?,
            token,
            refresh: Mutex::new(tokens.refresh_token),
            fleet: crate::admin::Fleet::new(),
            tasks: Mutex::new(Vec::new()),
            seen: Mutex::new(Instant::now()),
            ended: AtomicBool::new(false),
        });
        lock(&self.users).insert(key(&sid), user.clone());
        let refresher = tokio::spawn(refresh_loop(self.clone(), sid.clone(), user.clone()));
        user.hold([refresher.abort_handle()]);
        Ok((sid, user))
    }

    /// The live session for a cookie's id, marked as used.
    #[must_use]
    pub fn get(&self, sid: &str) -> Option<Arc<User>> {
        let u = lock(&self.users).get(&key(sid)).cloned()?;
        if u.ended() || lock(&u.seen).elapsed() > IDLE || lock(&u.claims).exp <= now() {
            self.close(sid);
            return None;
        }
        *lock(&u.seen) = Instant::now();
        Some(u)
    }

    /// End a session: its watches stop and its tokens are dropped.
    pub fn close(&self, sid: &str) {
        if let Some(u) = lock(&self.users).remove(&key(sid)) {
            u.end();
        }
    }

    /// End idle sessions and drop stale sign-ins; run every minute.
    pub fn sweep(&self) {
        lock(&self.pending).retain(|_, v| v.at.elapsed() < PENDING_TTL);
        lock(&self.users).retain(|_, u| {
            let keep = !u.ended() && lock(&u.seen).elapsed() <= IDLE;
            if !keep {
                u.end();
            }
            keep
        });
    }
}

/// Refresh the ID token ahead of its expiry, for as long as the session lives; a refused
/// refresh (or none to make) ends the session at the token's expiry.
async fn refresh_loop(sessions: Arc<Sessions>, sid: String, user: Arc<User>) {
    loop {
        let exp = lock(&user.claims).exp;
        let wait = (exp - now() - REFRESH_AHEAD).max(10);
        tokio::time::sleep(Duration::from_secs(u64::try_from(wait).unwrap_or(10))).await;
        let Some(rt) = lock(&user.refresh).clone() else {
            tokio::time::sleep(Duration::from_secs(
                u64::try_from((exp - now()).max(0)).unwrap_or(0),
            ))
            .await;
            break;
        };
        match sessions.provider.refresh(&rt).await {
            Ok(t) => {
                if let Ok(mut g) = user.token.write() {
                    *g = t.id_token;
                }
                *lock(&user.claims) = t.claims;
                if t.refresh_token.is_some() {
                    *lock(&user.refresh) = t.refresh_token;
                }
            }
            Err(e) => {
                eprintln!(
                    "recess: {}'s session not refreshed, it ends: {e:#}",
                    lock(&user.claims).name
                );
                break;
            }
        }
    }
    sessions.close(&sid);
}

/// Ask the API server who this client is: the name and groups RBAC applies to. A refusal
/// here (401) means the API server does not accept the issuer's token for this audience.
///
/// # Errors
/// The review refused or failed.
pub async fn whoami(client: &kube::Client) -> anyhow::Result<(String, Vec<String>)> {
    use k8s_openapi::api::authentication::v1::SelfSubjectReview;
    let api: kube::Api<SelfSubjectReview> = kube::Api::all(client.clone());
    let r = api
        .create(
            &kube::api::PostParams::default(),
            &SelfSubjectReview::default(),
        )
        .await?;
    let info = r.status.and_then(|s| s.user_info).unwrap_or_default();
    Ok((
        info.username.unwrap_or_default(),
        info.groups.unwrap_or_default(),
    ))
}

/// A cookie for this server: HttpOnly, Lax (the callback is a navigation from the issuer's
/// site, which a Strict cookie would not survive), Secure when served over https.
#[must_use]
pub fn cookie(name: &str, value: &str, secure: bool, max_age: Option<u64>) -> String {
    let mut c = format!("{name}={value}; Path=/; HttpOnly; SameSite=Lax");
    if secure {
        c.push_str("; Secure");
    }
    if let Some(a) = max_age {
        use std::fmt::Write as _;
        let _ = write!(c, "; Max-Age={a}");
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: &Value) -> String {
        format!(
            "e30.{}.sig",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap())
        )
    }

    const ISS: &str = "https://dex.example.com";

    fn base() -> Value {
        serde_json::json!({"iss": ISS, "aud": "kubernetes", "sub": "Cg1", "exp": 2000,
            "nonce": "n1", "preferred_username": "octocat", "groups": ["team-a"]})
    }

    #[test]
    fn pkce_matches_rfc_7636() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_token_for_this_sign_in_is_taken() {
        let c = check(
            &jwt(&base()),
            ISS,
            "kubernetes",
            "kubernetes",
            Some("n1"),
            1000,
        )
        .unwrap();
        assert_eq!(c.name, "octocat");
        assert_eq!(c.groups, ["team-a"]);
        let mut cross = base();
        cross["aud"] = serde_json::json!(["kubernetes"]);
        cross["azp"] = "recess".into();
        assert!(check(&jwt(&cross), ISS, "kubernetes", "recess", None, 1000).is_ok());
    }

    #[test]
    fn a_token_meant_for_something_else_is_refused() {
        let refused = |v: Value, nonce: Option<&str>, at: i64| {
            check(&jwt(&v), ISS, "kubernetes", "kubernetes", nonce, at).is_err()
        };
        let with = |k: &str, x: Value| {
            let mut v = base();
            v[k] = x;
            v
        };
        assert!(refused(
            with("iss", "https://evil.example.com".into()),
            None,
            1000
        ));
        assert!(
            refused(with("aud", "mediatore".into()), None, 1000),
            "another audience"
        );
        assert!(
            refused(with("azp", "mediatore".into()), None, 1000),
            "another client"
        );
        assert!(
            refused(
                with("aud", serde_json::json!(["kubernetes", "x"])),
                None,
                1000
            ),
            "several audiences, no authorized party"
        );
        assert!(refused(base(), None, 2000), "expired");
        assert!(refused(base(), Some("n2"), 1000), "another sign-in's nonce");
        assert!(check("not-a-jwt", ISS, "kubernetes", "kubernetes", None, 1000).is_err());
    }

    #[test]
    fn after_sign_in_only_a_path_on_this_server() {
        assert_eq!(safe_next("/admin"), "/admin");
        assert_eq!(safe_next("/?view=admin"), "/?view=admin");
        for bad in [
            "https://evil.example.com",
            "//evil.example.com",
            "/\\evil",
            "",
            "/a b",
        ] {
            assert_eq!(safe_next(bad), "/", "{bad:?}");
        }
    }

    #[test]
    fn the_public_url_keeps_the_cookie_off_clear_networks() {
        assert_eq!(
            public_url("https://recess.example.com/").unwrap(),
            "https://recess.example.com"
        );
        assert!(public_url("http://localhost:7480").is_ok());
        assert!(public_url("http://recess.example.com").is_err());
        assert!(public_url("https://recess.example.com/sub").is_err());
        assert_eq!(
            public_host("https://recess.example.com"),
            "recess.example.com"
        );
        assert_eq!(public_host("http://localhost:7480"), "localhost:7480");
    }

    #[test]
    fn scopes_ask_for_the_api_servers_audience_when_it_is_not_the_client() {
        let s = Settings {
            client_id: "recess".into(),
            audience: "kubernetes".into(),
            ..Settings::default()
        };
        assert!(
            s.scopes()
                .contains(&"audience:server:client_id:kubernetes".to_owned())
        );
        let plain = Settings {
            client_id: "kubernetes".into(),
            scopes: vec!["groups".into()],
            ..Settings::default()
        };
        assert_eq!(plain.scopes(), ["openid", "groups"]);
    }

    #[test]
    fn cookies_are_http_only_lax_and_secure_over_https() {
        assert_eq!(
            cookie("recess-sid", "x", true, None),
            "recess-sid=x; Path=/; HttpOnly; SameSite=Lax; Secure"
        );
        assert!(!cookie("recess-sid", "", false, Some(0)).contains("Secure"));
    }
}
