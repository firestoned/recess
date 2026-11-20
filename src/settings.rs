// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The two forms of the flow, in the CLI's own terms: `mediatore login` first, then
//! `mediatore sandbox create`. Each renders the command it is equivalent to, so the page and the
//! TUI show exactly what the CLI would have run; Recess runs the same code in-process
//! (`mediatore-client`).

use mediatore_client::{LoginOptions, Redirect};
use serde::{Deserialize, Serialize};

/// `mediatore login`'s options. The issuer is required, as it is for the CLI.
#[allow(clippy::struct_excessive_bools)] // a form: each bool is one checkbox
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LoginSettings {
    /// `--issuer`, exactly as mediatore's config names it.
    pub issuer: String,
    /// `--client-id`.
    pub client_id: String,
    /// `--scope`, repeatable; empty is the CLI's default set.
    pub scopes: Vec<String>,
    /// `--auth-param key=value`, repeatable.
    pub auth_params: Vec<String>,
    /// `--login-hint`.
    pub login_hint: String,
    /// `--ca-file`.
    pub ca_file: String,
    /// `--client-secret-file`.
    pub client_secret_file: String,
    /// `--redirect-port`, tried in order; 0 is a port the OS chooses.
    pub redirect_ports: Vec<u16>,
    /// `--redirect-host`.
    pub redirect_host: String,
    /// `--redirect-path`.
    pub redirect_path: String,
    /// `--no-browser`.
    pub no_browser: bool,
    /// Not a CLI flag: skip the login when the saved session is fresh and its delegation unspent.
    pub reuse_session: bool,
}

impl Default for LoginSettings {
    /// The CLI's defaults.
    fn default() -> Self {
        Self {
            issuer: String::new(),
            client_id: "mediatore".into(),
            scopes: vec![],
            auth_params: vec![],
            login_hint: String::new(),
            ca_file: String::new(),
            client_secret_file: String::new(),
            redirect_ports: vec![8000, 18000],
            redirect_host: "localhost".into(),
            redirect_path: String::new(),
            no_browser: false,
            reuse_session: false,
        }
    }
}

/// `mediatore sandbox create`'s options, and the workload field.
#[allow(clippy::struct_excessive_bools)] // a form: each bool is one checkbox
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaimSettings {
    /// `IMAGE [ARG...]`: `--image` and each `--arg`.
    pub workload: String,
    /// `--mediatore`, the user API.
    pub url: String,
    /// `--ca-file`.
    pub ca_file: String,
    /// `--allow-plain-http`.
    pub allow_plain_http: bool,
    pub namespace: String,
    pub pool: String,
    pub pool_selector: Vec<String>,
    pub strategy: String,
    pub ttl: u32,
    pub audiences: Vec<String>,
    pub delegate: Vec<String>,
    pub policy: String,
    pub restart: String,
    /// `--logs`.
    pub logs: bool,
}

/// One word as a POSIX shell would read it back: bare when safe, else single-quoted.
#[must_use]
pub fn shell_word(w: &str) -> String {
    let safe = !w.is_empty()
        && w.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@,+%".contains(c));
    if safe {
        w.to_owned()
    } else {
        format!("'{}'", w.replace('\'', r"'\''"))
    }
}

fn push_flag(out: &mut Vec<String>, flag: &str, value: &str) {
    if !value.is_empty() {
        out.push(format!("{flag} {}", shell_word(value)));
    }
}

/// `key=value`, split for `extra_params`.
///
/// # Errors
/// No `=`, or an empty key: the CLI refuses the same.
pub fn parse_auth_param(s: &str) -> anyhow::Result<(String, String)> {
    match s.split_once('=') {
        Some((k, v)) if !k.is_empty() => Ok((k.to_owned(), v.to_owned())),
        _ => anyhow::bail!("--auth-param takes key=value, got {s:?}"),
    }
}

