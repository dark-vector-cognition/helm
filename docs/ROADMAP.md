# HELM roadmap

Updated October 18, 2026. The dates below are roadmap targets, not release promises. Publication of this roadmap does not release a milestone.

## Released: 5.0.0

Helm Light is free and open source under the [Apache License 2.0](../LICENSE). Version `5.0.0` includes the desktop shell for local processes, ports, repositories and agent activity. It starts without a configured model; AI briefings remain optional. See the [release details](../CHANGELOG.md) and [setup instructions](../README.md#quick-start-2-minutes).

macOS is the primary supported platform. Windows and Linux have guarded monitor paths. Windows parser tests do not establish a test pass on actual Windows or Linux hardware.

## Review build

The [demo in the README](../README.md#see-helm-in-use) is based on `5.0.0` and includes unshipped fixes. A working review build does not establish a released update.

## Targets for 2026

| Target | Addition or improvement | Evidence required before release |
| --- | --- | --- |
| October 30, 2026 | Reliability update: safe radio relay requests, dependable Stop behavior, clean window reopen, current CPU sampling, disabled agent-launch enforcement and truthful navigation indicators. | Regression tests, a successful build, independent review, owner merge and a verified release. |
| November 20, 2026 | Guided first-run setup and clearer optional model connection diagnostics. | A setup recording from a fresh profile, configuration persistence, useful error states and a successful retry. |
| December 18, 2026 | Agent session export and a documented Windows and Linux test pass. | Export and reopen a real session. Run supported workflows on actual Windows and Linux hosts. Unit tests alone do not establish hardware support. |

Scope and dates can change. A milestone is complete only after its release evidence is verified.

## Packaging and enterprise enquiries

Earlier repository copy described Helm Go as a future signed build with auto-update and support. Those packaging plans have no announced delivery date. This roadmap does not establish a separate package, price or support commitment.

Need Helm for your team? [Discuss enterprise with DVC](https://darkvectorcognition.ai/helm/#enterprise).
