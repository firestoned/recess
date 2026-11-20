// Copyright (c) 2026 Erick Bourgeois, Low Tide
// SPDX-License-Identifier: Apache-2.0

//! `--demo`: a scripted run through the same event stream and the same pure functions
//! (`secrets::map`, `phases`), for showing the flow without a cluster. Every value is a
//! placeholder (RFC 2606 names, RFC 5737 addresses); no login, no claim, no Kubernetes call.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::engine::{Run, State, Step, gateway_ips};
use crate::secrets::{self, Facts};
use crate::util;

const SANDBOX_UID: &str = "0b9a8c7d-0000-4000-8000-00000000550b";
const CLAIM_UID: &str = "6f1e2d3c-0000-4000-8000-00000000c1a1";
const SESSION_PATH: &str = "/home/octocat/.config/mediatore/session.json";

fn now() -> String {
    jiff::Timestamp::now().to_string()
}

fn now_plus(secs: i64) -> String {
    (jiff::Timestamp::now() + jiff::SignedDuration::from_secs(secs)).to_string()
}

async fn pause(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// The demo's world: the gateways, and the secrets map as the custody loop would send it.
struct World {
    gateways: Vec<Value>,
    audiences: Vec<String>,
}

impl World {
    fn new() -> Self {
        let gateways = (1..=3)
            .map(|i| {
                json!({"name": format!("gateway-0{i}"), "namespace": "banlieue-system", "role": "gateway",
                    "class": "gateway-standard", "image": "mediatore-gateway", "power": "PoweredOn",
                    "ready": "True (Running)", "provider": format!("host-{}", ["a", "b", "c"][i - 1]),
                    "providerClass": "cloud-hypervisor", "failureDomain": format!("fd-{i}"),
                    "addresses": [format!("198.51.100.{i} (InternalIP)"), format!("203.0.113.{i} (ExternalIP)")],
                    "attestationSubject": format!("spiffe://sandbox.home.example/gateway/0{i}")})
            })
            .collect();
        Self {
            gateways,
            audiences: vec!["anthropic".to_owned()],
        }
    }

    fn custody(
        &self,
        r: &Run,
        obj: Option<&Value>,
        kube: &[Value],
        refresh_on_disk: bool,
        ended: bool,
        vm: &str,
    ) {
        let member = if vm.is_empty() {
            Value::Null
        } else {
            json!({"name": vm, "namespace": "sandboxes", "power": "PoweredOn", "ready": "True (Running)",
                "provider": "host-b", "providerClass": "cloud-hypervisor", "failureDomain": "fd-2",
                "addresses": ["198.51.100.40 (InternalIP)"], "class": "sandbox-small", "image": "mediatore-guest",
                "attestationSubject": "spiffe://sandbox.home.example/banlieue/node/9c41"})
        };
        let map = secrets::map(&Facts {
            session_path: SESSION_PATH.into(),
            session_mode: "600".into(),
            session_exists: true,
            refresh_on_disk,
            submitted: !refresh_on_disk,
            broker_namespace: "banlieue-system".into(),
            sandbox: obj,
            ended,
            kube_secrets: kube,
            audiences: &self.audiences,
            vm_name: vm.into(),
            gateway_ips: gateway_ips(&self.gateways),
        });
        r.data(
            Step::Seal,
            json!({"secrets": map, "kubeSecrets": kube, "brokerNamespace": "banlieue-system",
                "memberVm": member, "gateways": self.gateways,
                "gatewayQuery": {"selector": "mediatore.io/role=gateway", "namespace": "", "prefix": "gateway-"}}),
        );
    }
}

fn session_secret(state: &str, created: &str) -> Value {
    json!({"name": format!("mediatore-session-{SANDBOX_UID}"),
        "labels": {"mediatore.io/session": state, "mediatore.io/sandbox-uid": SANDBOX_UID},
        "annotations": {}, "created": created})
}

fn delegation_secret(created: &str) -> Value {
    json!({"name": format!("mediatore-session-{SANDBOX_UID}-5e1d0c9b8a7f6e5d"),
        "labels": {"mediatore.io/session": "claimed", "mediatore.io/audience": "anthropic", "mediatore.io/sandbox-uid": SANDBOX_UID},
        "annotations": {}, "created": created})
}

fn segment_secret() -> Value {
    json!({"name": format!("mediatore-logs-{CLAIM_UID}-000001"),
        "labels": {"mediatore.io/logs": "segment", "mediatore.io/claim-uid": CLAIM_UID},
        "annotations": {"mediatore.io/seal": "v1", "mediatore.io/first-seq": "0", "mediatore.io/last-seq": "0"},
        "created": now()})
}

/// Send the object's changes to the Run stage and advance its sub-steps.
fn push(r: &Run, obj: &Value, prev: &mut BTreeMap<String, String>) {
    let flat = util::flatten(obj);
    r.data(
        Step::Run,
        json!({"object": obj, "changes": util::diff(prev, &flat)}),
    );
    *prev = flat;
    r.track(Some(obj), None);
}

#[allow(clippy::too_many_lines)]
pub async fn run(r: Arc<Run>, workload: String) {
    let (image, args) = util::split_workload(&workload).unwrap_or_else(|_| {
        (
            "docker.io/library/python:3.13-slim".into(),
            vec!["python3".into()],
        )
    });
    let world = World::new();

    // 1. Mint the token.
    r.active(Step::Mint);
    r.data(
        Step::Mint,
        json!({"login": {"issuer": "https://dex.example.com", "clientId": "mediatore",
        "scopes": ["openid", "profile", "email", "groups", "offline_access"]}}),
    );
    pause(500).await;
    r.data(Step::Mint, json!({"authorizeUrl":
        "https://dex.example.com/auth?response_type=code&client_id=mediatore&code_challenge_method=S256"}));
    pause(2400).await;
    r.data(Step::Mint, json!({"authorizeUrl": null}));
    r.data(Step::Mint, json!({"session": {"path": SESSION_PATH, "mode": "600", "login": "octocat",
        "issuer": "https://dex.example.com", "clientId": "mediatore", "idTokenExpiresAt": now_plus(3600),
        "idTokenFresh": true, "idTokenFingerprint": "4f1c09a2be77d3e0",
        "refreshToken": "held, to be delegated with the claim"}}));
    let t = jiff::Timestamp::now().as_second();
    r.data(Step::Mint, json!({"identity": {"issuer": "https://dex.example.com", "subject": "CgZvY3RvY2F0EgZnaXRodWI",
        "username": "octocat", "email": "octocat@example.com", "audience": ["mediatore"],
        "groups": ["sandbox-users", "platform", "anthropic-api"], "issuedAt": t, "expiresAt": t + 3600,
        "claimNames": ["aud", "email", "email_verified", "exp", "groups", "iat", "iss", "name", "preferred_username", "sub"],
        "fingerprint": "4f1c09a2be77d3e0"}}));
    pause(900).await;
    r.done(
        Step::Mint,
        format!("octocat · 3 groups · token in {SESSION_PATH} (0600)"),
    );

    // 2. Create the workload.
    r.active(Step::Create);
    r.data(Step::Create, json!({"workload": {"image": image, "args": args, "restart": "never", "logs": true,
        "ttl": 3600, "namespace": "sandboxes", "pool": "", "poolSelector": ["tier=standard"], "strategy": "spread",
        "audiences": world.audiences, "policy": "default", "delegate": ["anthropic"]}}));
    r.note(
        Step::Create,
        "your anthropic credential goes with the claim, once",
    );
    pause(1200).await;
    r.data(
        Step::Create,
        json!({"claim": {"name": "octocat-7k2qd", "namespace": "sandboxes", "uid": CLAIM_UID,
        "sandbox_uid": SANDBOX_UID, "phase": "Pending", "ready": false, "addresses": []}}),
    );
    r.done(Step::Create, "AgentSandbox sandboxes/octocat-7k2qd");

    // 3. Seal, 4. Run.
    let created = now();
    let mut obj = json!({
        "apiVersion": "mediatore.io/v1beta1", "kind": "AgentSandbox",
        "metadata": {"name": "octocat-7k2qd", "namespace": "sandboxes", "uid": SANDBOX_UID,
            "creationTimestamp": created, "generation": 1, "finalizers": ["mediatore.io/release"],
            "labels": {"mediatore.io/claim-uid": CLAIM_UID}},
        "spec": {"subject": {"issuer": "https://dex.example.com", "id": "CgZvY3RvY2F0EgZnaXRodWI", "display": "octocat"},
            "ttlSeconds": 3600, "workload": {"image": image, "args": args, "restart": "Never", "logs": true}},
        "status": {"phase": "Pending"}
    });
    let mut prev = BTreeMap::new();
    r.set_logs_on(true);
    r.active(Step::Seal);
    r.active(Step::Run);
    world.custody(&r, None, &[], true, false, "");
    push(&r, &obj, &mut prev);
    r.note(Step::Run, "phase Pending");
    pause(900).await;
    world.custody(
        &r,
        Some(&obj),
        &[session_secret("parked", &created)],
        false,
        false,
        "",
    );
    pause(1200).await;
    obj["status"]["claimRef"] = json!({"name": "octocat-7k2qd"});
    obj["status"]["claimUid"] = json!(CLAIM_UID);
    obj["status"]["record"] = json!({"claimUid": CLAIM_UID, "sandboxUid": SANDBOX_UID, "createdAt": created,
        "refresh": true, "delegations": [{"audience": "anthropic"}]});
    push(&r, &obj, &mut prev);
    r.data(Step::Run, json!({"event": {"at": now(), "type": "Normal", "reason": "Claimed",
        "message": "VirtualMachineClaim created; waiting for a Ready member", "object": "AgentSandbox/octocat-7k2qd", "count": 1}}));
    let sealed = vec![
        session_secret("claimed", &created),
        delegation_secret(&created),
    ];
    world.custody(&r, Some(&obj), &sealed, false, false, "");
    r.done(
        Step::Seal,
        "refresh token and 1 delegated credential sealed in banlieue-system",
    );
    pause(2000).await;

    let vm = "pool-standard-b-4";
    obj["status"]["phase"] = json!("Bound");
    obj["status"]["virtualMachineRef"] = json!({"name": vm});
    obj["status"]["poolRef"] = json!({"name": "pool-standard-b"});
    obj["status"]["addresses"] = json!(["198.51.100.40"]);
    obj["status"]["boundAt"] = json!(now());
    obj["status"]["expiresAt"] = json!(now_plus(3600));
    obj["status"]["record"]["expiresAt"] = obj["status"]["expiresAt"].clone();
    push(&r, &obj, &mut prev);
    r.note(Step::Run, "phase Bound");
    r.data(Step::Run, json!({"event": {"at": now(), "type": "Normal", "reason": "Bound",
        "message": format!("bound to {vm} by Spread from fd-2"), "object": "VirtualMachineClaim/octocat-7k2qd", "count": 1}}));
    world.custody(&r, Some(&obj), &sealed, false, false, vm);
    pause(1100).await;
    obj["status"]["entrySet"] = json!(true);
    obj["status"]["ready"] = json!(true);
    obj["status"]["record"]["entryId"] = json!("e7d1c0b9-0000-4000-8000-0000000e0001");
    push(&r, &obj, &mut prev);
    pause(900).await;
    obj["status"]["record"]["nodeId"] = json!("spiffe://sandbox.home.example/banlieue/node/9c41");
    push(&r, &obj, &mut prev);
    world.custody(&r, Some(&obj), &sealed, false, false, vm);
    pause(2600).await;
    obj["status"]["record"]["report"] = json!({"reported_at": now(),
        "image_digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "sandbox_ruleset_sha256": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b"});
    push(&r, &obj, &mut prev);

    // 5. The output.
    r.active(Step::Logs);
    r.data(
        Step::Logs,
        json!({"truncated_before": 0, "claim_phase": "Bound"}),
    );
    pause(800).await;
    if r.cancelled() {
        return;
    }
    let first = now();
    r.line(
        Step::Logs,
        "stdout",
        "hello world".into(),
        Some(first.clone()),
    );
    r.track(None, Some(first));
    let mut kube = sealed.clone();
    kube.push(segment_secret());
    world.custody(&r, Some(&obj), &kube, false, false, vm);
    // The workload sleeps; the demo shortens it.
    pause(4000).await;
    if r.cancelled() {
        return;
    }
    r.line(
        Step::Logs,
        "stdout",
        "slept 10 s, exiting".into(),
        Some(now()),
    );
    pause(600).await;

    // 6. The exit, then the release.
    obj["status"]["record"]["exit"] = json!({"exited_at": now(), "code": 0, "restarts": 0});
    push(&r, &obj, &mut prev);
    r.note(Step::Run, "Bound: the workload exited");
    r.active(Step::Exit);
    r.data(
        Step::Exit,
        serde_json::to_value(util::exit_of(&obj)).unwrap_or_default(),
    );
    pause(1300).await;
    obj["status"]["phase"] = json!("Releasing");
    obj["status"]["record"]["revokedAt"] = json!(now());
    obj["status"]["record"]["refresh"] = json!(false);
    obj["status"]["record"]["delegations"] = json!([]);
    push(&r, &obj, &mut prev);
    r.note(Step::Run, "phase Releasing");
    world.custody(&r, Some(&obj), &[segment_secret()], false, true, vm);
    r.done(Step::Logs, "2 lines, stream ended: claim_ended");
    r.done(Step::Run, "workload exit code 0");
    r.state(Step::Exit, State::Done, Some("exit code 0".into()));
    r.finish(true, "exit code 0 (demo)".into());
}
