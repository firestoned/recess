// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The admission policies beside the Kubernetes API (`/kubernetes`): the ValidatingAdmissionPolicies
//! and their bindings, how often each is checked, and the cupboard of what they turned away.
//!
//! Three reads, each made as the person, as everything in the view is:
//!
//! - The policies and bindings (`admissionregistration.k8s.io/v1`, cluster-scoped), watched.
//! - The API server's own counters, `apiserver_validating_admission_policy_check_total` from its
//!   `/metrics`, read every [`SCRAPE`] while the page is open and a policy is listed: each
//!   policy's checks by binding and outcome (allow, warn, audit, deny). They name no namespace.
//!   Each API server counts its own, from its start: with several behind one address, each is
//!   told apart by its start time and only what it counted since it was last read is added
//!   ([`Counters`]), so a failover is not read as a burst of hits.
//! - Warning Events across all namespaces whose message carries a policy's denial or warning
//!   ([`verdicts`]): a controller that could not create a pod records one where the pod would
//!   have been. Those say where.
//!
//! What was turned away (a deny or a warning) is kept in the cupboard ([`Cupboard`]): a shelf per
//! namespace from the Events, and one shelf, with no namespace, for the API server's counts.
//! It outlives the Events (which the API server drops after an hour) for as long as this
//! Recess runs (shared: for as long as the person is signed in), up to [`MAX_KEPT`] records.
//!
//! Recess makes no admission request of its own: everything here is read.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::TryStreamExt as _;
use k8s_openapi::api::core::v1::Event;
use kube::api::{ApiResource, GroupVersionKind};
use kube::runtime::watcher;
use serde_json::{Value, json};

use crate::admin::Fleet;

/// How often the API server's counters are read while the page is open.
const SCRAPE: Duration = Duration::from_secs(10);
/// How long to wait before asking again for `/metrics` once it was refused.
const REFUSED_WAIT: Duration = Duration::from_mins(5);
/// The counter the API server keeps per policy, binding, outcome and error.
const CHECK_TOTAL: &str = "apiserver_validating_admission_policy_check_total";
/// API servers whose counters are remembered at once (a control plane has a few).
const MAX_SERVERS: usize = 16;
/// Records the cupboard keeps, all shelves together, and on one shelf.
pub const MAX_KEPT: usize = 1000;
const MAX_SHELF: usize = 200;
/// How much of a policy's message a record keeps.
const MAX_MESSAGE: usize = 1000;

/// Everything this module watches and reads, as one task: when it is aborted, all of it stops.
pub async fn run(fleet: Arc<Fleet>, client: kube::Client) {
    let cupboard = Arc::new(Mutex::new(Cupboard::default()));
    let policy = ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk(
            "admissionregistration.k8s.io",
            "v1",
            "ValidatingAdmissionPolicy",
        ),
        "validatingadmissionpolicies",
    );
    let binding = ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk(
            "admissionregistration.k8s.io",
            "v1",
            "ValidatingAdmissionPolicyBinding",
        ),
        "validatingadmissionpolicybindings",
    );
    tokio::join!(
        crate::cluster::watch(
            fleet.clone(),
            kube::Api::all_with(client.clone(), &policy),
            policy.clone(),
            "vap".to_owned(),
        ),
        crate::cluster::watch(
            fleet.clone(),
            kube::Api::all_with(client.clone(), &binding),
            binding.clone(),
            "vapb".to_owned(),
        ),
        watch_events(fleet.clone(), client.clone(), cupboard.clone()),
        count_hits(fleet.clone(), client, cupboard),
    );
}

// ------------------------------------------------------------------------------ the cupboard

/// What was turned away, kept past the Events it was read from: the records, oldest first,
/// each under its fleet key. Past [`MAX_SHELF`] on one shelf or [`MAX_KEPT`] in all, the
/// oldest goes.
#[derive(Default)]
pub struct Cupboard {
    order: VecDeque<(String, String)>,
    held: HashMap<String, Value>,
}

