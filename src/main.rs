// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! Recess: walk one workload through mediatore and watch each stage happen, in a
//! browser (`web`) or a terminal (`tui`). Both drive the same pipeline (`engine`), which uses
//! mediatore's own client crate for the login, the claim and the output, and the Kubernetes
//! API for the `AgentSandbox`.

mod admin;
mod config;
mod demo;
mod egress;
mod engine;
mod form;
mod kubeinfo;
mod phases;
mod probe;
mod secrets;
mod settings;
mod tui;
mod util;
mod web;

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

/// The workload the form and the TUI start with: real output, a pause, an exit code.
const DEFAULT_WORKLOAD: &str = "docker.io/library/python:3.13-slim python3 -u -c \"import time; print('hello world'); time.sleep(10); print('slept 10 s, exiting')\"";

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    /// The config file (KEY=VALUE in the mediatore CLI's variables); default
    /// ~/.config/recess/config.env, or RECESS_CONFIG
    #[arg(long, global = true, value_name = "PATH")]
    config: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(clap::Args)]
struct WebArgs {
    #[command(flatten)]
    common: Common,
    /// Where to listen; loopback only
    #[arg(long, env = "RECESS_LISTEN", default_value = "127.0.0.1:7480")]
    listen: SocketAddr,
    /// Print the link instead of opening the browser
    #[arg(long, env = "RECESS_NO_OPEN", value_parser = clap::builder::FalseyValueParser::new())]
    no_open: bool,
    /// The view a browser sees first: classic, agentsandbox or admin; the page's View menu
    /// changes it, and remembers (`--theme`, `RECESS_THEME`: its old names)
    #[arg(long, alias = "theme", env = "RECESS_VIEW", value_enum, default_value_t = web::View::Classic)]
    view: web::View,
}

#[derive(Subcommand)]
enum Cmd {
    /// Serve the pipeline as a web page on loopback and open it. The page's View menu
    /// switches between the stage cards (Classic), the wireframe 3D journey (AgentSandbox,
    /// `agentsandbox`) and every live agent in the cluster (Admin, `admin`) without touching the run.
    Web(WebArgs),
    /// The same as `web --view agentsandbox`, kept for the name it had.
    #[command(name = "web-3d", hide = true)]
    Web3d(WebArgs),
    /// Show the pipeline in this terminal.
    Tui {
        #[command(flatten)]
        common: Common,
    },
    /// Show the config file Recess read and what it set; `init` writes a commented template.
    Config {
        #[command(subcommand)]
        action: Option<ConfigCmd>,
    },
}

#[derive(Subcommand)]
enum ConfigCmd {
    /// Write a commented template at the config path (never over an existing file).
    Init,
}

/// `mediatore login`'s options, as the CLI spells them. The issuer is required: the web form
/// and the TUI ask for it when it is not given here.
#[derive(Args, Clone)]
#[allow(clippy::struct_field_names)] // `--login-hint` is the CLI's flag name
struct Login {
    /// The OIDC issuer URL, exactly as mediatore's config names it (required)
    #[arg(long, env = "MEDIATORE_ISSUER", default_value = "")]
    issuer: String,
    /// mediatore's public client id at that issuer
    #[arg(long, env = "MEDIATORE_CLIENT_ID", default_value = "mediatore")]
    client_id: String,
    /// A scope to request (repeatable); the default set is `openid profile email groups offline_access`
    #[arg(long = "scope", env = "RECESS_SCOPES", value_delimiter = ',')]
    scopes: Vec<String>,
    /// An extra parameter on the authorization request, key=value (repeatable)
    #[arg(long = "auth-param", env = "RECESS_AUTH_PARAMS", value_delimiter = ',')]
    auth_params: Vec<String>,
    /// A login hint for the issuer
    #[arg(long, env = "RECESS_LOGIN_HINT", default_value = "")]
    login_hint: String,
    /// A file holding the client secret the issuer's token endpoint wants (Google's installed-app clients)
    #[arg(long, env = "RECESS_CLIENT_SECRET_FILE", default_value = "")]
    client_secret_file: String,
    /// A loopback port for the redirect, tried in order (repeatable); 0 is a port the OS chooses
    #[arg(long = "redirect-port", env = "RECESS_REDIRECT_PORTS", value_delimiter = ',', default_values_t = [8000u16, 18000])]
    redirect_ports: Vec<u16>,
    /// The host in the redirect URI (the listener binds 127.0.0.1 either way)
    #[arg(long, env = "RECESS_REDIRECT_HOST", default_value = "localhost")]
    redirect_host: String,
    /// What follows the port in the redirect URI
    #[arg(long, env = "RECESS_REDIRECT_PATH", default_value = "")]
    redirect_path: String,
    /// Print the authorization URL instead of opening a browser
    #[arg(long, env = "RECESS_NO_BROWSER", value_parser = clap::builder::FalseyValueParser::new())]
    no_browser: bool,
    /// Skip the login when the saved session is fresh and its delegation unspent
    #[arg(long, env = "RECESS_REUSE_SESSION", value_parser = clap::builder::FalseyValueParser::new())]
    reuse_session: bool,
}

