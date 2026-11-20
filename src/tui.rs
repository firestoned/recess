// Copyright (c) 2026 Erick Bourgeois, Low Tide
// SPDX-License-Identifier: Apache-2.0

//! The terminal front end: the stages as a column of boxes, joined by connectors that fill in
//! and darken as the run passes through them; beside them, the selected stage's facts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{self, Event as TermEvent, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize as _};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Paragraph, Wrap};
use serde_json::Value;

use crate::engine::{Body, Event, KubeTarget, Run, Settings, State, Step};
use crate::util::{self, str_at};

pub async fn run(settings: Settings, kube: KubeTarget, demo: bool) -> anyhow::Result<()> {
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let mut terminal = ratatui::init();
        let result = Ui::new(settings, kube, handle, demo).main_loop(&mut terminal);
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

struct Ui {
    settings: Settings,
    kube: KubeTarget,
    rt: tokio::runtime::Handle,
    demo: bool,
    input: String,
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

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(text_of).collect::<Vec<_>>().join(", "),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

impl Ui {
    fn new(settings: Settings, kube: KubeTarget, rt: tokio::runtime::Handle, demo: bool) -> Self {
        Self {
            input: settings.workload.clone(),
            settings,
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

    fn start(&mut self) {
        if let Err(e) = util::split_workload(&self.input) {
            self.set_message(format!("workload: {e}"));
            return;
        }
        let mut s = self.settings.clone();
        s.workload.clone_from(&self.input);
        let run = Run::new();
        if self.demo {
            self.rt.spawn(crate::demo::run(run.clone(), s.workload));
        } else {
            self.rt.spawn(run.clone().execute(s, self.kube.clone()));
        }
        self.run = Some(run);
        self.cursor = 0;
        self.stages.clear();
        self.finished = None;
        self.editing = false;
        self.follow = true;
        self.log_scroll = 0;
        *self
            .message
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    fn pull(&mut self) {
        let Some(run) = self.run.clone() else { return };
        let (evs, _, _) = run.since(self.cursor);
        self.cursor += evs.len();
        for e in evs {
            self.apply(e);
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
                    if matches!(k.as_str(), "claimNames" | "fingerprint") {
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
            let TermEvent::Key(k) = event::read()? else {
                continue;
            };
            if k.kind != KeyEventKind::Press {
                continue;
            }
            let running = self.run.as_ref().is_some_and(|r| !r.finished());
            if self.editing {
                match k.code {
                    KeyCode::Esc if self.run.is_some() => self.editing = false,
                    KeyCode::Esc => return Ok(()),
                    KeyCode::Enter if !running => self.start(),
                    KeyCode::Backspace => {
                        self.input.pop();
                    }
                    KeyCode::Char('u') if k.modifiers.contains(KeyModifiers::CONTROL) => {
                        self.input.clear();
                    }
                    KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => {
                        return Ok(());
                    }
                    KeyCode::Char(c) => self.input.push(c),
                    _ => {}
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
                KeyCode::Char('c') => {
                    if let Some(r) = &self.run {
                        r.cancel();
                    }
                }
                KeyCode::Char('e' | 'n') if !running => self.editing = true,
                KeyCode::Enter if !running => self.start(),
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
            Constraint::Length(3),
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
        let border = if self.editing {
            Color::Cyan
        } else {
            Color::DarkGray
        };
        let title = Line::from(vec![
            " Low Tide ".bold().fg(Color::Black).bg(Color::Cyan),
            " workload: IMAGE [ARG...] ".fg(Color::Gray),
        ]);
        let mut spans = vec![Span::raw(self.input.clone())];
        if self.editing && (self.started.elapsed().as_millis() / 500).is_multiple_of(2) {
            spans.push("▏".fg(Color::Cyan));
        }
        let p = Paragraph::new(Line::from(spans)).block(
            Block::bordered()
                .border_type(BorderType::Rounded)
                .border_style(Style::new().fg(border))
                .title(title),
        );
        f.render_widget(p, area);
    }

    fn color(state: State) -> Color {
        match state {
            State::Pending => Color::DarkGray,
            State::Active => Color::Cyan,
            State::Done => Color::Green,
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
                .and_then(|v| v.note.clone())
                .unwrap_or_default();
            let title_style = if state == State::Pending {
                Style::new().fg(Color::DarkGray)
            } else {
                Style::new().fg(color).add_modifier(Modifier::BOLD)
            };
            let header = Line::from(vec![
                Span::styled(format!("{} ", self.icon(state)), Style::new().fg(color)),
                Span::styled(step.title(), title_style),
                Span::raw(" "),
                Span::styled(self.duration(*step), Style::new().fg(Color::DarkGray)),
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
            State::Pending => Span::styled("┆", Style::new().fg(Color::DarkGray)),
        };
        f.render_widget(Paragraph::new(Line::from(span)), cell);
    }

    fn draw_detail(&self, f: &mut ratatui::Frame, area: Rect) {
        let step = self.selected;
        let state = self.state_of(step);
        let view = self.stages.get(&step);
        let mut title = vec![Span::styled(
            format!(" {} ", step.title()),
            Style::new().fg(Self::color(state)).bold(),
        )];
        if !self.follow {
            title.push(Span::styled(
                "(pinned; f follows) ",
                Style::new().fg(Color::DarkGray),
            ));
        }
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(Self::color(state)))
            .title(Line::from(title));

        let mut lines: Vec<Line> = Vec::new();
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
            for (state, title, at, detail) in &v.phases {
                let (mark, color) = match state.as_str() {
                    "done" => ("●", Color::Green),
                    "active" => (self.icon(State::Active), Color::Cyan),
                    "failed" => ("✕", Color::Red),
                    _ => ("○", Color::DarkGray),
                };
                lines.push(Line::from(vec![
                    Span::styled(format!(" {mark} "), Style::new().fg(color)),
                    Span::styled(
                        format!("{title:<34}"),
                        Style::new()
                            .fg(if state == "pending" {
                                Color::DarkGray
                            } else {
                                color
                            })
                            .bold(),
                    ),
                    Span::styled(format!("{at:>8}  "), Style::new().fg(Color::DarkGray)),
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
                    "note" => Style::new().fg(Color::DarkGray).italic(),
                    "event" => Style::new().fg(Color::Magenta),
                    "change" => Style::new().fg(Color::Cyan),
                    "secret-held" => Style::new().fg(Color::Red).bold(),
                    "secret-possible" => Style::new().fg(Color::Red).italic(),
                    "secret-pending" => Style::new().fg(Color::Rgb(120, 60, 60)),
                    "secret-gone" => Style::new().fg(Color::DarkGray).crossed_out(),
                    "vm" => Style::new().fg(Color::LightMagenta),
                    _ => Style::new(),
                };
                lines.push(Line::from(vec![
                    Span::styled(format!("{ts:>8} "), Style::new().fg(Color::DarkGray)),
                    Span::styled(text.clone(), style),
                ]));
            }
        } else {
            lines.push(Line::from("not reached yet").fg(Color::DarkGray));
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
                "e/n new run · d delete sandbox · ↑↓ stage · q quit".fg(Color::DarkGray),
            ])
        } else if self.editing {
            Line::from("enter run · ctrl-u clear · esc back/quit").fg(Color::DarkGray)
        } else {
            Line::from(
                "↑↓ stage · f follow · pgup/pgdn scroll · c cancel · d delete sandbox · q quit",
            )
            .fg(Color::DarkGray)
        };
        f.render_widget(Paragraph::new(line), area);
    }
}
