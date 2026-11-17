# Private memo drafts

Approved policy (Kuu, 2026-11-17): draft and returned current memo content is
private to its creating account. Broad memo read/update scopes, future signers,
and historical editor IDs do not grant collaboration access. This kernel has no
explicit capability for a private-draft administrator or collaborator exception.
Normal tenant/entity and action grants still apply, including to the owner.

The list query and record checks apply the same restriction. The document owner
policy also denies legacy attachment access. Saved PDF export reads the protected
memo detail; document-based route preview uses the protected action check.
Prior frozen approval requests retain their existing authorization and snapshots.
Submitted and approved memo visibility, named routing and separation of duties
are unchanged. Detail responses expose canUpdate from the actual action decision;
the workspace uses it for edit, submit and upload controls.

Verification uses disposable Testcontainers Postgres with random host ports;
never use bos-p4v, existing volumes, seeds or user checkouts. The regression must
fail on the original service because an Accountant can list a Sales draft.
The memo integration suite covers private current content, future signers,
historical editors, returned drafts, legacy links, named approvals and scope.
No schema migration or runtime refresh is required by this source change.
