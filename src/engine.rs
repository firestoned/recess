// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! One run of the pipeline: the workload, the login, the session it leaves, the identity in
//! the ID token, the claim, the `AgentSandbox` as the Kubernetes API shows it, the workload's
//! output and its exit. Both front ends read the same ordered list of events.
//!
//! No event ever carries a token or refresh material: the session step reports the file's
//! path, mode and expiry, the identity step the decoded claims and a fingerprint.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{StreamExt as _, TryStreamExt as _};
use k8s_openapi::api::core::v1::Event as KubeEvent;
use kube::api::{ApiResource, DynamicObject, GroupVersionKind};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::runtime::{WatchStreamExt as _, watcher};
use mediatore_client::delegate::{self, Source};
use mediatore_client::logs::{LogsQuery, escape_controls};
use mediatore_client::{Api, Session};
use mediatore_proto::{
    ClaimRequest, LogLine, LogStream, RestartPolicy, Selection, SelectionStrategy, Workload,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::settings::{ClaimSettings, LoginSettings};
use crate::util::{self, str_at};

/// The stages, top to bottom.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    Mint,
    Create,
    Seal,
    Run,
    Logs,
    Exit,
}

impl Step {
    pub const ALL: [Step; 6] = [
        Step::Mint,
        Step::Create,
        Step::Seal,
        Step::Run,
        Step::Logs,
        Step::Exit,
    ];

    #[must_use]
    pub fn title(self) -> &'static str {
        match self {
            Step::Mint => "mediatore login",
            Step::Create => "mediatore sandbox create",
            Step::Seal => "Seal credentials",
            Step::Run => "Run in the sandbox",
            Step::Logs => "Output",
            Step::Exit => "Exit code",
        }
    }

    #[must_use]
    pub fn index(self) -> usize {
        Step::ALL.iter().position(|s| *s == self).unwrap_or(0)
    }
}

/// Where a stage is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Pending,
    Active,
    Done,
    Skipped,
    Failed,
}

