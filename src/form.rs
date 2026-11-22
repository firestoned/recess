// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

//! The TUI's forms: `mediatore login` and `mediatore sandbox create`, every option the CLI
//! takes, with a cursor in each text field, checkboxes, choices and buttons. Keys: Tab, Down
//! or Up to move; Left, Right, Home, End, Backspace, Delete, Ctrl-U (clear), Ctrl-W (word) to
//! edit; Space toggles a checkbox; Left and Right cycle a choice; Enter moves to the next
//! field or presses a button; Ctrl-S submits from anywhere; Esc leaves the form.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::settings::{ClaimSettings, LoginSettings};

const STRATEGIES: &[&str] = &["", "longest-ready", "most-available", "spread"];
const RESTARTS: &[&str] = &["never", "on-failure", "always"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Bool,
    Choice(&'static [&'static str]),
}

#[derive(Debug, Clone)]
pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    pub required: bool,
    pub hint: &'static str,
    text: Vec<char>,
    cursor: usize,
    on: bool,
    choice: usize,
}

impl Field {
    fn text(key: &'static str, label: &'static str, value: &str, hint: &'static str) -> Self {
        let text: Vec<char> = value.chars().collect();
        Self {
            key,
            label,
            kind: Kind::Text,
            required: false,
            hint,
            cursor: text.len(),
            text,
            on: false,
            choice: 0,
        }
    }

    fn list(key: &'static str, label: &'static str, values: &[String], hint: &'static str) -> Self {
        Self::text(key, label, &values.join(", "), hint)
    }

    fn flag(key: &'static str, label: &'static str, on: bool) -> Self {
        Self {
            key,
            label,
            kind: Kind::Bool,
            required: false,
            hint: "",
            text: vec![],
            cursor: 0,
            on,
            choice: 0,
        }
    }

    fn choice(
        key: &'static str,
        label: &'static str,
        options: &'static [&'static str],
        value: &str,
    ) -> Self {
        let choice = options.iter().position(|o| *o == value).unwrap_or(0);
        Self {
            key,
            label,
            kind: Kind::Choice(options),
            required: false,
            hint: "",
            text: vec![],
            cursor: 0,
            on: false,
            choice,
        }
    }

    fn required(mut self) -> Self {
        self.required = true;
        self
    }

    #[must_use]
    pub fn value(&self) -> String {
        match self.kind {
            Kind::Text => self.text.iter().collect(),
            Kind::Bool => self.on.to_string(),
            Kind::Choice(o) => o[self.choice].to_owned(),
        }
    }
}

/// What a key or a click asks of the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    None,
    Submit,
    CancelRun,
    Quit,
    Leave,
}

#[derive(Debug, Clone)]
pub struct Button {
    pub label: &'static str,
    pub action: Action,
}

#[derive(Debug, Clone)]
pub struct Form {
    pub fields: Vec<Field>,
    pub buttons: Vec<Button>,
    /// Over the fields, then the buttons.
    pub focus: usize,
}

/// Where an item was drawn, for the mouse: row, columns, item index.
#[derive(Debug, Clone, Copy)]
pub struct Hit {
    pub y: u16,
    pub x0: u16,
    pub x1: u16,
    pub item: usize,
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

impl Form {
    /// `mediatore login`'s form, from the settings the flags, environment and config file gave.
    #[must_use]
    pub fn login(l: &LoginSettings) -> Self {
        let ports: Vec<String> = l.redirect_ports.iter().map(ToString::to_string).collect();
        Self {
            fields: vec![
                Field::text("issuer", "Issuer", &l.issuer, "https://dex.example.com").required(),
                Field::text("clientId", "Client id", &l.client_id, "mediatore"),
                Field::list(
                    "scopes",
                    "Scopes",
                    &l.scopes,
                    "openid, profile, email, groups, offline_access",
                ),
                Field::list(
                    "authParams",
                    "Auth params",
                    &l.auth_params,
                    "key=value, ...",
                ),
                Field::text("loginHint", "Login hint", &l.login_hint, ""),
                Field::text("caFile", "CA file (PEM)", &l.ca_file, "private PKI only"),
                Field::text(
                    "clientSecretFile",
                    "Client secret file",
                    &l.client_secret_file,
                    "",
                ),
                Field::list(
                    "redirectPorts",
                    "Redirect ports",
                    &ports,
                    "8000, 18000 (0: any)",
                ),
                Field::text(
                    "redirectHost",
                    "Redirect host",
                    &l.redirect_host,
                    "localhost",
                ),
                Field::text("redirectPath", "Redirect path", &l.redirect_path, ""),
                Field::flag("noBrowser", "--no-browser", l.no_browser),
                Field::flag("reuseSession", "Reuse a fresh session", l.reuse_session),
            ],
            buttons: vec![
                Button {
                    label: "Log in",
                    action: Action::Submit,
                },
                Button {
                    label: "Quit",
                    action: Action::Quit,
                },
            ],
            focus: 0,
        }
    }

