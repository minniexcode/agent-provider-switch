---
status: accepted
---

# Share provider workflows through target adapters

The 1.2.0 review confirms a common workflow for Codex and Claude provider commands, selected through a target descriptor. Target adapters retain the existing record rules, defaults resolution, live configuration projection, matching, input collection, and presentation policies; the common workflow owns registry access, provider selection, and mutation orchestration. This removes duplicate command implementations without forcing two different tools to share one native configuration schema.

The review scope retains the existing registry files and stored formats. A combined registry is technically possible, but it is a separate decision involving provider identity, migration, and the effects of whole-file recovery. Different record shapes and the need for a discriminated union are not reasons that make combined storage impossible.

The user confirmed these goals, preserving existing operation semantics, and the consolidated rules in [the 1.2.0 review](../Reviews/agent-provider-switch-1.2.0-prd-review.md) on 2026-10-13. The [roadmap](../agent-provider-switch-1.x-roadmap.md) records the accepted scope. The [formal PRD](../PRD/agent-provider-switch-prd-v1.2.0.md) and [Technical Design](../Design/agent-provider-switch-v1.2.0-design.md) define the requirements and implementation contracts; implementation remains planned.
