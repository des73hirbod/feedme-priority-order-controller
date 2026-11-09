# FeedMe Priority Order Controller

A **Node.js command-line order-processing system** demonstrating priority scheduling, asynchronous workers, interruption recovery, and deterministic verification. Built as an independent portfolio implementation of the [FeedMe software-engineering take-home challenge](https://github.com/feedmepos/se-take-home-assignment/tree/2652e3c9c1d8446790e2961a113c391b52d5abf0).

This is **not** an official FeedMe or McDonald's product or a submission to their hiring process. It operates entirely in memory: there is no web UI, database, payment system, or physical kitchen integration.

## What it does

- Accepts **normal** and **VIP** orders. VIP orders are chosen before waiting normal orders; within each class, earlier submissions go first (FIFO).
- Adds and removes cooking workers dynamically. Each worker handles **one order at a time**, taking **10 uninterrupted seconds** per order.
- Keeps busy normal orders running when a VIP arrives. Removing the **newest active worker** interrupts its unfinished order and returns it to its original place in the priority order; a new attempt starts a fresh 10 seconds.
- Completes work autonomously, even when no new commands arrive. Canceled attempts cannot complete later.
- Supports an interactive terminal session and a finite **simulated-time demo**, both using the same order controller.

## Quick start

**Prerequisite:** [Node.js](https://nodejs.org/) **22 or later** on Windows, macOS, or Linux. No `npm install` is needed: the project uses only built-in Node.js modules.

Open a terminal in the extracted project directory and run:

```sh
node --version
node src/main.js
```

While the application is running, type these commands **one at a time**:

```text
order normal
order vip
bot add
status
```

The first worker picks up the VIP order even though the normal order was submitted first. Wait 10 seconds and enter `status` again to see the completed VIP order and the normal order in progress. End the session with `quit`.

To demonstrate interruption, start a **new session** and enter `order normal`, `bot add`, and `bot remove` within ten seconds. `status` should show order #1001 pending again with no active bots. `bot add` starts a new, full ten-second attempt.

| Command | Action |
|---|---|
| `order normal` | Create a normal order |
| `order vip` | Create a VIP order |
| `bot add` | Add a worker; immediately assign waiting work |
| `bot remove` | Remove the newest worker; requeue any interrupted order |
| `status` | Show order IDs, workers, states, and counts |
| `help` | List the available commands |
| `quit` | End the session; unfinished work is not saved |

Commands are lowercase and case-sensitive (extra whitespace is accepted). Closing standard input also ends the session. Each output line is a **JSON object**, not a graphical dashboard; events include a UTC clock display and logical elapsed time. A fresh session starts with order **#1001** and worker **B1**.

## Run the verification

Run these from the project root. They work in Windows PowerShell and on Linux/macOS:

```sh
node scripts/test.mjs      # Automated tests, including real elapsed-time checks
node scripts/build.mjs     # Syntax and import verification (no compilation needed)
node scripts/run.mjs       # Fresh, validated simulated demo
```

The demo creates `scripts/result.txt` only after its output passes an independent checker. It models **40 seconds of logical time without sleeping**; its records are labeled `SIMULATED`, so it must not be presented as a real-time performance result. The demo checker expects **18 semantic events and seven state checkpoints**. `scripts/result.txt` is generated and excluded from Git.

For the more demanding CI failure-injection rehearsal, optionally run:

```sh
node scripts/ci-faults.mjs
```

This exercises six deliberately broken delivery paths in isolated temporary copies. It is not necessary merely to run the application. The equivalent npm commands are `npm test`, `npm run build`, `npm run demo`, and `npm run verify:faults`; if Windows PowerShell blocks the `npm` shim, use `npm.cmd`. Unix/Git Bash wrappers are also provided under `scripts/*.sh`.

### Verification status

| Check | Evidence available as of 2026-11-09 |
|---|---|
| Windows, Node.js **24.8.0** | **120 tests passed**, zero failed or skipped; build and demo passed |
| Live external-process test | Completion observed **10.0056 s** after a pre-submission measurement; no early completion observed |
| Frozen demo oracle | **18 semantic events / 7 checkpoints** matched |
| Negative-log and CI fault checks | **12 corrupt-log cases rejected** in the test suite; **6 injected CI faults detected** in local review |
| Hosted GitHub Actions on Ubuntu | **Not yet run/verified**; `.github/workflows/verify.yml` is provided |

The tests also exercise a separate frozen **ten-order stress scenario**, cancellation, worker overlap, exact logical deadlines, stale callbacks, and process restart. Test counts alone do not prove correctness; the fixed expected results and live witness provide additional checks. The hosted workflow must run successfully before claiming hosted-CI verification.

## Architecture

| File | Responsibility |
|---|---|
| [`src/controller.js`](src/controller.js) | Sole owner of orders, workers, priority rules, deadlines, and state transitions |
| [`src/runtime.js`](src/runtime.js) | Monotonic real-time clock, scheduling, and timer cancellation guards |
| [`src/cli.js`](src/cli.js) | Command parsing and validation |
| [`src/demo.js`](src/demo.js) | Authored simulated inputs for the finite demo |
| [`src/log.js`](src/log.js) | Structured JSON Lines event formatting |
| [`src/main.js`](src/main.js) | Interactive and demo entrypoint |
| [`tests/`](tests/) | Controller, runtime, process, fixture, and negative verification tests |

The controller uses logical deadlines so overdue jobs are settled chronologically, including subsequent pickups. Equal-deadline completions are ordered by worker ID. Each pickup has a distinct attempt ID to prevent an interrupted attempt from completing after cancellation.

## Scope and provenance

FeedMe's original requirements provide VIP priority, unique order numbers, adjustable workers, ten-second processing, and interruption/requeue behavior. Some details were **local design decisions** rather than publisher requirements: non-preemption on VIP arrival, original submission-order restoration, full restart after interruption, exact-time tie handling, starting IDs, and the CLI commands. See [provenance and frozen specification hashes](docs/PROVENANCE.md).

This project followed an AI-assisted engineering workflow: requirements analysis, reviewed behavioral rules, architecture and tests specified before implementation, followed by local execution and independent verification. The implementation is separate from the original publisher's code; no affiliation or endorsement is claimed.

**Limits:** In-memory state is discarded on exit; there is no persistence, authentication, distributed processing, or failure recovery. An unlimited stream of VIP orders may indefinitely delay normal orders. Real operating-system scheduling and output buffering can delay observed events; this is **not a hard real-time system**.

**License:** Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution and notices.
