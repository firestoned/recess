// Copyright (c) 2026 Erick Bourgeois, Low Tide
// SPDX-License-Identifier: Apache-2.0

//! The run's sub-steps, in the guest's own order (`mediatore-guest` `guest::run` and
//! `build_and_run`): the VM claimed and bound, the claim's identity registered, the guest
//! attested, the sandbox built (tmpfs, rootfs, image pull, nftables ruleset, egress proxy,
//! phantom token; reported together), the jail (`nsjail`, then `mediatore jail-exec` applying
//! Landlock and seccomp, then the workload), its output, its exit, the release.
//!
//! Each step says how the UI knows: `observed` (a field on the `AgentSandbox` appeared),
//! `reported` (the guest's report or exit, with the guest's time), or `inferred` (no event of
//! its own: the jail has started once the workload prints or exits). Nothing inside the VM
//! emits per-step events today; telemetry from the guest would turn `inferred` into `observed`.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::util::str_at;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Phase {
    pub key: &'static str,
    pub title: &'static str,
    pub detail: String,
    /// When it happened: the object's own timestamp when it has one, else when the UI saw it.
    pub at: String,
    /// `done`, `active`, `pending` or `failed`.
    pub state: &'static str,
    /// `observed`, `reported` or `inferred`.
    pub how: &'static str,
}

/// The first time each step's evidence was seen, keyed by step key; the engine fills it.
pub type Seen = BTreeMap<&'static str, String>;

/// Which steps' evidence `obj` carries now (the keys the engine timestamps on first sight).
#[must_use]
pub fn evidence(obj: &Value) -> Vec<&'static str> {
    let has = |p: &str| match obj.pointer(p) {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Bool(b)) => *b,
        Some(_) => true,
    };
    let mut out = Vec::new();
    if has("/status/claimRef/name") {
        out.push("claim");
    }
    if has("/status/boundAt") || has("/status/virtualMachineRef/name") {
        out.push("bind");
    }
    if has("/status/entrySet") || has("/status/record/entryId") {
        out.push("entry");
    }
    if has("/status/record/nodeId") {
        out.push("attest");
    }
    if has("/status/record/report") {
        out.push("build");
    }
    if has("/status/record/exit") {
        out.push("exit");
    }
    if has("/status/record/revokedAt") || str_at(obj, "/status/phase") == "Releasing" {
        out.push("release");
    }
    out
}

