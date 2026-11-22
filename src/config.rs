// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The config file: `KEY=VALUE` lines in the mediatore CLI's own environment variables
//! (`MEDIATORE_ISSUER`, `MEDIATORE_URL`, `MEDIATORE_CA_FILE`, ...) and Recess's
//! (`RECESS_*`), so one file serves both and nothing is spelled twice. It only fills what
//! the environment leaves unset: a flag beats the environment, the environment beats the file,
//! the file beats the built-in default.
//!
//! Where: `--config <path>`, else `RECESS_CONFIG`, else
//! `$XDG_CONFIG_HOME/recess/config.env` (`~/.config/recess/config.env`). A missing default
//! file is fine; a missing file that was named is an error.

use std::path::{Path, PathBuf};

/// The keys the file may set: the CLI's, Recess's, and the kubeconfig. `LOW_TIDE_*`, the
/// names from before the rename, are still read, as their `RECESS_*` twins.
fn allowed(key: &str) -> bool {
    key.starts_with("MEDIATORE_")
        || key.starts_with("RECESS_")
        || key.starts_with(LEGACY)
        || key == "KUBECONFIG"
}

/// The prefix Recess's variables had while it was called Low Tide.
const LEGACY: &str = "LOW_TIDE_";

/// A `LOW_TIDE_*` name as its `RECESS_*` twin; any other name as it is.
#[must_use]
pub fn current_name(key: &str) -> String {
    key.strip_prefix(LEGACY)
        .map_or_else(|| key.to_owned(), |rest| format!("RECESS_{rest}"))
}

/// Give every `LOW_TIDE_*` variable of the environment to its `RECESS_*` twin when that is
/// unset, so a shell or a launcher set up before the rename keeps working. Returns the names
/// it carried over.
///
/// # Safety
/// Calls `std::env::set_var`: call it before any other thread exists, as `main` does.
pub unsafe fn adopt_legacy_env() -> Vec<String> {
    let legacy: Vec<(String, std::ffi::OsString)> = std::env::vars_os()
        .filter_map(|(k, v)| k.into_string().ok().map(|k| (k, v)))
        .filter(|(k, _)| k.starts_with(LEGACY))
        .collect();
    let mut adopted = Vec::new();
    for (k, v) in legacy {
        let twin = current_name(&k);
        if std::env::var_os(&twin).is_none_or(|x| x.is_empty()) {
            // SAFETY: the caller guarantees no other thread exists yet.
            unsafe { std::env::set_var(&twin, v) };
            adopted.push(k);
        }
    }
    adopted
}

/// One parsed file: the pairs it sets, in order, and the lines it ignored (with why).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub pairs: Vec<(String, String)>,
    pub ignored: Vec<(usize, String)>,
}

/// Parse a dotenv-style file: `KEY=VALUE`, `export KEY=VALUE`, `#` comments, blank lines,
/// values optionally in single or double quotes. No expansion of any kind.
#[must_use]
pub fn parse(text: &str) -> Parsed {
    let mut out = Parsed::default();
    for (i, raw) in text.lines().enumerate() {
        let n = i + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let Some((k, v)) = line.split_once('=') else {
            out.ignored.push((n, "not KEY=VALUE".into()));
            continue;
        };
        let k = k.trim();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            out.ignored
                .push((n, format!("{k:?} is not a variable name")));
            continue;
        }
        if !allowed(k) {
            out.ignored.push((
                n,
                format!("{k} is not a MEDIATORE_*, RECESS_* (or LOW_TIDE_*) or KUBECONFIG key"),
            ));
            continue;
        }
        let v = v.trim();
        let v = if v.len() >= 2
            && ((v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\'')))
        {
            &v[1..v.len() - 1]
        } else {
            // An unquoted value ends at a ` #` comment.
            v.split(" #").next().unwrap_or_default().trim_end()
        };
        out.pairs.push((k.to_owned(), v.to_owned()));
    }
    out
}

/// The default file's path.
#[must_use]
pub fn default_path() -> Option<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".config"),
    };
    let current = base.join("recess").join("config.env");
    // Before the rename the file lived under low-tide: still read when there is no new one.
    let legacy = base.join("low-tide").join("config.env");
    Some(if !current.exists() && legacy.exists() {
        legacy
    } else {
        current
    })
}