impl Cupboard {
    /// Keep (or update) the record `key` on shelf `ns`: `make` gets the record kept so far.
    pub fn keep(
        &mut self,
        fleet: &Fleet,
        ns: &str,
        key: String,
        make: impl FnOnce(Option<&Value>) -> Value,
    ) {
        let obj = make(self.held.get(&key));
        if !self.held.contains_key(&key) {
            self.order.push_back((ns.to_owned(), key.clone()));
            let on_shelf = self.order.iter().filter(|(n, _)| n == ns).count();
            if on_shelf > MAX_SHELF
                && let Some(i) = self.order.iter().position(|(n, _)| n == ns)
            {
                self.drop_at(fleet, i);
            }
            while self.order.len() > MAX_KEPT {
                self.drop_at(fleet, 0);
            }
        }
        self.held.insert(key.clone(), obj.clone());
        fleet.put("vapfail", key, obj);
    }

    fn drop_at(&mut self, fleet: &Fleet, i: usize) {
        if let Some((_, k)) = self.order.remove(i) {
            self.held.remove(&k);
            fleet.del(&k);
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now() -> String {
    jiff::Timestamp::now().to_string()
}

// ------------------------------------------------------------------------------ the Events

/// A policy's verdict as an Event carries it: deny or warn, the policy, its binding, and why.
#[derive(Debug, PartialEq, Eq)]
pub struct Verdict {
    pub action: &'static str,
    pub policy: String,
    pub binding: String,
    pub message: String,
}

const NAMED: &str = "ValidatingAdmissionPolicy '";
const WARNED: &str = "Validation failed for ";
const DENIED: &str = "denied request: ";

/// The verdicts in a message, as the API server words them:
/// `ValidatingAdmissionPolicy 'p' with binding 'b' denied request: why` for a deny, and
/// `Validation failed for ValidatingAdmissionPolicy 'p' with binding 'b': why` for a warning.
/// A message (a controller's, quoting the API server) may carry several, or none.
#[must_use]
pub fn verdicts(msg: &str) -> Vec<Verdict> {
    let starts: Vec<usize> = msg.match_indices(NAMED).map(|(i, _)| i).collect();
    let mut out = Vec::new();
    for (n, &at) in starts.iter().enumerate() {
        let warn = msg[..at].ends_with(WARNED);
        let end = starts.get(n + 1).map_or(msg.len(), |&next| {
            if msg[..next].ends_with(WARNED) {
                next - WARNED.len()
            } else {
                next
            }
        });
        let rest = &msg[at + NAMED.len()..end];
        let Some((policy, rest)) = rest.split_once('\'') else {
            continue;
        };
        let Some(rest) = rest.strip_prefix(" with binding '") else {
            continue;
        };
        let Some((binding, rest)) = rest.split_once('\'') else {
            continue;
        };
        let why = if warn {
            rest.strip_prefix(':').unwrap_or(rest)
        } else {
            rest.split_once(DENIED).map_or(rest, |(_, w)| w)
        };
        let why = why.trim().trim_end_matches([',', ';', '[', ']']).trim();
        out.push(Verdict {
            action: if warn { "warn" } else { "deny" },
            policy: policy.to_owned(),
            binding: binding.to_owned(),
            message: why.chars().take(MAX_MESSAGE).collect(),
        });
    }
    out
}

/// A timestamp as JSON, when there is one.
fn to<T: serde::Serialize>(t: Option<&T>) -> Option<Value> {
    t.and_then(|t| serde_json::to_value(t).ok())
}

/// An Event's verdicts as the cupboard's records: `(namespace, key, record)`.
fn records(e: &Event) -> Vec<(String, String, Value)> {
    let Some(msg) = e.message.as_deref() else {
        return Vec::new();
    };
    let found = verdicts(msg);
    if found.is_empty() {
        return Vec::new();
    }
    let o = &e.involved_object;
    let ns = o
        .namespace
        .clone()
        .or_else(|| e.metadata.namespace.clone())
        .unwrap_or_default();
    let uid = e.metadata.uid.clone().unwrap_or_else(|| {
        format!(
            "{}/{}",
            e.metadata.namespace.as_deref().unwrap_or_default(),
            e.metadata.name.as_deref().unwrap_or_default()
        )
    });
    let ts = |v: Option<Value>| v.filter(|v| !v.is_null()).unwrap_or(Value::Null);
    let series = e.series.as_ref();
    let last = ts(to(series.and_then(|s| s.last_observed_time.as_ref()))
        .or_else(|| to(e.last_timestamp.as_ref()))
        .or_else(|| to(e.event_time.as_ref()))
        .or_else(|| to(e.metadata.creation_timestamp.as_ref())));
    let first = ts(to(e.first_timestamp.as_ref())
        .or_else(|| to(e.event_time.as_ref()))
        .or_else(|| Some(last.clone())));
    let count = series.and_then(|s| s.count).or(e.count).unwrap_or(1).max(1);
    let component = e
        .reporting_component
        .clone()
        .filter(|c| !c.is_empty())
        .or_else(|| e.source.as_ref().and_then(|s| s.component.clone()))
        .unwrap_or_default();
    found
        .into_iter()
        .enumerate()
        .map(|(i, v)| {
            let key = format!("vapfail/{ns}/{uid}#{i}");
            let rec = json!({
                "ns": ns, "from": "event", "action": v.action, "policy": v.policy,
                "binding": v.binding, "message": v.message, "count": count,
                "first": first, "last": last, "reason": e.reason,
                "component": component,
                "object": {"kind": o.kind, "name": o.name, "apiVersion": o.api_version},
            });
            (ns.clone(), key, rec)
        })
        .collect()
}

fn status_code(e: &watcher::Error) -> u16 {
    match e {
        watcher::Error::InitialListFailed(kube::Error::Api(s))
        | watcher::Error::WatchStartFailed(kube::Error::Api(s))
        | watcher::Error::WatchFailed(kube::Error::Api(s))
        | watcher::Error::WatchError(s) => s.code,
        _ => 0,
    }
}

/// The Warning Events, across all namespaces, for the verdicts they carry. An Event that goes
/// (they live an hour) leaves its records in the cupboard; a relist adds, never takes away.
async fn watch_events(fleet: Arc<Fleet>, client: kube::Client, cupboard: Arc<Mutex<Cupboard>>) {
    let api: kube::Api<Event> = kube::Api::all(client);
    let mut stream = crate::util::relisting(api, watcher::Config::default().fields("type=Warning"));
    loop {
        match stream.try_next().await {
            Ok(Some(watcher::Event::Apply(e) | watcher::Event::InitApply(e))) => {
                fleet.note("vapevent", "");
                for (ns, key, rec) in records(&e) {
                    lock(&cupboard).keep(&fleet, &ns, key, |_| rec);
                }
            }
            Ok(Some(_)) => fleet.note("vapevent", ""),
            Ok(None) => {
                fleet.note("vapevent", "the watch ended");
                return;
            }
            Err(e) if matches!(status_code(&e), 401 | 403) => {
                fleet.note(
                    "vapevent",
                    "not allowed to list events in all namespaces: the cupboard has only the API server's counts",
                );
                return;
            }
            Err(e) => fleet.note("vapevent", &e.to_string()),
        }
    }
}

// ------------------------------------------------------------------------------ the counters

/// One of the API server's counters: a policy's checks through one binding with one outcome.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Series {
    pub policy: String,
    pub binding: String,
    /// allow, warn, audit or deny, as the API server labels it.
    pub action: String,
    /// The check failed to evaluate (its failure policy then decided).
    pub errored: bool,
}

/// The counters in a `/metrics` text, summed by [`Series`], and the API server's start time
/// (`process_start_time_seconds`, empty when it is not there), which tells one from another.
#[must_use]
pub fn read_metrics(text: &str) -> (String, HashMap<Series, f64>) {
    let mut start = String::new();
    let mut out: HashMap<Series, f64> = HashMap::new();
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("process_start_time_seconds ") {
            v.trim().clone_into(&mut start);
            continue;
        }
        let Some(rest) = line
            .strip_prefix(CHECK_TOTAL)
            .and_then(|r| r.strip_prefix('{'))
        else {
            continue;
        };
        let Some((labels, rest)) = parse_labels(rest) else {
            continue;
        };
        let Some(v) = rest
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<f64>().ok())
        else {
            continue;
        };
        let get = |k: &str| labels.get(k).cloned().unwrap_or_default();
        let err = get("error_type");
        let s = Series {
            policy: get("policy"),
            binding: get("policy_binding"),
            action: get("enforcement_action"),
            errored: !err.is_empty() && err != "no_error",
        };
        if s.policy.is_empty() {
            continue;
        }
        *out.entry(s).or_default() += v;
    }
    (start, out)
}

