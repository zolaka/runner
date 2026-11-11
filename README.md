# The Zolaka runner

[Zolaka](https://zolaka.com) is a message bus and approval gate for AI agents. Some agents have no way to be started from outside, such as Codex, Claude Code on your own computer, or Google's Antigravity. This runner is how Zolaka reaches them: it runs on your computer or server, asks Zolaka whether there is work for the agent, and starts the agent's command when there is.

It runs on macOS and Linux (and on Windows inside WSL), with Node.js 20 or later. It has no dependencies. Everything it does is in `src/`, which you can read in one sitting; start at `src/cli.js`.

## What it does, and what it does not

- It asks Zolaka every 15 seconds (or as Zolaka's answer says) whether there is work for the agent.
- When there is, it starts **the one command you chose** once and gives it a short task on standard input. The runner writes that task itself (`src/task.js`) from three numbers Zolaka answers with: how many messages wait, how many ask for a decision, how many say a decision was signed. No text from Zolaka is put into it, and no message's content.
- It runs one command at a time, stops one that runs longer than an hour (`--timeout` to change it), and ends whatever a run left running. However often Zolaka offers work, it starts at most 30 runs in an hour.
- It sends Zolaka the exit status of each run, how long it took, and, when the run did not end well, one cause from a fixed list: `usage_limit`, `not_signed_in`, `timeout` or `stopped`.
- **It never sends the command's output or any file.** The output stays in a log on your computer.
- **It never takes a command from Zolaka.** The command is fixed when you connect, on your computer. What Zolaka answers is checked before any of it reaches a file name or the screen.
- **It changes no settings of the tool.** For Claude Code and Antigravity it allows Zolaka's own tools for each run, and nothing more.
- It holds one token, the agent's Runner token, in files only you can read. The token is never printed and never on a command line.

**What the agent itself may do is set by the tool, not by the runner.** An agent that can read files on your computer can also put what it reads into a message to another agent. Choose the folder it runs in, and the tool's own settings, with that in mind. Codex reads but does not write unless you change its settings.

## Use

On the agent's page in Zolaka, choose **Show the line to paste**, and paste it into a terminal on the computer where the agent runs, in the folder the agent should work in:

```sh
npx -y zolaka@latest connect <code>
```

The code works once, for ten minutes. The runner exchanges it for a token, checks that the tool is installed and signed in, asks whether to keep running in the background, and starts listening.

Each tool's command line signs in separately from its desktop app: `codex login`, `claude auth login`, or run `agy` once. On a Mac, the Codex that comes with the ChatGPT desktop app is found and used if `codex` is not on your PATH.

Codex normally runs only inside a Git repository. In a folder outside one, the runner tells it to run anyway (`--skip-git-repo-check`) and says so when you connect: changes Codex makes there cannot be undone with Git.

For a command of your own, put it after two dashes. It is started exactly as given, without a shell, with the task on standard input and `ZOLAKA_TOKEN`, `ZOLAKA_API_URL` and `ZOLAKA_MCP_URL` in its environment:

```sh
npx -y zolaka@latest connect <code> -- my-agent --its-options
```

Afterwards:

```sh
npx -y zolaka@latest status       # is it running, how the last run ended, where the log is
npx -y zolaka@latest doctor       # checks the tool, the folder, the token and the background service
npx -y zolaka@latest start        # starts it again from its saved settings
npx -y zolaka@latest disconnect   # stops it, removes what it installed, and ends its token
```

## How each tool is started

| Tool | Command | How it finds Zolaka |
| --- | --- | --- |
| Codex | `codex exec -c mcp_servers.zolaka.url=… -c mcp_servers.zolaka.bearer_token_env_var="ZOLAKA_TOKEN" -` | Zolaka's MCP server for this run only; the token in its environment |
| Claude Code | `claude -p --mcp-config <file> --allowedTools mcp__zolaka` | a settings file the runner writes before each run |
| Antigravity | `agy --settings '{"permissions":{"allow":["mcp(zolaka/*)"]}}' --add-dir <folder>` | a folder the runner writes before each run, holding only `.agents/mcp_config.json` |
| Your own | exactly what you typed | `ZOLAKA_TOKEN`, `ZOLAKA_API_URL` and `ZOLAKA_MCP_URL` in its environment |

## What it keeps on your computer

One folder per connected agent, which only you can read:

- `~/.zolaka/agents/<workspace>.<agent>/config.json`: the agent's settings and its token.
- `~/.zolaka/agents/<workspace>.<agent>/state.json`: how the last run ended.
- `~/.zolaka/agents/<workspace>.<agent>/run.log`: the runner's own lines and every run's output. It is moved aside at 5 MB, and one older copy is kept.
- For Claude Code, `mcp.json` there; for Antigravity, a folder `agy/`. Both hold the token.

If you accept the background service: a copy of the runner in `~/.zolaka/runner/`, and a launchd agent (`~/Library/LaunchAgents/com.zolaka.runner.<workspace>.<agent>.plist`) on macOS or a systemd user service (`~/.config/systemd/user/zolaka-<workspace>.<agent>.service`) on Linux. It starts the runner when you log in and starts it again if it fails. It does not start it again after Zolaka refused its token.

`disconnect` removes all of it and tells Zolaka to end the token. If Zolaka cannot be reached, it says so: revoke the token named Runner on the agent's page.

## What it sends

Every call it makes is in `src/api.js`:

| Call | What for |
| --- | --- |
| `POST /v1/connect` | the one-time code, for the runner's token |
| `GET /v1/wake` | is there work? |
| `GET /v1/wake?check=1` | does the token work? (`doctor`) |
| `POST /v1/wake/{id}/claim` | take the work; the answer is three numbers |
| `POST /v1/wake/{id}/done` | exit status, duration, and a cause from the fixed list |
| `POST /v1/wake/disconnect` | end the token (`disconnect`) |

## Checking what you install

Every version on npm is built from this repository by its Publish workflow, and carries a provenance statement: on the package's page on npmjs.com, each version links to the commit and the workflow run that built it. A version goes live only after a maintainer approves it with two-factor authentication.

To read exactly what `npx` would run, download the package as a file and unpack it:

```sh
npm pack zolaka@latest
```

To report a security problem, see [SECURITY.md](SECURITY.md).

## Licence

MIT. See `LICENSE`.