    /// `mediatore sandbox create`'s form.
    #[must_use]
    pub fn claim(c: &ClaimSettings) -> Self {
        Self {
            fields: vec![
                Field::text("workload", "Workload", &c.workload, "IMAGE [ARG...]").required(),
                Field::text(
                    "url",
                    "mediatore URL",
                    &c.url,
                    "https://mediatore.example.com",
                )
                .required(),
                Field::text("caFile", "CA file (PEM)", &c.ca_file, "private PKI only"),
                Field::flag("allowPlainHttp", "--allow-plain-http", c.allow_plain_http),
                Field::text("namespace", "Namespace", &c.namespace, "broker default"),
                Field::text("pool", "Pool", &c.pool, "any pool in the namespace"),
                Field::list(
                    "poolSelector",
                    "Pool selector",
                    &c.pool_selector,
                    "key=value, ...",
                ),
                Field::choice("strategy", "Strategy", STRATEGIES, &c.strategy),
                Field::text(
                    "ttl",
                    "TTL (s)",
                    &if c.ttl == 0 {
                        "3600".to_owned()
                    } else {
                        c.ttl.to_string()
                    },
                    "3600",
                ),
                Field::choice(
                    "restart",
                    "Restart",
                    RESTARTS,
                    if c.restart.is_empty() {
                        "never"
                    } else {
                        &c.restart
                    },
                ),
                Field::list("audiences", "Audiences", &c.audiences, "comma separated"),
                Field::list(
                    "delegate",
                    "Delegate",
                    &c.delegate,
                    "audience=claude-code, ...",
                ),
                Field::text("policy", "Policy", &c.policy, ""),
                Field::flag("logs", "--logs (capture output)", c.logs),
            ],
            buttons: vec![
                Button {
                    label: "Run",
                    action: Action::Submit,
                },
                Button {
                    label: "Cancel run",
                    action: Action::CancelRun,
                },
            ],
            focus: 0,
        }
    }

    fn get(&self, key: &str) -> String {
        self.fields
            .iter()
            .find(|f| f.key == key)
            .map(Field::value)
            .unwrap_or_default()
    }

    fn on(&self, key: &str) -> bool {
        self.fields.iter().any(|f| f.key == key && f.on)
    }