/// Which file to read: `--config`, else `RECESS_CONFIG`, else the default; and whether it
/// was named (a named file must exist).
#[must_use]
pub fn choose(flag: Option<PathBuf>) -> Option<(PathBuf, bool)> {
    if let Some(p) = flag {
        return Some((p, true));
    }
    match std::env::var_os("RECESS_CONFIG") {
        Some(p) if !p.is_empty() => Some((PathBuf::from(p), true)),
        _ => default_path().map(|p| (p, false)),
    }
}

/// `--config <path>` or `--config=<path>` from the raw arguments, read before clap so the
/// file can feed clap's `env` defaults.
#[must_use]
pub fn flag_from_args(args: &[String]) -> Option<PathBuf> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--config" {
            return it.next().map(PathBuf::from);
        }
        if let Some(p) = a.strip_prefix("--config=") {
            return Some(PathBuf::from(p));
        }
    }
    None
}

/// What loading did, for `recess config` and the web page's hint.
#[derive(Debug, Default, Clone)]
pub struct Loaded {
    pub path: Option<PathBuf>,
    pub found: bool,
    /// Keys the file set (the environment did not have them).
    pub set: Vec<String>,
    /// Keys the file had but the environment already set.
    pub shadowed: Vec<String>,
    /// `LOW_TIDE_*` names read as their `RECESS_*` twins (the file's and the environment's).
    pub legacy: Vec<String>,
    pub ignored: Vec<(usize, String)>,
}

/// Read the file and fill the environment with what it leaves unset.
///
/// # Safety
/// Calls `std::env::set_var`: call it before any other thread exists (before the tokio
/// runtime is built), as `main` does.
///
/// # Errors
/// A named file that cannot be read.
pub unsafe fn load(chosen: Option<(PathBuf, bool)>) -> anyhow::Result<Loaded> {
    let Some((path, named)) = chosen else {
        return Ok(Loaded::default());
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if !named && e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded {
                path: Some(path),
                ..Loaded::default()
            });
        }
        Err(e) => anyhow::bail!("config {}: {e}", path.display()),
    };
    let parsed = parse(&text);
    let mut loaded = Loaded {
        path: Some(path),
        found: true,
        ignored: parsed.ignored,
        ..Loaded::default()
    };
    for (k, v) in parsed.pairs {
        let named = k;
        let k = current_name(&named);
        if k != named {
            loaded.legacy.push(named);
        }
        if std::env::var_os(&k).is_some_and(|x| !x.is_empty()) {
            loaded.shadowed.push(k);
        } else {
            // SAFETY: the caller guarantees no other thread exists yet.
            unsafe { std::env::set_var(&k, v) };
            loaded.set.push(k);
        }
    }
    Ok(loaded)
}

/// The template `recess config init` writes.
pub const TEMPLATE: &str = r#"# Recess config: KEY=VALUE, the mediatore CLI's own variables plus RECESS_*.
# A flag beats the environment, the environment beats this file. Lists are comma-separated;
# booleans are true unless empty, 0, false, no or off.
# Never put a token or a secret here: the login keeps those in the session file.

# mediatore login
#MEDIATORE_ISSUER=https://dex.example.com
#MEDIATORE_CLIENT_ID=mediatore
#MEDIATORE_CA_FILE=/path/to/ca.pem
#RECESS_SCOPES=openid,profile,email,groups,offline_access
#RECESS_AUTH_PARAMS=prompt=consent
#RECESS_LOGIN_HINT=
#RECESS_CLIENT_SECRET_FILE=
#RECESS_REDIRECT_PORTS=8000,18000
#RECESS_REDIRECT_HOST=localhost
#RECESS_REDIRECT_PATH=
#RECESS_NO_BROWSER=false
#RECESS_REUSE_SESSION=false
#MEDIATORE_SESSION=/path/to/session.json