/// `k="v",k="v"}` (after the `{`): the labels, unescaped, and what follows the `}`.
fn parse_labels(text: &str) -> Option<(HashMap<String, String>, &str)> {
    let mut labels = HashMap::new();
    let mut rest = text;
    loop {
        rest = rest.trim_start_matches([',', ' ']);
        if let Some(after) = rest.strip_prefix('}') {
            return Some((labels, after));
        }
        let (name, quoted) = rest.split_once("=\"")?;
        let mut value = String::new();
        let mut chars = quoted.char_indices();
        let end = loop {
            let (pos, ch) = chars.next()?;
            match ch {
                '\\' => match chars.next()?.1 {
                    'n' => value.push('\n'),
                    other => value.push(other),
                },
                '"' => break pos,
                other => value.push(other),
            }
        };
        labels.insert(name.trim().to_owned(), value);
        rest = &quoted[end + 1..];
    }
}

/// The counters last read from each API server, by its start time.
#[derive(Default)]
pub struct Counters {
    by_server: HashMap<String, HashMap<Series, f64>>,
}

impl Counters {
    /// What `server` counted since it was last read, by series: nothing the first time it is
    /// read (what it counted before is not what happened while the page watched). A counter
    /// that went down (a restart that kept its start time) is read afresh.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    pub fn advance(&mut self, server: &str, now: HashMap<Series, f64>) -> Vec<(Series, u64)> {
        if !self.by_server.contains_key(server) && self.by_server.len() >= MAX_SERVERS {
            self.by_server.clear();
        }
        let Some(prev) = self.by_server.insert(server.to_owned(), now.clone()) else {
            return Vec::new();
        };
        let mut out: Vec<(Series, u64)> = now
            .into_iter()
            .filter_map(|(s, v)| {
                let d = v - prev.get(&s).copied().unwrap_or(0.0);
                (d >= 0.5).then(|| (s, d.round() as u64))
            })
            .collect();
        out.sort();
        out
    }
}