/// `mediatore sandbox create`'s options, and where to watch. The web form starts from these.
#[derive(Args, Clone)]
#[allow(clippy::struct_excessive_bools)] // flags: each bool is one switch
struct Common {
    #[command(flatten)]
    login: Login,
    /// mediatore's user API base URL
    #[arg(long = "mediatore", env = "MEDIATORE_URL", default_value = "")]
    url: String,
    /// PEM CA for the issuer and the user API (private PKI); when given, nothing else is trusted
    #[arg(long, env = "MEDIATORE_CA_FILE", default_value = "")]
    ca_file: String,
    /// Allow a plain http user API on another host (test clusters only)
    #[arg(long, env = "MEDIATORE_ALLOW_PLAIN_HTTP", value_parser = clap::builder::FalseyValueParser::new())]
    allow_plain_http: bool,
    /// The namespace to claim in (ADR-0046)
    #[arg(long, env = "MEDIATORE_NAMESPACE", default_value = "")]
    namespace: String,
    /// One pool by name
    #[arg(long, env = "RECESS_POOL", default_value = "")]
    pool: String,
    /// Any pool whose labels match, KEY=VALUE (repeatable)
    #[arg(
        long = "pool-selector",
        env = "RECESS_POOL_SELECTOR",
        value_delimiter = ','
    )]
    pool_selector: Vec<String>,
    /// longest-ready, most-available or spread
    #[arg(long, env = "RECESS_STRATEGY", default_value = "")]
    strategy: String,
    /// Lifetime in seconds, from bind
    #[arg(long, env = "RECESS_TTL", default_value_t = 3600)]
    ttl: u32,
    /// Downstream audience the sandbox may request (repeatable)
    #[arg(long = "audience", env = "RECESS_AUDIENCES", value_delimiter = ',')]
    audiences: Vec<String>,
    /// AUDIENCE=SOURCE: claude-code, env:NAME or file:PATH (repeatable)
    #[arg(long, env = "RECESS_DELEGATE", value_delimiter = ',')]
    delegate: Vec<String>,
    /// The notaio policy, by name
    #[arg(long, env = "RECESS_POLICY", default_value = "")]
    policy: String,
    /// never (the default here: one run, one exit), on-failure or always
    #[arg(long, env = "RECESS_RESTART", default_value = "never")]
    restart: String,
    /// The workload the form starts with, `IMAGE [ARG...]` (editable before the run)
    #[arg(long, env = "RECESS_WORKLOAD", default_value = DEFAULT_WORKLOAD)]
    workload: String,
    /// Do not capture the workload's output
    #[arg(long, env = "RECESS_NO_LOGS", value_parser = clap::builder::FalseyValueParser::new())]
    no_logs: bool,
    /// Kubeconfig for the AgentSandbox watch (default: KUBECONFIG, then ~/.kube/config)
    #[arg(long)]
    kubeconfig: Option<PathBuf>,
    /// Kube context (default: the kubeconfig's current one)
    #[arg(long, env = "RECESS_CONTEXT")]
    context: Option<String>,
    /// Label selector for the egress gateway VMs (banlieue VirtualMachines)
    #[arg(
        long,
        env = "RECESS_GATEWAY_SELECTOR",
        default_value = "mediatore.io/role=gateway"
    )]
    gateway_selector: String,
    /// Namespace of the gateway VMs (default: all namespaces)
    #[arg(long, env = "RECESS_GATEWAY_NAMESPACE", default_value = "")]
    gateway_namespace: String,
    /// When the selector finds none: VMs whose name starts with this
    #[arg(long, env = "RECESS_GATEWAY_PREFIX", default_value = "gateway-")]
    gateway_prefix: String,
    /// Replay a scripted run with placeholder values: no login, no claim, no cluster
    #[arg(long, env = "RECESS_DEMO", value_parser = clap::builder::FalseyValueParser::new())]
    demo: bool,
    /// Do not look for gateway VMs
    #[arg(long, env = "RECESS_NO_GATEWAYS", value_parser = clap::builder::FalseyValueParser::new())]
    no_gateways: bool,
    /// The broker's namespace, where it writes the sealed Secrets
    #[arg(
        long,
        env = "RECESS_BROKER_NAMESPACE",
        default_value = "banlieue-system"
    )]
    broker_namespace: String,
}