impl LoginSettings {
    /// The command the CLI would run, flags only where they differ from its defaults.
    #[must_use]
    pub fn command(&self) -> String {
        let d = Self::default();
        let mut out = vec!["mediatore login".to_owned()];
        push_flag(
            &mut out,
            "--issuer",
            if self.issuer.is_empty() {
                "<required>"
            } else {
                &self.issuer
            },
        );
        if !self.client_id.is_empty() && self.client_id != d.client_id {
            push_flag(&mut out, "--client-id", &self.client_id);
        }
        for s in &self.scopes {
            push_flag(&mut out, "--scope", s);
        }
        for p in &self.auth_params {
            push_flag(&mut out, "--auth-param", p);
        }
        push_flag(&mut out, "--login-hint", &self.login_hint);
        push_flag(&mut out, "--ca-file", &self.ca_file);
        push_flag(&mut out, "--client-secret-file", &self.client_secret_file);
        if !self.redirect_ports.is_empty() && self.redirect_ports != d.redirect_ports {
            for p in &self.redirect_ports {
                push_flag(&mut out, "--redirect-port", &p.to_string());
            }
        }
        if !self.redirect_host.is_empty() && self.redirect_host != d.redirect_host {
            push_flag(&mut out, "--redirect-host", &self.redirect_host);
        }
        push_flag(&mut out, "--redirect-path", &self.redirect_path);
        if self.no_browser {
            out.push("--no-browser".into());
        }
        out.join(" ")
    }

    /// The options `mediatore_client::login` takes, built as the CLI builds them.
    ///
    /// # Errors
    /// No issuer (required), an unreadable CA or client secret file, or a malformed
    /// `--auth-param`.
    pub fn to_options(&self) -> anyhow::Result<LoginOptions> {
        anyhow::ensure!(
            !self.issuer.trim().is_empty(),
            "the issuer is required (--issuer, MEDIATORE_ISSUER)"
        );
        let ca_pem = if self.ca_file.is_empty() {
            None
        } else {
            Some(
                std::fs::read(&self.ca_file)
                    .map_err(|e| anyhow::anyhow!("--ca-file {}: {e}", self.ca_file))?,
            )
        };
        let client_secret = if self.client_secret_file.is_empty() {
            None
        } else {
            Some(
                std::fs::read_to_string(&self.client_secret_file)
                    .map_err(|e| {
                        anyhow::anyhow!("--client-secret-file {}: {e}", self.client_secret_file)
                    })?
                    .trim()
                    .to_owned(),
            )
        };
        Ok(LoginOptions {
            issuer: self.issuer.trim().to_owned(),
            client_id: if self.client_id.is_empty() {
                "mediatore".into()
            } else {
                self.client_id.clone()
            },
            scopes: if self.scopes.is_empty() {
                LoginOptions::default_scopes()
            } else {
                self.scopes.clone()
            },
            extra_params: self
                .auth_params
                .iter()
                .map(|p| parse_auth_param(p))
                .collect::<anyhow::Result<_>>()?,
            client_secret,
            login_hint: (!self.login_hint.is_empty()).then(|| self.login_hint.clone()),
            ca_pem,
            redirect: Redirect {
                host: if self.redirect_host.is_empty() {
                    "localhost".into()
                } else {
                    self.redirect_host.clone()
                },
                // `--redirect-port 0` is the OS-chosen port: no fixed list.
                ports: self
                    .redirect_ports
                    .iter()
                    .copied()
                    .filter(|p| *p != 0)
                    .collect(),
                path: self.redirect_path.clone(),
            },
        })
    }
}

