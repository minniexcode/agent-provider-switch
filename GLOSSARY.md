# Agent Provider Switch

Agent Provider Switch manages provider choices for agent tools. This glossary defines the product terms shared by its requirements and designs.

## Language

**Target**:
An agent tool whose provider settings are managed by Agent Provider Switch. Codex and Claude Code are the current targets.
_Avoid_: Provider, backend

**Provider**:
A named choice of service connection and settings available for a target. A provider belongs to one target.
_Avoid_: Target, agent tool

**Provider registry**:
The collection of provider records saved for a target. An empty registry is distinct from a provider with an unknown name.
_Avoid_: Active settings, provider

**Shared defaults**:
Settings inherited by the providers of one target unless a provider overrides or removes them.
_Avoid_: Global settings, active settings

**Stored settings**:
The settings saved in a provider record. When shared defaults are present, stored settings can express overrides and removals rather than a complete configuration.
_Avoid_: Effective settings, active settings

**Effective settings**:
The settings a provider contributes after its stored settings have been resolved against the applicable shared defaults.
_Avoid_: Stored settings, active settings

**Active settings**:
The settings currently present in a target's live configuration. They can differ from the effective settings of any registered provider.
_Avoid_: Stored settings, effective settings

**Compaction**:
Removing redundant stored settings while preserving the provider's effective settings under the current shared defaults.
_Avoid_: Reset, activation

**Backup**:
A snapshot of the state selected for recovery before a change. Its recovery can restore earlier contents or the earlier absence of an item.
_Avoid_: Provider export

**Command scope**:
The targets accepted for a command to operate on or report about. Shared operations have no target scope. Scope is distinct from the effects of recovering a particular backup.
_Avoid_: Backup origin, restore impact

**Backup origin**:
The target or targets associated with the operation that produced a backup. Origin describes the backup's provenance rather than everything its recovery affects.
_Avoid_: Restore impact, command scope

**Restore impact**:
The target state affected by recovering a backup, including its provider registry and active settings. Recovery can also affect shared state or state whose ownership is unknown. A restore's impact can differ from the backup's origin.
_Avoid_: Backup origin, command scope

**Configuration presence**:
Evidence that configuration state exists for a target. A location reserved for configuration is not evidence by itself. Presence does not establish that the state is active, valid, or managed by Agent Provider Switch.
_Avoid_: Target health, management history

**Target health**:
The absence of diagnosed faults in a target's configuration. An unused target or valid unmanaged active settings do not alone establish a fault.
_Avoid_: Configuration presence, managed state

**Unmanaged active settings**:
Valid active settings that cannot be identified with a registered provider. Unmanaged describes a relationship to the registry rather than a configuration fault.
_Avoid_: Invalid settings, unhealthy target

**Busy**:
A normal operation is currently using the shared access needed to make changes. Busy describes temporary activity rather than a fault.
_Avoid_: Broken lock, unhealthy target

**Provider identity**:
The characteristics that identify a provider's service connection, routing, and configured authentication. Identity is distinct from agreement on every setting associated with that provider.
_Avoid_: Complete configuration equality

**Ambiguous provider match**:
Active settings match the identities of multiple registered providers, so no unique provider can be identified.
_Avoid_: Active provider, first provider

**Configuration drift**:
A difference between active settings and the effective settings of a provider whose identity matches them.
_Avoid_: Unmanaged active settings, identity mismatch

**Deletion marker**:
An instruction in stored settings to remove an inherited setting when shared defaults are applied. A deletion can remain harmless when the inherited setting is already absent.
_Avoid_: Missing value, invalid setting

**Not activated**:
A target has no active configuration yet, even if saved providers or shared defaults are already prepared.
_Avoid_: Broken configuration, unmanaged active settings

**Unavailable result**:
Information that cannot be reliably established from the obtainable evidence. Unavailable is distinct from confirmed absence, an empty collection, or a diagnosed fault.
_Avoid_: Missing value, zero, healthy
