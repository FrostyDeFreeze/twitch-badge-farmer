# Badge Farmer

Collects free global Twitch badges by watching eligible streams

[Русская версия](README.ru.md)

## Installation

Download a ready-to-run version from [Releases](https://github.com/FrostyDeFreeze/twitch-badge-farmer/releases)

Open the latest release and download the archive for your system from **Assets**

| System                   | Download                        |
| ------------------------ | ------------------------------- |
| Windows x64              | badge-farmer-windows-x64.zip    |
| Linux x64                | badge-farmer-linux-x64.tar.gz   |
| macOS with Apple Silicon | badge-farmer-macos-arm64.tar.gz |
| macOS with an Intel chip | badge-farmer-macos-x64.tar.gz   |

Extract the archive into a folder where you want to keep the program and its settings

The executable is named `badge-farmer.exe` on Windows and `badge-farmer` on Linux and macOS

If no release is available yet, follow [Manual installation](#manual-installation)

### Set up your Twitch account

Open a terminal in the extracted folder

On Windows, open the folder in File Explorer, type `powershell` in the address bar and press **Enter**

Run this command on Windows

```powershell
.\badge-farmer.exe --gen-token
```

On Linux or macOS, run

```sh
./badge-farmer --gen-token
```

1. Sign in to the Twitch account you want to use in the browser window that opens
2. Complete the authorization on Twitch; if prompted, enter the activation code shown in the terminal
3. Return to the terminal and wait for the `Config saved` message

If the browser does not open, use the activation link printed in the terminal

The program creates `config.json` with your account details and token, so you do not need to fill in any fields yourself

Keep `config.json` private, since it contains your access token

### About the TV token

Badge Farmer uses a **Twitch TV-app OAuth token** obtained through device authorization

The `--gen-token` command generates this type of token automatically

For manual generation, follow this [device authorization example](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2/issues/94#issuecomment-1360683876)

Use the TV Client ID from `config.example.json` in the source files and leave the `scopes` parameter empty to match `--gen-token`

### Updating

Stop the program before replacing it with a newer version

Keep your existing `config.json` in the same folder as the new executable, or copy it there if you extract the update into a new folder

You can reuse this file after an update without generating a new token, as long as the token is still valid

Also keep `config.json.state.json`, which stores the program's saved collection state

If Twitch later rejects your authorization, run `--gen-token` again and sign in with the same account

## Manual installation

Use this method if you want to run the program from its source files

1. Install [Bun](https://bun.sh/docs/installation) 1.4.3 or newer
2. Open the [repository](https://github.com/FrostyDeFreeze/twitch-badge-farmer), choose **Code → Download ZIP** and extract it
3. Open a terminal in the extracted project folder and install the dependencies

```sh
bun install --frozen-lockfile
```

If you already have `config.json`, copy it into the project folder

Otherwise, create it by following the Twitch authorization steps above with this command

```sh
bun run gen-token
```

Start the program with `bun run start`, or list available badges with `bun run list`

To use the CLI options below, add them to the start command, for example `bun run start --debug` or `bun run start --config account.json`

## Usage

Run commands from the folder containing the program and your `config.json`

The program uses the terminal; keep it open while collecting badges

Start collecting on Windows

```powershell
.\badge-farmer.exe
```

On Linux or macOS

```sh
./badge-farmer
```

To see available badges without starting a viewing session, add `--list`

```powershell
.\badge-farmer.exe --list
```

On Linux or macOS, use `./badge-farmer` in place of `.\badge-farmer.exe` in the examples

| Option                  | What it does                                               |
| ----------------------- | ---------------------------------------------------------- |
| No option               | Keep collecting badges and checking for new ones           |
| `--list`                | List available badges without starting a viewing session   |
| `--gen-token`           | Sign in through Twitch and save your account configuration |
| `--help`                | Show the available commands                                |
| `--debug`               | Show technical details and reasons why badges were skipped |
| `--config account.json` | Use a different configuration file                         |

You can combine `--debug` and `--config` with a mode, for example

```powershell
.\badge-farmer.exe --list --debug --config account.json
```

To set up a separate configuration file, run `.\badge-farmer.exe --gen-token --config account.json`

Press **Ctrl+C** to stop

The program saves its state in `config.json.state.json` and uses it on the next launch

With `--config account.json`, the state file is named `account.json.state.json`

If there are no badges to collect, the program keeps checking for new ones

Run only one instance per Twitch account and avoid watching other streams on that account while collecting, as this can interfere with Drops progress

## How It Works

1. Checks [StreamDatabase](https://streamdatabase.com) for available free badges earned through viewing and skips badges you already own
2. Picks a badge, giving priority to rewards you have already started
3. Finds an eligible stream and watches it, trying another channel if viewing fails or progress stops
4. Tracks progress through Twitch, claims ready Drops and checks whether the badge has been added to your account

A badge is marked as collected only after Twitch confirms that you own it