/// What happened.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Body {
    /// The stage moved.
    State {
        state: State,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// A line of text: the workload's output, or a note.
    Line {
        stream: &'static str,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    /// Structured facts for the stage's box.
    Data { data: Value },
    /// The run is over.
    Finished { ok: bool, note: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub seq: u64,
    pub at: String,
    pub step: Step,
    #[serde(flatten)]
    pub body: Body,
}

/// The cluster the `AgentSandbox` is watched in.
#[derive(Debug, Clone, Default)]
pub struct KubeTarget {
    pub kubeconfig: Option<PathBuf>,
    pub context: Option<String>,
    pub gateways: Option<crate::kubeinfo::GatewayQuery>,
    /// Where the broker writes its Secrets (`banlieue-system` in the base deploy).
    pub broker_namespace: String,
}

/// The run's sub-steps' inputs.
#[derive(Default)]
struct Tracker {
    /// When the run stage started: the first sub-step's clock.
    started: String,
    /// The last stall sent, as (step, 15 s bucket), so a stall is re-sent only as it grows.
    stall_sent: Option<(&'static str, i64)>,
    seen: crate::phases::Seen,
    first_output: Option<String>,
    latest: Option<Value>,
    logs_on: bool,
    last: Value,
}

/// What the custody loop reads.
struct Custody {
    client: kube::Client,
    kube: KubeTarget,
    session_path: PathBuf,
    sandbox_uid: String,
    claim_uid: String,
    sandbox_ns: String,
    audiences: Vec<String>,
    delegations: usize,
    /// The pool named in the claim, until the sandbox says which one bound it.
    pool: String,
    latest: Arc<Mutex<Option<Value>>>,
    ended: Arc<AtomicBool>,
}

/// What `delete` needs once the claim exists.
struct Claimed {
    api: Arc<Api>,
    session: Session,
    name: String,
    namespace: String,
}

pub struct Run {
    pub id: String,
    events: Mutex<Vec<Event>>,
    tick: watch::Sender<u64>,
    cancel: CancellationToken,
    finished: AtomicBool,
    current: Mutex<Option<Step>>,
    states: Mutex<std::collections::HashMap<Step, State>>,
    tracker: Mutex<Tracker>,
    claimed: Mutex<Option<Claimed>>,
    /// The workload, handed over once the token is minted (`submit`).
    claim_tx: Mutex<Option<tokio::sync::oneshot::Sender<ClaimSettings>>>,
    claim_rx: Mutex<Option<tokio::sync::oneshot::Receiver<ClaimSettings>>>,
}

fn now() -> String {
    jiff::Timestamp::now().to_string()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Run {
    #[must_use]
    pub fn new() -> Arc<Self> {
        let mut b = [0u8; 6];
        let _ = aws_lc_rs::rand::fill(&mut b);
        let (tx, rx) = tokio::sync::oneshot::channel();
        Arc::new(Self {
            id: hex::encode(b),
            events: Mutex::new(Vec::new()),
            tick: watch::channel(0).0,
            cancel: CancellationToken::new(),
            finished: AtomicBool::new(false),
            current: Mutex::new(None),
            states: Mutex::new(std::collections::HashMap::new()),
            tracker: Mutex::new(Tracker::default()),
            claimed: Mutex::new(None),
            claim_tx: Mutex::new(Some(tx)),
            claim_rx: Mutex::new(Some(rx)),
        })
    }

    pub fn finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    /// Whether the token is minted and the run waits for the workload.
    pub fn waiting(&self) -> bool {
        !self.finished()
            && lock(&self.claim_tx).is_some()
            && lock(&self.states)
                .get(&Step::Mint)
                .is_some_and(|s| matches!(s, State::Done | State::Skipped))
    }

    /// Hand the workload to a run that waits for it (`mediatore sandbox create`'s options).
    ///
    /// # Errors
    /// The run is not waiting (not logged in yet, or already claimed), or the workload or the
    /// user API URL is missing or malformed: refused here, so a typo does not end the run.
    pub fn submit(&self, c: ClaimSettings, need_url: bool) -> anyhow::Result<()> {
        util::split_workload(&c.workload)?;
        restart_of(&c.restart)?;
        anyhow::ensure!(
            !need_url || !c.url.trim().is_empty(),
            "mediatore's URL is required (--mediatore, MEDIATORE_URL)"
        );
        anyhow::ensure!(self.waiting(), "not waiting for a workload: log in first");
        let tx = lock(&self.claim_tx)
            .take()
            .ok_or_else(|| anyhow::anyhow!("this run already has its workload"))?;
        tx.send(c).map_err(|_| anyhow::anyhow!("the run ended"))
    }

    /// Wait for `submit`, with the Create stage showing that it waits.
    pub(crate) async fn await_claim(&self) -> anyhow::Result<ClaimSettings> {
        let rx = lock(&self.claim_rx)
            .take()
            .ok_or_else(|| anyhow::anyhow!("the workload was already taken"))?;
        self.state(
            Step::Create,
            State::Active,
            Some("waiting for the workload: fill in the form and press Run".into()),
        );
        self.data(Step::Create, json!({"waiting": true}));
        let c = rx
            .await
            .map_err(|_| anyhow::anyhow!("no workload was given"))?;
        self.data(
            Step::Create,
            json!({"waiting": false, "command": c.command()}),
        );
        Ok(c)
    }

    /// Events from `from` on, whether the run is over, and a receiver that wakes on the next.
    pub fn since(&self, from: usize) -> (Vec<Event>, bool, watch::Receiver<u64>) {
        let rx = self.tick.subscribe();
        let evs = lock(&self.events);
        (
            evs.get(from..).map(<[Event]>::to_vec).unwrap_or_default(),
            self.finished(),
            rx,
        )
    }

    pub(crate) fn emit(&self, step: Step, body: Body) {
        let mut evs = lock(&self.events);
        let seq = evs.len() as u64;
        evs.push(Event {
            seq,
            at: now(),
            step,
            body,
        });
        drop(evs);
        self.tick.send_replace(seq + 1);
    }

    pub(crate) fn state(&self, step: Step, state: State, note: Option<String>) {
        if state == State::Active {
            *lock(&self.current) = Some(step);
        }
        lock(&self.states).insert(step, state);
        self.emit(step, Body::State { state, note });
    }

    pub(crate) fn active(&self, step: Step) {
        self.state(step, State::Active, None);
    }

    pub(crate) fn done(&self, step: Step, note: impl Into<String>) {
        self.state(step, State::Done, Some(note.into()));
    }

    pub(crate) fn data(&self, step: Step, data: Value) {
        self.emit(step, Body::Data { data });
    }

    pub(crate) fn line(&self, step: Step, stream: &'static str, text: String, ts: Option<String>) {
        self.emit(step, Body::Line { stream, text, ts });
    }

    pub(crate) fn note(&self, step: Step, text: impl Into<String>) {
        self.line(step, "note", text.into(), None);
    }

    /// Run the pipeline to its end, then mark the run finished.
    pub async fn execute(self: Arc<Self>, login: LoginSettings, kube: KubeTarget) {
        let result = tokio::select! {
            r = self.clone().pipeline(&login, &kube) => r,
            () = self.cancel.cancelled() => Err(anyhow::anyhow!("cancelled")),
        };
        let (ok, note) = match result {
            Ok(note) => (true, note),
            Err(e) => {
                let step = lock(&self.current).unwrap_or(Step::Mint);
                let msg = format!("{e:#}");
                // The stage that failed says why; any other still running just stops.
                let culprit = if lock(&self.states).get(&Step::Run) == Some(&State::Active)
                    && matches!(step, Step::Logs | Step::Seal | Step::Exit)
                {
                    Step::Run
                } else {
                    step
                };
                self.state(culprit, State::Failed, Some(msg.clone()));
                let running: Vec<Step> = lock(&self.states)
                    .iter()
                    .filter(|(_, st)| **st == State::Active)
                    .map(|(s, _)| *s)
                    .collect();
                for s in running {
                    self.state(s, State::Failed, Some("stopped".into()));
                }
                (false, msg)
            }
        };
        self.finish(ok, note);
    }

    /// Mark the run over.
    pub(crate) fn finish(&self, ok: bool, note: String) {
        self.finished.store(true, Ordering::SeqCst);
        self.emit(Step::Exit, Body::Finished { ok, note });
        self.cancel.cancel();
    }

    /// Whether `cancel` was called (or the run ended).
    pub(crate) fn cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Stop the run and give its claim back: stop watching first, then
    /// `DELETE /v1/claims/{name}` (as `mediatore sandbox delete`), so a cancelled run does not
    /// stay queued for the pool's next VM ahead of the next run. Without a claim yet, only stops.
    ///
    /// # Errors
    /// The broker refusing the delete.
    pub async fn cancel_and_release(&self) -> anyhow::Result<bool> {
        let claimed = lock(&self.claimed).is_some();
        self.cancel();
        if !claimed {
            return Ok(false);
        }
        self.delete_sandbox().await?;
        Ok(true)
    }

    /// `DELETE /v1/claims/{name}` for this run's sandbox.
    ///
    /// # Errors
    /// No claim yet, or the broker refusing.
    pub async fn delete_sandbox(&self) -> anyhow::Result<()> {
        let (api, session, name, ns) = {
            let c = lock(&self.claimed);
            let c = c
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("no sandbox was claimed in this run"))?;
            (
                c.api.clone(),
                c.session.clone(),
                c.name.clone(),
                c.namespace.clone(),
            )
        };
        api.delete(&session, &name, Some(&ns)).await?;
        self.note(Step::Run, format!("deleted {ns}/{name} at your request"));
        Ok(())
    }

    async fn pipeline(
        self: Arc<Self>,
        login: &LoginSettings,
        kube: &KubeTarget,
    ) -> anyhow::Result<String> {
        // 1. `mediatore login`: the token minted, the session it leaves, who the ID token says
        // you are.
        self.active(Step::Mint);
        self.data(Step::Mint, json!({"command": login.command()}));
        let path = session_path()?;
        let reusable = Session::load(&path).ok().filter(|x| {
            x.is_fresh(120) && x.refresh_token.is_some() && x.issuer == login.issuer.trim()
        });
        if login.reuse_session && reusable.is_some() {
            self.data(
                Step::Mint,
                json!({"login": {"reused": true, "issuer": login.issuer}}),
            );
            self.note(
                Step::Mint,
                "a fresh session with its delegation unspent was reused; no login",
            );
        } else {
            let opts = login.to_options()?;
            self.data(
                Step::Mint,
                json!({"login": {
                    "issuer": opts.issuer, "clientId": opts.client_id, "scopes": opts.scopes,
                    "authParams": opts.extra_params.iter().map(|(k, _)| k).collect::<Vec<_>>(),
                    "loginHint": opts.login_hint,
                    "redirect": format!("http://{}:{}{}", opts.redirect.host,
                        if opts.redirect.ports.is_empty() { "<any>".to_owned() }
                        else { opts.redirect.ports.iter().map(ToString::to_string).collect::<Vec<_>>().join("|") },
                        opts.redirect.path),
                    "privateCa": opts.ca_pem.is_some(),
                    "clientSecret": opts.client_secret.is_some(),
                }}),
            );
            let me = self.clone();
            let no_browser = login.no_browser;
            let session = mediatore_client::login(&opts, move |url| {
                me.data(Step::Mint, json!({"authorizeUrl": url}));
                if !no_browser {
                    open_browser(url);
                }
            })
            .await?;
            session.save(&path)?;
            self.data(Step::Mint, json!({"authorizeUrl": null}));
        }
        let session = Session::load(&path)?;
        let expires = jiff::Timestamp::from_second(session.expires_at)
            .map(|t| t.to_string())
            .unwrap_or_default();
        self.data(
            Step::Mint,
            json!({"session": {
                "path": path.display().to_string(),
                "mode": file_mode(&path),
                "login": session.login,
                "issuer": session.issuer,
                "clientId": session.client_id,
                "idTokenExpiresAt": expires,
                "idTokenFresh": session.is_fresh(0),
                "idTokenFingerprint": util::fingerprint(&session.id_token),
                "refreshToken": if session.refresh_token.is_some() { "held, to be delegated with the claim" } else { "spent" },
            }}),
        );
        anyhow::ensure!(
            session.refresh_token.is_some(),
            "the session's delegation is spent (one login per claim): log in again"
        );
        let id = util::identity_of(&session.id_token)?;
        let groups = id.groups.len();
        self.data(Step::Mint, json!({"identity": id}));
        self.done(
            Step::Mint,
            format!(
                "{} · {groups} group{} · token in {} (0{})",
                if id.username.is_empty() {
                    &id.subject
                } else {
                    &id.username
                },
                if groups == 1 { "" } else { "s" },
                path.display(),
                file_mode(&path)
            ),
        );

        // The workload, once you give it (`mediatore sandbox create`).
        let c = self.await_claim().await?;
        let s = &c;
        let (image, args) = util::split_workload(&s.workload)?;
        let restart = restart_of(&s.restart)?;

        // 2. Create the workload: the broker creates the AgentSandbox, the subject pinned to us.
        self.data(
            Step::Create,
            json!({"workload": {
                "image": image, "args": args, "restart": s.restart, "logs": s.logs,
                "ttl": s.ttl, "namespace": s.namespace, "pool": s.pool,
                "poolSelector": s.pool_selector, "strategy": s.strategy,
                "audiences": s.audiences, "policy": s.policy, "delegate": s.delegate.iter()
                    .map(|d| d.split_once('=').map_or(d.as_str(), |(a, _)| a)).collect::<Vec<_>>(),
            }}),
        );
        let api = Arc::new(user_api(s)?);
        let pool = (!s.pool.is_empty()).then(|| s.pool.clone());
        let (pool_ref, pool_selector) = mediatore_client::cli::pool_choice(pool, &s.pool_selector)?;
        let selection = match s.strategy.as_str() {
            "" => None,
            "longest-ready" => Some(SelectionStrategy::LongestReady),
            "most-available" => Some(SelectionStrategy::MostAvailable),
            "spread" => Some(SelectionStrategy::Spread),
            other => anyhow::bail!("strategy {other:?}: longest-ready, most-available or spread"),
        }
        .map(|strategy| Selection { strategy });
        let mut delegations = Vec::new();
        for d in &s.delegate {
            let (audience, source) = delegate::parse_delegate(d)?;
            anyhow::ensure!(
                source != Source::Prompt,
                "--delegate {audience}=prompt asks at a terminal; save it first with the CLI"
            );
            let cred = delegate::read(&audience, &source, s.ttl)?;
            self.note(
                Step::Create,
                format!("your {audience} credential goes with the claim, once"),
            );
            delegations.push(cred.delegation(&audience));
        }
        let namespace = (!s.namespace.is_empty()).then(|| s.namespace.clone());
        let request = ClaimRequest {
            namespace: namespace.clone(),
            pool_ref,
            pool_selector,
            selection,
            ttl_seconds: if s.ttl == 0 { 3600 } else { s.ttl },
            audiences: s.audiences.clone(),
            workload: Workload {
                image,
                args,
                restart,
                logs: s.logs,
            },
            refresh_token: None,
            policy_ref: (!s.policy.is_empty()).then(|| s.policy.clone()),
            delegations,
        };
        let (claim, spent) = api.claim(&session, &request).await?;
        // The refresh token is spent at the broker whatever follows.
        spent.save(&path)?;
        mediatore_client::cli::check_namespace(namespace.as_deref(), claim.namespace.as_deref())?;
        let name = claim.name.clone();
        let ns = claim
            .namespace
            .clone()
            .or(namespace)
            .ok_or_else(|| anyhow::anyhow!("the broker reported no namespace; pass one"))?;
        self.data(Step::Create, json!({"claim": claim}));
        *lock(&self.claimed) = Some(Claimed {
            api: api.clone(),
            session: spent.clone(),
            name: name.clone(),
            namespace: ns.clone(),
        });
        self.done(Step::Create, format!("AgentSandbox {ns}/{name}"));

        // 3. Seal: the refresh token and the delegated credentials into the broker's Secrets.
        // 4. Run: the AgentSandbox from the Kubernetes API. 5. The output, from the broker.
        let client = kube_client(kube).await?;
        let names = Arc::new(Mutex::new(BTreeSet::from([name.clone()])));
        let latest: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let ended = Arc::new(AtomicBool::new(false));
        let (bound_tx, bound_rx) = watch::channel(false);
        let tasks = self.cancel.child_token();
        self.set_logs_on(s.logs);
        lock(&self.tracker).started = jiff::Timestamp::now().to_string();
        self.active(Step::Seal);
        self.active(Step::Run);
        self.track(None, None);
        tokio::spawn({
            let (me, client, ns, names, tasks) = (
                self.clone(),
                client.clone(),
                ns.clone(),
                names.clone(),
                tasks.clone(),
            );
            async move {
                tokio::select! {
                    () = me.watch_events(client, &ns, names) => {},
                    () = tasks.cancelled() => {},
                }
            }
        });
        tokio::spawn({
            let me = self.clone();
            let ctx = Custody {
                client: client.clone(),
                kube: kube.clone(),
                session_path: path.clone(),
                sandbox_uid: claim
                    .sandbox_uid
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
                claim_uid: claim
                    .uid
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
                sandbox_ns: ns.clone(),
                audiences: s.audiences.clone(),
                delegations: s.delegate.len(),
                pool: s.pool.clone(),
                latest: latest.clone(),
                ended: ended.clone(),
            };
            let tasks = tasks.clone();
            async move {
                tokio::select! {
                    () = me.watch_custody(ctx) => {},
                    () = tasks.cancelled() => {},
                }
            }
        });
        // The claim's egress from the broker's own log: each gateway check of it.
        tokio::spawn({
            let me = self.clone();
            let (client, broker_ns, tasks, latest) = (
                client.clone(),
                kube.broker_namespace.clone(),
                tasks.clone(),
                latest.clone(),
            );
            let claim_uid = claim
                .uid
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_default();
            async move {
                tokio::select! {
                    () = me.watch_egress(client, broker_ns, claim_uid, latest) => {},
                    () = tasks.cancelled() => {},
                }
            }
        });
        tokio::spawn({
            let (me, tasks) = (self.clone(), tasks.clone());
            async move {
                let tick = async {
                    loop {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        me.check_stall();
                    }
                };
                tokio::select! {
                    () = tick => {},
                    () = tasks.cancelled() => {},
                }
            }
        });
        let logs_task = tokio::spawn({
            let (me, api, session, name, ns, tasks) = (
                self.clone(),
                api.clone(),
                spent.clone(),
                name.clone(),
                ns.clone(),
                tasks.clone(),
            );
            let wanted = s.logs;
            async move {
                tokio::select! {
                    () = me.follow_logs(&api, &session, &name, &ns, bound_rx, wanted) => {},
                    () = tasks.cancelled() => {},
                }
            }
        });

        let exit = match self
            .watch_sandbox(client, &ns, &name, &names, &bound_tx, &latest)
            .await
        {
            Ok(x) => x,
            Err(e) => {
                tasks.cancel();
                return Err(e);
            }
        };

        // 6. The exit. The output stream ends when the claim does; give it time to drain, and
        // keep watching so the release shows.
        ended.store(true, Ordering::SeqCst);
        self.active(Step::Exit);
        self.data(Step::Exit, serde_json::to_value(&exit)?);
        let summary = match (exit.code, exit.signal) {
            (Some(c), _) => format!("exit code {c}"),
            (None, Some(sig)) => format!("killed by signal {sig}"),
            _ => "exited".into(),
        };
        if tokio::time::timeout(Duration::from_secs(45), logs_task)
            .await
            .is_err()
        {
            self.note(
                Step::Logs,
                "the output stream had not ended 45 s after the exit; stopped reading",
            );
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        tasks.cancel();
        if lock(&self.states).get(&Step::Seal) == Some(&State::Active) {
            self.done(
                Step::Seal,
                "as of the exit; the envelopes are deleted at release",
            );
        }
        self.done(Step::Run, format!("workload {summary}"));
        let state = if exit.code == Some(0) {
            State::Done
        } else {
            State::Failed
        };
        self.state(Step::Exit, state, Some(summary.clone()));
        Ok(summary)
    }

    /// Check the step under way against its limit; send the stall when it starts, every 15 s
    /// while it lasts, and its end.
    pub(crate) fn check_stall(&self) {
        let now = jiff::Timestamp::now();
        let (stall, changed) = {
            let mut t = lock(&self.tracker);
            let ps = crate::phases::phases(
                t.latest.as_ref(),
                &t.seen,
                t.first_output.as_deref(),
                t.logs_on,
            );
            let st = crate::phases::stall(&ps, &t.started, now);
            let key = st.as_ref().map(|x| (x.key, x.secs / 15));
            let changed = key != t.stall_sent;
            t.stall_sent = key;
            (st, changed)
        };
        if changed {
            if let Some(st) = &stall
                && st.secs / 15 == crate::phases::stall_first_bucket(st.key)
            {
                self.note(
                    Step::Run,
                    format!(
                        "no progress for {} s at \"{}\": {}",
                        st.secs, st.title, st.hint
                    ),
                );
            }
            self.data(Step::Run, json!({"stall": stall}));
        }
    }

    /// Whether output is captured, for the run's sub-steps.
    pub(crate) fn set_logs_on(&self, on: bool) {
        lock(&self.tracker).logs_on = on;
    }

    /// Recompute the run's sub-steps from the latest object and the first output, and send
    /// them when they changed.
    pub(crate) fn track(&self, obj: Option<&Value>, first_output: Option<String>) {
        let now = jiff::Timestamp::now().to_string();
        let phases = {
            let mut t = lock(&self.tracker);
            if let Some(o) = obj {
                for k in crate::phases::evidence(o) {
                    t.seen.entry(k).or_insert_with(|| now.clone());
                }
                t.latest = Some(o.clone());
            }
            if first_output.is_some() && t.first_output.is_none() {
                t.first_output = first_output;
            }
            let ps = crate::phases::phases(
                t.latest.as_ref(),
                &t.seen,
                t.first_output.as_deref(),
                t.logs_on,
            );
            let v = serde_json::to_value(&ps).unwrap_or_default();
            if v == t.last {
                return;
            }
            t.last = v.clone();
            v
        };
        self.data(Step::Run, json!({"phases": phases}));
    }

    /// Where the secrets are and which VMs hold them, polled while the claim runs: the
    /// session file's shape, the Secrets' metadata in the broker's namespace, the member VM
    /// and the egress gateways. Sent only when something changed. A list this kubeconfig may
    /// not make is reported once and then shown as unknown.
    async fn watch_custody(&self, c: Custody) {
        let mut last = Value::Null;
        let mut warned = BTreeSet::new();
        let mut gateways: Vec<Value> = Vec::new();
        let mut round = 0u32;
        let mut sealed = false;
        let mut last_pool = Value::Null;
        loop {
            let obj = lock(&c.latest).clone();
            let vm_name = obj
                .as_ref()
                .map(|o| str_at(o, "/status/virtualMachineRef/name").to_owned())
                .unwrap_or_default();
            let session = Session::load(&c.session_path).ok();
            let secrets = match crate::kubeinfo::claim_secrets(
                c.client.clone(),
                &c.kube.broker_namespace,
                &c.sandbox_uid,
                &c.claim_uid,
            )
            .await
            {
                Ok(v) => v,
                Err(e) => {
                    if warned.insert("secrets") {
                        self.note(
                            Step::Seal,
                            format!("Secrets in {} not listed: {e}", c.kube.broker_namespace),
                        );
                    }
                    vec![]
                }
            };
            // The gateways change slowly: every fifth round.
            if round.is_multiple_of(5)
                && let Some(q) = &c.kube.gateways
            {
                match crate::kubeinfo::gateways(c.client.clone(), q).await {
                    Ok(v) => gateways = v,
                    Err(e) => {
                        if warned.insert("gateways") {
                            self.note(Step::Seal, format!("gateway VMs not listed: {e}"));
                        }
                    }
                }
            }
            round += 1;
            let member = if vm_name.is_empty() {
                Value::Null
            } else {
                crate::kubeinfo::vm(c.client.clone(), &c.sandbox_ns, &vm_name)
                    .await
                    .unwrap_or(Value::Null)
            };
            let map = crate::secrets::map(&crate::secrets::Facts {
                session_path: c.session_path.display().to_string(),
                session_mode: file_mode(&c.session_path),
                session_exists: session.is_some(),
                refresh_on_disk: session.as_ref().is_some_and(|s| s.refresh_token.is_some()),
                submitted: true,
                broker_namespace: c.kube.broker_namespace.clone(),
                sandbox: obj.as_ref(),
                ended: c.ended.load(Ordering::SeqCst),
                kube_secrets: &secrets,
                audiences: &c.audiences,
                vm_name: vm_name.clone(),
                gateway_ips: gateway_ips(&gateways),
            });
            // Sealed once the issuer session and every delegated credential are envelopes.
            if !sealed {
                use crate::secrets::Presence;
                let held = |prefix: &str| {
                    map.iter()
                        .filter(|i| i.name.starts_with(prefix) && i.presence == Presence::Held)
                        .count()
                };
                let (session, delegated) = (
                    held("Refresh token (issuer session)"),
                    held("Delegated credential"),
                );
                if session > 0 && delegated >= c.delegations {
                    sealed = true;
                    self.done(
                        Step::Seal,
                        format!(
                            "refresh token{} sealed in {}",
                            match delegated {
                                0 => String::new(),
                                1 => " and 1 delegated credential".to_owned(),
                                n => format!(" and {n} delegated credentials"),
                            },
                            c.kube.broker_namespace
                        ),
                    );
                }
            }
            // The pool: why a claim waits at "VM bound" (one warm member, the next still booting).
            let pool_name = obj
                .as_ref()
                .map(|o| str_at(o, "/status/poolRef/name").to_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| c.pool.clone());
            if !pool_name.is_empty() && round.is_multiple_of(2) {
                match crate::kubeinfo::pool_status(c.client.clone(), &c.sandbox_ns, &pool_name)
                    .await
                {
                    Ok(mut p) => {
                        // While the claim waits, banlieue's own reason.
                        let claim = obj
                            .as_ref()
                            .map(|o| str_at(o, "/status/claimRef/name").to_owned())
                            .unwrap_or_default();
                        let bound = obj
                            .as_ref()
                            .is_some_and(|o| !str_at(o, "/status/boundAt").is_empty());
                        if !claim.is_empty()
                            && !bound
                            && let Ok(Some(cond)) = crate::kubeinfo::claim_bound(
                                c.client.clone(),
                                &c.sandbox_ns,
                                &claim,
                            )
                            .await
                        {
                            p["claim"] = cond;
                        }
                        if p != last_pool {
                            self.data(Step::Run, json!({"pool": p}));
                            last_pool = p;
                        }
                    }
                    Err(e) => {
                        if warned.insert("pool") {
                            self.note(Step::Run, format!("pool {pool_name} not read: {e}"));
                        }
                    }
                }
            }
            // The claim's SPIRE entries (ADR-0006), once the record names the claim.
            let claim_uid = obj
                .as_ref()
                .map(|o| str_at(o, "/status/claimUid").to_owned())
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| c.claim_uid.clone());
            let spire = if warned.contains("spire") {
                json!({"error": "not readable with this kubeconfig"})
            } else {
                match crate::kubeinfo::spire_entries(c.client.clone(), &claim_uid).await {
                    Ok(entries) => json!({"entries": entries}),
                    Err(e) => {
                        warned.insert("spire");
                        self.note(
                            Step::Seal,
                            format!("SPIRE entries (clusterstaticentries) not read: {e}"),
                        );
                        json!({"error": format!("{e}")})
                    }
                }
            };
            let payload = json!({
                "spire": spire,
                "secrets": map,
                "kubeSecrets": secrets,
                "brokerNamespace": c.kube.broker_namespace,
                "memberVm": member,
                "gateways": gateways,
                "gatewayQuery": c.kube.gateways.as_ref().map(|q| json!({
                    "selector": q.selector, "namespace": q.namespace, "prefix": q.name_prefix,
                })),
            });
            if payload != last {
                self.data(Step::Seal, payload.clone());
                last = payload;
            }
            tokio::time::sleep(Duration::from_secs(4)).await;
        }
    }

    /// Watch the one `AgentSandbox` until the guest reports the workload's exit.
    async fn watch_sandbox(
        &self,
        client: kube::Client,
        ns: &str,
        name: &str,
        names: &Mutex<BTreeSet<String>>,
        bound: &watch::Sender<bool>,
        latest: &Mutex<Option<Value>>,
    ) -> anyhow::Result<util::Exit> {
        let ar = ApiResource::from_gvk_with_plural(
            &GroupVersionKind::gvk("mediatore.io", "v1beta1", "AgentSandbox"),
            "agentsandboxes",
        );
        let api: kube::Api<DynamicObject> = kube::Api::namespaced_with(client, ns, &ar);
        let cfg = watcher::Config::default().fields(&format!("metadata.name={name}"));
        let mut stream = watcher(api, cfg).default_backoff().boxed();
        let mut prev = BTreeMap::new();
        let mut errors = 0u32;
        let mut last_phase = String::new();
        loop {
            let ev = match stream.try_next().await {
                Ok(Some(ev)) => ev,
                Ok(None) => anyhow::bail!("the AgentSandbox watch ended"),
                Err(e) => {
                    errors += 1;
                    self.note(Step::Run, format!("watch: {e}"));
                    anyhow::ensure!(errors < 10, "the AgentSandbox watch keeps failing: {e}");
                    continue;
                }
            };
            let obj = match ev {
                watcher::Event::Apply(o) | watcher::Event::InitApply(o) => o,
                watcher::Event::Delete(_) => {
                    anyhow::bail!("the AgentSandbox was deleted before the workload exited")
                }
                watcher::Event::Init | watcher::Event::InitDone => continue,
            };
            errors = 0;
            let mut v = serde_json::to_value(&obj)?;
            if let Some(m) = v.pointer_mut("/metadata").and_then(Value::as_object_mut) {
                m.remove("managedFields");
            }
            let flat = util::flatten(&v);
            let changes = util::diff(&prev, &flat);
            if !changes.is_empty() {
                self.data(Step::Run, json!({"object": v, "changes": changes}));
            }
            prev = flat;
            *lock(latest) = Some(v.clone());
            self.track(Some(&v), None);
            {
                let mut n = lock(names);
                for p in ["/status/claimRef/name", "/status/virtualMachineRef/name"] {
                    let s = str_at(&v, p);
                    if !s.is_empty() {
                        n.insert(s.to_owned());
                    }
                }
            }
            let phase = str_at(&v, "/status/phase").to_owned();
            if phase != last_phase && !phase.is_empty() {
                self.note(Step::Run, format!("phase {phase}"));
                last_phase.clone_from(&phase);
            }
            if matches!(phase.as_str(), "Bound" | "Releasing") {
                bound.send_replace(true);
            }
            if let Some(x) = util::exit_of(&v) {
                self.note(Step::Run, format!("{phase}: the workload exited"));
                return Ok(x);
            }
            if phase == "Failed" {
                let reason = str_at(&v, "/status/reason");
                anyhow::bail!(
                    "the AgentSandbox failed: {}",
                    if reason.is_empty() {
                        "no reason given"
                    } else {
                        reason
                    }
                );
            }
        }
    }

    /// Kubernetes Events about the sandbox, its claim and its VM, as notes on the sandbox
    /// stage. A watch the caller may not make is reported once, then left alone.
    /// The claim's egress as the broker logs it (crate::egress): every gateway check of this
    /// claim, read from the broker pods' logs every 3 s. Says once when the logs cannot be read.
    /// The claim's uid is often not known when `POST /v1/claims` answers (the broker creates the
    /// claim after it): until it is, it is read from the `AgentSandbox`'s `status.claimUid`.
    async fn watch_egress(
        &self,
        client: kube::Client,
        broker_ns: String,
        mut claim_uid: String,
        latest: Arc<Mutex<Option<Value>>>,
    ) {
        use k8s_openapi::api::core::v1::Pod;
        if broker_ns.is_empty() {
            return;
        }
        while claim_uid.is_empty() {
            claim_uid = lock(&latest)
                .as_ref()
                .map(|o| str_at(o, "/status/claimUid").to_owned())
                .unwrap_or_default();
            if claim_uid.is_empty() {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
        let pods: kube::Api<Pod> = kube::Api::namespaced(client, &broker_ns);
        let list = kube::api::ListParams::default().labels("app.kubernetes.io/name=mediatore");
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut all: Vec<crate::egress::Check> = Vec::new();
        let mut warned = false;
        // The first read covers the claim from its start; later ones, the last few seconds.
        let mut since: i64 = 300;
        loop {
            let mut error = None;
            let mut fresh = false;
            match pods.list(&list).await {
                Ok(found) => {
                    for pod in found {
                        let Some(name) = pod.metadata.name else {
                            continue;
                        };
                        let params = kube::api::LogParams {
                            since_seconds: Some(since),
                            ..Default::default()
                        };
                        match pods.logs(&name, &params).await {
                            Ok(text) => {
                                for c in crate::egress::checks(&text, &claim_uid) {
                                    if seen.insert(format!("{name} {}", c.at)) {
                                        all.push(c);
                                        fresh = true;
                                    }
                                }
                            }
                            Err(e) => {
                                error =
                                    Some(format!("the broker's log in {broker_ns} not read: {e}"));
                            }
                        }
                    }
                }
                Err(e) => error = Some(format!("the broker's pods in {broker_ns} not listed: {e}")),
            }
            if let Some(e) = error {
                if !warned {
                    warned = true;
                    self.data(
                        Step::Run,
                        json!({"egress": {"error": e, "source": "broker log"}}),
                    );
                }
            } else if fresh {
                all.sort_by(|a, b| a.at.cmp(&b.at));
                let refused = all.iter().filter(|c| !c.live).count();
                let times: Vec<&str> = all.iter().rev().take(40).map(|c| c.at.as_str()).collect();
                self.data(
                    Step::Run,
                    json!({"egress": {
                        "checks": all.len(), "refused": refused,
                        "endpoints": all.iter().rev().find_map(|c| c.endpoints),
                        "last": all.last().map(|c| c.at.clone()), "times": times, "source": "broker log",
                    }}),
                );
            }
            since = 15;
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }

    async fn watch_events(
        &self,
        client: kube::Client,
        ns: &str,
        names: Arc<Mutex<BTreeSet<String>>>,
    ) {
        let api: kube::Api<KubeEvent> = kube::Api::namespaced(client, ns);
        let since = jiff::Timestamp::now() - jiff::SignedDuration::from_secs(30);
        let mut stream = watcher(api, watcher::Config::default())
            .applied_objects()
            .boxed();
        loop {
            match stream.try_next().await {
                Ok(Some(e)) => {
                    let obj = e.involved_object.name.clone().unwrap_or_default();
                    if !lock(&names).contains(&obj) {
                        continue;
                    }
                    let at = e
                        .last_timestamp
                        .as_ref()
                        .map(|t| t.0.to_string())
                        .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()))
                        .or_else(|| {
                            e.metadata
                                .creation_timestamp
                                .as_ref()
                                .map(|t| t.0.to_string())
                        })
                        .unwrap_or_default();
                    if at.parse::<jiff::Timestamp>().is_ok_and(|t| t < since) {
                        continue;
                    }
                    self.data(
                        Step::Run,
                        json!({"event": {
                            "at": at,
                            "type": e.type_,
                            "reason": e.reason,
                            "message": e.message,
                            "object": format!("{}/{}", e.involved_object.kind.unwrap_or_default(), obj),
                            "count": e.count,
                        }}),
                    );
                }
                Ok(None) => return,
                Err(e) => {
                    self.note(Step::Run, format!("events not watched: {e}"));
                    return;
                }
            }
        }
    }

    /// Follow the workload's output once the claim is bound, until the broker ends the stream.
    async fn follow_logs(
        &self,
        api: &Api,
        session: &Session,
        name: &str,
        ns: &str,
        mut bound: watch::Receiver<bool>,
        wanted: bool,
    ) {
        if bound.wait_for(|b| *b).await.is_err() {
            return;
        }
        self.active(Step::Logs);
        if !wanted {
            self.state(
                Step::Logs,
                State::Skipped,
                Some("not captured: the sandbox did not opt in (logs off)".into()),
            );
            return;
        }
        let mut since: Option<u64> = None;
        let mut lines = 0u64;
        for attempt in 0..30u32 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            let query = LogsQuery {
                follow: true,
                since,
                tail: None,
            };
            let mut resp = match api.logs(session, name, Some(ns), &query).await {
                Ok(r) => r,
                Err(e) => {
                    self.note(Step::Logs, format!("{e:#}; retrying"));
                    continue;
                }
            };
            let mut buf: Vec<u8> = Vec::new();
            loop {
                let chunk = match resp.chunk().await {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    Err(e) => {
                        self.note(Step::Logs, format!("read: {e}; reconnecting"));
                        break;
                    }
                };
                buf.extend_from_slice(&chunk);
                while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                    let raw: Vec<u8> = buf.drain(..=pos).collect();
                    let text = String::from_utf8_lossy(&raw);
                    let text = text.trim();
                    if text.is_empty() {
                        continue; // keepalive
                    }
                    match serde_json::from_str::<LogLine>(text) {
                        Ok(LogLine::Header(h)) => {
                            self.data(Step::Logs, serde_json::to_value(&h).unwrap_or_default());
                        }
                        Ok(LogLine::Record(r)) => {
                            since = Some(r.seq);
                            if lines == 0 {
                                self.track(None, Some(r.ts.to_string()));
                            }
                            lines += 1;
                            let stream = match r.stream {
                                LogStream::Stdout => "stdout",
                                LogStream::Stderr => "stderr",
                            };
                            self.line(
                                Step::Logs,
                                stream,
                                escape_controls(&r.text).into_owned(),
                                Some(r.ts.to_string()),
                            );
                        }
                        Ok(LogLine::Gap(g)) => self.note(
                            Step::Logs,
                            format!(
                                "[output lost: {} B stdout, {} B stderr]",
                                g.lost_stdout, g.lost_stderr
                            ),
                        ),
                        Ok(LogLine::End(e)) => {
                            let reason = serde_json::to_value(e.reason)
                                .ok()
                                .and_then(|v| v.as_str().map(ToOwned::to_owned))
                                .unwrap_or_default();
                            self.done(Step::Logs, format!("{lines} lines, stream ended: {reason}"));
                            return;
                        }
                        Err(e) => self.note(Step::Logs, format!("unreadable line: {e}")),
                    }
                }
            }
        }
        self.state(
            Step::Logs,
            State::Failed,
            Some(format!("{lines} lines; the stream kept failing")),
        );
    }
}

fn read_ca(path: &str) -> anyhow::Result<Option<Vec<u8>>> {
    if path.is_empty() {
        return Ok(None);
    }
    std::fs::read(path)
        .map(Some)
        .map_err(|e| anyhow::anyhow!("CA file {path}: {e}"))
}

pub(crate) fn user_api(s: &ClaimSettings) -> anyhow::Result<Api> {
    anyhow::ensure!(
        !s.url.is_empty(),
        "no user API URL: set MEDIATORE_URL or --mediatore"
    );
    if s.allow_plain_http && s.ca_file.is_empty() {
        return Api::plain_http(&s.url);
    }
    match read_ca(&s.ca_file)? {
        Some(pem) => Api::with_ca(&s.url, &pem),
        None => Api::new(&s.url),
    }
}

pub(crate) async fn kube_client(k: &KubeTarget) -> anyhow::Result<kube::Client> {
    let opts = KubeConfigOptions {
        context: k.context.clone(),
        ..KubeConfigOptions::default()
    };
    let cfg = match &k.kubeconfig {
        Some(p) => kube::Config::from_custom_kubeconfig(Kubeconfig::read_from(p)?, &opts).await?,
        None => kube::Config::from_kubeconfig(&opts).await?,
    };
    Ok(kube::Client::try_from(cfg)?)
}

/// Each gateway as `name address` (its first address, without the type).
pub(crate) fn gateway_ips(gateways: &[Value]) -> Vec<String> {
    gateways
        .iter()
        .map(|g| {
            let ip = g
                .pointer("/addresses/0")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .split(' ')
                .next()
                .unwrap_or_default();
            format!("{} {ip}", str_at(g, "/name")).trim().to_owned()
        })
        .collect()
}

/// `--restart` as the CLI takes it.
fn restart_of(s: &str) -> anyhow::Result<RestartPolicy> {
    match s {
        "" | "never" => Ok(RestartPolicy::Never),
        "on-failure" => Ok(RestartPolicy::OnFailure),
        "always" => Ok(RestartPolicy::Always),
        other => anyhow::bail!("restart {other:?}: never, on-failure or always"),
    }
}

/// The session file, as the CLI finds it: `MEDIATORE_SESSION`, else under the XDG config home.
///
/// # Errors
/// Neither `XDG_CONFIG_HOME` nor `HOME` is set.
pub fn session_path() -> anyhow::Result<PathBuf> {
    match std::env::var_os("MEDIATORE_SESSION") {
        Some(p) if !p.is_empty() => Ok(PathBuf::from(p)),
        _ => Session::default_path(),
    }
}

#[cfg(unix)]
fn file_mode(path: &std::path::Path) -> String {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path)
        .map(|m| format!("{:o}", m.permissions().mode() & 0o777))
        .unwrap_or_default()
}

#[cfg(not(unix))]
fn file_mode(_: &std::path::Path) -> String {
    String::new()
}

pub fn open_browser(url: &str) {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(opener)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}
