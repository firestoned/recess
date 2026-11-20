// Copyright (c) 2026 Erick Bourgeois, Low Tide
// SPDX-License-Identifier: Apache-2.0

//! The terminal front end: the stages as a column of boxes, joined by connectors that fill in
//! and darken as the run passes through them; beside them, the selected stage's facts.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event as TermEvent, KeyCode, KeyEventKind,
    KeyModifiers, MouseButton, MouseEventKind,
};
use ratatui::crossterm::execute;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize as _};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Paragraph, Wrap};
use serde_json::Value;

use crate::engine::{Body, Event, KubeTarget, Run, State, Step};
use crate::form::{Action, Form, Hit};
use crate::settings::{ClaimSettings, LoginSettings};
use crate::util::str_at;

/// Dim text and pending borders. An explicit colour: the palette's "dark gray" is the
/// background in some themes (Solarized Dark), which made pending stages vanish.
pub(crate) const DIM: Color = Color::Rgb(125, 135, 148);
/// The run's sub-steps that are authorizations or encrypted channels, locked once done.
const PHASE_LOCKS: [&str; 3] = [
    "Claim identity registered",
    "Node identity on the record",
    "Guest fetched and built the sandbox",
];
/// Done: an explicit green, the palette's is olive in Solarized.
const GOOD: Color = Color::Rgb(60, 190, 120);

pub async fn run(
    login: LoginSettings,
    claim: ClaimSettings,
    kube: KubeTarget,
    demo: bool,
) -> anyhow::Result<()> {
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let mut terminal = ratatui::init();
        // The buttons and fields take clicks.
        let _ = execute!(std::io::stdout(), EnableMouseCapture);
        let result = Ui::new(login, claim, kube, handle, demo).main_loop(&mut terminal);
        let _ = execute!(std::io::stdout(), DisableMouseCapture);
        ratatui::restore();
        result
    })
    .await?
}

/// What one stage shows.
#[derive(Default)]
struct StageView {
    state: Option<State>,
    note: Option<String>,
    facts: Vec<(String, String)>,
    lines: Vec<(String, String, Option<String>)>,
    started: Option<jiff::Timestamp>,
    ended: Option<jiff::Timestamp>,
    /// The run's sub-steps: state, title, time, detail and how it is known.
    phases: Vec<(String, String, String, String)>,
    /// The CLI command this stage ran.
    command: Option<String>,
    /// A step past its limit: its title, since when, and what to look at.
    stall: Option<(String, String, String)>,
}

impl StageView {
    fn fact(&mut self, k: &str, v: String) {
        if let Some(slot) = self.facts.iter_mut().find(|(key, _)| key == k) {
            slot.1 = v;
        } else {
            self.facts.push((k.to_owned(), v));
        }
    }
}

/// What the input line asks for: the flow's two forms, in the CLI's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Prompt {
    /// `mediatore login`: the issuer (required); the other options come from the flags.
    Issuer,
    /// `mediatore sandbox create`: the workload, once the token is minted.
    Workload,
    /// Nothing to type: the run is under way.
    Nothing,
}

struct Ui {
    login: LoginSettings,
    claim: ClaimSettings,
    prompt: Prompt,
    kube: KubeTarget,
    rt: tokio::runtime::Handle,
    demo: bool,
    /// `mediatore login`'s form, then `mediatore sandbox create`'s.
    login_form: Form,
    claim_form: Form,
    /// Where the open form's items were drawn last, for clicks (absolute rows and columns).
    hits: RefCell<Vec<Hit>>,
    editing: bool,
    run: Option<Arc<Run>>,
    cursor: usize,
    stages: HashMap<Step, StageView>,
    finished: Option<(bool, String)>,
    selected: Step,
    follow: bool,
    started: Instant,
    message: Arc<Mutex<Option<String>>>,
    log_scroll: u16,
}