    /// The login settings this form holds.
    ///
    /// # Errors
    /// No issuer, or a redirect port that is not a number.
    pub fn to_login(&self) -> anyhow::Result<LoginSettings> {
        let issuer = self.get("issuer").trim().to_owned();
        anyhow::ensure!(!issuer.is_empty(), "the issuer is required");
        let redirect_ports = split_list(&self.get("redirectPorts"))
            .iter()
            .map(|p| {
                p.parse::<u16>()
                    .map_err(|_| anyhow::anyhow!("redirect port {p:?} is not a port"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(LoginSettings {
            issuer,
            client_id: self.get("clientId").trim().to_owned(),
            scopes: split_list(&self.get("scopes")),
            auth_params: split_list(&self.get("authParams")),
            login_hint: self.get("loginHint").trim().to_owned(),
            ca_file: self.get("caFile").trim().to_owned(),
            client_secret_file: self.get("clientSecretFile").trim().to_owned(),
            redirect_ports,
            redirect_host: self.get("redirectHost").trim().to_owned(),
            redirect_path: self.get("redirectPath").trim().to_owned(),
            no_browser: self.on("noBrowser"),
            reuse_session: self.on("reuseSession"),
        })
    }

    /// The claim settings this form holds.
    ///
    /// # Errors
    /// A TTL that is not a number of seconds.
    pub fn to_claim(&self) -> anyhow::Result<ClaimSettings> {
        let ttl = self.get("ttl");
        let ttl = if ttl.trim().is_empty() {
            3600
        } else {
            ttl.trim()
                .parse::<u32>()
                .map_err(|_| anyhow::anyhow!("TTL {ttl:?} is not a number of seconds"))?
        };
        Ok(ClaimSettings {
            workload: self.get("workload").trim().to_owned(),
            url: self.get("url").trim().to_owned(),
            ca_file: self.get("caFile").trim().to_owned(),
            allow_plain_http: self.on("allowPlainHttp"),
            namespace: self.get("namespace").trim().to_owned(),
            pool: self.get("pool").trim().to_owned(),
            pool_selector: split_list(&self.get("poolSelector")),
            strategy: self.get("strategy"),
            ttl,
            audiences: split_list(&self.get("audiences")),
            delegate: split_list(&self.get("delegate")),
            policy: self.get("policy").trim().to_owned(),
            restart: self.get("restart"),
            logs: self.on("logs"),
        })
    }

    /// What the login form holds now, unchecked: for the live command preview.
    #[must_use]
    pub fn login_preview(&self) -> LoginSettings {
        LoginSettings {
            issuer: self.get("issuer").trim().to_owned(),
            client_id: self.get("clientId").trim().to_owned(),
            scopes: split_list(&self.get("scopes")),
            auth_params: split_list(&self.get("authParams")),
            login_hint: self.get("loginHint").trim().to_owned(),
            ca_file: self.get("caFile").trim().to_owned(),
            client_secret_file: self.get("clientSecretFile").trim().to_owned(),
            redirect_ports: split_list(&self.get("redirectPorts"))
                .iter()
                .filter_map(|p| p.parse().ok())
                .collect(),
            redirect_host: self.get("redirectHost").trim().to_owned(),
            redirect_path: self.get("redirectPath").trim().to_owned(),
            no_browser: self.on("noBrowser"),
            reuse_session: self.on("reuseSession"),
        }
    }

    /// What the create form holds now, unchecked: for the live command preview.
    #[must_use]
    pub fn claim_preview(&self) -> ClaimSettings {
        let mut c = self.to_claim().unwrap_or_else(|_| ClaimSettings {
            workload: self.get("workload"),
            url: self.get("url"),
            ..ClaimSettings::default()
        });
        if c.ttl == 0 {
            c.ttl = 3600;
        }
        c
    }

    /// The value of a field, by key.
    #[must_use]
    pub fn value(&self, key: &str) -> String {
        self.get(key)
    }

    fn items(&self) -> usize {
        self.fields.len() + self.buttons.len()
    }

    pub fn next(&mut self) {
        self.focus = (self.focus + 1) % self.items();
    }

    pub fn prev(&mut self) {
        self.focus = (self.focus + self.items() - 1) % self.items();
    }

    /// Focus an item (a click), and press it when it is a button or a checkbox.
    pub fn click(&mut self, item: usize) -> Action {
        self.focus = item.min(self.items() - 1);
        if let Some(b) = self
            .focus
            .checked_sub(self.fields.len())
            .and_then(|i| self.buttons.get(i))
        {
            return b.action;
        }
        if let Some(f) = self.fields.get_mut(self.focus)
            && f.kind == Kind::Bool
        {
            f.on = !f.on;
        }
        Action::None
    }

    /// Handle one key.
    pub fn key(&mut self, k: KeyEvent) -> Action {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match k.code {
            KeyCode::Char('s') if ctrl => return Action::Submit,
            KeyCode::Esc => return Action::Leave,
            KeyCode::Tab | KeyCode::Down => {
                self.next();
                return Action::None;
            }
            KeyCode::BackTab | KeyCode::Up => {
                self.prev();
                return Action::None;
            }
            _ => {}
        }
        if self.focus >= self.fields.len() {
            let b = &self.buttons[self.focus - self.fields.len()];
            return match k.code {
                KeyCode::Enter | KeyCode::Char(' ') => b.action,
                KeyCode::Left => {
                    self.prev();
                    Action::None
                }
                KeyCode::Right => {
                    self.next();
                    Action::None
                }
                _ => Action::None,
            };
        }
        if k.code == KeyCode::Enter {
            self.next();
            return Action::None;
        }
        let f = &mut self.fields[self.focus];
        match f.kind {
            Kind::Bool => {
                if matches!(k.code, KeyCode::Char(' ' | 'x')) {
                    f.on = !f.on;
                }
            }
            Kind::Choice(o) => match k.code {
                KeyCode::Left => f.choice = (f.choice + o.len() - 1) % o.len(),
                KeyCode::Right | KeyCode::Char(' ') => f.choice = (f.choice + 1) % o.len(),
                _ => {}
            },
            Kind::Text => edit(f, k, ctrl),
        }
        Action::None
    }

    /// The form as lines, and where each item landed (relative row, columns) for the mouse.
    #[must_use]
    pub fn render(&self, active: bool, width: u16, blink: bool) -> (Vec<Line<'static>>, Vec<Hit>) {
        let label_w = self
            .fields
            .iter()
            .map(|f| f.label.len() + usize::from(f.required) * 2)
            .max()
            .unwrap_or(0)
            + 2;
        let value_w = usize::from(width).saturating_sub(label_w + 4).max(10);
        let mut lines = Vec::new();
        let mut hits = Vec::new();
        for (i, f) in self.fields.iter().enumerate() {
            let focused = active && self.focus == i;
            let label = if f.required {
                format!("{} *", f.label)
            } else {
                f.label.to_owned()
            };
            let mut spans = vec![Span::styled(
                format!("{label:>w$}  ", w = label_w - 2),
                if focused {
                    Style::new().fg(Color::Cyan).bold()
                } else {
                    Style::new().fg(crate::tui::DIM)
                },
            )];
            match f.kind {
                Kind::Bool => spans.push(Span::styled(
                    if f.on { "[x]" } else { "[ ]" },
                    if focused {
                        Style::new().fg(Color::Black).bg(Color::Cyan)
                    } else {
                        Style::new()
                    },
                )),
                Kind::Choice(o) => {
                    let v = if o[f.choice].is_empty() {
                        "(default)"
                    } else {
                        o[f.choice]
                    };
                    spans.push(Span::styled(
                        format!("◀ {v} ▶"),
                        if focused {
                            Style::new().fg(Color::Black).bg(Color::Cyan)
                        } else {
                            Style::new()
                        },
                    ));
                }
                Kind::Text => spans.extend(text_spans(f, focused, value_w, blink)),
            }
            hits.push(Hit {
                y: u16::try_from(i).unwrap_or(0),
                x0: 0,
                x1: width,
                item: i,
            });
            lines.push(Line::from(spans));
        }
        lines.push(Line::raw(""));
        let mut row = vec![Span::raw(" ".repeat(label_w))];
        let mut x = u16::try_from(label_w).unwrap_or(0);
        let y = u16::try_from(lines.len()).unwrap_or(0);
        for (j, b) in self.buttons.iter().enumerate() {
            let item = self.fields.len() + j;
            let text = format!("[ {} ]", b.label);
            let w = u16::try_from(text.chars().count()).unwrap_or(0);
            let style = if active && self.focus == item {
                Style::new()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else if b.action == Action::Submit {
                Style::new().fg(Color::Cyan).bold()
            } else {
                Style::new().fg(crate::tui::DIM)
            };
            row.push(Span::styled(text, style));
            row.push(Span::raw("  "));
            hits.push(Hit {
                y,
                x0: x,
                x1: x + w,
                item,
            });
            x += w + 2;
        }
        lines.push(Line::from(row));
        (lines, hits)
    }
}

/// The visible window of a text field, scrolled so the cursor shows, the cursor drawn.
fn text_spans(f: &Field, focused: bool, width: usize, blink: bool) -> Vec<Span<'static>> {
    if f.text.is_empty() && !focused {
        return vec![Span::styled(
            f.hint.to_owned(),
            Style::new().fg(crate::tui::DIM).italic(),
        )];
    }
    let start = if f.cursor >= width {
        f.cursor + 1 - width
    } else {
        0
    };
    let end = (start + width).min(f.text.len());
    let before: String = f.text[start..f.cursor.min(end).max(start)].iter().collect();
    if !focused {
        let s: String = f.text[start..end].iter().collect();
        let more = if end < f.text.len() { "…" } else { "" };
        return vec![Span::raw(format!("{s}{more}"))];
    }
    let at = f.text.get(f.cursor).copied();
    let after: String = if f.cursor < end {
        f.text[f.cursor + 1..end].iter().collect()
    } else {
        String::new()
    };
    let cursor_style = if blink {
        Style::new().fg(Color::Black).bg(Color::Cyan)
    } else {
        Style::new().add_modifier(Modifier::UNDERLINED)
    };
    vec![
        Span::styled(before, Style::new().fg(Color::White)),
        Span::styled(
            at.map_or_else(|| " ".to_owned(), String::from),
            cursor_style,
        ),
        Span::styled(after, Style::new().fg(Color::White)),
    ]
}

fn edit(f: &mut Field, k: KeyEvent, ctrl: bool) {
    match k.code {
        KeyCode::Left => f.cursor = f.cursor.saturating_sub(1),
        KeyCode::Right => f.cursor = (f.cursor + 1).min(f.text.len()),
        KeyCode::Home => f.cursor = 0,
        KeyCode::End => f.cursor = f.text.len(),
        KeyCode::Char('a') if ctrl => f.cursor = 0,
        KeyCode::Char('e') if ctrl => f.cursor = f.text.len(),
        KeyCode::Char('u') if ctrl => {
            f.text.clear();
            f.cursor = 0;
        }
        KeyCode::Char('w') if ctrl => {
            let mut i = f.cursor;
            while i > 0 && f.text[i - 1] == ' ' {
                i -= 1;
            }
            while i > 0 && f.text[i - 1] != ' ' {
                i -= 1;
            }
            f.text.drain(i..f.cursor);
            f.cursor = i;
        }
        KeyCode::Backspace if f.cursor > 0 => {
            f.text.remove(f.cursor - 1);
            f.cursor -= 1;
        }
        KeyCode::Delete if f.cursor < f.text.len() => {
            f.text.remove(f.cursor);
        }
        KeyCode::Char(c) if !ctrl => {
            f.text.insert(f.cursor, c);
            f.cursor += 1;
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    fn typed(form: &mut Form, s: &str) {
        for c in s.chars() {
            form.key(key(KeyCode::Char(c)));
        }
    }

    #[test]
    fn the_workload_is_edited_in_the_middle_not_only_at_the_end() {
        let mut f = Form::claim(&ClaimSettings {
            workload: "img python3 -c pass".into(),
            ..ClaimSettings::default()
        });
        f.key(key(KeyCode::Home));
        for _ in 0..3 {
            f.key(key(KeyCode::Right));
        }
        typed(&mut f, ":3.13");
        f.key(key(KeyCode::End));
        f.key(key(KeyCode::Backspace));
        f.key(key(KeyCode::Backspace));
        f.key(key(KeyCode::Backspace));
        f.key(key(KeyCode::Backspace));
        typed(&mut f, "print(1)");
        assert_eq!(
            f.to_claim().unwrap().workload,
            "img:3.13 python3 -c print(1)"
        );
        f.key(ctrl('w'));
        assert_eq!(f.get("workload"), "img:3.13 python3 -c ");
        f.key(ctrl('u'));
        assert_eq!(f.get("workload"), "");
    }

    #[test]
    fn every_create_option_is_on_the_form() {
        let mut f = Form::claim(&ClaimSettings::default());
        let set = |f: &mut Form, k: &str, v: &str| {
            let i = f.fields.iter().position(|x| x.key == k).unwrap();
            f.focus = i;
            f.key(ctrl('u'));
            typed(f, v);
        };
        set(&mut f, "workload", "img echo hi");
        set(&mut f, "url", "https://mediatore.example.com");
        set(&mut f, "namespace", "sandboxes");
        set(&mut f, "pool", "pool-a");
        set(&mut f, "poolSelector", "tier=a, zone=b");
        set(&mut f, "ttl", "600");
        set(&mut f, "audiences", "anthropic, github");
        set(&mut f, "delegate", "anthropic=claude-code");
        set(&mut f, "policy", "default");
        let strat = f.fields.iter().position(|x| x.key == "strategy").unwrap();
        f.focus = strat;
        f.key(key(KeyCode::Right));
        f.key(key(KeyCode::Right));
        let restart = f.fields.iter().position(|x| x.key == "restart").unwrap();
        f.focus = restart;
        f.key(key(KeyCode::Left));
        let logs = f.fields.iter().position(|x| x.key == "logs").unwrap();
        f.focus = logs;
        f.key(key(KeyCode::Char(' ')));
        let c = f.to_claim().unwrap();
        assert_eq!(
            c,
            ClaimSettings {
                workload: "img echo hi".into(),
                url: "https://mediatore.example.com".into(),
                namespace: "sandboxes".into(),
                pool: "pool-a".into(),
                pool_selector: vec!["tier=a".into(), "zone=b".into()],
                strategy: "most-available".into(),
                ttl: 600,
                audiences: vec!["anthropic".into(), "github".into()],
                delegate: vec!["anthropic=claude-code".into()],
                policy: "default".into(),
                restart: "always".into(),
                logs: true,
                ..ClaimSettings::default()
            }
        );
        set(&mut f, "ttl", "ten");
        assert!(f.to_claim().is_err());
    }

    #[test]
    fn buttons_are_pressed_by_enter_space_or_a_click() {
        let mut f = Form::login(&LoginSettings {
            issuer: "https://dex.example.com".into(),
            ..LoginSettings::default()
        });
        assert_eq!(
            f.key(ctrl('s')),
            Action::Submit,
            "Ctrl-S submits from any field"
        );
        f.focus = f.fields.len();
        assert_eq!(f.key(key(KeyCode::Enter)), Action::Submit);
        f.key(key(KeyCode::Right));
        assert_eq!(f.key(key(KeyCode::Char(' '))), Action::Quit);
        assert_eq!(f.click(f.fields.len()), Action::Submit);
        let reuse = f
            .fields
            .iter()
            .position(|x| x.key == "reuseSession")
            .unwrap();
        assert_eq!(f.click(reuse), Action::None);
        assert!(
            f.to_login().unwrap().reuse_session,
            "a click toggles a checkbox"
        );
        assert_eq!(f.key(key(KeyCode::Esc)), Action::Leave);
    }

    #[test]
    fn the_login_form_round_trips_every_option() {
        let l = LoginSettings {
            issuer: "https://dex.example.com".into(),
            client_id: "mediatore".into(),
            scopes: vec!["openid".into(), "groups".into()],
            auth_params: vec!["prompt=consent".into()],
            login_hint: "octocat".into(),
            ca_file: "/ca.pem".into(),
            client_secret_file: "/secret".into(),
            redirect_ports: vec![8000, 0],
            redirect_host: "localhost".into(),
            redirect_path: "/cb".into(),
            no_browser: true,
            reuse_session: true,
        };
        assert_eq!(Form::login(&l).to_login().unwrap(), l);
        let mut f = Form::login(&l);
        f.focus = 0;
        f.key(ctrl('u'));
        assert!(f.to_login().is_err(), "the issuer is required");
    }

    #[test]
    fn render_marks_where_each_button_is() {
        let f = Form::claim(&ClaimSettings::default());
        let (lines, hits) = f.render(true, 100, true);
        let text: String = lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
                    + "\n"
            })
            .collect();
        assert!(
            text.contains("[ Run ]") && text.contains("[ Cancel run ]"),
            "{text}"
        );
        assert!(
            text.contains("Workload *") && text.contains("mediatore URL *"),
            "{text}"
        );
        let run = hits.iter().find(|h| h.item == f.fields.len()).unwrap();
        assert!(run.x1 > run.x0);
    }
}
