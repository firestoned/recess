// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! Where each secret of one claim is, from what the UI can see: the session file's shape
//! (never its values), the `AgentSandbox`'s `status.record`, the Secrets' metadata in the
//! broker's namespace, and the gateway VMs. A secret the UI cannot observe directly (one held
//! in a process's memory) is shown as `possible` while the claim makes it so, never as fact.
//!
//! Sources, in mediatore: the session file (`mediatore-client` `Session`, mode 0600, plain);
//! the envelopes (`mediatore-claims` kubestore `session_name`, `delegation_name`,
//! `logs_segment_name`, all sealed by construction, `mediatore-store` seal); the gateway's
//! credential cache (`mediatore-gateway`, memory, at most 60 s); the guest's phantom token
//! (tmpfs) and the egress proxy's token cache (memory).

use serde::Serialize;
use serde_json::Value;

use crate::util::str_at;

/// Where a secret sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Place {
    /// Your machine.
    Laptop,
    /// The Kubernetes API (etcd), in the broker's namespace.
    Kube,
    /// The broker's process memory.
    Broker,
    /// The sandbox's member VM.
    Vm,
    /// An egress gateway VM.
    Gateway,
}

/// Whether it is there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    /// Observed: the file, the Secret, the record field is there.
    Held,
    /// Not observable from here, but the claim's state makes it so (memory of a process).
    Possible,
    /// Was there, is not any more.
    Gone,
    /// Not yet.
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub name: String,
    pub place: Place,
    /// Exactly where: a path, a Secret's name, a process.
    #[serde(rename = "where")]
    pub location: String,
    /// Stored encrypted (sealed envelope); the UI draws a lock.
    pub sealed: bool,
    /// Only in memory (or tmpfs): nothing at rest.
    pub memory: bool,
    pub presence: Presence,
    pub note: String,
}

/// What the map is built from. None of it is secret.
#[derive(Debug, Default)]
#[allow(clippy::struct_excessive_bools)] // observations, one bool each
pub struct Facts<'a> {
    pub session_path: String,
    pub session_mode: String,
    pub session_exists: bool,
    /// The session file still holds a refresh token.
    pub refresh_on_disk: bool,
    /// The claim was submitted (the refresh token went to the broker).
    pub submitted: bool,
    pub broker_namespace: String,
    /// The latest `AgentSandbox`, if any.
    pub sandbox: Option<&'a Value>,
    /// The sandbox was deleted, or its claim has ended.
    pub ended: bool,
    /// Metadata of the Secrets labelled with this sandbox or claim.
    pub kube_secrets: &'a [Value],
    pub audiences: &'a [String],
    pub vm_name: String,
    /// Each gateway as `name address`, for the gateway lane.
    pub gateway_ips: Vec<String>,
}

fn label<'a>(s: &'a Value, k: &str) -> &'a str {
    s.get("labels")
        .and_then(|l| l.get(k))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

