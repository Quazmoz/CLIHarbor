# Research and Competitive Landscape

_Last reviewed: 2026-09-17._

This document records the market/technical research that led to CLIHarbor's current direction. It should be updated as competitors evolve.

## 1. Current upstream Idira/CyberArk tooling

### `idsec`

CyberArk's public `idsec-cli-golang` repository describes `idsec` as the official CLI for Idira Identity Security Platform operations.

Relevant behavior for CLIHarbor:

- Windows installation/use is documented.
- `idsec login` supports interactive authentication prompts including password/MFA as required by configured authentication methods.
- successful login stores access tokens in the computer keystore for their lifetime.

Source:

- https://github.com/cyberark/idsec-cli-golang

### `conjur`

The current `cyberark/conjur-cli-go` repository describes a Go CLI for Idira Secrets Manager.

The older Python repository `cyberark/cyberark-conjur-cli` is deprecated/archived and points users toward `conjur-cli-go`.

Sources:

- https://github.com/cyberark/conjur-cli-go
- https://github.com/cyberark/cyberark-conjur-cli

### Design implication

CLIHarbor should call the installed official binaries and let their supported authentication/session behavior remain authoritative. It should not fork vendor auth or turn itself into a secret/token store.

## 2. Closest existing products

### instagui

Repository/project:

- https://github.com/Soutar97/instagui

Current positioning is extremely close to the broad “turn any CLI into a local browser GUI” concept. Its README describes:

- one-command generation of a local web form for a CLI;
- capture of `--help` / `-h` / `help` output;
- schema generation, including AI-assisted extraction for unknown tools;
- bundled schemas for popular commands;
- localhost browser UI;
- exact command preview;
- direct process spawning with an argument array rather than a shell string;
- streamed stdout/stderr.

This means CLIHarbor should **not** position generic CLI-to-GUI generation alone as novel.

Where CLIHarbor can differ materially:

- enterprise-first/local-only security posture;
- no external AI/API dependency required for the normal runtime;
- curated and reviewable packs instead of optimistic automatic interpretation;
- explicit risk classifications and backend-enforced destructive confirmations;
- vendor-auth delegation and profile/context awareness;
- ability to embed into an already-approved internal CLI;
- pack trust/signing direction;
- stronger diagnostics/redaction requirements for secret-management/identity tooling.

### ScripTree

Project:

- https://scriptree.org/
- https://github.com/KenM76/scriptree

ScripTree describes itself as an open-source GUI generator/runtime for command-line tools. It can point at an executable or use a `.scriptree` definition to generate labeled forms with controls such as dropdowns, file pickers, and checkboxes. It also has a marketplace concept (ScripTreeApps).

As of the review date, its GitHub releases are still in a `0.8.0a*` alpha line, but the project is active and has a substantial automated test suite.

CLIHarbor should treat ScripTree as a real adjacent/competing architecture rather than assume no similar solution exists.

Potential differentiation remains the same: enterprise security boundary, Idira-specific polish, existing-CLI embedding, no marketplace requirement, and a deliberately constrained pack format.

### OliveTin

Project:

- https://github.com/OliveTin/OliveTin
- https://www.olivetin.app/

OliveTin is mature open-source software that gives web access to predefined shell/exec actions. It supports YAML configuration, typed arguments, authentication/ACLs, execution history, and other automation triggers. The project reports thousands of GitHub stars and production maturity.

OliveTin proves meaningful demand for exposing predefined commands through a web interface, but its primary product shape is a self-hosted/general command-action interface. CLIHarbor's intended shape is a local browser companion to a CLI, with CLI-aware packs, version probing, auth delegation, structured result models, and enterprise-local defaults.

### Adjacent GUI wrappers

There are many tool-specific GUI wrappers around command-line engines such as FFmpeg, yt-dlp, and rclone. They validate the usefulness of putting forms, presets, tables, and previews over a CLI, but they are generally not universal pack runtimes.

## 3. Reddit demand signals

The evidence is stronger for **specific CLI GUI pain** and **predefined-command web UIs** than for users explicitly searching for a “universal CLI GUI platform.” That distinction matters for product positioning.

Examples:

### Generic/predefined command UI demand

A 2019 r/selfhosted thread asks for a web UI where a user can click a button to run a specific command instead of opening SSH repeatedly. The requester explicitly wanted a preset list rather than arbitrary commands:

- https://www.reddit.com/r/selfhosted/comments/dl5a1z/

A 2023 r/selfhosted thread asks how to build a web UI for an existing CLI application, including translating UI on/off options into command arguments and displaying terminal values:

- https://www.reddit.com/r/selfhosted/comments/16tnjwg/

OliveTin's original r/selfhosted launch post received material engagement around giving less-technical users controlled access to commands and avoiding repeated SSH use:

- https://www.reddit.com/r/selfhosted/comments/nfqi5m/

### Tool-specific CLI GUI demand

FFmpeg communities repeatedly contain users asking for simpler GUIs because command syntax/flags are cumbersome. Examples include:

- https://www.reddit.com/r/ffmpeg/comments/1okd27r/
- https://www.reddit.com/r/ffmpeg/comments/is932j/
- https://www.reddit.com/r/ffmpeg/comments/13q5zmr/

A 2025 FFmpeg GUI project post explicitly says the author built a wrapper because they were spending too much time typing/searching for flags:

- https://www.reddit.com/r/ffmpeg/comments/1otd301/

These are not proof that a generic CLIHarbor product will automatically have broad adoption. They are evidence that the underlying pain — powerful CLI, repetitive syntax, discoverability friction, desire for visible/preset workflows — is recurring.

## 4. What the research changes

### We should build the Idira version first

There is a concrete internal need regardless of broader market adoption. That makes the first vertical slice useful even if the generic platform never becomes a standalone product.

### We should not start with automatic `--help` parsing

instagui already explores that direction aggressively. CLIHarbor should prioritize correctness, security, curated workflows, and enterprise context rather than race to support every CLI automatically.

Automatic discovery may later assist **pack authors**, but generated definitions should be reviewed and validated before becoming executable production packs.

### We should market by specific tool/workflow first

Users typically search for “GUI for X” rather than “universal CLI wrapper.” If CLIHarbor becomes public, distribution/SEO should initially target specific packs, e.g. “Idira CLI GUI” or “Conjur workflow UI,” while the generic engine stays underneath.

### Existing solutions may still be useful references

We should learn from, not blindly depend on:

- instagui's schema/preview/local execution UX;
- ScripTree's declarative definitions and GUI generation;
- OliveTin's mature action/history/security concepts.

For the company use case, pulling in an external third-party GUI may itself trigger approval and supply-chain review. A narrowly-scoped internal build that wraps an already-approved CLI can therefore be faster operationally even when adjacent open-source projects exist.

## 5. Competitive positioning hypothesis

CLIHarbor's strongest defensible framing is:

> A local, enterprise-safe GUI layer for approved CLIs, with curated packs, vendor-owned authentication, explicit execution transparency, and no need to hand the browser an arbitrary shell.

Not:

> The first tool that turns a CLI into a GUI.

## 6. Research questions for later validation

- Which enterprise/security CLIs have notably weak GUIs and recurring operator pain?
- Which tools already have active GUI wrappers, making another pack low-value?
- Which CLI communities ask repeatedly for UI/preset/form workflows?
- Can pack authorship itself become a product differentiator through strong schemas, test fixtures, and AI-assisted-but-reviewed generation?
- Do companies prefer local browser UIs because they can fit inside existing approved CLI distribution paths?

Future pack prioritization should combine forum demand, search demand, competitor quality, CLI stability, and feasibility — not intuition alone.