/// One policy's checks through one binding since this Recess began counting.
#[derive(Default, Clone)]
struct Tally {
    allow: u64,
    warn: u64,
    audit: u64,
    deny: u64,
    error: u64,
    last: String,
}

async fn scrape(client: &kube::Client) -> Result<String, kube::Error> {
    let req = axum::http::Request::get("/metrics")
        .body(Vec::new())
        .map_err(kube::Error::HttpError)?;
    client.request_text(req).await
}

/// The counters, read while someone has the page open and a policy is listed: each binding's
/// tally (kind `vaphit`), and each deny and warning on the cupboard's shelf with no namespace.
async fn count_hits(fleet: Arc<Fleet>, client: kube::Client, cupboard: Arc<Mutex<Cupboard>>) {
    let since = now();
    let mut counters = Counters::default();
    let mut tallies: HashMap<(String, String), Tally> = HashMap::new();
    tokio::time::sleep(Duration::from_secs(2)).await;
    loop {
        if !fleet.watched() || !fleet.holds("vap") {
            tokio::time::sleep(SCRAPE).await;
            continue;
        }
        let text = match scrape(&client).await {
            Ok(t) => t,
            Err(kube::Error::Api(s)) if s.code == 401 || s.code == 403 => {
                fleet.note(
                    "vaphit",
                    "not allowed to get /metrics: hits are not counted (the cupboard still has what Events say)",
                );
                tokio::time::sleep(REFUSED_WAIT).await;
                continue;
            }
            Err(e) => {
                fleet.note("vaphit", &format!("/metrics: {e}"));
                tokio::time::sleep(SCRAPE).await;
                continue;
            }
        };
        fleet.note("vaphit", "");
        let (server, read) = read_metrics(&text);
        let at = now();
        // Every binding that has been checked has a tally, from zero, before its first hit.
        let mut changed: Vec<(String, String)> = Vec::new();
        for s in read.keys() {
            let k = (s.policy.clone(), s.binding.clone());
            if !tallies.contains_key(&k) {
                tallies.insert(k.clone(), Tally::default());
                changed.push(k);
            }
        }
        for (s, d) in counters.advance(&server, read) {
            let k = (s.policy.clone(), s.binding.clone());
            let t = tallies.entry(k.clone()).or_default();
            match s.action.as_str() {
                "allow" => t.allow += d,
                "warn" => t.warn += d,
                "audit" => t.audit += d,
                "deny" => t.deny += d,
                _ => continue,
            }
            if s.errored {
                t.error += d;
            }
            t.last.clone_from(&at);
            changed.push(k);
            if s.action == "deny" || s.action == "warn" {
                let key = format!("vapfail//api:{}:{}:{}", s.policy, s.binding, s.action);
                lock(&cupboard).keep(&fleet, "", key, |was| {
                    let before = was.and_then(|w| w["count"].as_u64()).unwrap_or(0);
                    let first = was.map_or_else(|| json!(at), |w| w["first"].clone());
                    json!({
                        "ns": "", "from": "metrics", "action": s.action, "policy": s.policy,
                        "binding": s.binding, "count": before + d, "first": first, "last": at,
                        "message": "", "errored": s.errored,
                    })
                });
            }
        }
        changed.sort();
        changed.dedup();
        for (policy, binding) in changed {
            let t = &tallies[&(policy.clone(), binding.clone())];
            fleet.put(
                "vaphit",
                format!("vaphit/{policy}/{binding}"),
                json!({"policy": policy, "binding": binding, "allow": t.allow, "warn": t.warn,
                       "audit": t.audit, "deny": t.deny, "error": t.error,
                       "since": since, "last": t.last}),
            );
        }
        tokio::time::sleep(SCRAPE).await;
    }
}