impl Common {
    fn login(&self) -> settings::LoginSettings {
        let l = &self.login;
        settings::LoginSettings {
            issuer: l.issuer.clone(),
            client_id: l.client_id.clone(),
            scopes: l.scopes.clone(),
            auth_params: l.auth_params.clone(),
            login_hint: l.login_hint.clone(),
            ca_file: self.ca_file.clone(),
            client_secret_file: l.client_secret_file.clone(),
            redirect_ports: l.redirect_ports.clone(),
            redirect_host: l.redirect_host.clone(),
            redirect_path: l.redirect_path.clone(),
            no_browser: l.no_browser,
            reuse_session: l.reuse_session,
        }
    }

    fn claim(&self) -> settings::ClaimSettings {
        settings::ClaimSettings {
            workload: self.workload.clone(),
            url: self.url.clone(),
            ca_file: self.ca_file.clone(),
            allow_plain_http: self.allow_plain_http,
            namespace: self.namespace.clone(),
            pool: self.pool.clone(),
            pool_selector: self.pool_selector.clone(),
            strategy: self.strategy.clone(),
            ttl: self.ttl,
            audiences: self.audiences.clone(),
            delegate: self.delegate.clone(),
            policy: self.policy.clone(),
            restart: self.restart.clone(),
            logs: !self.no_logs,
        }
    }

    fn kube(&self) -> engine::KubeTarget {
        engine::KubeTarget {
            kubeconfig: self.kubeconfig.clone(),
            context: self.context.clone(),
            gateways: (!self.no_gateways).then(|| kubeinfo::GatewayQuery {
                selector: self.gateway_selector.clone(),
                namespace: self.gateway_namespace.clone(),
                name_prefix: self.gateway_prefix.clone(),
            }),
            broker_namespace: self.broker_namespace.clone(),
        }
    }
}