#[must_use]
pub fn phases(
    obj: Option<&Value>,
    seen: &Seen,
    first_output: Option<&str>,
    logs_on: bool,
) -> Vec<Phase> {
    let null = Value::Null;
    let o = obj.unwrap_or(&null);
    let s = |p: &str| str_at(o, p).to_owned();
    let when = |key: &str, explicit: String| {
        if explicit.is_empty() {
            seen.get(key).cloned().unwrap_or_default()
        } else {
            explicit
        }
    };
    let report = o.pointer("/status/record/report");
    let exit = o.pointer("/status/record/exit");
    let exit_at = exit
        .map(|x| str_at(x, "/exited_at").to_owned())
        .unwrap_or_default();
    let exit_detail = exit
        .map(|x| {
            match (
                x.get("code").and_then(Value::as_i64),
                x.get("signal").and_then(Value::as_i64),
            ) {
                (Some(c), _) => format!("exit code {c}"),
                (None, Some(sig)) => format!("signal {sig}"),
                _ => "exited".into(),
            }
        })
        .unwrap_or_default();
    let ran = first_output.is_some() || exit.is_some();
    let ran_at = first_output.map_or_else(|| exit_at.clone(), ToOwned::to_owned);

    let mut out = vec![
        (
            "claim",
            "Claim a VM",
            seen.contains_key("claim"),
            when("claim", String::new()),
            format!("VirtualMachineClaim {}", s("/status/claimRef/name")),
            "observed",
        ),
        (
            "bind",
            "VM bound",
            seen.contains_key("bind"),
            when("bind", s("/status/boundAt")),
            {
                let (vm, pool) = (s("/status/virtualMachineRef/name"), s("/status/poolRef/name"));
                let ips = o
                    .pointer("/status/addresses")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
                    .unwrap_or_default();
                let vm = if ips.is_empty() { vm } else { format!("{vm} ({ips})") };
                if pool.is_empty() { vm } else { format!("{vm} from {pool}") }
            },
            "observed",
        ),
        (
            "entry",
            "Claim identity registered",
            seen.contains_key("entry"),
            when("entry", String::new()),
            "SPIRE entry set: the claim SVID can be issued to the VM".to_owned(),
            "observed",
        ),
        (
            "attest",
            "Guest attested, sandbox fetched",
            seen.contains_key("attest"),
            when("attest", String::new()),
            s("/status/record/nodeId"),
            "observed",
        ),
        (
            "build",
            "Sandbox built",
            report.is_some(),
            when("build", report.map(|r| str_at(r, "/reported_at").to_owned()).unwrap_or_default()),
            report.map_or_else(
                || "tmpfs, rootfs, image pull, nftables ruleset, egress proxy, phantom token".to_owned(),
                |r| {
                    format!(
                        "image {} · ruleset {}",
                        str_at(r, "/image_digest"),
                        str_at(r, "/sandbox_ruleset_sha256").get(..12).unwrap_or_default()
                    )
                },
            ),
            "reported",
        ),
        (
            "jail",
            "nsjail enter → jail-exec → exec",
            ran,
            ran_at.clone(),
            "nsjail enters the jail's namespaces on the sandbox rootfs; mediatore jail-exec applies Landlock and seccomp, then execs the argv".to_owned(),
            "inferred",
        ),
        (
            "run",
            "Workload running",
            ran,
            ran_at,
            if first_output.is_some() {
                "first output received".to_owned()
            } else if logs_on {
                "waiting for its first output".to_owned()
            } else {
                "output not captured (logs off)".to_owned()
            },
            if first_output.is_some() { "observed" } else { "inferred" },
        ),
        ("exit", "Exit reported", exit.is_some(), when("exit", exit_at), exit_detail, "reported"),
        (
            "release",
            "Claim released",
            seen.contains_key("release"),
            when("release", s("/status/record/revokedAt")),
            "SPIRE entry deleted, sealed envelopes deleted, VM returned".to_owned(),
            "observed",
        ),
    ]
    .into_iter()
    .map(|(key, title, done, at, detail, how)| Phase {
        key,
        title,
        detail,
        at: if done { at } else { String::new() },
        state: if done { "done" } else { "pending" },
        how,
    })
    .collect::<Vec<_>>();

    // The first step not done after the last one done is the one under way, unless the
    // sandbox failed there.
    let failed = str_at(o, "/status/phase") == "Failed";
    if let Some(last) = out
        .iter()
        .rposition(|p| p.state == "done")
        .map(|i| i + 1)
        .or(Some(0))
        && let Some(p) = out.get_mut(last)
        && obj.is_some()
    {
        p.state = if failed { "failed" } else { "active" };
        if failed {
            p.detail = s("/status/reason");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn states(ps: &[Phase]) -> Vec<(&str, &str)> {
        ps.iter().map(|p| (p.key, p.state)).collect()
    }

    #[test]
    fn a_fresh_sandbox_is_claiming() {
        let o = json!({"status": {"phase": "Pending"}});
        let ps = phases(Some(&o), &Seen::new(), None, true);
        assert_eq!(ps[0].state, "active");
        assert!(ps[1..].iter().all(|p| p.state == "pending"));
        assert!(evidence(&o).is_empty());
    }

    #[test]
    fn bound_and_reported_waits_for_the_jail() {
        let o = json!({"status": {"phase": "Bound", "claimRef": {"name": "c"}, "boundAt": "2026-11-20T00:00:05Z",
            "virtualMachineRef": {"name": "vm-1"}, "poolRef": {"name": "pool-a"}, "addresses": ["198.51.100.40"], "entrySet": true,
            "record": {"entryId": "e", "nodeId": "spiffe://sandbox.test/banlieue/node/ab",
                "report": {"reported_at": "2026-11-20T00:00:20Z", "image_digest": "sha256:aa", "sandbox_ruleset_sha256": "0123456789abcdef"}}}});
        let mut seen = Seen::new();
        for k in evidence(&o) {
            seen.insert(k, "2026-11-20T00:00:30Z".into());
        }
        let ps = phases(Some(&o), &seen, None, true);
        assert_eq!(
            states(&ps),
            [
                ("claim", "done"),
                ("bind", "done"),
                ("entry", "done"),
                ("attest", "done"),
                ("build", "done"),
                ("jail", "active"),
                ("run", "pending"),
                ("exit", "pending"),
                ("release", "pending")
            ]
        );
        assert_eq!(
            ps[1].at, "2026-11-20T00:00:05Z",
            "boundAt beats first sight"
        );
        assert_eq!(ps[1].detail, "vm-1 (198.51.100.40) from pool-a");
        assert_eq!(ps[4].at, "2026-11-20T00:00:20Z", "the guest's report time");
        assert_eq!(ps[4].detail, "image sha256:aa · ruleset 0123456789ab");
        assert_eq!(ps[5].how, "inferred");
    }

    #[test]
    fn first_output_marks_the_jail_and_run_done() {
        let o = json!({"status": {"phase": "Bound", "claimRef": {"name": "c"}, "boundAt": "t", "entrySet": true,
            "record": {"nodeId": "n", "report": {"reported_at": "t"}}}});
        let seen: Seen = evidence(&o)
            .into_iter()
            .map(|k| (k, "t".to_owned()))
            .collect();
        let ps = phases(Some(&o), &seen, Some("2026-11-20T00:00:21Z"), true);
        assert_eq!(ps[5].state, "done");
        assert_eq!(ps[6].state, "done");
        assert_eq!(ps[6].how, "observed");
        assert_eq!(ps[7].state, "active");
    }

    #[test]
    fn an_exit_without_output_is_inferred_and_release_follows() {
        let o = json!({"status": {"phase": "Releasing", "claimRef": {"name": "c"}, "boundAt": "t", "entrySet": true,
            "record": {"nodeId": "n", "report": {"reported_at": "t"}, "revokedAt": "r",
                "exit": {"exited_at": "2026-11-20T00:01:00Z", "code": 3}}}});
        let seen: Seen = evidence(&o)
            .into_iter()
            .map(|k| (k, "t".to_owned()))
            .collect();
        let ps = phases(Some(&o), &seen, None, false);
        assert!(ps.iter().all(|p| p.state == "done"), "{:?}", states(&ps));
        assert_eq!(ps[6].how, "inferred");
        assert_eq!(ps[6].at, "2026-11-20T00:01:00Z");
        assert_eq!(ps[7].detail, "exit code 3");
    }

    #[test]
    fn a_failed_sandbox_fails_the_step_it_was_on() {
        let o = json!({"status": {"phase": "Failed", "claimRef": {"name": "c"}, "reason": "no Ready member"}});
        let seen: Seen = evidence(&o)
            .into_iter()
            .map(|k| (k, "t".to_owned()))
            .collect();
        let ps = phases(Some(&o), &seen, None, true);
        assert_eq!(ps[1].state, "failed");
        assert_eq!(ps[1].detail, "no Ready member");
    }
}