// ------------------------------------------------------------------------------ the demo

fn demo_policy(name: &str, resources: &[&str], expr: &str, msg: &str) -> Value {
    json!({
        "apiVersion": "admissionregistration.k8s.io/v1", "kind": "ValidatingAdmissionPolicy",
        "metadata": {"name": name, "uid": format!("demo-vap-{name}"), "generation": 1,
                     "creationTimestamp": "2026-11-20T09:00:00Z"},
        "spec": {
            "failurePolicy": "Fail",
            "matchConstraints": {"resourceRules": [{"apiGroups": ["", "apps"], "apiVersions": ["v1"],
                "operations": ["CREATE", "UPDATE"], "resources": resources}]},
            "validations": [{"expression": expr, "message": msg}],
        },
        "status": {"observedGeneration": 1, "typeChecking": {}},
    })
}

fn demo_binding(name: &str, policy: &str, actions: &[&str], team: bool) -> Value {
    let mut spec = json!({"policyName": policy, "validationActions": actions});
    if team {
        spec["matchResources"] = json!({"namespaceSelector": {"matchExpressions": [
            {"key": "kubernetes.io/metadata.name", "operator": "In", "values": ["team-a", "team-b"]}]}});
    }
    json!({
        "apiVersion": "admissionregistration.k8s.io/v1", "kind": "ValidatingAdmissionPolicyBinding",
        "metadata": {"name": name, "uid": format!("demo-vapb-{name}"),
                     "creationTimestamp": "2026-11-20T09:00:00Z"},
        "spec": spec,
    })
}

