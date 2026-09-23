# session-recap

Standalone fork of
[Thomas Mustier's session-recap](https://github.com/tmustier/pi-extensions/tree/main/session-recap),
published as `@jetserge/pi-session-recap`.

Based on upstream version 0.5.1 (Pi 0.87 compatibility, upstream commit
`4a63a2e`), with the fixes from
[PR #106](https://github.com/tmustier/pi-extensions/pull/106) at commit
`0c9b116`. Incomplete responses are discarded, and request failures use Pi
notifications instead of writing over the terminal. This fork also sends recap
requests through Pi's model runtime, so Anthropic subscription (OAuth) users are
not billed for extra usage. It adds `/recap-config` to change and save the
settings.

"While you were away" recap for Pi, modelled on Claude Code's away-summary. When
you've genuinely been away from a Pi session, a short recap is drafted while
you're gone and parked at the end of the scrollable transcript so it's waiting
when you return. In Pi's regular TUI it stays above the editor.

![session-recap widget in a live Pi session](./assets/recap.png)

Built for multi-clauding / multi-pi workflows where several agent sessions run
in parallel tabs.

The recap orients rather than reports: it states the high-level task first (what
you're building or debugging), then the concrete next step — the last assistant
message is already on screen; what you've lost after a context switch is the
task thread.

## How it triggers

1. **Away timer.** The extension enables terminal focus reporting (DECSET
   `?1004`) on session start. After the terminal has been continuously blurred
   for `awaySeconds` (default 90s), a recap is generated and shown, so it's
   parked above the editor when you refocus.
2. **Turn ends while you're away.** If the agent finishes a turn while the
   terminal is blurred — the prime multi-tab moment — a recap is drafted after a
   short debounce.
3. **Idle fallback.** Only on terminals that haven't demonstrated
   focus-reporting support: `idleSeconds` (default 120s) after the last
   `turn_end` with no input, a recap is generated anyway. The first real focus
   event disarms this path for the session.

Also fires automatically on `/resume` and `/fork` so you know where the prior
session left off. The delays and triggers are settings; see
[Configure](#configure).

The recap disappears when you submit a message or new agent work begins. It is
temporary UI: it is not saved in session history or sent to the model.

Quick alt-tabs cost nothing: no model call is made until you've actually been
away for the full threshold. If you return while a recap is still drafting, it's
allowed to finish — it lands moments after you're back, which is exactly when it
helps.

## Terminal compatibility

| Terminal | Focus reporting | Notes |
| -- | -- | -- |
| iTerm2, Ghostty, Alacritty, Kitty, WezTerm, xterm | ✅ | Works out of the box. |
| VS Code integrated terminal, Warp | ✅ | Works. |
| Apple Terminal | ⚠️ Partial | Idle fallback covers it. |
| tmux | ✅ (with config) | Add `set -g focus-events on` to `~/.tmux.conf`, then `tmux source-file ~/.tmux.conf`. |

If focus events cause any weirdness in your terminal, run with
`--recap-disable-focus` and the idle fallback still works.

## Model

The recap reuses the active provider's authentication and chooses a cheaper
model when available:

1. `--recap-model`, or the `model` setting from [Configure](#configure).
2. `claude-haiku-4-5` for Anthropic sessions, and for sessions on a native
   Claude model id (`claude-...`) whose provider also offers `claude-haiku-4-5`,
   such as an Anthropic-compatible proxy.
3. GPT-6 Luna when the active model is GPT and its provider offers it, or
   GPT-5.6 Luna when the provider offers only that.
4. The currently active model otherwise.

The recap sends no system prompt, no tools and no Agent Skills, and never writes
to the prompt cache. Reasoning is off unless the `thinking` setting selects a
level. Most APIs disable thinking when no reasoning level is requested, and
Codex models are sent an explicit `reasoningEffort: "none"` because they would
otherwise fall back to the server-side default.

It uses a window of recent messages (30 by default, set by `recentMessages`)
from Pi's current projected context, plus the earliest non-omitted user request
on the active branch and the latest active compaction or branch summary. Context
edits to that request are honoured, including replacement and omission. Large
initial requests and tool results retain their beginning and end.

The request goes through Pi's model runtime, the same path as agent turns. Auth
comes from Pi, and provider extensions apply to recaps too. This includes custom
providers with their own stream handlers and
[`@gotgenes/pi-anthropic-auth`](https://github.com/gotgenes/pi-anthropic-auth).
That extension shapes Anthropic OAuth requests; without it Anthropic bills them
as extra usage instead of against the subscription.

## Install

Requires Node.js 22.18 or newer and Pi 0.87.0 or newer.

```bash
pi install npm:@jetserge/pi-session-recap
```

If you use `@tmustier/pi-session-recap`, remove it before you install this fork:

```bash
pi remove npm:@tmustier/pi-session-recap
pi install npm:@jetserge/pi-session-recap
```

If you use the upstream monorepo, exclude `session-recap/index.ts` from that
package's extension filter. Do not load both versions.

For a local checkout, run `npm ci` in this repository, then run `pi install .`.

## Configure

Run `/recap-config` for a guided walkthrough of every setting. It opens with a
model picker over all available models: type to search, and the list scrolls
inside a window sized to the terminal, starting on the saved model. It then asks
for each value in turn. The current value is shown in brackets. An empty or
cancelled answer keeps it. Cancelling the first dialog discards the whole
walkthrough.

The settings are saved to `~/.pi/agent/session-recap.json`, in the directory
named by `PI_CODING_AGENT_DIR` when that is set. They apply at once in the
session that saved them. Other open Pi sessions read the file at their next
session start. There is no per-project file. The recap model receives your
transcript, so a repository must not be able to redirect it.

```json
{
  "model": { "provider": "anthropic", "model": "claude-haiku-4-5" },
  "thinking": "low",
  "awaySeconds": 60,
  "idleSeconds": 120,
  "autoRecap": true,
  "recapOnResume": true,
  "duringActive": false,
  "recentMessages": 30,
  "maxTokens": 512
}
```

All settings are optional. `/recap-config` leaves out any setting equal to its
default.

| Setting | Default | Description |
| -- | -- | -- |
| `model` | automatic | `{ "provider", "model" }`. Automatic selection is described in [Model](#model). A model that cannot be found falls back to the session model. |
| `thinking` | off | `minimal`, `low`, `medium` or `high`. On OpenAI models reasoning tokens count toward `maxTokens`, so raise it with thinking on. A response cut off at the cap is discarded. |
| `awaySeconds` | `90` | Seconds of continuous terminal blur before an away recap is generated. 5 to 86400. |
| `idleSeconds` | `120` | Idle-fallback delay after `turn_end`, used only when the terminal doesn't report focus. 5 to 86400. |
| `autoRecap` | `true` | Automatic recaps. With `false`, only `/recap` draws a recap. |
| `recapOnResume` | `true` | Recap automatically on `/resume` and `/fork`. Needs `autoRecap`. |
| `duringActive` | `false` | Draft an away recap while an agent turn is still running, instead of waiting for the turn to end. |
| `recentMessages` | `30` | Recent conversation messages sent with the recap request. 1 to 200. |
| `maxTokens` | `256` | Output token cap for the recap response. 64 to 8192. |

Invalid or unknown settings are ignored, with a warning when the session starts.
`/recap-config` refuses to overwrite a file that is not valid JSON.

## Flags

Flags override the saved settings for one launch.

| Flag | Overrides | Description |
| -- | -- | -- |
| `--recap-away-seconds <n>` | `awaySeconds` | Seconds of continuous terminal blur before an away recap is generated. |
| `--recap-idle-seconds <n>` | `idleSeconds` | Idle-fallback delay after `turn_end`, used only when the terminal doesn't report focus. |
| `--recap-disable-focus` | — | Disable DECSET `?1004` focus reporting. Idle fallback still runs. |
| `--recap-during-active` | `duringActive` | Allow away recaps while an agent turn is still running, instead of deferring to the end of the turn. |
| `--recap-disable` | `autoRecap` | Disable the automatic recap entirely. `/recap` still works. |
| `--recap-model "<p/id>"` | `model` | Override model selection, e.g. `anthropic/claude-sonnet-4-6`. |

## Command

| Command | Description |
| -- | -- |
| `/recap` | Force-generate a recap right now, bypassing the activity gate. |
| `/recap-config` | Change and save the settings in [Configure](#configure). |

## Development and releases

```bash
npm ci
npm run typecheck
npm test
npm run verify:tarball
```

The tarball check runs all regression tests against the packed extension.
`npm publish` runs these checks through `prepublishOnly`.

The first npm version requires an interactive publish from this repository:

```bash
npm login
npm publish --access public
```

After the package exists, configure its npm trusted publisher for GitHub
Actions:

- Owner: `CrazyCoder`
- Repository: `pi-session-recap`
- Workflow: `publish.yml`

Leave the environment field empty. No npm token is needed in GitHub secrets.

The workflow supports a manual dry run. For subsequent releases, update the
package version and changelog, commit to `main`, then push a matching
`v<version>` tag. The workflow checks the tag and branch, runs verification, and
publishes through OIDC. A version already on npm is skipped, so the bootstrap
tag can be pushed after the manual publish.

Retain the upstream MIT attribution when you distribute this fork.

## License

MIT
