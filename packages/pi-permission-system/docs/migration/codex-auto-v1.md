# Adopt the Codex Auto v1 Recommended Profile

`config/codex-auto-v1.json` is the versioned, copyable recommended profile for
this package. It aims for the **routing feel** of Codex Auto: deterministic local
policy handles routine work, while genuine grey-zone requests reach the
configured authorizer chain. It does not provide an OS sandbox or claim Codex
containment equivalence.

## Enable the profile

Back up any existing config, then copy the profile from the pi-auto-review
checkout (including a Pi-managed Git checkout):

```bash
profile_root=/path/to/pi-auto-review
config_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-permission-system"
mkdir -p "$config_dir"
[ ! -f "$config_dir/config.json" ] || cp "$config_dir/config.json" "$config_dir/config.json.before-codex-auto-v1"
cp "$profile_root/packages/pi-permission-system/config/codex-auto-v1.json" "$config_dir/config.json"
```

Restart Pi after copying. The profile names `safe-allow` in `authorizerChain`.
If that link is unavailable, asks fall through to the normal terminal decision;
they do not become allows. Set `authorizerChain: []` if you intentionally want
all asks to go directly to the terminal.

The filename is the profile version. Copy it to `config.json`; do not rename the
installed artifact in place, so later package updates can deliver a new profile
without silently changing an operator's active policy.

## What changes from `config.example.json`

| Surface | Current example | Codex Auto v1 | Direction |
| --- | --- | --- | --- |
| In-CWD `write` / `edit` | deny | allow | Looser; routine coding skips review |
| `grep` / `find` / `ls` tools | inherited ask | allow | Looser |
| Bash | two read-only Git commands allow; most commands ask; `npm *` deny | curated read-only commands and common test/check runners allow; unknown, network-capable, and destructive-adjacent commands ask | Looser for routine loops; less blanket denial |
| Sensitive paths | `.env*` deny with example exception | `.env*`, SSH, cloud credentials, shell profiles, `.netrc`, and Git credentials deny | Tighter |
| External directories | development and Cargo cache exceptions allow | all outside-CWD access asks | Tighter |
| MCP | status/list allow; other calls ask | status/list/search/describe allow; calls ask | Slightly looser for discovery only |
| Skills | allow | allow | Unchanged; actions emitted by a skill still hit native gates |

Test and check commands execute repository-controlled code. This profile treats
that as routine in-tree work; do not mistake the convenience for isolation when
opening an untrusted repository.

## Verification matrix

The executable matrix lives at `test/recommended-profile.test.ts` and loads the
shipped JSON artifact through the real extension composition root.

| Representative action | Route under v1 | Enters `safe-allow`? |
| --- | --- | --- |
| Write `src/feature.ts` inside CWD | allow | no |
| `git status` | allow | no |
| `npm test -- --runInBand` | allow | no |
| MCP status/discovery | allow | no |
| Select a skill | allow | no |
| Write outside CWD | ask | yes |
| `curl https://example.com` | ask | yes |
| `git reset --hard HEAD` | ask | yes |
| `find . -delete` | ask | yes |
| Side-effecting MCP call | ask | yes |
| Read or `cat` `~/.ssh/config` | deny | no |
| Read `.env` | hard-deny (`HARD_DENY_SECRET_PATH`) | no |
| Write `.pi/agents/worker.md` | hard-deny (`HARD_DENY_PERMISSION_CONTROL`) | no |
| `rm -rf /` | hard-deny (`HARD_DENY_CATASTROPHIC_DELETE`) | no |

Skill selection is allowed, but actions emitted by that skill are evaluated on
their native surfaces; the outside-CWD write row demonstrates that action gate.

Issue #10's built-in hard-deny runs before this profile, normal policy, YOLO
rewrites, and authorizers. Copying this profile therefore cannot loosen that
baseline. Routing controls **when** review is requested; safe-allow configuration
controls **how** an eligible ask is judged.