#[allow(clippy::too_many_lines)]
#[must_use]
pub fn map(f: &Facts) -> Vec<Item> {
    let mut out = Vec::new();
    let it = |name: &str, place, location: String, sealed, memory, presence, note: &str| Item {
        name: name.to_owned(),
        place,
        location,
        sealed,
        memory,
        presence,
        note: note.to_owned(),
    };
    let record = f.sandbox.and_then(|o| o.pointer("/status/record"));
    let phase = f
        .sandbox
        .map(|o| str_at(o, "/status/phase"))
        .unwrap_or_default();
    let revoked = record.is_some_and(|r| !str_at(r, "/revokedAt").is_empty());
    let live = !f.ended && !revoked && phase == "Bound";
    // Once bound and now over, what lived in a process's memory is gone with it.
    let was_bound = f
        .sandbox
        .is_some_and(|o| !str_at(o, "/status/boundAt").is_empty())
        || record.is_some_and(|r| !str_at(r, "/nodeId").is_empty());
    let in_memory = || {
        if live {
            Presence::Possible
        } else if (f.ended || revoked) && was_bound {
            Presence::Gone
        } else {
            Presence::Pending
        }
    };

    // Your machine.
    let file = format!("{} (0{})", f.session_path, f.session_mode);
    out.push(it(
        "ID token",
        Place::Laptop,
        file.clone(),
        false,
        false,
        if f.session_exists {
            Presence::Held
        } else {
            Presence::Pending
        },
        "plain JSON, owner-only file; the bearer for the user API until it expires",
    ));
    out.push(it(
        "Refresh token",
        Place::Laptop,
        file,
        false,
        false,
        if f.refresh_on_disk {
            Presence::Held
        } else if f.submitted {
            Presence::Gone
        } else {
            Presence::Pending
        },
        if f.submitted {
            "delegated with the claim; the client cleared it from the file"
        } else {
            "plain JSON, owner-only file; sent once with the claim"
        },
    ));

    // The Kubernetes API, in the broker's namespace.
    let ns = &f.broker_namespace;
    let sessions: Vec<&Value> = f
        .kube_secrets
        .iter()
        .filter(|s| {
            !label(s, "mediatore.io/session").is_empty()
                && label(s, "mediatore.io/audience").is_empty()
        })
        .collect();
    let refresh_flag = record
        .and_then(|r| r.get("refresh"))
        .and_then(Value::as_bool)
        == Some(true);
    let session_presence = if !sessions.is_empty() || refresh_flag {
        Presence::Held
    } else if f.submitted && (f.ended || record.is_some()) {
        Presence::Gone
    } else {
        Presence::Pending
    };
    let session_where = sessions.first().map_or_else(
        || format!("{ns}/mediatore-session-<sandbox uid>"),
        |s| {
            format!(
                "{ns}/{} ({})",
                str_at(s, "/name"),
                label(s, "mediatore.io/session")
            )
        },
    );
    out.push(it(
        "Refresh token (issuer session)",
        Place::Kube,
        session_where,
        true,
        false,
        session_presence,
        "AES-256-GCM envelope bound to the sandbox UID; re-sealed on every refresh, deleted at release",
    ));
    let mut seen_delegations = Vec::new();
    for s in f
        .kube_secrets
        .iter()
        .filter(|s| !label(s, "mediatore.io/audience").is_empty())
    {
        let aud = label(s, "mediatore.io/audience");
        seen_delegations.push(aud.to_owned());
        out.push(it(
            &format!("Delegated credential: {aud}"),
            Place::Kube,
            format!("{ns}/{}", str_at(s, "/name")),
            true,
            false,
            Presence::Held,
            "sealed envelope, one per audience; deleted at release",
        ));
    }
    if let Some(Value::Array(ds)) = record.and_then(|r| r.get("delegations")) {
        for d in ds {
            let aud = str_at(d, "/audience");
            if !aud.is_empty() && !seen_delegations.iter().any(|x| x == aud) {
                out.push(it(
                    &format!("Delegated credential: {aud}"),
                    Place::Kube,
                    format!("{ns}/mediatore-session-<sandbox uid>-<hash>"),
                    true,
                    false,
                    Presence::Held,
                    "on the record; its Secret is not visible to this kubeconfig",
                ));
            }
        }
    }
    let segments: Vec<&Value> = f
        .kube_secrets
        .iter()
        .filter(|s| label(s, "mediatore.io/logs") == "segment")
        .collect();
    if !segments.is_empty() {
        let sealed = segments.iter().all(|s| {
            s.get("annotations")
                .and_then(|a| a.get("mediatore.io/seal"))
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
        });
        out.push(it(
            &format!(
                "Workload output ({} segment{})",
                segments.len(),
                if segments.len() == 1 { "" } else { "s" }
            ),
            Place::Kube,
            format!("{ns}/mediatore-logs-<claim uid>-NNNNNN"),
            sealed,
            false,
            Presence::Held,
            "redacted in the VM, sealed per batch; kept for the retention window after the claim",
        ));
    }

    // The broker's memory.
    out.push(it(
        "Refresh token (plaintext)",
        Place::Broker,
        "broker process".into(),
        false,
        true,
        if live {
            Presence::Possible
        } else if f.submitted {
            Presence::Gone
        } else {
            Presence::Pending
        },
        "opened only to refresh at the issuer, then sealed again",
    ));

    // The sandbox VM.
    let vm_ip = f
        .sandbox
        .and_then(|o| o.pointer("/status/addresses/0"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let vm = match (f.vm_name.is_empty(), vm_ip.is_empty()) {
        (true, _) => "member VM".to_owned(),
        (false, true) => f.vm_name.clone(),
        (false, false) => format!("{} ({vm_ip})", f.vm_name),
    };
    let vm_presence = |observed: bool| {
        if f.ended || revoked {
            if observed {
                Presence::Gone
            } else {
                Presence::Pending
            }
        } else if observed {
            Presence::Held
        } else {
            Presence::Pending
        }
    };
    let node = record.map(|r| str_at(r, "/nodeId")).unwrap_or_default();
    out.push(it(
        "Node SVID",
        Place::Vm,
        format!("{vm}: guest (root)"),
        false,
        true,
        vm_presence(!node.is_empty()),
        if node.is_empty() {
            "the node's X.509 SVID, once attested"
        } else {
            node
        },
    ));
    let entry = record.is_some_and(|r| !str_at(r, "/entryId").is_empty());
    out.push(it(
        "Claim SVID",
        Place::Vm,
        format!("{vm}: egress proxy (sandbox user)"),
        false,
        true,
        vm_presence(entry),
        "issued while the SPIRE entry exists; the jail has none",
    ));
    out.push(it(
        "Phantom token",
        Place::Vm,
        format!("{vm}: tmpfs egress/phantom (0400) and MEDIATORE_TOKEN"),
        false,
        true,
        in_memory(),
        "random, worthless outside the proxy; redacted from captured output",
    ));
    if !f.audiences.is_empty() {
        out.push(it(
            &format!("Audience tokens ({})", f.audiences.join(", ")),
            Place::Vm,
            format!("{vm}: egress proxy memory"),
            false,
            true,
            in_memory(),
            "for proxy-placed audiences, from POST /v1/token; cached until 30 s before expiry",
        ));

        // The gateways.
        out.push(it(
            &format!("Audience credentials ({})", f.audiences.join(", ")),
            Place::Gateway,
            if f.gateway_ips.is_empty() {
                "authorizer on the gateway that carries the tunnel".into()
            } else {
                format!("authorizer on whichever gateway carries the tunnel: {}", f.gateway_ips.join(", "))
            },
            false,
            true,
            in_memory(),
            "for gateway-placed audiences only; cached at most 60 s, never past the deadline, never on disk",
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn find<'a>(m: &'a [Item], name: &str) -> &'a Item {
        m.iter()
            .find(|i| i.name == name)
            .unwrap_or_else(|| panic!("{name} missing"))
    }

    #[test]
    fn before_the_claim_both_tokens_are_on_disk_in_the_clear() {
        let m = map(&Facts {
            session_path: "/home/u/.config/mediatore/session.json".into(),
            session_mode: "600".into(),
            session_exists: true,
            refresh_on_disk: true,
            broker_namespace: "banlieue-system".into(),
            ..Facts::default()
        });
        let id = find(&m, "ID token");
        assert_eq!(
            (id.place, id.presence, id.sealed),
            (Place::Laptop, Presence::Held, false)
        );
        assert_eq!(find(&m, "Refresh token").presence, Presence::Held);
        assert_eq!(
            find(&m, "Refresh token (issuer session)").presence,
            Presence::Pending
        );
        assert!(
            !m.iter().any(|i| i.place == Place::Gateway),
            "no audiences, no gateway credential"
        );
    }

    #[test]
    fn a_bound_claim_moves_the_refresh_token_into_a_sealed_secret() {
        let sandbox = json!({"status": {"phase": "Bound", "record": {
            "refresh": true, "nodeId": "spiffe://sandbox.test/banlieue/node/ab", "entryId": "e1",
            "delegations": [{"audience": "anthropic"}]}}});
        let secrets = [
            json!({"name": "mediatore-session-u1", "labels": {"mediatore.io/session": "claimed", "mediatore.io/sandbox-uid": "u1"}}),
            json!({"name": "mediatore-session-u1-0123456789abcdef", "labels": {"mediatore.io/session": "claimed", "mediatore.io/audience": "anthropic"}}),
            json!({"name": "mediatore-logs-c1-000001", "labels": {"mediatore.io/logs": "segment"}, "annotations": {"mediatore.io/seal": "v1"}}),
        ];
        let audiences = ["anthropic".to_owned()];
        let m = map(&Facts {
            session_exists: true,
            refresh_on_disk: false,
            submitted: true,
            broker_namespace: "banlieue-system".into(),
            sandbox: Some(&sandbox),
            kube_secrets: &secrets,
            audiences: &audiences,
            vm_name: "pool-a-3".into(),
            gateway_ips: vec!["gateway-01 198.51.100.1".into()],
            ..Facts::default()
        });
        assert_eq!(find(&m, "Refresh token").presence, Presence::Gone);
        let env = find(&m, "Refresh token (issuer session)");
        assert_eq!(
            (env.place, env.presence, env.sealed),
            (Place::Kube, Presence::Held, true)
        );
        assert!(
            env.location
                .contains("banlieue-system/mediatore-session-u1 (claimed)")
        );
        let d = find(&m, "Delegated credential: anthropic");
        assert!(d.sealed);
        assert_eq!(
            m.iter().filter(|i| i.name.starts_with("Delegated")).count(),
            1,
            "record and Secret are one"
        );
        let logs = find(&m, "Workload output (1 segment)");
        assert!(logs.sealed);
        assert_eq!(find(&m, "Node SVID").presence, Presence::Held);
        assert_eq!(find(&m, "Claim SVID").presence, Presence::Held);
        let gw = find(&m, "Audience credentials (anthropic)");
        assert_eq!(
            (gw.place, gw.presence, gw.memory, gw.sealed),
            (Place::Gateway, Presence::Possible, true, false)
        );
        assert!(gw.location.contains("gateway-01 198.51.100.1"));
    }

    #[test]
    fn a_segment_without_the_seal_marker_is_not_drawn_locked() {
        let secrets = [
            json!({"name": "mediatore-logs-c1-000001", "labels": {"mediatore.io/logs": "segment"}}),
        ];
        let m = map(&Facts {
            kube_secrets: &secrets,
            ..Facts::default()
        });
        assert!(!find(&m, "Workload output (1 segment)").sealed);
    }

    #[test]
    fn after_release_memory_secrets_are_gone() {
        let sandbox = json!({"status": {"phase": "Releasing", "record": {
            "nodeId": "spiffe://sandbox.test/banlieue/node/ab", "entryId": "e1", "revokedAt": "2026-11-20T00:00:00Z"}}});
        let audiences = ["git".to_owned()];
        let m = map(&Facts {
            submitted: true,
            sandbox: Some(&sandbox),
            ended: true,
            audiences: &audiences,
            ..Facts::default()
        });
        assert_eq!(find(&m, "Node SVID").presence, Presence::Gone);
        assert_eq!(
            find(&m, "Audience credentials (git)").presence,
            Presence::Gone
        );
        assert_eq!(find(&m, "Phantom token").presence, Presence::Gone);
        assert_eq!(find(&m, "Audience tokens (git)").presence, Presence::Gone);
        assert_eq!(
            find(&m, "Refresh token (issuer session)").presence,
            Presence::Gone
        );
    }
}
