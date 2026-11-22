// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The claim's egress as the broker's own log shows it. A gateway's authorizer asks the broker
//! for a claim's allowed endpoints when a tunnel opens and its cache is cold, and the broker
//! logs each answer with the claim's uid ("claim egress answered to the gateway"). So every
//! such line is a gateway checking this claim: at least one tunnel being opened. What the line
//! does not carry: which gateway asked (they reach the broker from one address here) and which
//! host the tunnel was for (the authorizer checks that itself, on the gateway).

use serde::Serialize;

/// One gateway check of the claim, from one log line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// The line's own timestamp.
    pub at: String,
    /// The claim was live and its endpoints were answered; false when the gateway asked about
    /// a claim that was not (a tunnel refused).
    pub live: bool,
    /// How many endpoints the broker answered with.
    pub endpoints: Option<u32>,
}

/// The checks of `claim_uid` in a stretch of the broker's log.
#[must_use]
pub fn checks(log: &str, claim_uid: &str) -> Vec<Check> {
    if claim_uid.is_empty() {
        return Vec::new();
    }
    let key = format!("claim_uid={claim_uid}");
    log.lines()
        .filter(|l| l.split_whitespace().any(|w| w == key))
        .filter_map(|l| {
            let live = if l.contains("claim egress answered to the gateway") {
                true
            } else if l.contains("gateway asked about a claim that is not live") {
                false
            } else {
                return None;
            };
            let at = l.split_whitespace().next().unwrap_or_default().to_owned();
            let endpoints = l
                .split_whitespace()
                .find_map(|w| w.strip_prefix("endpoints="))
                .and_then(|n| n.parse().ok());
            Some(Check {
                at,
                live,
                endpoints,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "\
2026-11-20T14:41:58.456283Z DEBUG mediatore_tls::server: mtls connection peer=192.0.2.9:36460 spiffe_id=spiffe://sandbox.example/gateway
2026-11-20T14:41:58.469347Z DEBUG mediatore_api: claim egress answered to the gateway claim_uid=08799118-4721-4406-85ce-21fcfb09f75b endpoints=5
2026-11-20T14:42:03.100000Z DEBUG mediatore_api: claim egress answered to the gateway claim_uid=ffffffff-4721-4406-85ce-21fcfb09f75b endpoints=2
2026-11-20T14:43:10.000001Z DEBUG mediatore_api: gateway asked about a claim that is not live claim_uid=08799118-4721-4406-85ce-21fcfb09f75b
";

    #[test]
    fn only_this_claims_checks_are_read_with_their_time_and_outcome() {
        let c = checks(LOG, "08799118-4721-4406-85ce-21fcfb09f75b");
        assert_eq!(
            c,
            [
                Check {
                    at: "2026-11-20T14:41:58.469347Z".into(),
                    live: true,
                    endpoints: Some(5)
                },
                Check {
                    at: "2026-11-20T14:43:10.000001Z".into(),
                    live: false,
                    endpoints: None
                },
            ]
        );
    }

    #[test]
    fn a_uid_that_is_a_prefix_of_another_does_not_match_it_and_an_empty_one_matches_nothing() {
        assert_eq!(checks(LOG, "08799118"), Vec::<Check>::new());
        assert_eq!(checks(LOG, ""), Vec::<Check>::new());
    }
}