/// The pool in one line: `sandbox-pool: 0/1 warm · 1 provisioning (lf97b booting since 06:24:41)`.
fn pool_line(p: &Value) -> String {
    if p.get("missing").is_some() {
        return format!("{}: not found", str_at(p, "/name"));
    }
    let n = |k: &str| p.get(k).and_then(Value::as_i64).unwrap_or(0);
    let booting: Vec<String> = p
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| m.get("guestReady").and_then(Value::as_bool) != Some(true))
        .map(|m| {
            let since = str_at(m, "/created")
                .parse::<jiff::Timestamp>()
                .map(|t| t.strftime("%H:%M:%S").to_string())
                .unwrap_or_default();
            format!("{} booting since {since}", str_at(m, "/name"))
        })
        .collect();
    let mut out = format!(
        "{}: {} available · {} claimed · {} provisioning",
        str_at(p, "/name"),
        n("available"),
        n("claimed"),
        n("provisioning")
    );
    if !booting.is_empty() {
        out = format!("{out} ({})", booting.join(", "));
    }
    if let Some(c) = p.get("claim").filter(|c| str_at(c, "/status") != "True") {
        out = format!(
            "{out} · {}: {}",
            str_at(c, "/reason"),
            str_at(c, "/message")
        );
    }
    out
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(text_of).collect::<Vec<_>>().join(", "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

impl Ui {
    fn new(
        login: LoginSettings,
        claim: ClaimSettings,
        kube: KubeTarget,
        rt: tokio::runtime::Handle,
        demo: bool,
    ) -> Self {
        Self {
            login_form: Form::login(&login),
            claim_form: Form::claim(&claim),
            hits: RefCell::new(Vec::new()),
            login,
            claim,
            prompt: Prompt::Issuer,
            kube,
            rt,
            demo,
            editing: true,
            run: None,
            cursor: 0,
            stages: HashMap::new(),
            finished: None,
            selected: Step::Mint,
            follow: true,
            started: Instant::now(),
            message: Arc::new(Mutex::new(None)),
            log_scroll: 0,
        }
    }

    fn set_message(&self, m: impl Into<String>) {
        *self
            .message
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(m.into());
    }

    /// `mediatore login` with the issuer typed and the other options from the flags.
    fn start_login(&mut self) {
        let login = if self.demo {
            let mut l = self.login_form.login_preview();
            if l.issuer.is_empty() {
                l.issuer = "https://dex.example.com".into();
            }
            l
        } else {
            match self.login_form.to_login() {
                Ok(l) => l,
                Err(e) => {
                    self.set_message(format!("login: {e:#}"));
                    return;
                }
            }
        };
        self.login = login;
        self.release_run();
        let run = Run::new();
        if self.demo {
            self.rt
                .spawn(crate::demo::run(run.clone(), self.login.clone()));
        } else {
            self.rt
                .spawn(run.clone().execute(self.login.clone(), self.kube.clone()));
        }
        self.run = Some(run);
        self.cursor = 0;
        self.stages.clear();
        self.finished = None;
        self.editing = false;
        self.prompt = Prompt::Nothing;
        self.follow = true;
        self.log_scroll = 0;
        *self
            .message
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    /// `mediatore sandbox create` with the workload typed, handed to the waiting run.
    fn submit_workload(&mut self) {
        let Some(run) = self.run.clone() else { return };
        let c = match self.claim_form.to_claim() {
            Ok(c) => c,
            Err(e) => {
                self.set_message(format!("workload: {e:#}"));
                return;
            }
        };
        match run.submit(c.clone(), !self.demo) {
            Ok(()) => {
                self.claim = c;
                self.editing = false;
                self.prompt = Prompt::Nothing;
                *self
                    .message
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            }
            Err(e) => self.set_message(format!("workload: {e:#}")),
        }
    }

    /// Cancel the current run and give its claim back, in the background; the outcome is the
    /// footer's message.
    fn release_run(&self) {
        let Some(r) = self.run.clone() else { return };
        if r.finished() {
            return;
        }
        let msg = self.message.clone();
        self.rt.spawn(async move {
            let m = match r.cancel_and_release().await {
                Ok(true) => "cancelled; the claim was released".to_owned(),
                Ok(false) => "cancelled before a claim was made".to_owned(),
                Err(e) => format!("cancelled, but the claim was not released: {e:#}"),
            };
            *msg.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(m);
        });
    }

    /// Whether a stage carries a lock: authorized (login, claim, claim identity) or encrypted
    /// at rest (sealed envelopes, sealed output), once it has happened.
    fn locked(&self, step: Step) -> bool {
        let Some(v) = self.stages.get(&step) else {
            return false;
        };
        let sealed_held = |what: &str| {
            self.stages.get(&Step::Seal).is_some_and(|s| {
                s.lines.iter().any(|(stream, text, _)| {
                    stream == "secret-held" && text.contains('🔒') && text.contains(what)
                })
            })
        };
        match step {
            Step::Mint => v.state == Some(State::Done),
            Step::Create => v.facts.iter().any(|(k, _)| k == "sandbox_uid"),
            Step::Seal => sealed_held("kubernetes"),
            Step::Run => v
                .phases
                .iter()
                .any(|(st, title, _, _)| st == "done" && title == "Claim identity registered"),
            Step::Logs => sealed_held("Workload output"),
            Step::Exit => false,
        }
    }

    /// The form the prompt asks for.
    fn form_mut(&mut self) -> Option<&mut Form> {
        match self.prompt {
            Prompt::Issuer => Some(&mut self.login_form),
            Prompt::Workload => Some(&mut self.claim_form),
            Prompt::Nothing => None,
        }
    }

    /// Do what a form asked; true to quit.
    fn act(&mut self, act: Action) -> bool {
        let running = self.run.as_ref().is_some_and(|r| !r.finished());
        match act {
            Action::None => {}
            Action::Submit => match self.prompt {
                Prompt::Issuer if !running => self.start_login(),
                Prompt::Workload => self.submit_workload(),
                _ => {}
            },
            Action::CancelRun => {
                self.release_run();
                self.editing = false;
            }
            Action::Quit => {
                if let Some(r) = &self.run {
                    r.cancel();
                }
                return true;
            }
            Action::Leave => self.editing = false,
        }
        false
    }

    /// What the input line should ask for now.
    fn want_prompt(&self) -> Prompt {
        match &self.run {
            None => Prompt::Issuer,
            Some(r) if r.finished() => Prompt::Issuer,
            Some(r) if r.waiting() => Prompt::Workload,
            Some(_) => Prompt::Nothing,
        }
    }

    fn pull(&mut self) {
        let Some(run) = self.run.clone() else { return };
        let (evs, _, _) = run.since(self.cursor);
        self.cursor += evs.len();
        for e in evs {
            self.apply(e);
        }
        let want = self.want_prompt();
        if want != self.prompt {
            self.prompt = want;
            match want {
                // A finished run: the results stay in view until `n` starts a new login.
                Prompt::Issuer => {
                    self.editing = false;
                }
                Prompt::Workload => {
                    self.claim_form.focus = 0;
                    self.editing = true;
                    self.selected = Step::Create;
                }
                Prompt::Nothing => self.editing = false,
            }
        }
    }

    fn apply(&mut self, e: Event) {
        let at: Option<jiff::Timestamp> = e.at.parse().ok();
        if let Body::Finished { ok, note } = &e.body {
            self.finished = Some((*ok, note.clone()));
            return;
        }
        let st = self.stages.entry(e.step).or_default();
        match e.body {
            Body::State { state, note } => {
                if state == State::Active {
                    st.started = at;
                    if self.follow {
                        self.selected = e.step;
                    }
                } else {
                    st.ended = at;
                }
                st.state = Some(state);
                if note.is_some() {
                    st.note = note;
                }
            }
            Body::Line { stream, text, ts } => {
                st.lines.push((stream.to_owned(), text, ts));
            }
            Body::Data { data } => Self::absorb(st, e.step, &data, at),
            Body::Finished { .. } => {}
        }
    }

    /// Fold a data event into the stage's facts (and, for the sandbox, its timeline).
    fn absorb(st: &mut StageView, step: Step, data: &Value, at: Option<jiff::Timestamp>) {
        let clock = at
            .map(|t| t.strftime("%H:%M:%S").to_string())
            .unwrap_or_default();
        if step == Step::Run
            && let Some(p) = data.get("pool")
        {
            st.fact("pool", pool_line(p));
            return;
        }
        if step == Step::Run && data.get("stall").is_some() {
            st.stall = data.get("stall").filter(|v| !v.is_null()).map(|v| {
                (
                    str_at(v, "/title").to_owned(),
                    str_at(v, "/since").to_owned(),
                    str_at(v, "/hint").to_owned(),
                )
            });
            return;
        }
        if step == Step::Run
            && let Some(Value::Array(ps)) = data.get("phases")
        {
            st.phases = ps
                .iter()
                .map(|p| {
                    let at = str_at(p, "/at")
                        .parse::<jiff::Timestamp>()
                        .map(|t| t.strftime("%H:%M:%S").to_string())
                        .unwrap_or_default();
                    let how = str_at(p, "/how");
                    let detail = if how == "observed" || str_at(p, "/state") == "pending" {
                        str_at(p, "/detail").to_owned()
                    } else {
                        format!("{} [{how}]", str_at(p, "/detail"))
                    };
                    (
                        str_at(p, "/state").to_owned(),
                        str_at(p, "/title").to_owned(),
                        at,
                        detail,
                    )
                })
                .collect();
            return;
        }
        if step == Step::Run {
            if let Some(obj) = data.get("object") {
                for (k, p) in [
                    ("name", "/metadata/name"),
                    ("namespace", "/metadata/namespace"),
                    ("uid", "/metadata/uid"),
                    ("created", "/metadata/creationTimestamp"),
                    ("phase", "/status/phase"),
                    ("claim", "/status/claimRef/name"),
                    ("claim uid", "/status/claimUid"),
                    ("vm", "/status/virtualMachineRef/name"),
                    ("pool", "/status/poolRef/name"),
                    ("bound at", "/status/boundAt"),
                    ("expires at", "/status/expiresAt"),
                    ("node", "/status/record/nodeId"),
                    ("image digest", "/status/record/report/image_digest"),
                    ("reason", "/status/reason"),
                ] {
                    let v = str_at(obj, p);
                    if !v.is_empty() {
                        st.fact(k, v.to_owned());
                    }
                }
                if let Some(a) = obj.pointer("/status/addresses") {
                    st.fact("addresses", text_of(a));
                }
                for k in ["entrySet", "ready"] {
                    if let Some(v) = obj.pointer(&format!("/status/{k}")) {
                        st.fact(k, v.to_string());
                    }
                }
                if let Some(Value::Array(changes)) = data.get("changes") {
                    for c in changes {
                        let path = str_at(c, "/path");
                        if path.starts_with("status.") || path.starts_with("metadata.deletion") {
                            let (from, to) = (str_at(c, "/from"), str_at(c, "/to"));
                            let text = if from.is_empty() {
                                format!("{path} = {to}")
                            } else {
                                format!("{path}: {from} → {to}")
                            };
                            st.lines.push(("change".into(), text, Some(clock.clone())));
                        }
                    }
                }
            } else if let Some(ev) = data.get("event") {
                let text = format!(
                    "{} {}: {}",
                    str_at(ev, "/object"),
                    str_at(ev, "/reason"),
                    str_at(ev, "/message")
                );
                st.lines.push(("event".into(), text, Some(clock)));
            }
            return;
        }
        if step == Step::Seal {
            // Rebuilt on every change: the map is a snapshot, not a log.
            st.lines.retain(|(stream, _, _)| stream == "note");
            st.facts.clear();
            if let Some(ns) = data.get("brokerNamespace").and_then(Value::as_str) {
                st.fact("broker namespace", ns.to_owned());
            }
            let place_name = |p: &str| match p {
                "laptop" => "your machine",
                "kube" => "kubernetes",
                "broker" => "broker",
                "vm" => "sandbox VM",
                "gateway" => "gateways",
                _ => "?",
            };
            for x in data
                .get("secrets")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let presence = str_at(x, "/presence");
                let lock = if x.get("sealed").and_then(Value::as_bool) == Some(true) {
                    "🔒"
                } else {
                    ""
                };
                let ram = if x.get("memory").and_then(Value::as_bool) == Some(true) {
                    " [RAM]"
                } else {
                    ""
                };
                st.lines.push((
                    format!("secret-{presence}"),
                    format!(
                        "{:<12} {}{lock}{ram}  {}  ({presence})",
                        place_name(str_at(x, "/place")),
                        str_at(x, "/name"),
                        str_at(x, "/where"),
                    ),
                    None,
                ));
            }
            let vm_line = |kind: &str, v: &Value| {
                format!(
                    "{kind} {}  {}  ready {}  {}  {}",
                    str_at(v, "/name"),
                    str_at(v, "/power"),
                    str_at(v, "/ready"),
                    str_at(v, "/failureDomain"),
                    text_of(v.get("addresses").unwrap_or(&Value::Null)),
                )
            };
            if let Some(v) = data.get("memberVm").filter(|v| !v.is_null()) {
                st.lines.push(("vm".into(), vm_line("sandbox VM", v), None));
            }
            for g in data
                .get("gateways")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                st.lines.push(("vm".into(), vm_line("gateway   ", g), None));
            }
            return;
        }
        if let Value::Object(m) = data {
            // Mint and Create send sections ({"session": {...}}); their fields are the facts.
            for (k, v) in m {
                let fields: Vec<(&String, &Value)> = match v {
                    Value::Object(inner) => inner.iter().collect(),
                    _ => vec![(k, v)],
                };
                for (k, v) in fields {
                    if matches!(k.as_str(), "claimNames" | "fingerprint" | "waiting") {
                        continue;
                    }
                    if k == "command" {
                        st.command = v.as_str().map(ToOwned::to_owned);
                        continue;
                    }
                    let text = text_of(v);
                    if text.is_empty() {
                        st.facts.retain(|(key, _)| key != k);
                    } else {
                        st.fact(k, text);
                    }
                }
            }
        }
    }

    fn state_of(&self, s: Step) -> State {
        self.stages
            .get(&s)
            .and_then(|v| v.state)
            .unwrap_or(State::Pending)
    }

    fn main_loop(mut self, terminal: &mut DefaultTerminal) -> anyhow::Result<()> {
        loop {
            self.pull();
            terminal.draw(|f| self.draw(f))?;
            if !event::poll(Duration::from_millis(80))? {
                continue;
            }
            let ev = event::read()?;
            if let TermEvent::Mouse(m) = ev {
                if m.kind == MouseEventKind::Down(MouseButton::Left)
                    && self.prompt != Prompt::Nothing
                {
                    let hit = self
                        .hits
                        .borrow()
                        .iter()
                        .find(|h| h.y == m.row && (h.x0..h.x1).contains(&m.column))
                        .copied();
                    if let Some(h) = hit {
                        self.editing = true;
                        let act = self.form_mut().map_or(Action::None, |f| f.click(h.item));
                        if self.act(act) {
                            return Ok(());
                        }
                    }
                }
                continue;
            }
            let TermEvent::Key(k) = ev else {
                continue;
            };
            if k.kind != KeyEventKind::Press {
                continue;
            }
            if k.code == KeyCode::Char('c') && k.modifiers.contains(KeyModifiers::CONTROL) {
                if let Some(r) = &self.run {
                    r.cancel();
                }
                return Ok(());
            }
            if self.editing && self.prompt != Prompt::Nothing {
                let act = self.form_mut().map_or(Action::None, |f| f.key(k));
                if self.act(act) {
                    return Ok(());
                }
                continue;
            }
            match k.code {
                KeyCode::Char('q') => {
                    if let Some(r) = &self.run {
                        r.cancel();
                    }
                    return Ok(());
                }
                KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => {
                    if let Some(r) = &self.run {
                        r.cancel();
                    }
                    return Ok(());
                }
                KeyCode::Char('c') => self.release_run(),
                KeyCode::Char('e' | 'n') | KeyCode::Enter if self.prompt != Prompt::Nothing => {
                    self.editing = true;
                    self.follow = true;
                    self.selected = if self.prompt == Prompt::Issuer {
                        Step::Mint
                    } else {
                        Step::Create
                    };
                }
                KeyCode::Char('d') => {
                    if let Some(r) = self.run.clone() {
                        let msg = self.message.clone();
                        self.rt.spawn(async move {
                            let m = match r.delete_sandbox().await {
                                Ok(()) => "sandbox deleted".to_owned(),
                                Err(e) => format!("delete: {e:#}"),
                            };
                            *msg.lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(m);
                        });
                    }
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.follow = false;
                    self.selected = Step::ALL[self.selected.index().saturating_sub(1)];
                    self.log_scroll = 0;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    self.follow = false;
                    self.selected = Step::ALL[(self.selected.index() + 1).min(Step::ALL.len() - 1)];
                    self.log_scroll = 0;
                }
                KeyCode::PageUp => self.log_scroll = self.log_scroll.saturating_add(10),
                KeyCode::PageDown => self.log_scroll = self.log_scroll.saturating_sub(10),
                KeyCode::Char('f') => self.follow = true,
                _ => {}
            }
        }
    }

    fn draw(&self, f: &mut ratatui::Frame) {
        let [top, body, foot] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(10),
            Constraint::Length(1),
        ])
        .areas(f.area());
        self.draw_input(f, top);
        let [left, right] =
            Layout::horizontal([Constraint::Length(36), Constraint::Min(30)]).areas(body);
        self.draw_pipeline(f, left);
        self.draw_detail(f, right);
        self.draw_footer(f, foot);
    }

    fn draw_input(&self, f: &mut ratatui::Frame, area: Rect) {
        let line = Line::from(vec![
            " Low Tide ".bold().fg(Color::Black).bg(Color::Cyan),
            Span::raw(" "),
            match self.prompt {
                Prompt::Issuer => "mediatore login: fill the form, then [ Log in ]".fg(Color::Gray),
                Prompt::Workload => {
                    "mediatore sandbox create: fill the form, then [ Run ]".fg(Color::Gray)
                }
                Prompt::Nothing => "running".fg(Color::Gray),
            },
        ]);
        f.render_widget(Paragraph::new(line), area);
    }

    fn color(state: State) -> Color {
        match state {
            State::Pending => DIM,
            State::Active => Color::Cyan,
            State::Done => GOOD,
            State::Skipped => Color::Yellow,
            State::Failed => Color::Red,
        }
    }

    fn icon(&self, state: State) -> &'static str {
        const SPIN: [&str; 4] = ["◐", "◓", "◑", "◒"];
        match state {
            State::Pending => "○",
            State::Active => SPIN[(self.started.elapsed().as_millis() / 150) as usize % 4],
            State::Done => "●",
            State::Skipped => "◌",
            State::Failed => "✕",
        }
    }

    fn duration(&self, s: Step) -> String {
        let Some(v) = self.stages.get(&s) else {
            return String::new();
        };
        let Some(start) = v.started else {
            return String::new();
        };
        let end = v.ended.unwrap_or_else(jiff::Timestamp::now);
        let d = end.duration_since(start);
        let secs = d.as_secs_f64();
        if secs < 0.05 {
            String::new()
        } else if secs < 60.0 {
            format!("{secs:.1}s")
        } else {
            format!("{}m{:02}s", d.as_secs() / 60, d.as_secs() % 60)
        }
    }

    fn draw_pipeline(&self, f: &mut ratatui::Frame, area: Rect) {
        let n = u16::try_from(Step::ALL.len()).unwrap_or(8);
        let tall = area.height >= n * 3 + (n - 1);
        let box_h = if tall { 3 } else { 1 };
        let mut constraints = Vec::new();
        for i in 0..n {
            constraints.push(Constraint::Length(box_h));
            if i + 1 < n {
                constraints.push(Constraint::Length(u16::from(tall)));
            }
        }
        constraints.push(Constraint::Min(0));
        let areas = Layout::vertical(constraints).split(area);
        let tick = self.started.elapsed().as_millis() / 120;
        for (i, step) in Step::ALL.iter().enumerate() {
            let state = self.state_of(*step);
            let color = Self::color(state);
            let selected = *step == self.selected;
            let note = self
                .stages
                .get(step)
                .and_then(|v| {
                    v.stall
                        .as_ref()
                        .map(|(title, _, _)| format!("⚠ stalled at {title}"))
                        .or_else(|| v.note.clone())
                })
                .unwrap_or_default();
            let title_style = if state == State::Pending {
                Style::new().fg(DIM)
            } else {
                Style::new().fg(color).add_modifier(Modifier::BOLD)
            };
            let header = Line::from(vec![
                Span::styled(format!("{} ", self.icon(state)), Style::new().fg(color)),
                Span::styled(step.title(), title_style),
                Span::raw(if self.locked(*step) { " 🔒" } else { "" }),
                Span::raw(" "),
                Span::styled(self.duration(*step), Style::new().fg(DIM)),
            ]);
            let area = areas[i * 2];
            if tall {
                let mut border = Style::new().fg(color);
                if state == State::Active && tick % 6 < 3 {
                    border = border.add_modifier(Modifier::BOLD);
                }
                let block = Block::bordered()
                    .border_type(if selected {
                        BorderType::Double
                    } else {
                        BorderType::Rounded
                    })
                    .border_style(border)
                    .title(header);
                f.render_widget(
                    Paragraph::new(Line::from(note).fg(Color::Gray)).block(block),
                    area,
                );
            } else {
                let mut line = header;
                if selected {
                    line = line.add_modifier(Modifier::REVERSED);
                }
                f.render_widget(Paragraph::new(line), area);
            }
            if tall && i + 1 < Step::ALL.len() {
                self.draw_link(f, areas[i * 2 + 1], *step, Step::ALL[i + 1], tick);
            }
        }
    }

    /// The connector between two boxes: dotted and faint until the run reaches it, a heavy
    /// dark line once it has passed, and a pulse travelling down while the next stage runs.
    fn draw_link(&self, f: &mut ratatui::Frame, area: Rect, from: Step, to: Step, tick: u128) {
        let (a, b) = (self.state_of(from), self.state_of(to));
        let x = area.x + 3;
        let cell = Rect::new(x, area.y, 3, 1);
        let span = match b {
            State::Failed => Span::styled("┃", Style::new().fg(Color::Red)),
            State::Active => {
                let frames = ["╽", "┃", "▼", "┃"];
                Span::styled(
                    frames[(tick % 4) as usize],
                    Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                )
            }
            // Passed: a heavy, dark line.
            State::Done | State::Skipped => Span::styled(
                "┃",
                Style::new()
                    .fg(Color::Rgb(40, 110, 70))
                    .add_modifier(Modifier::BOLD),
            ),
            // The stage above is done, the next not yet started: the link is being drawn.
            State::Pending if matches!(a, State::Done | State::Skipped) => Span::styled(
                if tick % 4 < 2 { "┃" } else { "╏" },
                Style::new().fg(Color::Cyan),
            ),
            State::Pending => Span::styled("┆", Style::new().fg(DIM)),
        };
        f.render_widget(Paragraph::new(Line::from(span)), cell);
    }

    fn draw_detail(&self, f: &mut ratatui::Frame, area: Rect) {
        let step = self.selected;
        let form = match (step, self.prompt) {
            (Step::Mint, Prompt::Issuer) => Some((&self.login_form, " mediatore login ")),
            (Step::Create, Prompt::Workload) => {
                Some((&self.claim_form, " mediatore sandbox create "))
            }
            _ => None,
        };
        self.hits.borrow_mut().clear();
        let area = if let Some((form, title)) = form {
            let blink = (self.started.elapsed().as_millis() / 500).is_multiple_of(2);
            let (lines, hits) = form.render(self.editing, area.width.saturating_sub(2), blink);
            let h = u16::try_from(lines.len()).unwrap_or(0) + 2;
            let [top, rest] =
                Layout::vertical([Constraint::Length(h.min(area.height)), Constraint::Min(0)])
                    .areas(area);
            let border = if self.editing { Color::Cyan } else { DIM };
            f.render_widget(
                Paragraph::new(Text::from(lines)).block(
                    Block::bordered()
                        .border_type(BorderType::Rounded)
                        .border_style(Style::new().fg(border))
                        .title(Line::from(title.bold().fg(border))),
                ),
                top,
            );
            self.hits.borrow_mut().extend(hits.into_iter().map(|h| Hit {
                y: top.y + 1 + h.y,
                x0: top.x + 1 + h.x0,
                x1: top.x + 1 + h.x1,
                item: h.item,
            }));
            rest
        } else {
            area
        };
        if area.height < 3 {
            return;
        }
        let state = self.state_of(step);
        let view = self.stages.get(&step);
        let mut title = vec![Span::styled(
            format!(
                " {}{} ",
                step.title(),
                if self.locked(step) { " 🔒" } else { "" }
            ),
            Style::new().fg(Self::color(state)).bold(),
        )];
        if !self.follow {
            title.push(Span::styled("(pinned; f follows) ", Style::new().fg(DIM)));
        }
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(Self::color(state)))
            .title(Line::from(title));

        let mut lines: Vec<Line> = Vec::new();
        // What the CLI would run: the preview while the form is open, then what ran.
        let preview = match (step, self.prompt) {
            (Step::Mint, Prompt::Issuer) => Some(self.login_form.login_preview().command()),
            (Step::Create, Prompt::Workload) => Some(self.claim_form.claim_preview().command()),
            _ => view.and_then(|v| v.command.clone()),
        };
        if let Some(cmd) = preview {
            lines.push(Line::from(vec![
                Span::styled("$ ", Style::new().fg(GOOD)),
                Span::raw(cmd),
            ]));
            lines.push(Line::raw(""));
        }
        if step == Step::Create
            && self.prompt == Prompt::Workload
            && self.claim_form.value("url").trim().is_empty()
        {
            lines.push(Line::from(
                "mediatore URL is empty: Run will be refused. Type it above, or set MEDIATORE_URL in ~/.config/low-tide/config.env.",
            ).fg(Color::Red).bold());
            lines.push(Line::raw(""));
        }
        if step == Step::Mint
            && self.prompt == Prompt::Issuer
            && self.login_form.value("issuer").trim().is_empty()
        {
            lines.push(Line::from(
                "The issuer is required: type it above, or set MEDIATORE_ISSUER in ~/.config/low-tide/config.env.",
            ).fg(Color::Yellow));
            lines.push(Line::raw(""));
        }
        if let Some((title, since, hint)) = view.and_then(|v| v.stall.clone()) {
            let secs = since
                .parse::<jiff::Timestamp>()
                .map(|t| jiff::Timestamp::now().duration_since(t).as_secs())
                .unwrap_or_default();
            lines.push(
                Line::from(format!(
                    "⚠ no progress for {}m{:02}s at \"{title}\"",
                    secs / 60,
                    secs % 60
                ))
                .fg(Color::Yellow)
                .bold(),
            );
            lines.push(Line::from(hint).fg(Color::Yellow));
            lines.push(Line::raw(""));
        }
        if let Some(v) = view {
            if let Some(n) = &v.note {
                lines.push(Line::from(n.clone()).fg(Self::color(state)).bold());
                lines.push(Line::raw(""));
            }
            if step == Step::Exit
                && let Some((_, code)) = v.facts.iter().find(|(k, _)| k == "code")
            {
                {
                    let good = code == "0";
                    lines.push(Line::from(vec![
                        Span::raw("  exit code  "),
                        Span::styled(
                            format!(" {code} "),
                            Style::new()
                                .fg(Color::Black)
                                .bg(if good { Color::Green } else { Color::Red })
                                .bold(),
                        ),
                    ]));
                    lines.push(Line::raw(""));
                }
            }
            // While the claim waits, the pool's reason goes on the step it explains.
            let waiting = v
                .facts
                .iter()
                .find(|(k, _)| k == "pool")
                .map(|(_, p)| p.clone());
            for (state, title, at, detail) in &v.phases {
                let detail = match (&waiting, state.as_str(), title.as_str()) {
                    (Some(p), "active", "VM bound") => p,
                    _ => detail,
                };
                let (mark, color) = match state.as_str() {
                    "done" => ("●", GOOD),
                    "active" => (self.icon(State::Active), Color::Cyan),
                    "failed" => ("✕", Color::Red),
                    _ => ("○", DIM),
                };
                lines.push(Line::from(vec![
                    Span::styled(format!(" {mark} "), Style::new().fg(color)),
                    Span::styled(
                        format!(
                            "{:<34}",
                            if state == "done" && PHASE_LOCKS.contains(&title.as_str()) {
                                format!("{title} 🔒")
                            } else {
                                title.clone()
                            }
                        ),
                        Style::new()
                            .fg(if state == "pending" { DIM } else { color })
                            .bold(),
                    ),
                    Span::styled(format!("{at:>8}  "), Style::new().fg(DIM)),
                    Span::styled(detail.clone(), Style::new().fg(Color::Gray)),
                ]));
            }
            if !v.phases.is_empty() {
                lines.push(Line::raw(""));
            }
            let width = v.facts.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
            for (k, val) in &v.facts {
                if step == Step::Mint && k == "groups" {
                    lines.push(Line::from(Span::styled(
                        format!("{k:>width$}"),
                        Style::new().fg(Color::Gray),
                    )));
                    for g in val.split(", ").filter(|g| !g.is_empty()) {
                        lines.push(Line::from(vec![
                            Span::raw(" ".repeat(width + 2)),
                            Span::styled(
                                format!(" {g} "),
                                Style::new().fg(Color::Black).bg(Color::Magenta),
                            ),
                        ]));
                    }
                    continue;
                }
                lines.push(Line::from(vec![
                    Span::styled(format!("{k:>width$}  "), Style::new().fg(Color::Gray)),
                    Span::raw(val.clone()),
                ]));
            }
            if !v.lines.is_empty() && !v.facts.is_empty() {
                lines.push(Line::raw(""));
            }
            for (stream, text, ts) in &v.lines {
                let ts = ts
                    .as_deref()
                    .map(|t| {
                        t.parse::<jiff::Timestamp>()
                            .map_or_else(|_| t.to_owned(), |x| x.strftime("%H:%M:%S").to_string())
                    })
                    .unwrap_or_default();
                let style = match stream.as_str() {
                    "stderr" => Style::new().fg(Color::Yellow),
                    "note" => Style::new().fg(DIM).italic(),
                    "event" => Style::new().fg(Color::Magenta),
                    "change" => Style::new().fg(Color::Cyan),
                    "secret-held" => Style::new().fg(Color::Red).bold(),
                    "secret-possible" => Style::new().fg(Color::Red).italic(),
                    "secret-pending" => Style::new().fg(Color::Rgb(120, 60, 60)),
                    "secret-gone" => Style::new().fg(DIM).crossed_out(),
                    "vm" => Style::new().fg(Color::LightMagenta),
                    _ => Style::new(),
                };
                lines.push(Line::from(vec![
                    Span::styled(format!("{ts:>8} "), Style::new().fg(DIM)),
                    Span::styled(text.clone(), style),
                ]));
            }
        } else {
            lines.push(Line::from("not reached yet").fg(DIM));
        }
        // Keep the newest lines in view unless scrolled back.
        let inner_h = area.height.saturating_sub(2);
        let total = u16::try_from(lines.len()).unwrap_or(u16::MAX);
        let scroll = total
            .saturating_sub(inner_h)
            .saturating_sub(self.log_scroll);
        f.render_widget(
            Paragraph::new(Text::from(lines))
                .block(block)
                .wrap(Wrap { trim: false })
                .scroll((scroll, 0)),
            area,
        );
    }

    fn draw_footer(&self, f: &mut ratatui::Frame, area: Rect) {
        let msg = self
            .message
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let line = if let Some(m) = msg {
            Line::from(m).fg(Color::Yellow)
        } else if let Some((ok, note)) = &self.finished {
            Line::from(vec![
                Span::styled(
                    if *ok { " finished " } else { " stopped " },
                    Style::new()
                        .fg(Color::Black)
                        .bg(if *ok { Color::Green } else { Color::Red }),
                ),
                Span::raw(format!(" {note}   ")),
                "n new login · d delete sandbox · ↑↓ stage · q quit".fg(DIM),
            ])
        } else if self.editing {
            Line::from(
                "tab/↑↓ field · ←→ edit or choose · space toggle · enter next or press · ctrl-s submit · click buttons · esc leave",
            )
            .fg(DIM)
        } else {
            Line::from(
                "↑↓ stage · f follow · pgup/pgdn scroll · c cancel (releases the claim) · e form · q quit",
            )
            .fg(DIM)
        };
        f.render_widget(Paragraph::new(line), area);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::crossterm::event::KeyEvent;

    fn screen(ui: &Ui, w: u16, h: u16) -> String {
        let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
        t.draw(|f| ui.draw(f)).unwrap();
        let buf = t.backend().buffer().clone();
        (0..h)
            .map(|y| (0..w).map(|x| buf[(x, y)].symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn ui(login: LoginSettings, claim: ClaimSettings) -> (tokio::runtime::Runtime, Ui) {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let ui = Ui::new(
            login,
            claim,
            KubeTarget::default(),
            rt.handle().clone(),
            false,
        );
        (rt, ui)
    }

    fn press(ui: &mut Ui, code: KeyCode) {
        let act = ui.form_mut().map_or(Action::None, |f| {
            f.key(KeyEvent::new(code, KeyModifiers::NONE))
        });
        ui.act(act);
    }

    #[test]
    fn every_stage_is_drawn_and_the_login_form_comes_first() {
        let login = LoginSettings {
            issuer: "https://dex.example.com".into(),
            ..LoginSettings::default()
        };
        let (_rt, ui) = ui(login, ClaimSettings::default());
        let s = screen(&ui, 150, 44);
        for step in Step::ALL {
            assert!(s.contains(step.title()), "{} missing:\n{s}", step.title());
        }
        for label in [
            "Issuer *",
            "Client id",
            "Scopes",
            "Auth params",
            "Login hint",
            "Client secret file",
            "Redirect ports",
            "--no-browser",
            "[ Log in ]",
            "[ Quit ]",
        ] {
            assert!(s.contains(label), "{label} missing:\n{s}");
        }
        assert!(
            s.contains("$ mediatore login --issuer https://dex.example.com"),
            "{s}"
        );
    }

    #[test]
    fn the_create_form_has_every_option_and_edits_the_workload_in_place() {
        let claim = ClaimSettings {
            workload: "registry.internal:5000/python python3 -c pass".into(),
            restart: "never".into(),
            ..ClaimSettings::default()
        };
        let (_rt, mut ui) = ui(LoginSettings::default(), claim.clone());
        ui.claim_form = Form::claim(&claim);
        ui.prompt = Prompt::Workload;
        ui.editing = true;
        ui.selected = Step::Create;
        let s = screen(&ui, 170, 48);
        for label in [
            "Workload *",
            "mediatore URL *",
            "Namespace",
            "Pool selector",
            "Strategy",
            "TTL (s)",
            "Restart",
            "Audiences",
            "Delegate",
            "Policy",
            "--logs",
            "[ Run ]",
            "[ Cancel run ]",
        ] {
            assert!(s.contains(label), "{label} missing:\n{s}");
        }
        assert!(s.contains("mediatore URL is empty"), "{s}");
        // Into the middle of the workload: after "python3", before " -c pass".
        press(&mut ui, KeyCode::End);
        for _ in 0..8 {
            press(&mut ui, KeyCode::Left);
        }
        for c in " -u".chars() {
            press(&mut ui, KeyCode::Char(c));
        }
        assert_eq!(
            ui.claim_form.value("workload"),
            "registry.internal:5000/python python3 -u -c pass"
        );
        let s = screen(&ui, 170, 48);
        assert!(s.contains("--arg=python3 --arg=-u"), "{s}");
    }

    #[test]
    fn the_buttons_are_where_a_click_finds_them() {
        let login = LoginSettings {
            issuer: "https://dex.example.com".into(),
            ..LoginSettings::default()
        };
        let (_rt, ui) = ui(login, ClaimSettings::default());
        let s = screen(&ui, 150, 44);
        let rows: Vec<&str> = s.lines().collect();
        let hit = ui
            .hits
            .borrow()
            .iter()
            .find(|h| h.item == ui.login_form.fields.len())
            .copied()
            .unwrap();
        let row: String = rows[usize::from(hit.y)]
            .chars()
            .skip(usize::from(hit.x0))
            .take(usize::from(hit.x1 - hit.x0))
            .collect();
        assert_eq!(row, "[ Log in ]");
    }

    #[test]
    fn a_lock_appears_once_the_login_is_authorized() {
        let (_rt, mut ui) = ui(LoginSettings::default(), ClaimSettings::default());
        assert!(!ui.locked(Step::Mint), "no lock before it happens");
        ui.apply(Event {
            seq: 0,
            at: jiff::Timestamp::now().to_string(),
            step: Step::Mint,
            body: Body::State {
                state: State::Done,
                note: Some("octocat".into()),
            },
        });
        assert!(ui.locked(Step::Mint));
        let s = screen(&ui, 150, 44);
        assert!(s.contains("mediatore login 🔒"), "{s}");
        assert!(!ui.locked(Step::Seal), "nothing sealed yet");
    }
}