/// The demo's policies, their hits and the cupboard: a few checks every few seconds, now and
/// then one turned away, in a team's namespace or (the API server's count) in none.
pub async fn demo(fleet: Arc<Fleet>) {
    let policies = [
        (
            "require-non-root",
            &["pods"][..],
            "object.spec.containers.all(c, has(c.securityContext) && c.securityContext.runAsNonRoot == true)",
            "containers must run as non-root",
        ),
        (
            "images-from-ghcr",
            &["pods"][..],
            "object.spec.containers.all(c, c.image.startsWith('ghcr.io/'))",
            "images must come from ghcr.io",
        ),
        (
            "no-latest-tag",
            &["pods", "deployments"][..],
            "object.spec.containers.all(c, !c.image.endsWith(':latest'))",
            "pin an image tag; :latest is not allowed",
        ),
        (
            "replica-limit",
            &["deployments"][..],
            "object.spec.replicas <= 10",
            "at most 10 replicas",
        ),
    ];
    for (name, res, expr, msg) in policies {
        fleet.put(
            "vap",
            format!("vap//{name}"),
            demo_policy(name, res, expr, msg),
        );
    }
    for (name, policy, actions, team) in [
        (
            "require-non-root-teams",
            "require-non-root",
            &["Deny"][..],
            true,
        ),
        ("images-from-ghcr", "images-from-ghcr", &["Warn"][..], false),
        (
            "no-latest-tag",
            "no-latest-tag",
            &["Deny", "Audit"][..],
            false,
        ),
    ] {
        fleet.put(
            "vapb",
            format!("vapb//{name}"),
            demo_binding(name, policy, actions, team),
        );
    }
    let cupboard = Mutex::new(Cupboard::default());
    let since = now();
    let fail = |tick: u32, ns: &str, policy: &str, binding: &str, rs: &str, why: &str| {
        let at = now();
        let msg = format!(
            "Error creating: pods \"{rs}-{tick:05x}\" is forbidden: ValidatingAdmissionPolicy '{policy}' with binding '{binding}' denied request: {why}"
        );
        let v = verdicts(&msg).pop();
        let Some(v) = v else { return };
        lock(&cupboard).keep(&fleet, ns, format!("vapfail/{ns}/demo-{tick}#0"), |_| {
            json!({"ns": ns, "from": "event", "action": v.action, "policy": v.policy,
                   "binding": v.binding, "message": v.message, "count": 1, "first": at, "last": at,
                   "reason": "FailedCreate", "component": "replicaset-controller",
                   "object": {"kind": "ReplicaSet", "name": rs, "apiVersion": "apps/v1"}})
        });
    };
    // What the cupboard holds when the page opens.
    fail(
        1,
        "team-a",
        "require-non-root",
        "require-non-root-teams",
        "worker-7b5d9c8f6",
        "containers must run as non-root",
    );
    fail(
        2,
        "team-b",
        "require-non-root",
        "require-non-root-teams",
        "web-6c9f8d7b5",
        "containers must run as non-root",
    );
    let mut t: HashMap<&str, [u64; 4]> = HashMap::new();
    let mut tick = 2u32;
    loop {
        tokio::time::sleep(Duration::from_secs(4)).await;
        tick += 1;
        let at = now();
        // allow, warn, audit, deny
        let hits: [(&str, &str, [u64; 4]); 3] = [
            (
                "require-non-root",
                "require-non-root-teams",
                [
                    u64::from(2 + tick % 3),
                    0,
                    0,
                    u64::from(tick.is_multiple_of(5)),
                ],
            ),
            (
                "images-from-ghcr",
                "images-from-ghcr",
                [
                    u64::from(1 + tick % 2),
                    u64::from(tick.is_multiple_of(3)),
                    0,
                    0,
                ],
            ),
            (
                "no-latest-tag",
                "no-latest-tag",
                [
                    u64::from(1 + tick % 4),
                    0,
                    u64::from(tick.is_multiple_of(7)),
                    u64::from(tick.is_multiple_of(7)),
                ],
            ),
        ];
        for (policy, binding, d) in hits {
            let c = t.entry(policy).or_default();
            for i in 0..4 {
                c[i] += d[i];
            }
            fleet.put(
                "vaphit",
                format!("vaphit/{policy}/{binding}"),
                json!({"policy": policy, "binding": binding, "allow": c[0], "warn": c[1],
                       "audit": c[2], "deny": c[3], "error": 0, "since": since, "last": at}),
            );
            for (i, action) in [(1, "warn"), (3, "deny")] {
                if d[i] == 0 {
                    continue;
                }
                let key = format!("vapfail//api:{policy}:{binding}:{action}");
                lock(&cupboard).keep(&fleet, "", key, |was| {
                    let first = was.map_or_else(|| json!(at), |w| w["first"].clone());
                    json!({"ns": "", "from": "metrics", "action": action, "policy": policy,
                           "binding": binding, "count": c[i], "first": first, "last": at,
                           "message": "", "errored": false})
                });
            }
        }
        if tick.is_multiple_of(5) {
            let (ns, rs) = if tick.is_multiple_of(10) {
                ("team-a", "worker-7b5d9c8f6")
            } else {
                ("team-b", "web-6c9f8d7b5")
            };
            fail(
                tick,
                ns,
                "require-non-root",
                "require-non-root-teams",
                rs,
                "containers must run as non-root",
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_denial_is_read_from_a_controllers_event() {
        let m = "Error creating: pods \"web-1\" is forbidden: ValidatingAdmissionPolicy 'require-non-root' with binding 'teams' denied request: containers must run as non-root";
        assert_eq!(
            verdicts(m),
            vec![Verdict {
                action: "deny",
                policy: "require-non-root".into(),
                binding: "teams".into(),
                message: "containers must run as non-root".into(),
            }]
        );
    }

    #[test]
    fn a_warning_and_a_denial_in_one_message_are_both_read() {
        let m = "Validation failed for ValidatingAdmissionPolicy 'ghcr' with binding 'ghcr-b': images must come from ghcr.io; ValidatingAdmissionPolicy 'p' with binding 'b' and params 'x' denied request: no";
        let v = verdicts(m);
        assert_eq!(v.len(), 2);
        assert_eq!((v[0].action, v[0].policy.as_str()), ("warn", "ghcr"));
        assert_eq!(v[0].message, "images must come from ghcr.io");
        assert_eq!((v[1].action, v[1].binding.as_str()), ("deny", "b"));
        assert_eq!(v[1].message, "no");
    }

    #[test]
    fn a_message_without_a_policy_has_no_verdict() {
        assert_eq!(verdicts("Back-off restarting failed container"), Vec::new());
        assert_eq!(
            verdicts("ValidatingAdmissionPolicy 'unterminated"),
            Vec::new()
        );
    }

    #[test]
    fn the_counters_are_read_by_label_name_and_summed() {
        let text = "# HELP x\nprocess_start_time_seconds 1.7e+09\n\
            apiserver_validating_admission_policy_check_total{enforcement_action=\"deny\",error_type=\"no_error\",policy=\"p\",policy_binding=\"b\"} 3\n\
            apiserver_validating_admission_policy_check_total{policy=\"p\",policy_binding=\"b\",error_type=\"no_error\",enforcement_action=\"allow\"} 10\n\
            apiserver_validating_admission_policy_check_total{policy=\"p\",policy_binding=\"b\",error_type=\"compile_error\",enforcement_action=\"allow\"} 2\n\
            apiserver_validating_admission_policy_check_duration_seconds_count{policy=\"p\"} 9\n";
        let (start, read) = read_metrics(text);
        assert_eq!(start, "1.7e+09");
        let s = |a: &str, e| Series {
            policy: "p".into(),
            binding: "b".into(),
            action: a.into(),
            errored: e,
        };
        assert_eq!(read.len(), 3);
        assert_eq!(read[&s("deny", false)], 3.0);
        assert_eq!(read[&s("allow", false)], 10.0);
        assert_eq!(read[&s("allow", true)], 2.0);
    }

    #[test]
    fn an_escaped_label_value_is_unescaped() {
        let (l, rest) = parse_labels("a=\"x\\\"y\",b=\"z\"} 1").unwrap();
        assert_eq!(l["a"], "x\"y");
        assert_eq!(l["b"], "z");
        assert_eq!(rest, " 1");
    }

    #[test]
    fn each_api_server_is_counted_from_its_own_last_reading() {
        let s = Series {
            policy: "p".into(),
            binding: "b".into(),
            action: "deny".into(),
            errored: false,
        };
        let at = |v: f64| HashMap::from([(s.clone(), v)]);
        let mut c = Counters::default();
        // First reading of each server: a baseline, no hits.
        assert_eq!(c.advance("a", at(100.0)), Vec::new());
        assert_eq!(c.advance("b", at(7.0)), Vec::new());
        // Alternating between them adds only what each counted since.
        assert_eq!(c.advance("a", at(103.0)), vec![(s.clone(), 3)]);
        assert_eq!(c.advance("b", at(8.0)), vec![(s.clone(), 1)]);
        assert_eq!(c.advance("a", at(103.0)), Vec::new());
        // A counter that went down is not a negative hit.
        assert_eq!(c.advance("a", at(1.0)), Vec::new());
        assert_eq!(c.advance("a", at(2.0)), vec![(s, 1)]);
    }

    #[test]
    fn the_cupboard_keeps_at_most_a_shelf_and_drops_the_oldest() {
        let fleet = Fleet::new();
        let mut c = Cupboard::default();
        for i in 0..=MAX_SHELF {
            c.keep(
                &fleet,
                "team-a",
                format!("vapfail/team-a/{i}"),
                |_| json!({"i": i}),
            );
        }
        c.keep(&fleet, "team-b", "vapfail/team-b/0".into(), |_| json!({}));
        assert_eq!(c.order.len(), MAX_SHELF + 1);
        assert!(!c.held.contains_key("vapfail/team-a/0"));
        assert!(c.held.contains_key("vapfail/team-a/1"));
        // An update keeps its place and sees what was kept.
        c.keep(&fleet, "team-b", "vapfail/team-b/0".into(), |was| {
            assert!(was.is_some());
            json!({"n": 2})
        });
        assert_eq!(c.order.len(), MAX_SHELF + 1);
    }
}