# mediatore sandbox create
#MEDIATORE_URL=https://mediatore.example.com
#MEDIATORE_ALLOW_PLAIN_HTTP=false
#MEDIATORE_NAMESPACE=sandboxes
#RECESS_POOL=
#RECESS_POOL_SELECTOR=
#RECESS_STRATEGY=
#RECESS_TTL=3600
#RECESS_AUDIENCES=
#RECESS_DELEGATE=
#RECESS_POLICY=
#RECESS_RESTART=never
#RECESS_NO_LOGS=false
# The workload the form starts with: an image from a registry the pool reaches.
#RECESS_WORKLOAD=registry.internal:5000/library/python:3.13-slim python3 -u -c "print('hello world')"

# Where to watch, and the server
#KUBECONFIG=/path/to/kubeconfig
#RECESS_CONTEXT=
#RECESS_BROKER_NAMESPACE=banlieue-system
#RECESS_GATEWAY_SELECTOR=mediatore.io/role=gateway
#RECESS_GATEWAY_NAMESPACE=
#RECESS_GATEWAY_PREFIX=gateway-
#RECESS_NO_GATEWAYS=false
#RECESS_LISTEN=127.0.0.1:7480
#RECESS_THEME=classic
#RECESS_NO_OPEN=false
#RECESS_DEMO=false
#RECESS_DEMO_PACE=1
"#;

/// Write the template at `path`, never over an existing file.
///
/// # Errors
/// The file exists, or cannot be written.
pub fn init(path: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(!path.exists(), "{} exists; edit it instead", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, TEMPLATE)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_before_the_rename_are_read_as_their_recess_twins() {
        assert_eq!(current_name("LOW_TIDE_TTL"), "RECESS_TTL");
        assert_eq!(current_name("RECESS_TTL"), "RECESS_TTL");
        assert_eq!(current_name("MEDIATORE_URL"), "MEDIATORE_URL");
        let p = parse("LOW_TIDE_POOL=sandbox-pool\nRECESS_TTL=600\nOTHER=x\n");
        assert_eq!(
            p.pairs,
            [
                ("LOW_TIDE_POOL".to_owned(), "sandbox-pool".to_owned()),
                ("RECESS_TTL".to_owned(), "600".to_owned())
            ],
            "a LOW_TIDE_ key is allowed in the file (load gives it to its RECESS_ twin)"
        );
        assert_eq!(p.ignored.len(), 1);
    }

    #[test]
    fn parses_the_cli_variables_and_ignores_the_rest() {
        let p = parse(
            "# comment\n\
             \n\
             MEDIATORE_ISSUER=https://dex.example.com\n\
             export MEDIATORE_URL = \"https://mediatore.example.com\"\n\
             RECESS_WORKLOAD='img python3 -c \"print(1)\"'\n\
             MEDIATORE_NAMESPACE=sandboxes # trailing comment\n\
             HOME=/tmp\n\
             not a pair\n\
             BAD-KEY=x\n",
        );
        assert_eq!(
            p.pairs,
            [
                ("MEDIATORE_ISSUER".into(), "https://dex.example.com".into()),
                (
                    "MEDIATORE_URL".into(),
                    "https://mediatore.example.com".into()
                ),
                (
                    "RECESS_WORKLOAD".into(),
                    r#"img python3 -c "print(1)""#.into()
                ),
                ("MEDIATORE_NAMESPACE".into(), "sandboxes".into()),
            ]
        );
        let lines: Vec<usize> = p.ignored.iter().map(|(n, _)| *n).collect();
        assert_eq!(lines, [7, 8, 9]);
    }

    #[test]
    fn the_config_flag_is_read_before_clap() {
        let a = |v: &[&str]| v.iter().map(ToString::to_string).collect::<Vec<_>>();
        assert_eq!(
            flag_from_args(&a(&["recess", "--config", "/x", "web"])),
            Some(PathBuf::from("/x"))
        );
        assert_eq!(
            flag_from_args(&a(&["recess", "web", "--config=/y"])),
            Some(PathBuf::from("/y"))
        );
        assert_eq!(flag_from_args(&a(&["recess", "web"])), None);
    }

    #[test]
    fn the_template_parses_to_nothing_set() {
        let p = parse(TEMPLATE);
        assert_eq!(p, Parsed::default());
    }
}