fn main() -> anyhow::Result<()> {
    // The config file feeds clap's `env` defaults, so it is read first, while this is the only
    // thread: `set_var` is not safe once the runtime's workers exist.
    let args: Vec<String> = std::env::args().collect();
    // Names from before the rename (LOW_TIDE_*) keep working, as their RECESS_* twins.
    // SAFETY: no other thread exists yet; the tokio runtime is built below.
    let adopted = unsafe { config::adopt_legacy_env() };
    let chosen = config::choose(config::flag_from_args(&args));
    // SAFETY: as above.
    let mut loaded = unsafe { config::load(chosen.clone()) }?;
    loaded.legacy.extend(adopted);
    let legacy_path = loaded
        .path
        .as_ref()
        .is_some_and(|p| p.components().any(|c| c.as_os_str() == "low-tide"));
    if !loaded.legacy.is_empty() || legacy_path {
        eprintln!(
            "recess: still reading older names: {}{}; `recess config` shows them",
            if loaded.legacy.is_empty() {
                String::new()
            } else {
                format!(
                    "{} variable(s) (LOW_TIDE_*, RECESS_THEME)",
                    loaded.legacy.len()
                )
            },
            if legacy_path {
                format!(
                    "{}the config file under ~/.config/low-tide",
                    if loaded.legacy.is_empty() {
                        ""
                    } else {
                        " and "
                    }
                )
            } else {
                String::new()
            }
        );
    }
    let cli = Cli::parse();
    if let Cmd::Config { action } = &cli.cmd {
        return show_config(action.as_ref(), chosen, &loaded);
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(cli, loaded))
}

fn show_config(
    action: Option<&ConfigCmd>,
    chosen: Option<(PathBuf, bool)>,
    loaded: &config::Loaded,
) -> anyhow::Result<()> {
    let path = chosen
        .map(|(p, _)| p)
        .ok_or_else(|| anyhow::anyhow!("no config path: set HOME, XDG_CONFIG_HOME or --config"))?;
    if matches!(action, Some(ConfigCmd::Init)) {
        config::init(&path)?;
        println!("wrote {}", path.display());
        return Ok(());
    }
    println!(
        "config file: {}{}",
        path.display(),
        if loaded.found { "" } else { " (none)" }
    );
    for k in &loaded.set {
        println!(
            "  {k} = {}  (from the file)",
            std::env::var(k).unwrap_or_default()
        );
    }
    for k in &loaded.shadowed {
        println!(
            "  {k} = {}  (the environment's; the file's value is ignored)",
            std::env::var(k).unwrap_or_default()
        );
    }
    for (n, why) in &loaded.ignored {
        println!("  line {n} ignored: {why}");
    }
    if !loaded.legacy.is_empty() {
        println!("names from before the rename, read as RECESS_*: rename them when you can");
        for k in &loaded.legacy {
            println!("  {k} -> {}", config::current_name(k));
        }
    }
    if path.components().any(|c| c.as_os_str() == "low-tide") {
        println!("the file is under ~/.config/low-tide: move it to ~/.config/recess/config.env");
    }
    println!("session file: {}", engine::session_path()?.display());
    Ok(())
}

async fn run(cli: Cli, loaded: config::Loaded) -> anyhow::Result<()> {
    mediatore_proto::tls::ensure_provider();
    let config_note = loaded
        .path
        .as_ref()
        .filter(|_| loaded.found)
        .map(|p| format!("{} ({} set)", p.display(), loaded.set.len()));
    match cli.cmd {
        Cmd::Web(args) => serve_web(args, None, config_note).await,
        Cmd::Web3d(args) => {
            eprintln!("recess: `web-3d` is now `web --view agentsandbox`");
            serve_web(args, Some(web::View::AgentSandbox), config_note).await
        }
        Cmd::Tui { common } => {
            tui::run(common.login(), common.claim(), common.kube(), common.demo).await
        }
        Cmd::Config { .. } => Ok(()),
    }
}

/// `recess web`, with `view` in place of `--view` for the old `web-3d`.
async fn serve_web(
    args: WebArgs,
    view: Option<web::View>,
    config_note: Option<String>,
) -> anyhow::Result<()> {
    let WebArgs {
        common,
        listen,
        no_open,
        view: chosen,
    } = args;
    web::serve(
        view.unwrap_or(chosen),
        listen,
        common.login(),
        common.claim(),
        common.kube(),
        !no_open,
        common.demo,
        config_note,
    )
    .await
}