impl ClaimSettings {
    /// The command the CLI would run for this workload.
    #[must_use]
    pub fn command(&self) -> String {
        let mut out = vec!["mediatore sandbox create".to_owned()];
        push_flag(
            &mut out,
            "--mediatore",
            if self.url.is_empty() {
                "<required>"
            } else {
                &self.url
            },
        );
        push_flag(&mut out, "--ca-file", &self.ca_file);
        if self.allow_plain_http {
            out.push("--allow-plain-http".into());
        }
        push_flag(&mut out, "--namespace", &self.namespace);
        push_flag(&mut out, "--pool", &self.pool);
        for p in &self.pool_selector {
            push_flag(&mut out, "--pool-selector", p);
        }
        push_flag(&mut out, "--strategy", &self.strategy);
        if self.ttl != 0 && self.ttl != 3600 {
            push_flag(&mut out, "--ttl", &self.ttl.to_string());
        }
        for a in &self.audiences {
            push_flag(&mut out, "--audience", a);
        }
        for d in &self.delegate {
            push_flag(&mut out, "--delegate", d);
        }
        push_flag(&mut out, "--policy", &self.policy);
        if !self.restart.is_empty() && self.restart != "always" {
            push_flag(&mut out, "--restart", &self.restart);
        }
        if self.logs {
            out.push("--logs".into());
        }
        match crate::util::split_workload(&self.workload) {
            Ok((image, args)) => {
                push_flag(&mut out, "--image", &image);
                for a in &args {
                    // `--arg=` keeps an argument that starts with `-` an argument.
                    out.push(format!("--arg={}", shell_word(a)));
                }
            }
            Err(_) => out.push("--image <IMAGE>".into()),
        }
        out.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_only_what_a_shell_would_split() {
        assert_eq!(
            shell_word("https://dex.example.com"),
            "https://dex.example.com"
        );
        assert_eq!(shell_word("a b"), "'a b'");
        assert_eq!(shell_word("print('hi')"), r"'print('\''hi'\'')'");
        assert_eq!(shell_word(""), "''");
    }

    #[test]
    fn the_login_command_names_only_what_differs_from_the_cli_defaults() {
        let mut s = LoginSettings {
            issuer: "https://dex.example.com".into(),
            ..LoginSettings::default()
        };
        assert_eq!(
            s.command(),
            "mediatore login --issuer https://dex.example.com"
        );
        s.scopes = vec!["openid".into(), "groups".into()];
        s.auth_params = vec!["prompt=consent".into()];
        s.redirect_ports = vec![0];
        s.no_browser = true;
        assert_eq!(
            s.command(),
            "mediatore login --issuer https://dex.example.com --scope openid --scope groups \
             --auth-param prompt=consent --redirect-port 0 --no-browser"
        );
        assert!(
            LoginSettings::default()
                .command()
                .contains("--issuer '<required>'")
        );
    }

    #[test]
    fn login_options_are_built_as_the_cli_builds_them() {
        assert!(
            LoginSettings::default().to_options().is_err(),
            "the issuer is required"
        );
        let s = LoginSettings {
            issuer: " https://dex.example.com ".into(),
            auth_params: vec!["access_type=offline".into()],
            redirect_ports: vec![0],
            ..LoginSettings::default()
        };
        let o = s.to_options().unwrap();
        assert_eq!(o.issuer, "https://dex.example.com");
        assert_eq!(o.scopes, LoginOptions::default_scopes());
        assert_eq!(
            o.extra_params,
            [("access_type".to_owned(), "offline".to_owned())]
        );
        assert!(o.redirect.ports.is_empty(), "port 0 is the OS's choice");
        assert_eq!(o.redirect.host, "localhost");
        let bad = LoginSettings {
            issuer: "x".into(),
            auth_params: vec!["=v".into()],
            ..LoginSettings::default()
        };
        assert!(bad.to_options().is_err());
    }

    #[test]
    fn the_create_command_carries_the_workload() {
        let c = ClaimSettings {
            workload: r#"docker.io/library/python:3.13-slim python3 -u -c "print('hello world')""#
                .into(),
            url: "https://mediatore.example.com".into(),
            namespace: "sandboxes".into(),
            restart: "never".into(),
            logs: true,
            ttl: 3600,
            ..ClaimSettings::default()
        };
        assert_eq!(
            c.command(),
            "mediatore sandbox create --mediatore https://mediatore.example.com --namespace sandboxes \
             --restart never --logs --image docker.io/library/python:3.13-slim --arg=python3 --arg=-u \
             --arg=-c --arg='print('\\''hello world'\\'')'"
        );
    }
}
